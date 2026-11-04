# TikTok → Discord Live Alerts

A Discord bot that posts in a channel when TikTok creators go live, and edits the
post to "Stream ended" when they stop.

- `/tiktok add username:<name> channel:<#channel> [ping:<@role>] [message:<text>]`
- `/tiktok remove username:<name>`
- `/tiktok list`
- `/tiktok check username:<name>` (checks right now, handy for testing)

These commands need the **Manage Server** permission. Each stream is announced once,
using TikTok's room ID, so a stream that flickers won't post twice.

Custom messages can use `{user}`, `{nickname}`, `{title}` and `{url}`.
Default: `🔴 **{nickname}** is now live on TikTok! {url}`

## How it works

The bot doesn't get notified when someone goes live, because TikTok doesn't offer
that. Instead it **asks TikTok on a timer** (every 90 seconds by default) and
compares the answer with what it remembers from the last check.

```
          every 90 seconds, for each TikTok user someone follows
                                  │
                                  ▼
                 ask TikTok: "is @bob live right now?"
                                  │
            ┌─────────────────────┴─────────────────────┐
            ▼                                           ▼
          LIVE                                      NOT LIVE
            │                                           │
  is this a stream we've                   did we think they were live?
  already announced?                                    │
  (compare the stream's room ID)            ┌───────────┴───────────┐
            │                               ▼                       ▼
    ┌───────┴───────┐                      yes                      no
    ▼               ▼                       │                       │
   yes              no           offline 2 checks in a row?    do nothing
    │               │                       │
 do nothing   post the alert     yes → edit the alerts to "Stream ended"
              in every server    no  → wait for the next check
              that follows them        (could just be a TikTok hiccup)
              and save the message IDs
```

Some details:

- **No double posts.** TikTok gives every live stream a unique **room ID**. The bot
  saves the room ID of each stream it announces, so the same stream is never
  announced twice, even if it briefly drops and comes back.
- **One check per creator.** If five servers follow the same creator, TikTok is
  still only asked once per round, and all five servers get the alert.
- **Joining mid-stream works.** If a server runs `/tiktok add` while the creator is
  already live, that server gets the alert on the next check.
- **Everything survives a restart.** Subscriptions and the last announced stream
  are saved to `data/store.json`.

### What each file does

| File | Job |
| --- | --- |
| `src/index.js` | The main bot: logs into Discord, handles `/tiktok` commands, runs the check loop, and posts and edits alerts. Start with `checkUser()`, where the bot decides whether to post. |
| `src/tiktok.js` | Asks TikTok whether someone is live. It has nothing to do with Discord, so it can be reused anywhere. |
| `src/store.js` | Saves and loads the bot's data in a JSON file. |
| `src/check.js` | A test tool: `npm run check -- <username>` checks TikTok without starting the bot. |
| `test/` | Automated tests for the TikTok parsing code (`npm test`). |

Every file is commented to explain what each part does and why.

## Setup

1. **Create the bot.** Go to https://discord.com/developers/applications, then
   **New Application** → **Bot** → **Reset Token**. Copy the token.
   No privileged intents are needed.
2. **Invite it.** Go to **OAuth2 → URL Generator**, tick `bot` and `applications.commands`,
   then tick **View Channels**, **Send Messages** and **Embed Links**. Open the generated URL.
3. **Run it** (Node.js 18.17 or newer):

   ```bash
   npm install
   cp .env.example .env   # then put your token in DISCORD_TOKEN
   npm start
   ```

   Global slash commands can take a little while to show up. To get them instantly
   while testing, set `GUILD_ID` in `.env` to your server's ID.

To check that TikTok is reachable without Discord: `npm run check -- <username>`

Subscriptions are saved in `data/store.json`. Keep that file if you move the bot.

## Hosting

The bot has to run 24/7 to catch streams. Any always-on machine works, for example
a VPS, a Raspberry Pi, or a host like Railway or Fly.io. Use a process manager such as
`pm2 start src/index.js --name tiktok-bot` so it restarts if it crashes.

## How the bot gets live info from TikTok

TikTok has **no official API** for live status. The bot doesn't log in or use an
official API. It sends the same requests your browser sends when you open
tiktok.com, then reads the answers. All of this is in `src/tiktok.js`, and it tries
two methods in order.

### Method 1: TikTok's own live-status URL (tried first)

When you open someone's profile, the tiktok.com page quietly asks this URL whether
they're live:

```
https://www.tiktok.com/api-live/user/room/?aid=1988&app_name=tiktok_web&device_platform=web_pc&sourceType=54&uniqueId=bob
```

The extra settings (`aid=1988` and the rest) are just copied from what the website
itself sends. TikTok answers with JSON, roughly like this:

```json
{
  "statusCode": 0,
  "data": {
    "user":     { "roomId": "7300000000000000001", "nickname": "Bob" },
    "liveRoom": { "status": 2, "title": "Chatting", "liveRoomStats": { "userCount": 42 } }
  }
}
```

The bot treats someone as **live** when they have a `roomId` **and** `status` is
`2`. Status `4` means the stream ended. The title, viewer count and cover image for
the Discord embed come from this same answer. If `statusCode` isn't `0` (for
example "user not found"), the bot moves on to method 2.

### Method 2: read the live page itself (backup)

If method 1 fails or gets blocked, the bot downloads the normal web page
`https://www.tiktok.com/@bob/live`. TikTok builds that page with a big block of
JSON hidden in it:

```html
<script id="SIGI_STATE" type="application/json">{ ...all the page's data... }</script>
```

(Newer versions of the page call it `__UNIVERSAL_DATA_FOR_REHYDRATION__`, so the
bot looks for both.) The bot cuts that block out with a regular expression and
reads the same `roomId` and `status` from inside it.

If the layout has changed and that doesn't work, it falls back again. It searches
the raw page text for `"roomId":"12345"`, then asks a third URL whether that room
is actually live:

```
https://webcast.tiktok.com/webcast/room/check_alive/?aid=1988&room_ids=12345
→ { "data": [ { "alive": true } ] }
```

### Looking like a browser

Websites often block requests that look like bots, so every request includes:

- a **User-Agent** copied from Chrome on Windows,
- a **Referer** of `tiktok.com`, so the request looks like it came from TikTok's own site,
- optionally a **`sessionid` cookie**, so it looks like a logged-in user (see below).

### Limits

- **These URLs aren't official.** They're just how tiktok.com happens to work
  today, and TikTok can rename them, move the data or block cloud servers whenever
  it likes. That's why there are backups, and why the bot logs an error instead of
  guessing when every method fails. The code to update is in `src/tiktok.js`.
- **Blocked servers.** If TikTok starts blocking your server (`/tiktok check`
  fails), log into TikTok in a browser, copy the value of the `sessionid` cookie,
  and put it in `TIKTOK_SESSIONID` in `.env`. Use a throwaway account for this.
- **Alerts can be a little late.** The bot checks every 90 seconds by default
  (`POLL_INTERVAL_SECONDS`, minimum 30), so an alert can arrive up to about a
  minute and a half after the stream starts.

### Finding these URLs yourself

Open a live creator's page on tiktok.com, press **F12**, go to the **Network** tab
and refresh the page. Type `room` or `live` into the filter, click a request and
open the **Response** tab. You'll see the same JSON the bot reads. If TikTok
changes something, this is how to find the new URL or field and update
`src/tiktok.js`. If you do, add a test to `test/tiktok.test.js` with the new format.

## Tests

```bash
npm test
```
