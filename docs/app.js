import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAK1W4reUyi6kDyPetwqdqtLCnXF0469tc",
  authDomain: "postkina.firebaseapp.com",
  projectId: "postkina",
  storageBucket: "postkina.firebasestorage.app",
  messagingSenderId: "594893100682",
  appId: "1:594893100682:web:799226823a1fee3a447f73"
};
const WORKER_URL = "https://postkina-facebook-publisher.whatthewithyking.workers.dev/";
const ADMIN_EMAIL = "yasodhasandeepa@gmail.com";
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
const elements = Object.fromEntries(["accountLabel","authButton","publishButton","actionMessage","countdown","scheduleLabel","audienceClock","pipelineStatus","pipelineDetail","latestCard","latestDate","latestTitle","latestMeta","facebookLink","articleLink","refreshButton"].map(id => [id, document.getElementById(id)]));
let statusData = null;
let nextAt = null;

function formatDate(value) {
  if (!value) return "No publication recorded yet";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "America/New_York" }).format(new Date(value)) + " ET";
}

function setStatus(name, detail) {
  const value = String(name || "idle").toLowerCase();
  const labels = { published: "Published", queued: "Queued", uploading: "Uploading", failed: "Needs attention", idle: "Ready" };
  elements.pipelineStatus.textContent = labels[value] || value;
  elements.pipelineStatus.className = `status-pill ${value === "published" ? "status-success" : value === "failed" ? "status-error" : ["queued","uploading"].includes(value) ? "status-warning" : "status-neutral"}`;
  elements.pipelineDetail.textContent = detail || (value === "failed" ? "The latest run did not complete." : "Publisher is ready.");
}

function renderStatus(data) {
  statusData = data;
  nextAt = data.schedule?.nextScheduledAt ? new Date(data.schedule.nextScheduledAt) : null;
  elements.scheduleLabel.textContent = `Daily at ${data.schedule?.localTime || "20:15"} ${data.schedule?.timeZone || "America/New_York"}`;
  const state = data.state || {};
  setStatus(state.lastStatus, state.lastError || (state.lastTriggeredAt ? `Last requested ${formatDate(state.lastTriggeredAt)}` : "Publisher is ready for its first Reel."));
  if (state.lastVideoId) {
    elements.latestCard.classList.remove("empty");
    elements.latestDate.textContent = formatDate(state.lastPublishedAt);
    elements.latestTitle.textContent = state.lastTitle || "PostKina Facebook Reel";
    elements.latestMeta.textContent = `Facebook video ID ${state.lastVideoId}`;
    if (state.lastFacebookUrl) { elements.facebookLink.href = state.lastFacebookUrl; elements.facebookLink.classList.remove("hidden"); }
    if (state.lastArticleUrl) { elements.articleLink.href = state.lastArticleUrl; elements.articleLink.classList.remove("hidden"); }
  }
}

async function refreshStatus() {
  elements.refreshButton.disabled = true;
  try {
    const response = await fetch(`${WORKER_URL}?reels=1`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load Reel status.");
    renderStatus(data);
  } catch (error) {
    setStatus("failed", error.message);
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function tick() {
  elements.audienceClock.textContent = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
  if (!nextAt) return;
  const delta = Math.max(0, nextAt.getTime() - Date.now());
  const hours = Math.floor(delta / 3600000);
  const minutes = Math.floor((delta % 3600000) / 60000);
  const seconds = Math.floor((delta % 60000) / 1000);
  elements.countdown.textContent = [hours, minutes, seconds].map(value => String(value).padStart(2, "0")).join(":");
  if (delta === 0) refreshStatus();
}

async function triggerPublish() {
  const user = auth.currentUser;
  if (!user || user.email?.toLowerCase() !== ADMIN_EMAIL) return;
  elements.publishButton.disabled = true;
  elements.actionMessage.textContent = "Starting the Reel workflow…";
  try {
    const token = await user.getIdToken(true);
    const response = await fetch(WORKER_URL, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "trigger_reel_workflow" }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not start the workflow.");
    elements.actionMessage.textContent = "Queued successfully. Video generation usually takes a few minutes.";
    setStatus("queued", "The manual Reel workflow is now running.");
    setTimeout(refreshStatus, 12000);
  } catch (error) {
    elements.actionMessage.textContent = error.message;
  } finally {
    elements.publishButton.disabled = false;
  }
}

elements.authButton.addEventListener("click", async () => auth.currentUser ? signOut(auth) : signInWithPopup(auth, provider));
elements.publishButton.addEventListener("click", triggerPublish);
elements.refreshButton.addEventListener("click", refreshStatus);
onAuthStateChanged(auth, user => {
  const isAdmin = user?.email?.toLowerCase() === ADMIN_EMAIL;
  elements.accountLabel.textContent = user ? (isAdmin ? `${user.email} · Admin` : `${user.email} · Not authorised`) : "Admin sign-in required to publish";
  elements.authButton.textContent = user ? "Sign out" : "Sign in with Google";
  elements.publishButton.disabled = !isAdmin;
});

refreshStatus();
tick();
setInterval(tick, 1000);
setInterval(refreshStatus, 60000);
