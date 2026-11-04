// =============================================================================
// tiktok.js — answers the question "is this TikTok user live right now?"
//
// TikTok has NO official public API for live status. So we pretend to be a web
// browser and ask the same URLs that tiktok.com itself uses behind the scenes.
// (You can find URLs like these by opening tiktok.com, pressing F12 → Network
// tab, and watching what the page loads.)
//
// We try two methods, so if TikTok changes or blocks one, the other might still work:
//   Method 1 (viaApi):  a small JSON URL that directly says live or not.
//   Method 2 (viaPage): download the user's /live web page and dig the info
//                       out of the HTML, then double-check with another URL.
// =============================================================================

// A "User-Agent" tells websites what browser you are. Node's default looks like
// a bot, which TikTok tends to block, so we copy what Chrome on Windows sends.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Give up on a request after 15 seconds (15_000 — the underscore is just a
// readability separator, like writing 15,000).
const TIMEOUT_MS = 15_000;

// TikTok marks a live room with a status number: 2 = live, 4 = ended/offline.
const STATUS_LIVE = 2;

// Turns whatever the user typed into a clean username, or null if invalid.
//   "@Bob.Smith"                           → "bob.smith"
//   "https://www.tiktok.com/@bob/live"     → "bob"
//   "not valid!!"                          → null
export function normalizeUsername(input) {
  // `String(input ?? '')` makes sure we have a string even if input is null.
  let name = String(input ?? '').trim();

  // If it's a link, pull out the part after "@". This is a regular expression
  // ("regex"): a pattern for matching text. ([^/?#\s]+) means "capture every
  // character until a / ? # or space".
  const fromUrl = name.match(/tiktok\.com\/@([^/?#\s]+)/i);
  if (fromUrl) name = fromUrl[1]; // [1] = the first captured part

  name = name.replace(/^@/, '').toLowerCase(); // remove a leading @, make lowercase

  // TikTok usernames: letters, numbers, dots, underscores, up to 24 characters.
  if (!/^[a-z0-9._]{1,24}$/.test(name)) return null;
  return name;
}

// The HTTP headers we send with every request (extra info about the request).
function headers() {
  const h = {
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.tiktok.com/', // "I came from tiktok.com" — looks more like a real browser
  };
  // Optional: if TikTok blocks anonymous requests, sending a logged-in
  // account's "sessionid" cookie makes us look like a logged-in user.
  if (process.env.TIKTOK_SESSIONID) {
    h.Cookie = `sessionid=${process.env.TIKTOK_SESSIONID}`;
  }
  return h;
}

// Downloads a URL. Returns parsed JSON by default, or raw text if as='text'.
// Throws an error if the request fails, so callers can try something else.
async function get(url, as = 'json') {
  // `fetch` is built into Node 18+. It downloads a URL.
  const res = await fetch(url, {
    headers: headers(),
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS), // cancel if it takes too long
  });
  // res.ok is true for success codes (200–299). 403 = blocked, 404 = not found, etc.
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);

  const text = await res.text();
  if (as !== 'json') return text;
  try {
    return JSON.parse(text); // turn the JSON text into a JavaScript object
  } catch {
    // TikTok sometimes returns an HTML "verify you're human" page instead of JSON.
    throw new Error(`Non-JSON response from ${new URL(url).host}`);
  }
}

// TikTok stores images in different shapes: sometimes a plain URL string,
// sometimes { url_list: ["https://...", ...] }. This handles both.
function firstUrl(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v.url_list) && v.url_list[0]) return v.url_list[0];
  return null;
}

// Takes TikTok's messy data and builds one simple, consistent object that the
// rest of the bot uses. Both methods end up here, so index.js never needs to
// know which method was used. `user = {}` means "default to an empty object".
function build(username, user = {}, room = {}, live) {
  return {
    username,
    live, // true / false
    roomId: user.roomId || room.id_str || room.roomId || null, // unique ID of this stream
    nickname: user.nickname || username, // display name, e.g. "Bob 🎮"
    avatar: user.avatarLarger || user.avatarMedium || user.avatarThumb || null,
    title: room.title || null, // stream title
    cover: firstUrl(room.coverUrl) || firstUrl(room.cover) || null, // stream thumbnail
    viewers: room.liveRoomStats?.userCount ?? room.user_count ?? null,
    url: `https://www.tiktok.com/@${username}/live`,
  };
}

// -----------------------------------------------------------------------------
// Parsers — turn TikTok's raw response into our simple object.
// These are separate from the downloading code (and exported) so the tests in
// test/tiktok.test.js can feed them fake data without needing the internet.
// -----------------------------------------------------------------------------

// Method 1's response looks roughly like:
// { statusCode: 0, data: { user: { roomId, nickname, ... }, liveRoom: { status, title, ... } } }
export function parseRoomApi(username, json) {
  // statusCode 0 means success. Anything else (e.g. "user not found") is an error.
  if (!json || json.statusCode !== 0 || !json.data) {
    throw new Error(`api-live returned statusCode ${json?.statusCode} ${json?.message ?? ''}`.trim());
  }
  const user = json.data.user ?? {};
  const room = json.data.liveRoom ?? {};
  const status = room.status ?? user.status;
  // Live = they have a room AND that room's status is "live".
  const live = Boolean(user.roomId) && status === STATUS_LIVE;
  return build(username, user, room, live);
}

// Method 2: the /live web page has a <script> tag containing a big blob of JSON
// with the page's data. We find that tag and read the room info from it.
export function parseLivePage(username, html) {
  // TikTok has used both of these script IDs at different times, so try both.
  const scripts = ['SIGI_STATE', '__UNIVERSAL_DATA_FOR_REHYDRATION__'];
  for (const id of scripts) {
    // Regex to grab everything between <script id="..."> and </script>.
    const m = html.match(new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`));
    if (!m) continue; // not on this page → try the next ID

    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue; // couldn't parse → try the next ID
    }

    // The info lives in a different place depending on which format it is.
    const info =
      data?.LiveRoom?.liveRoomUserInfo ??
      data?.__DEFAULT_SCOPE__?.['webapp.live-room']?.liveRoomUserInfo;
    if (info) {
      const user = info.user ?? {};
      const room = info.liveRoom ?? {};
      const status = room.status ?? user.status;
      // We also return `status` so viaPage knows whether it still needs to double-check.
      return { ...build(username, user, room, status === STATUS_LIVE), status };
    }
  }

  // Last resort: just search the raw HTML for "roomId":"12345".
  // We get the room ID but not whether it's live, so status stays undefined.
  const roomId = html.match(/"roomId":"(\d+)"/)?.[1];
  if (!roomId) throw new Error('Could not find room info on live page');
  return { ...build(username, { roomId }, {}, false), status: undefined };
}

// Asks TikTok's webcast server "is this room ID live?" → true / false.
async function checkAlive(roomId) {
  const json = await get(
    `https://webcast.tiktok.com/webcast/room/check_alive/?aid=1988&region=CH&room_ids=${roomId}&user_is_login=false`,
  );
  // Response looks like: { data: [ { alive: true, room_id: ... } ] }
  const entry = Array.isArray(json?.data) ? json.data[0] : null;
  if (!entry) throw new Error('check_alive returned no data');
  return Boolean(entry.alive);
}

// -----------------------------------------------------------------------------
// The two methods
// -----------------------------------------------------------------------------

// Method 1: the JSON endpoint. aid=1988 etc. are values tiktok.com itself sends.
// encodeURIComponent makes the username safe to put inside a URL.
async function viaApi(username) {
  const url =
    'https://www.tiktok.com/api-live/user/room/?aid=1988&app_name=tiktok_web' +
    `&device_platform=web_pc&sourceType=54&uniqueId=${encodeURIComponent(username)}`;
  return parseRoomApi(username, await get(url));
}

// Method 2: scrape the /live page.
async function viaPage(username) {
  const html = await get(`https://www.tiktok.com/@${encodeURIComponent(username)}/live`, 'text');
  const info = parseLivePage(username, html);
  if (info.roomId && info.status === undefined) {
    // We only found a room ID, not its status — ask webcast if it's actually live.
    info.live = await checkAlive(info.roomId);
  }
  delete info.status; // internal detail, the rest of the bot doesn't need it
  return info;
}

/**
 * The main function other files use.
 * Returns { username, live, roomId, nickname, avatar, title, cover, viewers, url }.
 * Throws an error if every method failed (e.g. TikTok is blocking us).
 */
export async function getLiveStatus(username) {
  const errors = [];
  // Try each method in order; return the first one that works.
  for (const method of [viaApi, viaPage]) {
    try {
      return await method(username);
    } catch (err) {
      // Remember why it failed (method.name is the function's name, e.g. "viaApi").
      errors.push(`${method.name}: ${err.message}`);
    }
  }
  // If we get here, everything failed. Include all the reasons to help debugging.
  throw new Error(`Could not check @${username} — ${errors.join('; ')}`);
}
