// =============================================================================
// index.js — the main file. This is what runs when you type `npm start`.
//
// It does three jobs:
//   1. Logs the bot into Discord.
//   2. Handles the /tiktok slash commands people type in Discord.
//   3. Runs a loop forever that checks TikTok and posts alerts.
//
// The other files are helpers:
//   - tiktok.js → asks TikTok "is this person live?"
//   - store.js  → saves/loads the bot's data to a file so it survives restarts
// =============================================================================

// `dotenv/config` reads the `.env` file and puts each line into `process.env`.
// So `DISCORD_TOKEN=abc` in .env becomes `process.env.DISCORD_TOKEN === 'abc'`.
// This keeps secrets (like the bot token) out of the code itself.
import 'dotenv/config';

// discord.js is the library that talks to Discord for us. We only import the
// pieces we actually use:
import {
  ChannelType, // names for channel kinds (text, announcement, voice...)
  Client, // the bot itself — connects to Discord and receives events
  EmbedBuilder, // builds those nice boxed "embed" messages
  Events, // names of events, e.g. Events.ClientReady instead of the string 'ready'
  GatewayIntentBits, // "intents" = which kinds of events we want Discord to send us
  InteractionContextType, // where a slash command can be used (servers, DMs...)
  MessageFlags, // special message options, e.g. Ephemeral (only you can see it)
  PermissionFlagsBits, // names for Discord permissions (Send Messages, Manage Server...)
  SlashCommandBuilder, // builds the definition of a slash command
} from 'discord.js';

// Our own helper files. `* as store` means "import everything from store.js and
// put it under the name `store`", so we call store.load(), store.listSubs(), etc.
import * as store from './store.js';
import { getLiveStatus, normalizeUsername } from './tiktok.js';

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

// The bot token is like the bot's password. Without it we can't log in, so we
// stop right away with a helpful message instead of crashing later.
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.');
  process.exit(1); // exit code 1 = "something went wrong"
}

// How often (in seconds) to check TikTok. `Number(...) || 90` means "use the
// value from .env, or 90 if it's missing/not a number". `Math.max(30, ...)`
// makes sure it's never below 30, so we don't hammer TikTok and get blocked.
const POLL_SECONDS = Math.max(30, Number(process.env.POLL_INTERVAL_SECONDS) || 90);

// TikTok sometimes gives a wrong "offline" answer for one check. So we only
// decide a stream has really ended after this many "offline" answers in a row.
const OFFLINE_CHECKS_BEFORE_END = 2;

// Colors in Discord embeds are written as hex numbers. 0xfe2c55 = TikTok's pink.
const TIKTOK_PINK = 0xfe2c55;

// The message used when the server doesn't set a custom one. The {words} in
// curly braces get swapped for real values by the `fill()` function below.
const DEFAULT_MESSAGE = '🔴 **{nickname}** is now live on TikTok! {url}';

// -----------------------------------------------------------------------------
// Slash command definition
//
// This describes what /tiktok looks like in Discord: its subcommands (add,
// remove, list, check) and the options each one takes. Discord shows this to
// users as the little form that pops up when you type /tiktok.
// -----------------------------------------------------------------------------

const command = new SlashCommandBuilder()
  .setName('tiktok') // the command is /tiktok
  .setDescription('TikTok live alerts')
  // Only members with "Manage Server" see/use this command by default.
  // Server admins can change this later in Server Settings → Integrations.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  // Only allow it inside servers (not in DMs), since alerts belong to a server.
  .setContexts(InteractionContextType.Guild)

  // /tiktok add username:<text> channel:<#channel> [ping:<@role>] [message:<text>]
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Post in a channel when a TikTok user goes live')
      .addStringOption((o) =>
        o.setName('username').setDescription('TikTok username or profile link').setRequired(true),
      )
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Where to post the alert')
          // Only let people pick channels we can actually post text in.
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      // Options without .setRequired(true) are optional.
      .addRoleOption((o) => o.setName('ping').setDescription('Role to ping (optional)'))
      .addStringOption((o) =>
        o
          .setName('message')
          .setDescription('Custom text. Placeholders: {user} {nickname} {title} {url}')
          .setMaxLength(500),
      ),
  )

  // /tiktok remove username:<text>
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Stop alerts for a TikTok user')
      .addStringOption((o) =>
        // setAutocomplete(true) = Discord asks us for suggestions while the user
        // types. We answer in the "autocomplete" part of the InteractionCreate handler.
        o.setName('username').setDescription('TikTok username').setRequired(true).setAutocomplete(true),
      ),
  )

  // /tiktok list
  .addSubcommand((s) => s.setName('list').setDescription('Show the TikTok users this server follows'))

  // /tiktok check username:<text>
  .addSubcommand((s) =>
    s
      .setName('check')
      .setDescription('Check right now whether a TikTok user is live')
      .addStringOption((o) =>
        o.setName('username').setDescription('TikTok username or profile link').setRequired(true),
      ),
  );

// -----------------------------------------------------------------------------
// The Discord client (the bot)
// -----------------------------------------------------------------------------

// Intents tell Discord which events to send us. We only need `Guilds`
// (servers/channels info) because slash commands arrive regardless. We don't
// need to read people's messages, so we don't ask for that — less permissions
// needed, and no "privileged intents" to turn on in the developer portal.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// `client.once(event, fn)` = run fn the first time this event happens.
// ClientReady fires once the bot has finished logging in.
client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  // Tell Discord about our /tiktok command ("registering" it). We do this on
  // every startup so any changes to the command definition get picked up.
  try {
    if (process.env.GUILD_ID) {
      // Registering in ONE server shows up instantly — great for testing.
      await c.application.commands.set([command.toJSON()], process.env.GUILD_ID);
      console.log(`Registered /tiktok in guild ${process.env.GUILD_ID}`);
    } else {
      // Registering globally works in every server, but can take a bit to appear.
      await c.application.commands.set([command.toJSON()]);
      console.log('Registered /tiktok globally');
    }
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }

  console.log(`Checking TikTok every ${POLL_SECONDS}s`);
  // Start the forever-loop that checks TikTok. Note: no `await` here — we
  // start it and let it run in the background.
  pollLoop();
});

// If the bot gets kicked from a server, forget that server's subscriptions.
// ("Guild" is Discord's internal word for "server".)
client.on(Events.GuildDelete, (guild) => store.removeGuild(guild.id));

// InteractionCreate fires whenever someone uses a slash command, clicks a
// button, or (here) types into an autocomplete option.
client.on(Events.InteractionCreate, async (interaction) => {
  // --- Autocomplete: suggest usernames while someone types /tiktok remove ---
  if (interaction.isAutocomplete() && interaction.commandName === 'tiktok') {
    const typed = interaction.options.getFocused().toLowerCase(); // what they've typed so far
    const choices = store
      .listSubs(interaction.guildId) // everyone this server follows
      .map((s) => s.username) // just the names
      .filter((u) => u.includes(typed)) // only ones matching what was typed
      .slice(0, 25) // Discord allows max 25 suggestions
      .map((u) => ({ name: `@${u}`, value: u })); // name = shown, value = sent to us
    // `.catch(() => {})` = ignore errors (e.g. if the user already moved on).
    return interaction.respond(choices).catch(() => {});
  }

  // Ignore anything that isn't our /tiktok slash command.
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'tiktok') return;

  // Run the command. If anything throws an error, tell the user instead of
  // leaving them staring at "The application did not respond".
  try {
    await handleCommand(interaction);
  } catch (err) {
    console.error('Command error:', err);
    const reply = { content: `Something went wrong: ${err.message}`, flags: MessageFlags.Ephemeral };
    // If we already replied/deferred we must *edit* the reply; otherwise send a new one.
    if (interaction.deferred || interaction.replied) await interaction.editReply(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

// -----------------------------------------------------------------------------
// Slash command handler — what happens for each /tiktok subcommand
// -----------------------------------------------------------------------------

async function handleCommand(interaction) {
  const sub = interaction.options.getSubcommand(); // 'add', 'remove', 'list' or 'check'

  // "Ephemeral" replies are only visible to the person who ran the command.
  // We reuse this object with `...ephemeral` (the "spread" syntax copies its
  // properties into another object).
  const ephemeral = { flags: MessageFlags.Ephemeral };

  // ---------- /tiktok list ----------
  if (sub === 'list') {
    const subs = store.listSubs(interaction.guildId);
    if (!subs.length) {
      return interaction.reply({ content: 'No TikTok users yet. Add one with `/tiktok add`.', ...ephemeral });
    }
    // Build one line of text per followed user.
    // <#id> shows as a clickable channel, <@&id> shows as a role mention.
    const lines = subs.map((s) => {
      const live = store.getLive(s.username)?.live ? ' 🔴 live' : '';
      const ping = s.roleId ? ` (pings <@&${s.roleId}>)` : '';
      return `• [@${s.username}](https://www.tiktok.com/@${s.username}) → <#${s.channelId}>${ping}${live}`;
    });
    // allowedMentions: { parse: [] } = don't actually ping anyone with this list.
    return interaction.reply({ content: lines.join('\n'), allowedMentions: { parse: [] }, ...ephemeral });
  }

  // Every other subcommand has a username option, so read & clean it up once here.
  const raw = interaction.options.getString('username', true);
  const username = normalizeUsername(raw); // e.g. "@Bob" or a link → "bob"
  if (!username) {
    return interaction.reply({ content: `\`${raw}\` doesn't look like a TikTok username.`, ...ephemeral });
  }

  // ---------- /tiktok remove ----------
  if (sub === 'remove') {
    const removed = store.removeSub(interaction.guildId, username);
    return interaction.reply({
      // `condition ? a : b` is a short if/else: if removed, use a, otherwise b.
      content: removed ? `Stopped alerts for **@${username}**.` : `This server wasn't following **@${username}**.`,
      ...ephemeral,
    });
  }

  // ---------- /tiktok check ----------
  if (sub === 'check') {
    // Discord requires a reply within 3 seconds. Asking TikTok can take longer,
    // so we "defer" — this shows "Bot is thinking..." and gives us 15 minutes.
    await interaction.deferReply(ephemeral);
    const info = await getLiveStatus(username);
    return interaction.editReply(
      info.live
        ? { content: `🔴 **@${username}** is live right now.`, embeds: [liveEmbed(info)] }
        : { content: `⚫ **@${username}** is not live right now.` },
    );
  }

  // ---------- /tiktok add ----------
  if (sub === 'add') {
    const channel = interaction.options.getChannel('channel', true);
    const role = interaction.options.getRole('ping'); // null if not given
    const message = interaction.options.getString('message') || DEFAULT_MESSAGE;

    // Make sure the bot can actually post in that channel *before* saving,
    // otherwise alerts would silently fail later.
    const me = interaction.guild.members.me; // the bot's own member in this server
    const perms = channel.permissionsFor(me);
    const needed = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ];
    // `perms?.has(...)` — the `?.` means "if perms is null, don't crash, just give undefined".
    if (!perms?.has(needed)) {
      return interaction.reply({
        content: `I need **View Channel**, **Send Messages** and **Embed Links** in ${channel}.`,
        ...ephemeral,
      });
    }

    await interaction.deferReply(ephemeral); // we're about to call TikTok, which can be slow

    // Do a quick check now so we can tell the user something useful. If TikTok
    // can't be reached we still save the subscription and just warn them.
    let note = '';
    try {
      const info = await getLiveStatus(username);
      note = info.live ? ' They are live right now, so an alert will go out on the next check.' : '';
    } catch (err) {
      note = `\n⚠️ I couldn't reach TikTok to verify this user just now (${err.message}). I'll keep trying.`;
    }

    // Save it. upsertSub = "update if it exists, insert if it doesn't".
    const isNew = store.upsertSub({
      guildId: interaction.guildId,
      channelId: channel.id,
      username,
      roleId: role?.id ?? null, // `??` = "use the right side if the left is null/undefined"
      message,
    });
    return interaction.editReply(
      `${isNew ? 'Added' : 'Updated'} **@${username}** → ${channel}${role ? `, pinging ${role}` : ''}.${note}`,
    );
  }
}

// -----------------------------------------------------------------------------
// Building the alert messages
// -----------------------------------------------------------------------------

// Replaces the {placeholders} in a message template with real values.
// Example: "{nickname} is live!" → "Bob is live!"
function fill(template, info) {
  return template
    .replaceAll('{user}', `@${info.username}`)
    .replaceAll('{nickname}', info.nickname)
    .replaceAll('{title}', info.title || 'LIVE')
    .replaceAll('{url}', info.url);
}

// Builds the pink "X is live!" embed (the box with title, image, etc).
function liveEmbed(info) {
  const e = new EmbedBuilder()
    .setColor(TIKTOK_PINK)
    // The little line at the top with the creator's avatar and name.
    // `|| undefined` because Discord rejects null for iconURL but accepts "not set".
    .setAuthor({ name: `${info.nickname} (@${info.username})`, url: info.url, iconURL: info.avatar || undefined })
    .setTitle(info.title || `${info.nickname} is live!`)
    .setURL(info.url) // makes the title a clickable link
    .setFooter({ text: 'TikTok LIVE' })
    .setTimestamp(); // shows "Today at 5:32 PM" in each viewer's own timezone

  // Only add things TikTok actually gave us (`!= null` catches null AND undefined).
  if (info.viewers != null) e.addFields({ name: 'Viewers', value: String(info.viewers), inline: true });
  if (info.cover) e.setImage(info.cover); // big stream cover image
  else if (info.avatar) e.setThumbnail(info.avatar); // or a small avatar if no cover
  return e;
}

// Builds the grey "Stream ended" embed that replaces the live one afterwards.
function endedEmbed(info, startedAt) {
  // Date.now() is milliseconds, so divide by 60000 to get minutes.
  const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
  // Show "1h 12m" for long streams, "45m" for short ones. `%` is "remainder".
  const length = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  return new EmbedBuilder()
    .setColor(0x555555) // grey
    .setAuthor({ name: `${info.nickname} (@${info.username})`, url: `https://www.tiktok.com/@${info.username}` })
    .setTitle('Stream ended')
    .setDescription(`Was live for about ${length}.`)
    .setFooter({ text: 'TikTok LIVE' })
    .setTimestamp();
}

// -----------------------------------------------------------------------------
// Posting & editing alerts in Discord
// -----------------------------------------------------------------------------

// Sends the "X is live" message for one subscription (one server/channel).
// Returns where we posted it, so we can edit it later when the stream ends.
async function announce(sub, info) {
  // Look the channel up by ID. If it was deleted, fetch fails → we get null.
  const channel = await client.channels.fetch(sub.channelId).catch(() => null);
  if (!channel?.isTextBased()) {
    console.warn(`Channel ${sub.channelId} for @${sub.username} is gone or not a text channel`);
    return null;
  }

  // Put the role ping (if any) in front of the message text.
  const content = (sub.roleId ? `<@&${sub.roleId}> ` : '') + fill(sub.message, info);

  const msg = await channel.send({
    content,
    embeds: [liveEmbed(info)],
    // allowedMentions controls who actually gets pinged. We allow ONLY the
    // chosen role (plus @everyone/@here if the admin typed it in their custom
    // message). This stops random mentions from pinging people by accident.
    allowedMentions: { roles: sub.roleId ? [sub.roleId] : [], parse: ['everyone'] },
  });

  // In announcement channels, "publish" the message so servers that follow
  // this channel get it too. Ignore errors (e.g. missing permission).
  if (channel.type === ChannelType.GuildAnnouncement) await msg.crosspost().catch(() => {});

  return { guildId: sub.guildId, channelId: channel.id, messageId: msg.id };
}

// When a stream ends, go back and edit every alert we posted for it.
async function markEnded(state, info) {
  for (const p of state.posts) {
    try {
      const channel = await client.channels.fetch(p.channelId);
      const msg = await channel.messages.fetch(p.messageId);
      // Swap the pink embed for the grey "ended" one. The text/ping stays the same.
      await msg.edit({ embeds: [endedEmbed(info, state.startedAt)] });
    } catch {
      // The message was deleted or we lost access — nothing to do, that's fine.
    }
  }
}

// -----------------------------------------------------------------------------
// The core logic: check one TikTok user and decide what to do
//
// We remember (in store.js) the last stream we announced for each user:
//   { roomId, live, misses, startedAt, nickname, posts: [...] }
// TikTok gives every live stream a unique "roomId". Comparing roomIds is how
// we know whether this is the SAME stream we already announced or a NEW one.
// -----------------------------------------------------------------------------

async function checkUser(username) {
  const info = await getLiveStatus(username); // what TikTok says right now
  const state = store.getLive(username); // what we remembered from last time
  const subs = store.subsFor(username); // every server/channel following this user

  if (info.live) {
    // --- They are LIVE ---
    const sameStream = state?.roomId && state.roomId === info.roomId;

    // If it's the same stream, keep our old record (including which servers we
    // already posted in). If it's a new stream, start a fresh record.
    const base = sameStream
      ? { ...state, live: true, misses: 0 }
      : { roomId: info.roomId, live: true, misses: 0, startedAt: Date.now(), nickname: info.nickname, posts: [] };

    // Post only in servers that haven't been told about this stream yet.
    // (This also covers a server that ran /tiktok add mid-stream.)
    // A Set is like an array, but fast at answering "is X in here?".
    const alreadyPosted = new Set(base.posts.map((p) => p.guildId));
    const pending = subs.filter((s) => !alreadyPosted.has(s.guildId));

    for (const sub of pending) {
      try {
        const post = await announce(sub, info);
        if (post) base.posts.push(post); // remember it so we can edit it later
        console.log(`Announced @${username} live in guild ${sub.guildId}`);
      } catch (err) {
        // One broken channel shouldn't stop the other servers getting alerts.
        console.error(`Failed to announce @${username} in ${sub.channelId}:`, err.message);
      }
    }

    // Only write to disk if something actually changed (saves pointless writes).
    if (!sameStream || pending.length || !state.live || state.misses) store.setLive(username, base);
    return;
  }

  // --- They are NOT live, but we thought they were ---
  if (state?.live) {
    const misses = (state.misses ?? 0) + 1;

    // Not enough "offline" answers in a row yet — could be a TikTok hiccup.
    // Just count it and wait for the next check.
    if (misses < OFFLINE_CHECKS_BEFORE_END) {
      store.setLive(username, { ...state, misses });
      return;
    }

    // OK, they've really gone offline. Edit the alerts to say "Stream ended".
    console.log(`@${username} went offline`);
    await markEnded(state, { ...info, nickname: state.nickname || info.nickname });

    // Keep the roomId so a brief blip with the same room doesn't re-announce.
    store.setLive(username, { ...state, live: false, misses: 0 });
  }
  // (If they're not live and weren't live before, there's nothing to do.)
}

// -----------------------------------------------------------------------------
// The forever loop
// -----------------------------------------------------------------------------

// A tiny helper: `await sleep(1000)` pauses for 1 second.
// It wraps setTimeout in a Promise so we can use it with `await`.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollLoop() {
  // `for (;;)` is a loop with no end condition — it runs forever.
  for (;;) {
    const started = Date.now();

    // Check each followed TikTok user once. allUsernames() removes duplicates,
    // so if 5 servers follow the same person we still only ask TikTok once.
    for (const username of store.allUsernames()) {
      try {
        await checkUser(username);
      } catch (err) {
        // TikTok errors are expected sometimes. Log and move on to the next user.
        console.warn(err.message);
      }
      await sleep(1500); // small gap between users so TikTok doesn't think we're spamming
    }

    // Wait until it's time for the next round. We subtract how long this round
    // took, so rounds start roughly every POLL_SECONDS (but wait at least 5s).
    await sleep(Math.max(5000, POLL_SECONDS * 1000 - (Date.now() - started)));
  }
}

// -----------------------------------------------------------------------------
// Start everything!
// -----------------------------------------------------------------------------

store.load(); // read saved subscriptions from data/store.json
client.login(TOKEN); // connect to Discord → triggers ClientReady above when done
