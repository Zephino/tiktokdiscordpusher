import 'dotenv/config';
import {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import * as store from './store.js';
import { getLiveStatus, normalizeUsername } from './tiktok.js';

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
const POLL_SECONDS = Math.max(30, Number(process.env.POLL_INTERVAL_SECONDS) || 90);
const OFFLINE_CHECKS_BEFORE_END = 2; // avoid "ended" flicker from one bad response
const TIKTOK_PINK = 0xfe2c55;
const DEFAULT_MESSAGE = '🔴 **{nickname}** is now live on TikTok! {url}';

// ---------- slash commands ----------

const command = new SlashCommandBuilder()
  .setName('tiktok')
  .setDescription('TikTok live alerts')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
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
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      .addRoleOption((o) => o.setName('ping').setDescription('Role to ping (optional)'))
      .addStringOption((o) =>
        o
          .setName('message')
          .setDescription('Custom text. Placeholders: {user} {nickname} {title} {url}')
          .setMaxLength(500),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Stop alerts for a TikTok user')
      .addStringOption((o) =>
        o.setName('username').setDescription('TikTok username').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((s) => s.setName('list').setDescription('Show the TikTok users this server follows'))
  .addSubcommand((s) =>
    s
      .setName('check')
      .setDescription('Check right now whether a TikTok user is live')
      .addStringOption((o) =>
        o.setName('username').setDescription('TikTok username or profile link').setRequired(true),
      ),
  );

// ---------- discord client ----------

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  try {
    if (process.env.GUILD_ID) {
      await c.application.commands.set([command.toJSON()], process.env.GUILD_ID);
      console.log(`Registered /tiktok in guild ${process.env.GUILD_ID}`);
    } else {
      await c.application.commands.set([command.toJSON()]);
      console.log('Registered /tiktok globally');
    }
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
  console.log(`Checking TikTok every ${POLL_SECONDS}s`);
  pollLoop();
});

client.on(Events.GuildDelete, (guild) => store.removeGuild(guild.id));

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete() && interaction.commandName === 'tiktok') {
    const typed = interaction.options.getFocused().toLowerCase();
    const choices = store
      .listSubs(interaction.guildId)
      .map((s) => s.username)
      .filter((u) => u.includes(typed))
      .slice(0, 25)
      .map((u) => ({ name: `@${u}`, value: u }));
    return interaction.respond(choices).catch(() => {});
  }
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'tiktok') return;

  try {
    await handleCommand(interaction);
  } catch (err) {
    console.error('Command error:', err);
    const reply = { content: `Something went wrong: ${err.message}`, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.editReply(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

async function handleCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  const ephemeral = { flags: MessageFlags.Ephemeral };

  if (sub === 'list') {
    const subs = store.listSubs(interaction.guildId);
    if (!subs.length) {
      return interaction.reply({ content: 'No TikTok users yet. Add one with `/tiktok add`.', ...ephemeral });
    }
    const lines = subs.map((s) => {
      const live = store.getLive(s.username)?.live ? ' 🔴 live' : '';
      const ping = s.roleId ? ` (pings <@&${s.roleId}>)` : '';
      return `• [@${s.username}](https://www.tiktok.com/@${s.username}) → <#${s.channelId}>${ping}${live}`;
    });
    return interaction.reply({ content: lines.join('\n'), allowedMentions: { parse: [] }, ...ephemeral });
  }

  const raw = interaction.options.getString('username', true);
  const username = normalizeUsername(raw);
  if (!username) {
    return interaction.reply({ content: `\`${raw}\` doesn't look like a TikTok username.`, ...ephemeral });
  }

  if (sub === 'remove') {
    const removed = store.removeSub(interaction.guildId, username);
    return interaction.reply({
      content: removed ? `Stopped alerts for **@${username}**.` : `This server wasn't following **@${username}**.`,
      ...ephemeral,
    });
  }

  if (sub === 'check') {
    await interaction.deferReply(ephemeral);
    const info = await getLiveStatus(username);
    return interaction.editReply(
      info.live
        ? { content: `🔴 **@${username}** is live right now.`, embeds: [liveEmbed(info)] }
        : { content: `⚫ **@${username}** is not live right now.` },
    );
  }

  if (sub === 'add') {
    const channel = interaction.options.getChannel('channel', true);
    const role = interaction.options.getRole('ping');
    const message = interaction.options.getString('message') || DEFAULT_MESSAGE;

    const me = interaction.guild.members.me;
    const perms = channel.permissionsFor(me);
    const needed = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ];
    if (!perms?.has(needed)) {
      return interaction.reply({
        content: `I need **View Channel**, **Send Messages** and **Embed Links** in ${channel}.`,
        ...ephemeral,
      });
    }

    await interaction.deferReply(ephemeral);
    let note = '';
    try {
      const info = await getLiveStatus(username);
      note = info.live ? ' They are live right now, so an alert will go out on the next check.' : '';
    } catch (err) {
      note = `\n⚠️ I couldn't reach TikTok to verify this user just now (${err.message}). I'll keep trying.`;
    }
    const isNew = store.upsertSub({
      guildId: interaction.guildId,
      channelId: channel.id,
      username,
      roleId: role?.id ?? null,
      message,
    });
    return interaction.editReply(
      `${isNew ? 'Added' : 'Updated'} **@${username}** → ${channel}${role ? `, pinging ${role}` : ''}.${note}`,
    );
  }
}

// ---------- alerts ----------

function fill(template, info) {
  return template
    .replaceAll('{user}', `@${info.username}`)
    .replaceAll('{nickname}', info.nickname)
    .replaceAll('{title}', info.title || 'LIVE')
    .replaceAll('{url}', info.url);
}

function liveEmbed(info) {
  const e = new EmbedBuilder()
    .setColor(TIKTOK_PINK)
    .setAuthor({ name: `${info.nickname} (@${info.username})`, url: info.url, iconURL: info.avatar || undefined })
    .setTitle(info.title || `${info.nickname} is live!`)
    .setURL(info.url)
    .setFooter({ text: 'TikTok LIVE' })
    .setTimestamp();
  if (info.viewers != null) e.addFields({ name: 'Viewers', value: String(info.viewers), inline: true });
  if (info.cover) e.setImage(info.cover);
  else if (info.avatar) e.setThumbnail(info.avatar);
  return e;
}

function endedEmbed(info, startedAt) {
  const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
  const length = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  return new EmbedBuilder()
    .setColor(0x555555)
    .setAuthor({ name: `${info.nickname} (@${info.username})`, url: `https://www.tiktok.com/@${info.username}` })
    .setTitle('Stream ended')
    .setDescription(`Was live for about ${length}.`)
    .setFooter({ text: 'TikTok LIVE' })
    .setTimestamp();
}

async function announce(sub, info) {
  const channel = await client.channels.fetch(sub.channelId).catch(() => null);
  if (!channel?.isTextBased()) {
    console.warn(`Channel ${sub.channelId} for @${sub.username} is gone or not a text channel`);
    return null;
  }
  const content = (sub.roleId ? `<@&${sub.roleId}> ` : '') + fill(sub.message, info);
  const msg = await channel.send({
    content,
    embeds: [liveEmbed(info)],
    allowedMentions: { roles: sub.roleId ? [sub.roleId] : [], parse: ['everyone'] },
  });
  if (channel.type === ChannelType.GuildAnnouncement) await msg.crosspost().catch(() => {});
  return { guildId: sub.guildId, channelId: channel.id, messageId: msg.id };
}

async function markEnded(state, info) {
  for (const p of state.posts) {
    try {
      const channel = await client.channels.fetch(p.channelId);
      const msg = await channel.messages.fetch(p.messageId);
      await msg.edit({ embeds: [endedEmbed(info, state.startedAt)] });
    } catch {
      // message deleted / no access — fine
    }
  }
}

async function checkUser(username) {
  const info = await getLiveStatus(username);
  const state = store.getLive(username);
  const subs = store.subsFor(username);

  if (info.live) {
    const sameStream = state?.roomId && state.roomId === info.roomId;
    const base = sameStream
      ? { ...state, live: true, misses: 0 }
      : { roomId: info.roomId, live: true, misses: 0, startedAt: Date.now(), nickname: info.nickname, posts: [] };
    const alreadyPosted = new Set(base.posts.map((p) => p.guildId));
    const pending = subs.filter((s) => !alreadyPosted.has(s.guildId));
    for (const sub of pending) {
      try {
        const post = await announce(sub, info);
        if (post) base.posts.push(post);
        console.log(`Announced @${username} live in guild ${sub.guildId}`);
      } catch (err) {
        console.error(`Failed to announce @${username} in ${sub.channelId}:`, err.message);
      }
    }
    if (!sameStream || pending.length || !state.live || state.misses) store.setLive(username, base);
    return;
  }

  if (state?.live) {
    const misses = (state.misses ?? 0) + 1;
    if (misses < OFFLINE_CHECKS_BEFORE_END) {
      store.setLive(username, { ...state, misses });
      return;
    }
    console.log(`@${username} went offline`);
    await markEnded(state, { ...info, nickname: state.nickname || info.nickname });
    // Keep roomId so a brief blip with the same room doesn't re-announce.
    store.setLive(username, { ...state, live: false, misses: 0 });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollLoop() {
  for (;;) {
    const started = Date.now();
    for (const username of store.allUsernames()) {
      try {
        await checkUser(username);
      } catch (err) {
        console.warn(err.message);
      }
      await sleep(1500); // be gentle with TikTok
    }
    await sleep(Math.max(5000, POLL_SECONDS * 1000 - (Date.now() - started)));
  }
}

store.load();
client.login(TOKEN);
