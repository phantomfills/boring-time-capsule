import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const $ = (id) => document.getElementById(id);

// ?preview shows the open room with made-up notes, at any time of day.
// Nothing done in preview is saved anywhere.
const PREVIEW = new URLSearchParams(location.search).has("preview");
const CONFIGURED = /^https:\/\//.test(SUPABASE_URL) && !SUPABASE_URL.includes("YOUR-PROJECT") && !SUPABASE_KEY.includes("PASTE");
const db = CONFIGURED && !PREVIEW
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null;

const POLL_MS = 10_000;        // how often to check for new notes, hearts and goodnights while open
const RESYNC_MS = 10 * 60_000; // how often to re-check the server clock while closed

let offset = 0;          // server clock minus this computer's clock, in ms
let status = null;       // { open, opensAt, closesAt, night }
let state = "loading";
let pollTimer = null;
let lastCheck = 0;
let checking = false;

const mine = new Set();      // ids of notes this visitor left, for the "(yours)" tag
const hearts = new Map();    // note id -> heart count, as last seen
const items = new Map();     // note id -> its <li>, so updates don't rebuild the list

const serverNow = () => Date.now() + offset;

/* ---------- small storage helpers (browser storage can be blocked) ---------- */

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked; fine */ }
}

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

// Time left while open: "4:59:59" with hours to go, "09:59" in the last hour.
function timeLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 3600 ? hms(ms) : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/* ---------- talking to the server ---------- */

async function fetchStatus() {
  if (PREVIEW) {
    if (status) return status;
    const now = Date.now();
    return {
      open: true,
      opensAt: now - 45_000,
      closesAt: now + 4 * 3_600_000 + 12 * 60_000 + 15_000,
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

  if (next === "closed") {
    clearInterval(pollTimer);
    pollTimer = null;
    $("aftermath").hidden = prev !== "open";
    $("yours").textContent = yourTime(status.opensAt);
    document.title = "The 10pm Room (closed)";
  }

  if (next === "open" && prev !== "open") {
    document.title = "The 10pm Room is open";
    updateForm();
    updateBed();
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }

  tick();
}

function poll() {
  loadNotes();
  loadGoodnights();
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
    $("left").textContent = timeLeft(ms);
    $("left").classList.toggle("long", ms > 3_600_000); // more digits, so a smaller size
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
      .select("id, body, created_at, night, hearts")
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

  // forget notes that have dropped off the wall
  const shown = new Set(rows.map((r) => r.id));
  for (const id of items.keys()) {
    if (!shown.has(id)) { items.get(id).remove(); items.delete(id); }
  }
}

// Puts the rows into the list in order, reusing existing items so a button
// someone is about to press doesn't vanish and reappear under them.
function fillList(list, rows) {
  rows.forEach((r, i) => {
    hearts.set(r.id, r.hearts ?? 0);
    const li = items.get(r.id) ?? makeItem(r);
    li.classList.toggle("mine", mine.has(r.id));
    updateHeart(r.id);
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null);
  });
  while (list.children.length > rows.length) list.lastElementChild.remove();
}

function makeItem(r) {
  const li = document.createElement("li");

  const body = document.createElement("p");
  body.className = "body";
  body.textContent = r.body; // textContent, never innerHTML: notes are written by strangers

  const meta = document.createElement("div");
  meta.className = "meta";

  const time = document.createElement("time");
  time.dateTime = r.created_at;
  time.textContent = londonClock.format(new Date(r.created_at));

  const heart = document.createElement("button");
  heart.type = "button";
  heart.className = "heart";
  heart.addEventListener("click", () => toggleHeart(r.id));

  meta.append(time, heart);
  li.append(body, meta);
  items.set(r.id, li);
  return li;
}

/* ---------- hearts ---------- */

// Which notes this browser has hearted. One heart per note, kept on trust.
const HEARTED_KEY = "ten-pm:hearted";
const hearted = new Set(load(HEARTED_KEY, []));

function updateHeart(id) {
  const button = items.get(id)?.querySelector(".heart");
  if (!button) return;
  const on = hearted.has(id);
  const count = hearts.get(id) ?? 0;
  button.textContent = `${on ? "♥" : "♡"}${count > 0 ? ` ${count}` : ""}`;
  button.setAttribute("aria-pressed", String(on));
  button.setAttribute("aria-label", `${on ? "Remove your heart" : "Heart this note"} (${count} ${count === 1 ? "heart" : "hearts"})`);
}

function rememberHearted(id, on) {
  if (on) hearted.add(id); else hearted.delete(id);
  save(HEARTED_KEY, [...hearted].slice(-2000));
}

async function toggleHeart(id) {
  const on = !hearted.has(id);
  const before = hearts.get(id) ?? 0;

  // Show it straight away, then confirm with the server.
  rememberHearted(id, on);
  hearts.set(id, Math.max(0, before + (on ? 1 : -1)));
  updateHeart(id);

  if (PREVIEW) {
    const note = previewNotes.find((n) => n.id === id);
    if (note) note.hearts = hearts.get(id);
    return;
  }

  const { data, error } = await db.rpc("heart_note", { note_id: id, hearted: on });
  if (error) {
    console.error(error);
    rememberHearted(id, !on);
    hearts.set(id, before);
    updateHeart(id);
    showToast(error.code === "42501" ? "The room has closed, so that heart wasn't saved." : "That heart didn't go through. Try again.");
    if (error.code === "42501") checkDoor();
    return;
  }
  hearts.set(id, data);
  updateHeart(id);
}

/* ---------- going to bed ---------- */

const bedKey = () => `ten-pm:bed:${status.night}`;
let seenGoodnights = null;   // highest goodnight id already shown, null until the first check
const previewGoodnights = [];

function saidGoodnight() {
  return load(bedKey(), null) !== null;
}

function updateBed() {
  const done = saidGoodnight();
  $("bed").hidden = done;
  $("bed-done").hidden = !done;
}

function showBedCount(n) {
  $("bed-count").textContent =
    n === 0 ? "" : n === 1 ? "1 person has gone to bed tonight." : `${n} people have gone to bed tonight.`;
}

async function loadGoodnights() {
  let ids;
  if (PREVIEW) {
    ids = previewGoodnights;
  } else {
    const { data, error } = await db.from("goodnights").select("id").order("id");
    if (error) { console.error(error); return; }
    ids = data.map((g) => g.id);
  }

  showBedCount(ids.length);

  // The first check only sets the starting point, so people arriving don't get
  // a pile of goodnights from earlier in the evening.
  const latest = ids.length ? ids[ids.length - 1] : 0;
  if (seenGoodnights === null) { seenGoodnights = latest; return; }

  const myId = load(bedKey(), null);
  const fresh = ids.filter((id) => id > seenGoodnights && id !== myId).length;
  seenGoodnights = Math.max(seenGoodnights, latest);

  if (fresh === 1) showToast("Someone's going to bed. Goodnight.");
  if (fresh > 1) showToast(`${fresh} people are going to bed. Goodnight.`);
}

$("bed").addEventListener("click", async () => {
  $("bed").disabled = true;

  let id;
  if (PREVIEW) {
    id = Date.now();
    previewGoodnights.push(id);
  } else {
    const { data, error } = await db.rpc("say_goodnight");
    if (error) {
      console.error(error);
      $("bed").disabled = false;
      showToast(error.code === "42501" ? "The room has already closed." : "That didn't go through. Try again.");
      if (error.code === "42501") checkDoor();
      return;
    }
    id = data;
  }

  save(bedKey(), id);
  $("bed").disabled = false;
  updateBed();
  showToast("Goodnight. Everyone here will see you've gone to bed.");
  loadGoodnights();
});

/* ---------- notifications ---------- */

let toastTimer = null;

function showToast(text) {
  const toast = $("toast");
  toast.textContent = text;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add("shown"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("shown");
    setTimeout(() => { toast.hidden = true; }, 400);
  }, 6000);
}

/* ---------- leaving a note ---------- */

// One note per visitor per night. It's an honour system kept in this browser;
// the server's own limits are in supabase/schema.sql.
const postedKey = () => `ten-pm:posted:${status.night}`;

function updateForm() {
  const posted = load(postedKey(), null);
  if (posted) mine.add(posted);

  const done = posted !== null;
  $("form").hidden = done;
  if (done) setFormMessage("Your note is on the wall. Everyone gets one a night, so come back tomorrow.");
}

function setFormMessage(text) {
  $("formmsg").textContent = text;
}

function explain(error) {
  switch (error.code) {
    case "42501": return "The room closed before your note got through, so it wasn't saved.";
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
    previewNotes.unshift({ id, body, created_at: new Date().toISOString(), night: status.night, hearts: 0 });
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
  save(postedKey(), id ?? 0);
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
  // Made-up times just after 10pm UK time, so preview looks like the real thing.
  const ukHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hourCycle: "h23" });
  const tenPm = (date, min) => {
    const asUtc = Date.parse(`${date}T22:${pad(min)}:00Z`);
    const shift = Number(ukHour.format(asUtc)) - 22; // 0 in winter, 1 in summer
    return new Date(asUtc - shift * 3_600_000).toISOString();
  };
  const at = (min) => tenPm(today, min);
  const lastNight = (min) => tenPm(yesterday, min);
  return [
    { id: 1, night: today, created_at: at(1), hearts: 0, body: "first time making it in. the countdown was more stressful than my mocks" },
    { id: 2, night: yesterday, created_at: lastNight(53), hearts: 4, body: "If you're reading this you should probably go to sleep. I won't, but you should." },
    { id: 3, night: yesterday, created_at: lastNight(41), hearts: 2, body: "the fox outside my window has been screaming for twenty minutes. is this normal" },
    { id: 4, night: yesterday, created_at: lastNight(29), hearts: 7, body: "night shift at the hospital, on my break. hello to whoever's next" },
    { id: 5, night: yesterday, created_at: lastNight(14), hearts: 0, body: "set an alarm specifically for this. worth it? jury's out" },
    { id: 6, night: yesterday, created_at: lastNight(2), hearts: 1, body: "in Sydney, it's 9am here. having my breakfast with you lot" },
  ];
}

/* ---------- start ---------- */

if (PREVIEW) {
  showNotice("Preview. The room isn't really open, and nothing you do here is saved. Remove ?preview from the address to see the real thing.");
  checkDoor();
  // Pretend someone else heads to bed a few seconds in, so the notification can be seen.
  setTimeout(() => { previewGoodnights.push(1); loadGoodnights(); }, 6000);
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
