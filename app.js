import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const $ = (id) => document.getElementById(id);

// ?preview shows the open room with made-up notes, at any time of day.
// Nothing written in preview is saved anywhere.
const PREVIEW = new URLSearchParams(location.search).has("preview");
const CONFIGURED = /^https:\/\//.test(SUPABASE_URL) && !SUPABASE_URL.includes("YOUR-PROJECT") && !SUPABASE_KEY.includes("PASTE");
const db = CONFIGURED && !PREVIEW
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null;

const POLL_MS = 15_000;      // how often to fetch new notes while open
const RESYNC_MS = 10 * 60_000; // how often to re-check the server clock while closed

let offset = 0;          // server clock minus this computer's clock, in ms
let status = null;       // { open, opensAt, closesAt, night }
let state = "loading";
let pollTimer = null;
let lastCheck = 0;
let checking = false;
let mine = new Set();    // ids of notes this visitor left, for the "(yours)" tag

const serverNow = () => Date.now() + offset;

/* ---------- time formatting ---------- */

const londonClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", hour: "numeric", minute: "2-digit", hour12: true,
});
const localClock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const londonDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" });

const pad = (n) => String(n).padStart(2, "0");

function hms(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/* ---------- talking to the server ---------- */

async function fetchStatus() {
  if (PREVIEW) {
    if (status) return status;
    const now = Date.now();
    return {
      open: true,
      opensAt: now - 45_000,
      closesAt: now + 14 * 60_000 + 15_000,
      night: londonDate.format(now),
    };
  }

  const sent = Date.now();
  const { data, error } = await db.rpc("door_status");
  const received = Date.now();
  if (error) throw error;

  // Assume the server answered halfway through the round trip.
  offset = data.now_ms - (sent + received) / 2;
  return {
    open: data.open,
    opensAt: data.opens_at_ms,
    closesAt: data.closes_at_ms,
    night: data.night,
  };
}

async function checkDoor() {
  if (checking) return;
  checking = true;
  lastCheck = Date.now();
  try {
    status = await fetchStatus();
    hideNotice();
    setState(status.open ? "open" : "closed");
  } catch (err) {
    console.error(err);
    showNotice("Can't reach the room's server right now. Trying again in a moment.");
    setTimeout(checkDoor, 10_000);
  } finally {
    checking = false;
  }
}

/* ---------- switching between closed and open ---------- */

function setState(next) {
  const prev = state;
  state = next;
  document.body.dataset.state = next;
  $("closed").hidden = next !== "closed";
  $("open").hidden = next !== "open";
  document.querySelector('meta[name="theme-color"]')
    .setAttribute("content", next === "open" ? "#221836" : "#D7DCE1");

  if (next === "closed") {
    clearInterval(pollTimer);
    pollTimer = null;
    $("aftermath").hidden = prev !== "open";
    $("yours").textContent = yourTime(status.opensAt);
    document.title = "The 3am Room (closed)";
  }

  if (next === "open" && prev !== "open") {
    document.title = "The 3am Room is open";
    updateForm();
    loadNotes();
    pollTimer = setInterval(loadNotes, POLL_MS);
  }

  tick();
}

// "Where you are, that's 10:00 pm." Left blank if it's the same as UK time.
function yourTime(opensAt) {
  const uk = londonClock.format(opensAt).replace(/\s/g, "").toLowerCase();
  const here = localClock.format(opensAt);
  const hereFlat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", hour12: true })
    .format(opensAt).replace(/\s/g, "").toLowerCase();
  return uk === hereFlat ? "" : `Where you are, that's ${here}.`;
}

function tick() {
  if (!status) return;
  const now = serverNow();

  if (state === "closed") {
    const ms = status.opensAt - now;
    if (ms <= 0) {
      $("countdown").textContent = "Opening…";
      if (Date.now() - lastCheck > 2000) checkDoor();
    } else {
      $("countdown").textContent = `Opens in ${hms(ms)}`;
      if (Date.now() - lastCheck > RESYNC_MS) checkDoor();
    }
  }

  if (state === "open") {
    const ms = status.closesAt - now;
    $("left").textContent = mmss(ms);
    if (ms <= 0 && Date.now() - lastCheck > 2000) {
      if (PREVIEW) {
        status = { ...status, open: false, opensAt: status.opensAt + 86_400_000 };
        setState("closed");
      } else {
        checkDoor();
      }
    }
  }
}

/* ---------- the wall of notes ---------- */

const previewNotes = makePreviewNotes();

async function loadNotes() {
  let rows;
  if (PREVIEW) {
    rows = previewNotes;
  } else {
    const { data, error } = await db
      .from("messages")
      .select("id, body, created_at, night")
      .order("created_at", { ascending: false })
      .limit(600);
    if (error) { console.error(error); return; }
    rows = data;
  }
  renderNotes(rows);
}

function renderNotes(rows) {
  const tonight = rows.filter((r) => r.night === status.night);
  const before = rows.filter((r) => r.night !== status.night);
  fillList($("tonight"), tonight);
  fillList($("lastnight"), before);
  $("tonight-empty").hidden = tonight.length > 0;
  $("lastnight-empty").hidden = before.length > 0;
}

function fillList(list, rows) {
  list.replaceChildren(...rows.map((r) => {
    const li = document.createElement("li");
    if (mine.has(r.id)) li.className = "mine";
    const body = document.createElement("p");
    body.className = "body";
    body.textContent = r.body; // textContent, never innerHTML: notes are written by strangers
    const time = document.createElement("time");
    time.dateTime = r.created_at;
    time.textContent = londonClock.format(new Date(r.created_at));
    li.append(body, time);
    return li;
  }));
}

/* ---------- leaving a note ---------- */

// One note per visitor per night. It's an honour system kept in this browser;
// the server's own limits are in supabase/schema.sql.
const postedKey = () => `three-am:posted:${status.night}`;

function alreadyPosted() {
  try { return localStorage.getItem(postedKey()) !== null; } catch { return false; }
}

function rememberPosted(id) {
  try { localStorage.setItem(postedKey(), String(id ?? "")); } catch { /* storage blocked; fine */ }
}

function updateForm() {
  try {
    const id = Number(localStorage.getItem(postedKey()));
    if (id) mine.add(id);
  } catch { /* ignore */ }

  const done = alreadyPosted();
  $("form").hidden = done;
  if (done) setFormMessage("Your note is on the wall. Everyone gets one a night, so come back tomorrow.");
}

function setFormMessage(text) {
  $("formmsg").textContent = text;
}

function explain(error) {
  switch (error.code) {
    case "42501": return "The door shut before your note got through, so it wasn't saved.";
    case "23505": return "Someone already left exactly that tonight. Try saying it your own way.";
    case "23514": return "Notes need to be between 1 and 140 characters.";
    case "P0001": return error.message;
    default: return "Your note wasn't saved. Check your connection and try again.";
  }
}

$("note").addEventListener("input", () => {
  const left = 140 - $("note").value.length;
  $("count").textContent = left === 1 ? "1 character left" : `${left} characters left`;
  $("count").classList.toggle("low", left <= 20);
});

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = $("note").value.trim();
  if (!body) {
    setFormMessage("Write something first.");
    return;
  }

  $("leave").disabled = true;
  setFormMessage("Leaving your note…");

  let id = null;
  let error = null;

  if (PREVIEW) {
    id = Date.now();
    previewNotes.unshift({ id, body, created_at: new Date().toISOString(), night: status.night });
  } else {
    // Ask for the new note's id back so it can be marked "(yours)" on the wall.
    let data;
    ({ data, error } = await db.from("messages").insert({ body }).select("id").single());
    id = data?.id ?? null;
  }

  $("leave").disabled = false;

  if (error) {
    console.error(error);
    setFormMessage(explain(error));
    if (error.code === "42501") checkDoor();
    return;
  }

  if (id) mine.add(id);
  rememberPosted(id);
  $("note").value = "";
  $("form").hidden = true;
  setFormMessage("Your note is on the wall. Everyone gets one a night, so come back tomorrow.");
  loadNotes();
});

/* ---------- notices and preview ---------- */

function showNotice(text) {
  $("notice").textContent = text;
  $("notice").hidden = false;
}

function hideNotice() {
  if (PREVIEW) return;
  $("notice").hidden = true;
}

function makePreviewNotes() {
  const now = Date.now();
  const today = londonDate.format(now);
  const yesterday = londonDate.format(now - 86_400_000);
  // Made-up times between 3:00 and 3:15am UK time, so preview looks like the real thing.
  const ukHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hourCycle: "h23" });
  const threeAm = (date, min) => {
    const asUtc = Date.parse(`${date}T03:${pad(min)}:00Z`);
    const shift = Number(ukHour.format(asUtc)) - 3; // 0 in winter, 1 in summer
    return new Date(asUtc - shift * 3_600_000).toISOString();
  };
  const at = (min) => threeAm(today, min);
  const lastNight = (min) => threeAm(yesterday, min);
  return [
    { id: 1, night: today, created_at: at(1), body: "first time making it in. the countdown was more stressful than my mocks" },
    { id: 2, night: yesterday, created_at: lastNight(13), body: "If you're reading this you should probably go to sleep. I won't, but you should." },
    { id: 3, night: yesterday, created_at: lastNight(11), body: "the fox outside my window has been screaming for twenty minutes. is this normal" },
    { id: 4, night: yesterday, created_at: lastNight(9), body: "night shift at the hospital, on my break. hello to whoever's next" },
    { id: 5, night: yesterday, created_at: lastNight(4), body: "set an alarm specifically for this. worth it? jury's out" },
    { id: 6, night: yesterday, created_at: lastNight(1), body: "jet lagged in Sydney, it's 2pm here. feels like cheating" },
  ];
}

/* ---------- start ---------- */

if (PREVIEW) {
  showNotice("Preview. The room isn't really open, and notes you leave here aren't saved. Remove ?preview from the address to see the real thing.");
  checkDoor();
} else if (!CONFIGURED) {
  document.body.dataset.state = "closed";
  $("closed").hidden = false;
  $("countdown").textContent = "";
  showNotice("This copy isn't connected to a database yet. Add your Supabase details to config.js (the README explains how), or add ?preview to the address to see the room open.");
} else {
  checkDoor();
}

setInterval(tick, 250);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !PREVIEW) checkDoor();
});
