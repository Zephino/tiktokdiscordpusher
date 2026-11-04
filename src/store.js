// =============================================================================
// store.js — saves the bot's data to a JSON file so it isn't lost on restart.
//
// A real database would be overkill for a small bot, so we keep everything in
// one object in memory (`state`) and write it to data/store.json whenever it
// changes. On startup, load() reads it back.
//
// The data looks like this:
// {
//   "subs": [                      ← who to watch, and where to post
//     { "guildId": "...", "channelId": "...", "username": "bob",
//       "roleId": "..." or null, "message": "🔴 {nickname} is live! {url}" }
//   ],
//   "live": {                      ← the last stream we announced per user
//     "bob": { "roomId": "...", "live": true, "misses": 0, "startedAt": 1730000000000,
//              "nickname": "Bob", "posts": [{ "guildId", "channelId", "messageId" }] }
//   }
// }
// =============================================================================

// Built-in Node.js modules (no install needed):
import fs from 'node:fs'; // fs = "file system": read/write files
import path from 'node:path'; // helps build file paths that work on Windows, Mac and Linux

// Where to save. You can override it with DATA_FILE in .env; otherwise it's
// data/store.json inside the folder you started the bot from.
const FILE = process.env.DATA_FILE || path.resolve('data', 'store.json');

// The in-memory copy of everything. `let` (not `const`) because load() replaces it.
let state = { subs: [], live: {} };

// Read the file into `state`. Called once when the bot starts.
export function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // `?? []` guards against an old/partial file missing a section.
    state = { subs: parsed.subs ?? [], live: parsed.live ?? {} };
  } catch (err) {
    // ENOENT = "file not found". That's normal on the very first run, so stay quiet.
    // Any other error (e.g. a corrupted file) is worth printing.
    if (err.code !== 'ENOENT') console.error(`Could not read ${FILE}:`, err.message);
  }
}

// Write `state` to disk.
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true }); // make the data/ folder if missing
  // Write to a temporary file first, then rename it over the real one.
  // Renaming is instant, so if the bot crashes mid-write the real file is never
  // left half-written/corrupted. This is a common trick for safe saving.
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); // `null, 2` = pretty-print with 2-space indents
  fs.renameSync(tmp, FILE);
}

// -----------------------------------------------------------------------------
// Subscriptions: "server X wants alerts for TikTok user Y in channel Z"
// (`export` makes a function usable from other files, like index.js.)
// -----------------------------------------------------------------------------

// All subscriptions for one Discord server.
export function listSubs(guildId) {
  return state.subs.filter((s) => s.guildId === guildId);
}

// Every TikTok username anyone follows, with duplicates removed.
// `new Set(...)` drops duplicates; `[...set]` turns it back into an array.
export function allUsernames() {
  return [...new Set(state.subs.map((s) => s.username))];
}

// Every subscription (across all servers) for one TikTok user.
export function subsFor(username) {
  return state.subs.filter((s) => s.username === username);
}

// Add a subscription, or replace it if this server already follows that user.
// Returns true if it was new, false if it was an update.
export function upsertSub(sub) {
  // findIndex returns the position in the array, or -1 if not found.
  const i = state.subs.findIndex((s) => s.guildId === sub.guildId && s.username === sub.username);
  if (i >= 0) state.subs[i] = sub; // found → replace
  else state.subs.push(sub); // not found → add to the end
  save();
  return i < 0;
}

// Remove one server's subscription to a user. Returns true if something was removed.
export function removeSub(guildId, username) {
  const before = state.subs.length;
  // Keep everything EXCEPT the one matching this server + username.
  state.subs = state.subs.filter((s) => !(s.guildId === guildId && s.username === username));
  // If no server follows this user any more, forget their live state too.
  if (!state.subs.some((s) => s.username === username)) delete state.live[username];
  save();
  return state.subs.length !== before; // the list got shorter → we removed one
}

// Remove all subscriptions for a server (used when the bot is kicked).
export function removeGuild(guildId) {
  state.subs = state.subs.filter((s) => s.guildId !== guildId);
  save();
}

// -----------------------------------------------------------------------------
// Live state: which stream we last announced, so we never double-post
// -----------------------------------------------------------------------------

// Get what we remember about a user's stream, or null if nothing.
export function getLive(username) {
  return state.live[username] ?? null;
}

// Save (or, if value is null, delete) what we remember about a user's stream.
export function setLive(username, value) {
  if (value) state.live[username] = value;
  else delete state.live[username];
  save();
}
