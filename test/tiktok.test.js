import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsername, parseRoomApi, parseLivePage } from '../src/tiktok.js';

test('normalizeUsername', () => {
  assert.equal(normalizeUsername('@Some.User_1'), 'some.user_1');
  assert.equal(normalizeUsername('https://www.tiktok.com/@cool.guy/live?lang=en'), 'cool.guy');
  assert.equal(normalizeUsername('not a name!'), null);
  assert.equal(normalizeUsername(''), null);
});

test('parseRoomApi: live', () => {
  const info = parseRoomApi('bob', {
    statusCode: 0,
    data: {
      user: { roomId: '7300000000000000001', nickname: 'Bob', avatarThumb: 'https://a/av.jpg', status: 2 },
      liveRoom: { title: 'Chatting', status: 2, coverUrl: 'https://a/c.jpg', liveRoomStats: { userCount: 42 } },
    },
  });
  assert.equal(info.live, true);
  assert.equal(info.roomId, '7300000000000000001');
  assert.equal(info.title, 'Chatting');
  assert.equal(info.viewers, 42);
  assert.equal(info.cover, 'https://a/c.jpg');
  assert.equal(info.url, 'https://www.tiktok.com/@bob/live');
});

test('parseRoomApi: offline', () => {
  const info = parseRoomApi('bob', {
    statusCode: 0,
    data: { user: { roomId: '', nickname: 'Bob', status: 4 }, liveRoom: { status: 4 } },
  });
  assert.equal(info.live, false);
});

test('parseRoomApi: error code throws', () => {
  assert.throws(() => parseRoomApi('bob', { statusCode: 19881007, message: 'user_not_found' }));
});

test('parseLivePage: SIGI_STATE', () => {
  const state = {
    LiveRoom: {
      liveRoomUserInfo: {
        user: { roomId: '123', nickname: 'Al', status: 2 },
        liveRoom: { title: 'hi', status: 2, coverUrl: 'https://c' },
      },
    },
  };
  const html = `<html><script id="SIGI_STATE" type="application/json">${JSON.stringify(state)}</script></html>`;
  const info = parseLivePage('al', html);
  assert.equal(info.live, true);
  assert.equal(info.roomId, '123');
});

test('parseLivePage: universal data', () => {
  const data = {
    __DEFAULT_SCOPE__: {
      'webapp.live-room': { liveRoomUserInfo: { user: { roomId: '9', status: 4 }, liveRoom: { status: 4 } } },
    },
  };
  const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script>`;
  assert.equal(parseLivePage('x', html).live, false);
});

test('parseLivePage: regex fallback leaves status for check_alive', () => {
  const info = parseLivePage('x', '<div>"roomId":"555"</div>');
  assert.equal(info.roomId, '555');
  assert.equal(info.status, undefined);
});
