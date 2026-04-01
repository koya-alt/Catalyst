const express = require('express');
const session = require('express-session');
const path = require('path');
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
  ChannelType
} = require('discord.js');

const app = express();
const PORT = 5000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 1000 * 60 * 60 * 4 }
}));

let botClient = null;
let botToken = null;

// In-memory data stores
const warnings = new Map();   // guildId -> Map(userId -> [{id, reason, date}])
const guildSettings = new Map(); // guildId -> { welcomeChannel, logChannel }
const activeGiveaways = new Map(); // messageId -> giveaway data

function getWarnings(guildId, userId) {
  if (!warnings.has(guildId)) warnings.set(guildId, new Map());
  const guild = warnings.get(guildId);
  if (!guild.has(userId)) guild.set(userId, []);
  return guild.get(userId);
}

function addWarning(guildId, userId, reason) {
  const list = getWarnings(guildId, userId);
  const entry = { id: Date.now().toString(36), reason, date: new Date().toISOString() };
  list.push(entry);
  return entry;
}

function getSettings(guildId) {
  if (!guildSettings.has(guildId)) guildSettings.set(guildId, {});
  return guildSettings.get(guildId);
}

// ── SLASH COMMAND DEFINITIONS ─────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member from the server')
    .addUserOption(o => o.setName('user').setDescription('Member to ban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for ban'))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member from the server')
    .addUserOption(o => o.setName('user').setDescription('Member to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for kick'))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Timeout (mute) a member')
    .addUserOption(o => o.setName('user').setDescription('Member to mute').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption(o => o.setName('reason').setDescription('Reason for mute'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Remove timeout from a member')
    .addUserOption(o => o.setName('user').setDescription('Member to unmute').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Issue a warning to a member')
    .addUserOption(o => o.setName('user').setDescription('Member to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for warning').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('View warnings for a member')
    .addUserOption(o => o.setName('user').setDescription('Member to check').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('clearwarnings')
    .setDescription('Clear all warnings for a member')
    .addUserOption(o => o.setName('user').setDescription('Member to clear').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Delete a number of messages from this channel')
    .addIntegerOption(o => o.setName('amount').setDescription('Number of messages to delete (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('View server statistics'),

  new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('View detailed server information'),

  new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('View information about a member')
    .addUserOption(o => o.setName('user').setDescription('Member to look up (defaults to you)')),

  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check the bot\'s response time'),

  new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create a poll in this channel')
    .addStringOption(o => o.setName('question').setDescription('The poll question').setRequired(true))
    .addStringOption(o => o.setName('option1').setDescription('First option').setRequired(true))
    .addStringOption(o => o.setName('option2').setDescription('Second option').setRequired(true))
    .addStringOption(o => o.setName('option3').setDescription('Third option'))
    .addStringOption(o => o.setName('option4').setDescription('Fourth option')),

  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Start a giveaway in this channel')
    .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(10080))
    .addStringOption(o => o.setName('prize').setDescription('What is being given away').setRequired(true))
    .addIntegerOption(o => o.setName('winners').setDescription('Number of winners (default 1)').setMinValue(1).setMaxValue(20))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents),

  new SlashCommandBuilder()
    .setName('setwelcome')
    .setDescription('Set the welcome channel for new members')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to send welcome messages in').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('setlogs')
    .setDescription('Set the moderation log channel')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to send mod logs to').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('View the current Catalyst setup for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

// ── REGISTER SLASH COMMANDS ───────────────────────────────────────
async function registerCommands(token, clientId) {
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: commands.map(c => c.toJSON()) });
    console.log('✓ Slash commands registered globally');
  } catch (err) {
    console.error('✗ Failed to register commands:', err.message);
  }
}

// ── LOG TO MOD CHANNEL ────────────────────────────────────────────
async function sendLog(guild, embed) {
  const settings = getSettings(guild.id);
  if (!settings.logChannel) return;
  try {
    const ch = guild.channels.cache.get(settings.logChannel);
    if (ch) await ch.send({ embeds: [embed] });
  } catch {}
}

// ── COMMAND HANDLER ───────────────────────────────────────────────
async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild, member, options } = interaction;

  try {
    // ── BAN ──────────────────────────────────────────────────────
    if (commandName === 'ban') {
      const target = options.getMember('user');
      const reason = options.getString('reason') || 'No reason provided';
      if (!target) return interaction.reply({ content: '❌ User not found in this server.', ephemeral: true });
      if (!target.bannable) return interaction.reply({ content: '❌ I cannot ban this member. They may have a higher role than me.', ephemeral: true });
      await target.ban({ reason });
      const embed = new EmbedBuilder()
        .setColor(0xef4444)
        .setTitle('🔨 Member Banned')
        .addFields(
          { name: 'User', value: `${target.user.tag}`, inline: true },
          { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
          { name: 'Reason', value: reason }
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
      await sendLog(guild, embed);
    }

    // ── KICK ─────────────────────────────────────────────────────
    else if (commandName === 'kick') {
      const target = options.getMember('user');
      const reason = options.getString('reason') || 'No reason provided';
      if (!target) return interaction.reply({ content: '❌ User not found in this server.', ephemeral: true });
      if (!target.kickable) return interaction.reply({ content: '❌ I cannot kick this member.', ephemeral: true });
      await target.kick(reason);
      const embed = new EmbedBuilder()
        .setColor(0xf59e0b)
        .setTitle('👢 Member Kicked')
        .addFields(
          { name: 'User', value: `${target.user.tag}`, inline: true },
          { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
          { name: 'Reason', value: reason }
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
      await sendLog(guild, embed);
    }

    // ── MUTE ─────────────────────────────────────────────────────
    else if (commandName === 'mute') {
      const target = options.getMember('user');
      const minutes = options.getInteger('minutes');
      const reason = options.getString('reason') || 'No reason provided';
      if (!target) return interaction.reply({ content: '❌ User not found.', ephemeral: true });
      if (!target.moderatable) return interaction.reply({ content: '❌ I cannot timeout this member.', ephemeral: true });
      await target.timeout(minutes * 60 * 1000, reason);
      const embed = new EmbedBuilder()
        .setColor(0x6366f1)
        .setTitle('🔇 Member Muted')
        .addFields(
          { name: 'User', value: `${target.user.tag}`, inline: true },
          { name: 'Duration', value: `${minutes} minute${minutes !== 1 ? 's' : ''}`, inline: true },
          { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
          { name: 'Reason', value: reason }
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
      await sendLog(guild, embed);
    }

    // ── UNMUTE ───────────────────────────────────────────────────
    else if (commandName === 'unmute') {
      const target = options.getMember('user');
      if (!target) return interaction.reply({ content: '❌ User not found.', ephemeral: true });
      if (!target.moderatable) return interaction.reply({ content: '❌ I cannot modify this member.', ephemeral: true });
      await target.timeout(null);
      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('🔊 Member Unmuted')
        .addFields(
          { name: 'User', value: `${target.user.tag}`, inline: true },
          { name: 'Moderator', value: `${interaction.user.tag}`, inline: true }
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
      await sendLog(guild, embed);
    }

    // ── WARN ─────────────────────────────────────────────────────
    else if (commandName === 'warn') {
      const target = options.getUser('user');
      const reason = options.getString('reason');
      const entry = addWarning(guild.id, target.id, reason);
      const total = getWarnings(guild.id, target.id).length;
      const embed = new EmbedBuilder()
        .setColor(0xf59e0b)
        .setTitle('⚠️ Member Warned')
        .addFields(
          { name: 'User', value: `${target.tag}`, inline: true },
          { name: 'Total Warnings', value: `${total}`, inline: true },
          { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
          { name: 'Reason', value: reason }
        )
        .setFooter({ text: `Warning ID: ${entry.id}` })
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
      await sendLog(guild, embed);
      try { await target.send(`⚠️ You have been warned in **${guild.name}**.\n**Reason:** ${reason}\nTotal warnings: ${total}`); } catch {}
    }

    // ── WARNINGS ─────────────────────────────────────────────────
    else if (commandName === 'warnings') {
      const target = options.getUser('user');
      const list = getWarnings(guild.id, target.id);
      const embed = new EmbedBuilder()
        .setColor(0xf59e0b)
        .setTitle(`⚠️ Warnings for ${target.tag}`)
        .setDescription(list.length === 0
          ? 'This member has no warnings.'
          : list.map((w, i) => `**${i + 1}.** ${w.reason}\n*${new Date(w.date).toLocaleDateString()} — ID: \`${w.id}\`*`).join('\n\n'))
        .setFooter({ text: `Total: ${list.length} warning${list.length !== 1 ? 's' : ''}` })
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
    }

    // ── CLEARWARNINGS ────────────────────────────────────────────
    else if (commandName === 'clearwarnings') {
      const target = options.getUser('user');
      const list = getWarnings(guild.id, target.id);
      const count = list.length;
      list.splice(0, list.length);
      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('✅ Warnings Cleared')
        .setDescription(`Cleared **${count}** warning${count !== 1 ? 's' : ''} for ${target.tag}.`)
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
    }

    // ── PURGE ────────────────────────────────────────────────────
    else if (commandName === 'purge') {
      const amount = options.getInteger('amount');
      const deleted = await interaction.channel.bulkDelete(amount, true);
      const embed = new EmbedBuilder()
        .setColor(0x6366f1)
        .setDescription(`🗑️ Deleted **${deleted.size}** message${deleted.size !== 1 ? 's' : ''}.`)
        .setTimestamp();
      const reply = await interaction.reply({ embeds: [embed], fetchReply: true });
      setTimeout(() => reply.delete().catch(() => {}), 5000);
    }

    // ── STATS ────────────────────────────────────────────────────
    else if (commandName === 'stats') {
      await guild.members.fetch();
      const total = guild.memberCount;
      const bots = guild.members.cache.filter(m => m.user.bot).size;
      const humans = total - bots;
      const online = guild.members.cache.filter(m => m.presence?.status !== 'offline' && !m.user.bot).size;
      const channels = guild.channels.cache;
      const text = channels.filter(c => c.type === ChannelType.GuildText).size;
      const voice = channels.filter(c => c.type === ChannelType.GuildVoice).size;
      const roles = guild.roles.cache.size - 1;
      const embed = new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle(`📊 ${guild.name} — Server Stats`)
        .setThumbnail(guild.iconURL({ size: 256 }))
        .addFields(
          { name: '👥 Total Members', value: `${total}`, inline: true },
          { name: '🟢 Online', value: `${online}`, inline: true },
          { name: '🤖 Bots', value: `${bots}`, inline: true },
          { name: '💬 Text Channels', value: `${text}`, inline: true },
          { name: '🔊 Voice Channels', value: `${voice}`, inline: true },
          { name: '🎭 Roles', value: `${roles}`, inline: true }
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
    }

    // ── SERVERINFO ───────────────────────────────────────────────
    else if (commandName === 'serverinfo') {
      await guild.fetch();
      const owner = await guild.fetchOwner();
      const created = `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`;
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`🖥️ ${guild.name}`)
        .setThumbnail(guild.iconURL({ size: 256 }))
        .addFields(
          { name: 'Owner', value: `${owner.user.tag}`, inline: true },
          { name: 'Members', value: `${guild.memberCount}`, inline: true },
          { name: 'Created', value: created, inline: true },
          { name: 'Channels', value: `${guild.channels.cache.size}`, inline: true },
          { name: 'Roles', value: `${guild.roles.cache.size - 1}`, inline: true },
          { name: 'Boosts', value: `${guild.premiumSubscriptionCount || 0}`, inline: true },
          { name: 'Verification', value: guild.verificationLevel.toString(), inline: true },
          { name: 'Server ID', value: guild.id, inline: true }
        )
        .setFooter({ text: `Catalyst Bot` })
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
    }

    // ── USERINFO ─────────────────────────────────────────────────
    else if (commandName === 'userinfo') {
      const target = options.getMember('user') || member;
      const user = target.user;
      const joined = `<t:${Math.floor(target.joinedTimestamp / 1000)}:D>`;
      const created = `<t:${Math.floor(user.createdTimestamp / 1000)}:D>`;
      const roles = target.roles.cache
        .filter(r => r.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map(r => `<@&${r.id}>`)
        .slice(0, 10)
        .join(' ') || 'None';
      const embed = new EmbedBuilder()
        .setColor(target.displayHexColor || 0x7c3aed)
        .setTitle(`👤 ${user.tag}`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'Display Name', value: target.displayName, inline: true },
          { name: 'User ID', value: user.id, inline: true },
          { name: 'Bot', value: user.bot ? 'Yes' : 'No', inline: true },
          { name: 'Joined Server', value: joined, inline: true },
          { name: 'Account Created', value: created, inline: true },
          { name: `Roles (${target.roles.cache.size - 1})`, value: roles }
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
    }

    // ── PING ─────────────────────────────────────────────────────
    else if (commandName === 'ping') {
      const sent = await interaction.reply({ content: '🏓 Pinging...', fetchReply: true });
      const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('🏓 Pong!')
        .addFields(
          { name: 'Roundtrip', value: `${roundtrip}ms`, inline: true },
          { name: 'WebSocket', value: `${Math.round(interaction.client.ws.ping)}ms`, inline: true }
        );
      await interaction.editReply({ content: null, embeds: [embed] });
    }

    // ── POLL ─────────────────────────────────────────────────────
    else if (commandName === 'poll') {
      const question = options.getString('question');
      const opts = [
        options.getString('option1'),
        options.getString('option2'),
        options.getString('option3'),
        options.getString('option4'),
      ].filter(Boolean);
      const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`📊 ${question}`)
        .setDescription(opts.map((o, i) => `${emojis[i]} ${o}`).join('\n\n'))
        .setFooter({ text: `Poll by ${interaction.user.tag}` })
        .setTimestamp();
      const msg = await interaction.reply({ embeds: [embed], fetchReply: true });
      for (let i = 0; i < opts.length; i++) {
        await msg.react(emojis[i]);
      }
    }

    // ── GIVEAWAY ─────────────────────────────────────────────────
    else if (commandName === 'giveaway') {
      const minutes = options.getInteger('minutes');
      const prize = options.getString('prize');
      const winnersCount = options.getInteger('winners') || 1;
      const endsAt = Date.now() + minutes * 60 * 1000;
      const endsTs = Math.floor(endsAt / 1000);
      const embed = new EmbedBuilder()
        .setColor(0xf59e0b)
        .setTitle(`🎉 GIVEAWAY — ${prize}`)
        .setDescription(`React with 🎉 to enter!\n\n**Ends:** <t:${endsTs}:R>\n**Winners:** ${winnersCount}\n**Hosted by:** ${interaction.user}`)
        .setFooter({ text: 'Catalyst Giveaways' })
        .setTimestamp(endsAt);
      const msg = await interaction.reply({ embeds: [embed], fetchReply: true });
      await msg.react('🎉');

      activeGiveaways.set(msg.id, { prize, winnersCount, endsAt, channelId: interaction.channelId, host: interaction.user.tag });

      setTimeout(async () => {
        try {
          const channel = interaction.channel;
          const giveawayMsg = await channel.messages.fetch(msg.id);
          const reaction = giveawayMsg.reactions.cache.get('🎉');
          if (!reaction) return;
          const users = await reaction.users.fetch();
          const eligible = users.filter(u => !u.bot);
          if (eligible.size === 0) {
            const endEmbed = new EmbedBuilder().setColor(0xef4444).setTitle(`🎉 Giveaway Ended — ${prize}`).setDescription('No valid entries. No winner selected.').setTimestamp();
            await giveawayMsg.edit({ embeds: [endEmbed] });
            return;
          }
          const arr = [...eligible.values()];
          const winners = [];
          const pool = [...arr];
          for (let i = 0; i < Math.min(winnersCount, pool.length); i++) {
            const idx = Math.floor(Math.random() * pool.length);
            winners.push(pool.splice(idx, 1)[0]);
          }
          const winnerMentions = winners.map(w => `<@${w.id}>`).join(', ');
          const endEmbed = new EmbedBuilder()
            .setColor(0x22c55e)
            .setTitle(`🎉 Giveaway Ended — ${prize}`)
            .setDescription(`**Winner${winners.length > 1 ? 's' : ''}:** ${winnerMentions}\nCongratulations! 🎊`)
            .setTimestamp();
          await giveawayMsg.edit({ embeds: [endEmbed] });
          await channel.send(`🎊 Congratulations ${winnerMentions}! You won **${prize}**!`);
          activeGiveaways.delete(msg.id);
        } catch (e) { console.error('Giveaway error:', e.message); }
      }, minutes * 60 * 1000);
    }

    // ── SETWELCOME ───────────────────────────────────────────────
    else if (commandName === 'setwelcome') {
      const channel = options.getChannel('channel');
      const settings = getSettings(guild.id);
      settings.welcomeChannel = channel.id;
      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('✅ Welcome Channel Set')
        .setDescription(`New members will be welcomed in ${channel}.`)
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
    }

    // ── SETLOGS ──────────────────────────────────────────────────
    else if (commandName === 'setlogs') {
      const channel = options.getChannel('channel');
      const settings = getSettings(guild.id);
      settings.logChannel = channel.id;
      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('✅ Log Channel Set')
        .setDescription(`Moderation logs will be sent to ${channel}.`)
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
    }

    // ── SETUP ────────────────────────────────────────────────────
    else if (commandName === 'setup') {
      const settings = getSettings(guild.id);
      const welcomeCh = settings.welcomeChannel ? `<#${settings.welcomeChannel}>` : 'Not set';
      const logCh = settings.logChannel ? `<#${settings.logChannel}>` : 'Not set';
      const embed = new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle(`⚙️ Catalyst Setup — ${guild.name}`)
        .addFields(
          { name: '👋 Welcome Channel', value: welcomeCh, inline: true },
          { name: '📋 Log Channel', value: logCh, inline: true }
        )
        .setFooter({ text: 'Use /setwelcome and /setlogs to configure' })
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
    }

  } catch (err) {
    console.error(`Error in /${commandName}:`, err.message);
    const errMsg = { content: `❌ An error occurred: ${err.message}`, ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errMsg).catch(() => {});
    } else {
      await interaction.reply(errMsg).catch(() => {});
    }
  }
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  res.redirect('/login.html');
}

// ── AUTH ROUTES ───────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.loggedIn = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Wrong password' });
  }
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/auth-check', (req, res) => res.json({ loggedIn: !!req.session.loggedIn }));

// ── BOT CONNECT ───────────────────────────────────────────────────
app.post('/api/bot/connect', requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'No token provided' });

  if (botClient) {
    try { await botClient.destroy(); } catch (e) {}
    botClient = null; botToken = null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildMessageReactions,
    ]
  });

  client.on('interactionCreate', handleInteraction);

  client.on('guildMemberAdd', async (member) => {
    const settings = getSettings(member.guild.id);
    if (!settings.welcomeChannel) return;
    try {
      const ch = member.guild.channels.cache.get(settings.welcomeChannel);
      if (!ch) return;
      const embed = new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('👋 Welcome!')
        .setDescription(`Welcome to **${member.guild.name}**, ${member}! 🎉`)
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
        .addFields({ name: 'Member #', value: `${member.guild.memberCount}`, inline: true })
        .setTimestamp();
      await ch.send({ embeds: [embed] });
    } catch {}
  });

  try {
    await new Promise((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
      client.login(token).catch(reject);
      setTimeout(() => reject(new Error('Login timed out')), 15000);
    });
    botClient = client;
    botToken = token;
    await registerCommands(token, client.user.id);
    res.json({ success: true, username: client.user.tag, id: client.user.id });
  } catch (err) {
    try { await client.destroy(); } catch (e) {}
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/bot/status', requireAuth, (req, res) => {
  if (!botClient || !botClient.isReady()) return res.json({ connected: false });
  res.json({ connected: true, username: botClient.user.tag, id: botClient.user.id });
});

app.post('/api/bot/disconnect', requireAuth, async (req, res) => {
  if (botClient) { try { await botClient.destroy(); } catch (e) {} botClient = null; botToken = null; }
  res.json({ success: true });
});

// ── DASHBOARD API ROUTES ──────────────────────────────────────────
app.get('/api/bot/guilds', requireAuth, async (req, res) => {
  if (!botClient?.isReady()) return res.status(400).json({ success: false, error: 'Bot not connected' });
  const guilds = botClient.guilds.cache.map(g => ({ id: g.id, name: g.name, memberCount: g.memberCount, icon: g.iconURL({ size: 64 }) || null }));
  res.json({ success: true, guilds });
});

app.post('/api/bot/leave-guild', requireAuth, async (req, res) => {
  if (!botClient?.isReady()) return res.status(400).json({ success: false, error: 'Bot not connected' });
  try {
    const guild = botClient.guilds.cache.get(req.body.guildId);
    if (!guild) return res.status(404).json({ success: false, error: 'Server not found' });
    await guild.leave();
    res.json({ success: true, message: `Left server: ${guild.name}` });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/bot/delete-channels', requireAuth, async (req, res) => {
  if (!botClient?.isReady()) return res.status(400).json({ success: false, error: 'Bot not connected' });
  try {
    const guild = botClient.guilds.cache.get(req.body.guildId);
    if (!guild) return res.status(404).json({ success: false, error: 'Server not found' });
    const results = [];
    for (const [, ch] of guild.channels.cache.filter(c => c.deletable)) {
      try { await ch.delete(); results.push({ name: ch.name, success: true }); }
      catch (e) { results.push({ name: ch.name, success: false, error: e.message }); }
    }
    res.json({ success: true, results });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/bot/delete-roles', requireAuth, async (req, res) => {
  if (!botClient?.isReady()) return res.status(400).json({ success: false, error: 'Bot not connected' });
  try {
    const guild = await botClient.guilds.fetch(req.body.guildId);
    await guild.roles.fetch();
    const results = [];
    for (const [, role] of guild.roles.cache.filter(r => r.editable && r.id !== guild.id)) {
      try { await role.delete(); results.push({ name: role.name, success: true }); }
      catch (e) { results.push({ name: role.name, success: false, error: e.message }); }
    }
    res.json({ success: true, results });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/bot/ban-all', requireAuth, async (req, res) => {
  if (!botClient?.isReady()) return res.status(400).json({ success: false, error: 'Bot not connected' });
  try {
    const guild = await botClient.guilds.fetch(req.body.guildId);
    const members = await guild.members.fetch();
    const results = [];
    for (const [, m] of members) {
      if (m.id === botClient.user.id) continue;
      if (!m.bannable) { results.push({ name: m.user.tag, success: false, error: 'Not bannable' }); continue; }
      try { await m.ban({ reason: 'Control panel' }); results.push({ name: m.user.tag, success: true }); }
      catch (e) { results.push({ name: m.user.tag, success: false, error: e.message }); }
    }
    res.json({ success: true, results });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/bot/kick-all', requireAuth, async (req, res) => {
  if (!botClient?.isReady()) return res.status(400).json({ success: false, error: 'Bot not connected' });
  try {
    const guild = await botClient.guilds.fetch(req.body.guildId);
    const members = await guild.members.fetch();
    const results = [];
    for (const [, m] of members) {
      if (m.id === botClient.user.id) continue;
      if (!m.kickable) { results.push({ name: m.user.tag, success: false, error: 'Not kickable' }); continue; }
      try { await m.kick('Control panel'); results.push({ name: m.user.tag, success: true }); }
      catch (e) { results.push({ name: m.user.tag, success: false, error: e.message }); }
    }
    res.json({ success: true, results });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/bot/send-message', requireAuth, async (req, res) => {
  if (!botClient?.isReady()) return res.status(400).json({ success: false, error: 'Bot not connected' });
  try {
    const { guildId, channelId, message } = req.body;
    const guild = botClient.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ success: false, error: 'Server not found' });
    await guild.channels.fetch();
    const ch = guild.channels.cache.get(channelId);
    if (!ch?.isTextBased()) return res.status(404).json({ success: false, error: 'Channel not found or not text-based' });
    await ch.send(message);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/bot/channels', requireAuth, async (req, res) => {
  if (!botClient?.isReady()) return res.status(400).json({ success: false, error: 'Bot not connected' });
  try {
    const guild = botClient.guilds.cache.get(req.query.guildId);
    if (!guild) return res.status(404).json({ success: false, error: 'Server not found' });
    await guild.channels.fetch();
    const channels = guild.channels.cache.filter(c => c.isTextBased?.()).map(c => ({ id: c.id, name: c.name }));
    res.json({ success: true, channels });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── STATIC FILES ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session?.loggedIn) res.redirect('/dashboard.html');
  else res.sendFile(path.join(__dirname, 'index.html'));
});

app.use(express.static(__dirname));

app.listen(PORT, '0.0.0.0', () => console.log(`Catalyst running on port ${PORT}`));
