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

## How live detection works (and its limits)

TikTok has **no official API** for live status, so the bot uses the endpoints the
tiktok.com website uses:

1. `tiktok.com/api-live/user/room/` (fast JSON).
2. Fallback: scrape `tiktok.com/@user/live` and confirm with webcast's `check_alive`.

By default the bot checks every 90 seconds (`POLL_INTERVAL_SECONDS`, minimum 30).
If TikTok starts blocking your server's IP (`/tiktok check` fails), log into TikTok
in a browser, copy the value of the `sessionid` cookie, and put it in
`TIKTOK_SESSIONID`. Use a throwaway account for this. Because these are unofficial
endpoints, TikTok can change them at any time. If that happens, the code to update
is in `src/tiktok.js`.

## Tests

```bash
npm test
```
