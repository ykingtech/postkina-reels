import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const BUILD = path.join(ROOT, "build");
const STATE_FILE = path.join(ROOT, "state", "published.json");
const API_URL = process.env.POSTKINA_API_URL || "https://postkina-facebook-publisher.whatthewithyking.workers.dev/?posts=1&limit=30";
const TIME_ZONE = process.env.REEL_TIME_ZONE || "America/New_York";
const TARGET_HOUR = Number(process.env.REEL_TARGET_HOUR || 20);
const PUBLISHER_URL = process.env.POSTKINA_PUBLISHER_URL || "https://postkina-facebook-publisher.whatthewithyking.workers.dev/";

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

function wrap(value, width = 28) {
  const words = compact(value).split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line || `${line} ${word}`.length <= width) line = line ? `${line} ${word}` : word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function limitWords(value, maximum) {
  const words = compact(value).split(" ").filter(Boolean);
  if (words.length <= maximum) return words.join(" ");
  return `${words.slice(0, maximum).join(" ")}…`;
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
  const slides = [
    limitWords(sentence[0] || post.excerpt, 18),
    compact(sentence[1] || "Here is why this development matters right now."),
    "Read the verified context on PostKina."
  ];
  return {
    hook: limitWords(post.title, 10),
    slides,
    narration: [compact(post.title), ...slides].join(" "),
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
  const prompt = `Create clear American-English copy for a polished 30-second vertical Facebook news Reel. Return JSON only with keys hook, slides, narration, caption, hashtags. The hook must be one complete headline of no more than 9 words. slides must contain exactly 3 complete sentences of 10-14 words each: fact, why it matters, and a final context/CTA line. narration must be a natural 55-70 word spoken news script using only the same facts. Never output keyword lists, fragments, unrelated headlines, or invented facts. Use only this material. Title: ${post.title}\nSummary: ${post.excerpt}\nArticle: ${post.articleUrl}\nExisting tags: ${post.hashtags}`;
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
      hook: limitWords(parsed.hook || fallback.hook, 10),
      slides: Array.isArray(parsed.slides) ? parsed.slides.slice(0, 3).map(value => limitWords(value, 18)) : fallback.slides,
      narration: compact(parsed.narration || fallback.narration),
      caption: compact(parsed.caption || fallback.caption),
      hashtags: cleanHashTags(parsed.hashtags || fallback.hashtags)
    };
  } catch (error) {
    console.warn(`AI copy fallback: ${error.message}`);
    return fallback;
  }
}

function assTime(seconds) {
  const value = Math.max(0, seconds);
  const hours = Math.floor(value / 3600);
  const minutes = String(Math.floor((value % 3600) / 60)).padStart(2, "0");
  const secs = String(Math.floor(value % 60)).padStart(2, "0");
  const centis = String(Math.round((value % 1) * 100)).padStart(2, "0");
  return `${hours}:${minutes}:${secs}.${centis}`;
}

function assEscape(value) {
  return wrap(value).replaceAll("\\", "\\\\").replaceAll("{", "\\{").replaceAll("}", "\\}").replaceAll("\n", "\\N");
}

function makeAss(copy) {
  const cues = [copy.hook, ...copy.slides].slice(0, 4);
  const events = cues.map((text, index) => {
    const start = index * 7.5;
    const end = (index + 1) * 7.5 - 0.15;
    return `Dialogue: 0,${assTime(start)},${assTime(end)},${index === 0 ? "Hook" : "Body"},,0,0,0,,${assEscape(text)}`;
  });
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Hook,DejaVu Sans,62,&H00FFFFFF,&H000000FF,&H60000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,2,86,86,190,1
Style: Body,DejaVu Sans,50,&H00FFFFFF,&H000000FF,&H60000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,2,96,96,200,1
Style: Kicker,DejaVu Sans,28,&H0000ADFF,&H000000FF,&H60000000,&H00000000,-1,0,0,0,100,100,1,0,1,2,0,7,350,40,72,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
Dialogue: 0,0:00:00.00,0:00:30.00,Kicker,,0,0,0,,30 SECOND BRIEF
${events.join("\n")}
`;
}

async function download(url, destination) {
  const response = await fetch(url, { headers: { "user-agent": "PostKina-Reels/1.0" } });
  if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function generateVoiceover(copy) {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-lite-tts",
        input: [{ type: "user_input", content: [{ type: "text", text: copy.narration, annotations: [{ type: "speech_metadata", style: "confident, clear American broadcast delivery; brisk but natural pace" }] }] }],
        response_format: { type: "audio", mime_type: "audio/wav", sample_rate: 24000 },
        generation_config: { speech_config: [{ voice: "Kore" }] }
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error?.message || `Gemini TTS ${response.status}`);
    const audio = (result.steps || []).flatMap(step => step.content || []).filter(item => item.type === "audio" && item.data).at(-1);
    if (!audio?.data) throw new Error("Gemini TTS returned no audio.");
    const destination = path.join(BUILD, "narration.wav");
    await writeFile(destination, Buffer.from(audio.data, "base64"));
    return destination;
  } catch (error) {
    console.warn(`Voiceover fallback: ${error.message}`);
    return null;
  }
}

function renderVideo(imageFile, narrationFile) {
  const logo = path.join(ROOT, "assets", "postkina-logo.png");
  const captions = path.join(BUILD, "captions.ass").replaceAll("\\", "/").replace(":", "\\:");
  const output = path.join(BUILD, "reel.mp4");
  const filter = [
    "[0:v]split=2[bgsrc][photosrc]",
    "[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=32:16,eq=brightness=-0.20:saturation=0.72[bg]",
    "[photosrc]scale=980:1020:force_original_aspect_ratio=decrease[photo]",
    "[bg][photo]overlay=(W-w)/2:235[base]",
    "[base]drawbox=x=0:y=0:w=iw:h=188:color=0x0f1d2a@0.96:t=fill,drawbox=x=0:y=1260:w=iw:h=660:color=0x0f1d2a@0.94:t=fill[panel]",
    "[1:v]scale=235:-1[logo]",
    "[panel][logo]overlay=46:38[brand]",
    "[brand]drawbox=x=46:y=151:w=220:h=5:color=0xffad00@1:t=fill[accent]",
    `[accent]ass='${captions}'[v]`,
    "[2:a]apad=pad_dur=30,atrim=0:30,highpass=f=90,loudnorm=I=-16:LRA=7:TP=-1.5[voice]",
    "[3:a]atrim=0:30,lowpass=f=1800,highpass=f=75,aecho=0.8:0.35:320|640:0.18|0.08,afade=t=in:st=0:d=1.2,afade=t=out:st=28:d=2,volume=0.16[music]",
    "[voice][music]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0,alimiter=limit=0.90[a]"
  ].join(";");
  const audioInput = narrationFile ? ["-i", narrationFile] : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"];
  // This gentle pad is synthesized during rendering, so it has no third-party
  // recording, song, sample, or licence attached to it.
  const originalMusic = "aevalsrc=0.12*(sin(2*PI*110*t)+0.55*sin(2*PI*164.81*t)+0.42*sin(2*PI*220*t))*(0.55+0.45*sin(2*PI*0.10*t)):s=48000:d=30";
  execFileSync("ffmpeg", [
    "-y", "-loop", "1", "-i", imageFile,
    "-loop", "1", "-i", logo,
    ...audioInput,
    "-f", "lavfi", "-i", originalMusic,
    "-filter_complex", filter,
    "-map", "[v]", "-map", "[a]", "-t", "30",
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
  await writeFile(path.join(BUILD, "captions.ass"), makeAss(copy), "utf8");
  const narrationFile = await generateVoiceover(copy);
  renderVideo(imageFile, narrationFile);
  const assetName = `postkina-reel-${now.date}-${post.id}.mp4`.replace(/[^A-Za-z0-9._-]/g, "-");
  await writeFile(path.join(BUILD, "meta.json"), JSON.stringify({ date: now.date, post, copy, assetName }, null, 2));
  console.log(`Prepared ${assetName} from ${post.id}.`);
}

async function publish() {
  const workflowSecret = process.env.REELS_WORKFLOW_SECRET;
  if (!workflowSecret) throw new Error("REELS_WORKFLOW_SECRET is required.");
  const videoUrl = process.env.REEL_VIDEO_URL;
  if (!videoUrl) throw new Error("REEL_VIDEO_URL is required.");
  const meta = await readJson(path.join(BUILD, "meta.json"), null);
  if (!meta) throw new Error("build/meta.json was not found.");
  const response = await fetch(PUBLISHER_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Workflow-Secret": workflowSecret },
    body: JSON.stringify({
      action: "publish_reel",
      videoUrl,
      title: meta.post.title,
      description: `${meta.copy.caption}\n\n${meta.copy.hashtags}\n\nImage: ${meta.post.imageAttribution || "PostKina source"} · ${meta.post.imageLicense || "See article"}`,
      articleUrl: meta.post.articleUrl,
      sourcePostId: meta.post.id
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(`Publish Reel failed: ${result.error || response.status}`);
  const state = await readJson(STATE_FILE, { publishedDates: {}, publishedPostIds: [] });
  state.publishedDates ||= {};
  state.publishedDates[meta.date] = { postId: meta.post.id, videoId: result.videoId, facebookUrl: result.facebookUrl, publishedAt: result.publishedAt || new Date().toISOString() };
  state.publishedPostIds = [...new Set([...(state.publishedPostIds || []), meta.post.id])].slice(-180);
  state.lastRun = state.publishedDates[meta.date];
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  console.log(`Published Facebook Reel ${result.videoId}.`);
}

const command = process.argv[2];
if (command === "prepare") await prepare();
else if (command === "publish") await publish();
else throw new Error("Use: node src/run.mjs prepare|publish");

