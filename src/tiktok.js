// Checks whether a TikTok user is live.
//
// TikTok has no official public API for live status, so this uses the same
// endpoints the tiktok.com website uses. Method 1 is a small JSON endpoint;
// method 2 scrapes the user's /live page and confirms with webcast's
// check_alive endpoint. If TikTok changes one, the other often still works.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const TIMEOUT_MS = 15_000;

// TikTok live room status codes: 2 = live, 4 = ended/offline.
const STATUS_LIVE = 2;

export function normalizeUsername(input) {
  let name = String(input ?? '').trim();
  const fromUrl = name.match(/tiktok\.com\/@([^/?#\s]+)/i);
  if (fromUrl) name = fromUrl[1];
  name = name.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,24}$/.test(name)) return null;
  return name;
}

function headers() {
  const h = {
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.tiktok.com/',
  };
  if (process.env.TIKTOK_SESSIONID) {
    h.Cookie = `sessionid=${process.env.TIKTOK_SESSIONID}`;
  }
  return h;
}

async function get(url, as = 'json') {
  const res = await fetch(url, {
    headers: headers(),
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const text = await res.text();
  if (as !== 'json') return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${new URL(url).host}`);
  }
}

function firstUrl(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v.url_list) && v.url_list[0]) return v.url_list[0];
  return null;
}

function build(username, user = {}, room = {}, live) {
  return {
    username,
    live,
    roomId: user.roomId || room.id_str || room.roomId || null,
    nickname: user.nickname || username,
    avatar: user.avatarLarger || user.avatarMedium || user.avatarThumb || null,
    title: room.title || null,
    cover: firstUrl(room.coverUrl) || firstUrl(room.cover) || null,
    viewers: room.liveRoomStats?.userCount ?? room.user_count ?? null,
    url: `https://www.tiktok.com/@${username}/live`,
  };
}

// Parses the JSON from /api-live/user/room/. Exported for tests.
export function parseRoomApi(username, json) {
  if (!json || json.statusCode !== 0 || !json.data) {
    throw new Error(`api-live returned statusCode ${json?.statusCode} ${json?.message ?? ''}`.trim());
  }
  const user = json.data.user ?? {};
  const room = json.data.liveRoom ?? {};
  const status = room.status ?? user.status;
  const live = Boolean(user.roomId) && status === STATUS_LIVE;
  return build(username, user, room, live);
}

// Pulls user/room info out of the HTML of tiktok.com/@user/live. Exported for tests.
export function parseLivePage(username, html) {
  const scripts = ['SIGI_STATE', '__UNIVERSAL_DATA_FOR_REHYDRATION__'];
  for (const id of scripts) {
    const m = html.match(new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`));
    if (!m) continue;
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const info =
      data?.LiveRoom?.liveRoomUserInfo ??
      data?.__DEFAULT_SCOPE__?.['webapp.live-room']?.liveRoomUserInfo;
    if (info) {
      const user = info.user ?? {};
      const room = info.liveRoom ?? {};
      const status = room.status ?? user.status;
      return { ...build(username, user, room, status === STATUS_LIVE), status };
    }
  }
  // Last resort: regex the raw HTML.
  const roomId = html.match(/"roomId":"(\d+)"/)?.[1];
  if (!roomId) throw new Error('Could not find room info on live page');
  return { ...build(username, { roomId }, {}, false), status: undefined };
}

async function checkAlive(roomId) {
  const json = await get(
    `https://webcast.tiktok.com/webcast/room/check_alive/?aid=1988&region=CH&room_ids=${roomId}&user_is_login=false`,
  );
  const entry = Array.isArray(json?.data) ? json.data[0] : null;
  if (!entry) throw new Error('check_alive returned no data');
  return Boolean(entry.alive);
}

async function viaApi(username) {
  const url =
    'https://www.tiktok.com/api-live/user/room/?aid=1988&app_name=tiktok_web' +
    `&device_platform=web_pc&sourceType=54&uniqueId=${encodeURIComponent(username)}`;
  return parseRoomApi(username, await get(url));
}

async function viaPage(username) {
  const html = await get(`https://www.tiktok.com/@${encodeURIComponent(username)}/live`, 'text');
  const info = parseLivePage(username, html);
  if (info.roomId && info.status === undefined) {
    // We only have a room ID; ask webcast if that room is actually live.
    info.live = await checkAlive(info.roomId);
  }
  delete info.status;
  return info;
}

/**
 * Returns { username, live, roomId, nickname, avatar, title, cover, viewers, url }.
 * Throws if TikTok couldn't be reached by any method.
 */
export async function getLiveStatus(username) {
  const errors = [];
  for (const method of [viaApi, viaPage]) {
    try {
      return await method(username);
    } catch (err) {
      errors.push(`${method.name}: ${err.message}`);
    }
  }
  throw new Error(`Could not check @${username} — ${errors.join('; ')}`);
}
