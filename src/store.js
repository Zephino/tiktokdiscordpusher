// Tiny JSON-file store. Saves to data/store.json (override with DATA_FILE).
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.DATA_FILE || path.resolve('data', 'store.json');

let state = { subs: [], live: {} };

export function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = { subs: parsed.subs ?? [], live: parsed.live ?? {} };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not read ${FILE}:`, err.message);
  }
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}

// ---- subscriptions: which TikTok user posts to which Discord channel ----

export function listSubs(guildId) {
  return state.subs.filter((s) => s.guildId === guildId);
}

export function allUsernames() {
  return [...new Set(state.subs.map((s) => s.username))];
}

export function subsFor(username) {
  return state.subs.filter((s) => s.username === username);
}

export function upsertSub(sub) {
  const i = state.subs.findIndex((s) => s.guildId === sub.guildId && s.username === sub.username);
  if (i >= 0) state.subs[i] = sub;
  else state.subs.push(sub);
  save();
  return i < 0;
}

export function removeSub(guildId, username) {
  const before = state.subs.length;
  state.subs = state.subs.filter((s) => !(s.guildId === guildId && s.username === username));
  if (!state.subs.some((s) => s.username === username)) delete state.live[username];
  save();
  return state.subs.length !== before;
}

export function removeGuild(guildId) {
  state.subs = state.subs.filter((s) => s.guildId !== guildId);
  save();
}

// ---- live state: which stream we last announced, so we never double-post ----

export function getLive(username) {
  return state.live[username] ?? null;
}

export function setLive(username, value) {
  if (value) state.live[username] = value;
  else delete state.live[username];
  save();
}
