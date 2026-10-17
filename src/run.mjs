import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const BUILD = path.join(ROOT, "build");
const STATE_FILE = path.join(ROOT, "state", "published.json");
const API_URL = process.env.POSTKINA_API_URL || "https://postkina-facebook-publisher.whatthewithyking.workers.dev/?posts=1&limit=30";
const TIME_ZONE = process.env.REEL_TIME_ZONE || "America/New_York";
const TARGET_HOUR = Number(process.env.REEL_TARGET_HOUR || 20);
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || "v26.0";

function zonedParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function wrap(value, width = 36) {
  const words = compact(value).split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line || `${line} ${word}`.length <= width) line = line ? `${line} ${word}` : word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4).join("\n");
}

function cleanHashTags(value) {
  const found = compact(value).match(/#[A-Za-z0-9_]+/g) || [];
  return [...new Set(["#PostKina", "#USNews", ...found])].slice(0, 7).join(" ");
}

function relevance(post) {
  const text = `${post.title} ${post.excerpt} ${post.hashtags}`.toLowerCase();
  const terms = ["united states", " u.s", " us ", "america", "american", "trump", "white house", "washington", "congress", "new york", "california", "texas"];
  return terms.reduce((score, term) => score + (text.includes(term) ? 3 : 0), 0) + (post.imageUrl ? 1 : 0);
}

function fallbackCopy(post) {
  const sentence = compact(post.excerpt).split(/(?<=[.!?])\s+/).filter(Boolean);
  return {
    hook: compact(post.title),
    slides: [
      compact(sentence[0] || post.excerpt),
      compact(sentence[1] || "Here is why this story matters now."),
      "Follow PostKina for clear global news in under a minute."
    ],
    caption: `${compact(post.title)}\n\n${compact(post.excerpt)}\n\nRead the full story: ${post.articleUrl}`,
    hashtags: cleanHashTags(post.hashtags)
  };
}

function parseAiJson(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI response did not contain JSON");
  return JSON.parse(match[0]);
}

async function generateCopy(post) {
  const fallback = fallbackCopy(post);
  if (!process.env.GEMINI_API_KEY) return fallback;
  const prompt = `Create concise American-English copy for a 30-second vertical Facebook news Reel. Return JSON only with keys hook, slides (exactly 3 short strings), caption, hashtags. Never invent facts. Use only this material. Title: ${post.title}\nSummary: ${post.excerpt}\nArticle: ${post.articleUrl}\nExisting tags: ${post.hashtags}`;
  try {
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.35 } })
    });
    if (!response.ok) throw new Error(`Gemini ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const parsed = parseAiJson(data?.candidates?.[0]?.content?.parts?.[0]?.text);
    return {
      hook: compact(parsed.hook || fallback.hook),
      slides: Array.isArray(parsed.slides) ? parsed.slides.slice(0, 3).map(compact) : fallback.slides,
      caption: compact(parsed.caption || fallback.caption),
      hashtags: cleanHashTags(parsed.hashtags || fallback.hashtags)
    };
  } catch (error) {
    console.warn(`AI copy fallback: ${error.message}`);
    return fallback;
  }
}

function srtTime(seconds) {
  const value = Math.max(0, seconds);
  const hh = String(Math.floor(value / 3600)).padStart(2, "0");
  const mm = String(Math.floor((value % 3600) / 60)).padStart(2, "0");
  const ss = String(Math.floor(value % 60)).padStart(2, "0");
  return `${hh}:${mm}:${ss},000`;
}

function makeSrt(copy) {
  const cues = [copy.hook, ...copy.slides].slice(0, 4);
  return cues.map((text, index) => `${index + 1}\n${srtTime(index * 7.5)} --> ${srtTime((index + 1) * 7.5 - 0.25)}\n${wrap(text)}\n`).join("\n");
}

async function download(url, destination) {
  const response = await fetch(url, { headers: { "user-agent": "PostKina-Reels/1.0" } });
  if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

function renderVideo(imageFile) {
  const logo = path.join(ROOT, "assets", "postkina-logo.png");
  const srt = path.join(BUILD, "captions.srt").replaceAll("\\", "/").replace(":", "\\:");
  const output = path.join(BUILD, "reel.mp4");
  const filter = [
    "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:10[bg]",
    "[0:v]scale=1000:1120:force_original_aspect_ratio=decrease[photo]",
    "[bg][photo]overlay=(W-w)/2:245[base]",
    "[base]drawbox=x=0:y=0:w=iw:h=210:color=0x0f1d2a@0.95:t=fill,drawbox=x=0:y=1350:w=iw:h=570:color=0x0f1d2a@0.90:t=fill[panel]",
    "[1:v]scale=250:-1[logo]",
    "[panel][logo]overlay=40:45[brand]",
    `[brand]subtitles='${srt}':force_style='FontName=DejaVu Sans,FontSize=30,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,BackColour=&H900F1D2A,Outline=2,Shadow=0,MarginV=155,Alignment=2'[v]`
  ].join(";");
  execFileSync("ffmpeg", [
    "-y", "-loop", "1", "-i", imageFile,
    "-loop", "1", "-i", logo,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-filter_complex", filter,
    "-map", "[v]", "-map", "2:a", "-t", "30",
    "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "21",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output
  ], { stdio: "inherit" });
  return output;
}

async function prepare() {
  await mkdir(BUILD, { recursive: true });
  const state = await readJson(STATE_FILE, { publishedDates: {}, publishedPostIds: [] });
  const now = zonedParts();
  const forced = String(process.env.FORCE_RUN || "").toLowerCase() === "true";
  if (!forced && now.hour !== TARGET_HOUR) {
    console.log(`Skipping: ${TIME_ZONE} hour ${now.hour}, target ${TARGET_HOUR}.`);
    return;
  }
  if (!forced && state.publishedDates?.[now.date]) {
    console.log(`Skipping: a Reel was already published for ${now.date}.`);
    return;
  }
  const response = await fetch(API_URL);
  if (!response.ok) throw new Error(`PostKina API ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const used = new Set(state.publishedPostIds || []);
  const candidates = (data.posts || []).filter(post => post.status === "published" && post.imageUrl && post.articleUrl && !used.has(post.id));
  if (!candidates.length) throw new Error("No unused published article with an image is available.");
  candidates.sort((a, b) => relevance(b) - relevance(a) || new Date(b.publishedAt) - new Date(a.publishedAt));
  const post = candidates[0];
  const copy = await generateCopy(post);
  const imageFile = path.join(BUILD, "source-image");
  await download(post.imageUrl, imageFile);
  await writeFile(path.join(BUILD, "captions.srt"), makeSrt(copy), "utf8");
  renderVideo(imageFile);
  const assetName = `postkina-reel-${now.date}-${post.id}.mp4`.replace(/[^A-Za-z0-9._-]/g, "-");
  await writeFile(path.join(BUILD, "meta.json"), JSON.stringify({ date: now.date, post, copy, assetName }, null, 2));
  console.log(`Prepared ${assetName} from ${post.id}.`);
}

async function publish() {
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("FACEBOOK_PAGE_ACCESS_TOKEN is required.");
  const videoUrl = process.env.REEL_VIDEO_URL;
  if (!videoUrl) throw new Error("REEL_VIDEO_URL is required.");
  const meta = await readJson(path.join(BUILD, "meta.json"), null);
  if (!meta) throw new Error("build/meta.json was not found.");
  const startUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/me/video_reels`);
  startUrl.searchParams.set("access_token", token);
  startUrl.searchParams.set("upload_phase", "start");
  const startResponse = await fetch(startUrl, { method: "POST" });
  if (!startResponse.ok) throw new Error(`Create Reel failed: ${await startResponse.text()}`);
  const session = await startResponse.json();
  const uploadResponse = await fetch(session.upload_url, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, file_url: videoUrl }
  });
  if (!uploadResponse.ok) throw new Error(`Upload Reel failed: ${await uploadResponse.text()}`);
  const finishUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/me/video_reels`);
  finishUrl.searchParams.set("access_token", token);
  finishUrl.searchParams.set("video_id", session.video_id);
  finishUrl.searchParams.set("upload_phase", "finish");
  finishUrl.searchParams.set("video_state", "PUBLISHED");
  finishUrl.searchParams.set("title", meta.post.title.slice(0, 100));
  finishUrl.searchParams.set("description", `${meta.copy.caption}\n\n${meta.copy.hashtags}\n\nImage: ${meta.post.imageAttribution || "PostKina source"} · ${meta.post.imageLicense || "See article"}`);
  const finishResponse = await fetch(finishUrl, { method: "POST" });
  if (!finishResponse.ok) throw new Error(`Publish Reel failed: ${await finishResponse.text()}`);
  const state = await readJson(STATE_FILE, { publishedDates: {}, publishedPostIds: [] });
  state.publishedDates ||= {};
  state.publishedDates[meta.date] = { postId: meta.post.id, videoId: session.video_id, publishedAt: new Date().toISOString() };
  state.publishedPostIds = [...new Set([...(state.publishedPostIds || []), meta.post.id])].slice(-180);
  state.lastRun = state.publishedDates[meta.date];
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  console.log(`Published Facebook Reel ${session.video_id}.`);
}

const command = process.argv[2];
if (command === "prepare") await prepare();
else if (command === "publish") await publish();
else throw new Error("Use: node src/run.mjs prepare|publish");

