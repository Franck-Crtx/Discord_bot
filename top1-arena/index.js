import 'dotenv/config';
import pkg from 'discord.js';
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField
} = pkg;
import Database from 'better-sqlite3';
import { distance as levenshteinDistance } from 'fastest-levenshtein';

// =============================
// DB setup (sans mode)
// =============================
const db = new Database('data.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS wins (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  champion TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// KV store pour scheduler
db.exec(`
CREATE TABLE IF NOT EXISTS bot_kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`);

const kvGet = db.prepare(`SELECT v FROM bot_kv WHERE k=? LIMIT 1;`);
const kvSet = db.prepare(`INSERT INTO bot_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v;`);

// Préparés (sans mode)
const insertWin        = db.prepare(`INSERT OR IGNORE INTO wins (guild_id, user_id, champion) VALUES (?, ?, ?);`);
const deleteWin        = db.prepare(`DELETE FROM wins WHERE guild_id=? AND user_id=? AND LOWER(champion)=LOWER(?);`);
const deleteAllWins    = db.prepare(`DELETE FROM wins WHERE guild_id=? AND user_id=?;`);
const listWins         = db.prepare(`SELECT champion FROM wins WHERE guild_id=? AND user_id=? ORDER BY LOWER(champion);`);
const countByUser      = db.prepare(`
  SELECT user_id, COUNT(*) as cnt
  FROM wins
  WHERE guild_id=?
  GROUP BY user_id
  ORDER BY cnt DESC, user_id ASC
`);
const hasWin           = db.prepare(`SELECT 1 FROM wins WHERE guild_id=? AND user_id=? AND LOWER(champion)=LOWER(?) LIMIT 1;`);
const listAllByGuild   = db.prepare(`SELECT user_id, champion FROM wins WHERE guild_id=? ORDER BY user_id, LOWER(champion);`);

// ==== Requêtes pour /flg_summary (fenêtre temporelle) ====
const countWinsSince = db.prepare(`
  SELECT COUNT(*) AS cnt
  FROM wins
  WHERE guild_id=? AND created_at >= ?
`);
const countActiveUsersSince = db.prepare(`
  SELECT COUNT(DISTINCT user_id) AS cnt
  FROM wins
  WHERE guild_id=? AND created_at >= ?
`);
const topUserSince = db.prepare(`
  SELECT user_id, COUNT(*) AS cnt
  FROM wins
  WHERE guild_id=? AND created_at >= ?
  GROUP BY user_id
  ORDER BY cnt DESC, user_id ASC
  LIMIT 1
`);
const topChampsSince = db.prepare(`
  SELECT champion, COUNT(*) AS cnt
  FROM wins
  WHERE guild_id=? AND created_at >= ?
  GROUP BY champion
  ORDER BY cnt DESC, champion ASC
  LIMIT 5
`);
// Pour /flg_stats
const listWinsWithDates = db.prepare(`
  SELECT champion, created_at
  FROM wins
  WHERE guild_id=? AND user_id=?
  ORDER BY datetime(created_at) DESC
`);
const countUserWinsSince = db.prepare(`
  SELECT COUNT(*) AS cnt
  FROM wins
  WHERE guild_id=? AND user_id=? AND created_at >= ?
`);

// =============================
// Champions (auto-fetch depuis Data Dragon)
// =============================
let CHAMPIONS = ['Galio']; // fallback minimal
async function loadChampions() {
  try {
    const versions = await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json();
    const ver = versions?.[0];
    const url = `https://ddragon.leagueoflegends.com/cdn/${ver}/data/en_US/champion.json`;
    const data = await (await fetch(url)).json();
    CHAMPIONS = Object.values(data.data).map((c) => c.name).sort((a,b)=>a.localeCompare(b));
    console.log(`✅ Champions DDragon ${ver} — ${CHAMPIONS.length} noms`);
  } catch (e) {
    console.warn('⚠️ Impossible de charger DDragon, fallback minimal utilisé.', e.message);
  }
}
loadChampions();

// =============================
// Utils
// =============================
function normalizeChampion(input) {
  const s = input.trim().replace(/\s+/g, ' ');
  return s.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}
function parseChampions(multi) {
  const parts = multi.split(/[,;\n\r\t]+| {2,}/g)
    .map(s => s.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const n = normalizeChampion(p);
    const key = n.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(n);
    }
  }
  return out.slice(0, 50);
}
const formatPerLineWithComma = (arr) => arr.map(x => `${x},`).join('\n');
function chunkString(str, size) {
  const chunks = [];
  for (let i = 0; i < str.length; i += size) chunks.push(str.slice(i, i + size));
  return chunks;
}
function arrToBullets(arr) {
  return arr.map(c => `• ${c}`).join('\n') || '—';
}
function hasAdmin(interaction) {
  return interaction.member?.permissions?.has?.(PermissionsBitField.Flags.ManageGuild);
}
function canonicalExact(name) {
  const lower = name.toLowerCase();
  return CHAMPIONS.find(c => c.toLowerCase() === lower) || null;
}
function canonicalFuzzy(name) {
  const scored = CHAMPIONS.map(c => ({ name: c, dist: levenshteinDistance(name.toLowerCase(), c.toLowerCase()) }))
                         .sort((a,b)=>a.dist-b.dist)[0];
  return scored && scored.dist <= 2 ? scored.name : null; // seuil fuzzy
}
const applyRenameTx = db.transaction((guildId, userId, from, to) => {
  insertWin.run(guildId, userId, to);
  deleteWin.run(guildId, userId, from);
});
function toSqliteDateTime(d) {
  return new Date(d).toISOString().slice(0,19).replace('T',' ');
}
function percent(n, d) {
  if (!d) return '0%';
  const p = (n * 100) / d;
  return `${p.toFixed(1)}%`;
}
function textBar(n, d, width = 20) {
  if (!d) return '—';
  const filled = Math.round((n / d) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}
function toUnixTs(s) {
  try { return Math.floor(new Date(s.replace(' ', 'T') + 'Z').getTime() / 1000); }
  catch { return null; }
}
// Heure Europe/Paris côté JS (sans lib)
function getParisDate() {
  const parisStr = new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' });
  return new Date(parisStr);
}
function parisYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// =============================
// HELP interactif (multi-pages)
// =============================
function buildHelpEmbed(page = 'player') {
  const base = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📘 Aide — Bot FLG (Checklist LoL Top 1)')
    .setDescription('Navigue avec les boutons ci-dessous.');

  if (page === 'player') {
    return base
      .addFields(
        {
          name: '🏆 Progression personnelle',
          value:
            '• `/flg_win champions:<liste>` — Ajoute un ou plusieurs champions à ta liste TOP 1.\n' +
            '• `/flg_check [champion]` — Vérifie si tu as déjà fait TOP 1 avec ce champion.\n' +
            '• `/flg_list [user]` — Affiche ta liste ou celle de quelqu’un d’autre.\n' +
            '• `/flg_remove champion:<nom>` — Retire un champion spécifique.\n' +
            '• `/flg_remove_all` — Vide ta liste (avec confirmation).',
          inline: false
        }
      )
      .setFooter({ text: 'Onglet Joueur • Bot FLG' });
  }

  if (page === 'leaders') {
    return base
      .addFields(
        {
          name: '👥 Classements & comparaisons',
          value:
            '• `/flg_leaders` — Affiche le top 10 des joueurs ayant le plus de TOP 1.\n' +
            '• `/flg_compare user:@Pseudo` — Compare ta liste avec celle d’un autre joueur.\n' +
            '• `/flg_completion [user] [public]` — Ton % de complétion.\n' +
            '• `/flg_stats [user] [days] [public]` — Stats perso.',
          inline: false
        },
        {
          name: '📅 Résumés',
          value: '• `/flg_summary [days] [public]` — Récap de la période (par défaut 7 jours).',
          inline: false
        }
      )
      .setFooter({ text: 'Onglet Classement • Bot FLG' });
  }

  if (page === 'admin') {
    return base
      .addFields(
        {
          name: '🧹 Maintenance (admin)',
          value:
            '• `/flg_fix_names` — Corrige les noms mal formatés/orthographiés en base.\n' +
            ' → Options : `user`, `dry_run`, `force_fuzzy` (≤2)',
          inline: false
        },
        {
          name: 'Auto-récap',
          value: '• Le bot poste automatiquement chaque **samedi à 23:42 (Europe/Paris)** dans le salon configuré.',
          inline: false
        }
      )
      .setFooter({ text: 'Onglet Admin • Bot FLG' });
  }

  return base
    .addFields(
      {
        name: 'ℹ️ Comportement',
        value:
          '• Par défaut, les réponses sont **éphémères** (seul l’auteur voit).\n' +
          '• Dans `#check-list-arena` (si configuré via env), certaines réponses peuvent être **publiques**.',
        inline: false
      },
      {
        name: '🧠 Autocomplete & tolérance',
        value:
          '• Autocomplétion sur les commandes qui prennent 1 champion.\n' +
          '• `/flg_win` accepte plusieurs noms et propose des **suggestions** en cas de fautes.',
        inline: false
      }
    )
    .setFooter({ text: 'Onglet Infos • Bot FLG' });
}
function buildHelpRow(activePage = 'player', authorId) {
  const OWNER_ID = process.env.OWNER_ID; // optionnel : ne montre "Admin" qu’à toi
  const mk = (id, label) =>
    new ButtonBuilder()
      .setCustomId(`help:${id}:${authorId}`)
      .setLabel(label)
      .setStyle(id === activePage ? ButtonStyle.Primary : ButtonStyle.Secondary);

  const buttons = [
    mk('player', 'Joueur'),
    mk('leaders', 'Classement'),
  ];
  if (!OWNER_ID || authorId === OWNER_ID) buttons.push(mk('admin', 'Admin'));
  buttons.push(mk('info', 'Infos'));
  return new ActionRowBuilder().addComponents(buttons);
}

// =============================
// Slash commands
// =============================
export const commands = [
  new SlashCommandBuilder()
    .setName('flg_win')
    .setDescription('Ajouter un ou plusieurs champions comme TOP 1')
    .addStringOption(o =>
      o.setName('champions')
       .setDescription('Champions séparés par virgules / points-virgules / retours à la ligne')
       .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('flg_check')
    .setDescription('Vérifier si un champion est dans ta liste TOP 1')
    .addStringOption(o =>
      o.setName('champion')
       .setDescription('Nom du champion (si vide: Galio)')
       .setAutocomplete(true)
       .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('flg_list')
    .setDescription('Voir la liste des champions TOP 1')
    .addUserOption(o =>
      o.setName('user').setDescription('Voir la liste de quelqu’un').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('flg_remove')
    .setDescription('Retirer un champion (ou tout vider avec "all")')
    .addStringOption(o =>
      o.setName('champion').setDescription('Nom du champion (ou "all")').setAutocomplete(true).setRequired(true)
    ),
  new SlashCommandBuilder().setName('flg_remove_all').setDescription('Vider toute ta liste (confirmation requise)'),
  new SlashCommandBuilder().setName('flg_leaders').setDescription('Classement des personnes avec le plus de champions TOP 1'),
  new SlashCommandBuilder()
    .setName('flg_compare')
    .setDescription('Comparer ta liste TOP 1 avec un autre joueur')
    .addUserOption(o =>
      o.setName('user').setDescription('Le joueur avec qui comparer').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('flg_fix_names')
    .setDescription('ADMIN : normaliser/corriger les noms déjà enregistrés')
    .addUserOption(o =>
      o.setName('user').setDescription('Limiter à un utilisateur').setRequired(false)
    )
    .addBooleanOption(o =>
      o.setName('dry_run').setDescription('Aperçu sans appliquer (défaut: true)').setRequired(false)
    )
    .addBooleanOption(o =>
      o.setName('force_fuzzy').setDescription('Appliquer aussi les corrections fuzzy (≤2)').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('flg_summary')
    .setDescription('Résumé sur une période (par défaut 7 jours)')
    .addIntegerOption(o =>
      o.setName('days').setDescription('Nombre de jours à résumer (ex: 7)').setRequired(false)
    )
    .addBooleanOption(o =>
      o.setName('public').setDescription('Rendre le message public (sinon éphémère)').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('flg_completion')
    .setDescription('Taux de complétion d’un joueur vs roster')
    .addUserOption(o =>
      o.setName('user').setDescription('Joueur ciblé (par défaut: toi)').setRequired(false)
    )
    .addBooleanOption(o =>
      o.setName('public').setDescription('Rendre le message public (sinon éphémère)').setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('flg_stats')
    .setDescription('Statistiques personnelles sur une période')
    .addUserOption(o =>
      o.setName('user').setDescription('Joueur ciblé (défaut: toi)').setRequired(false)
    )
    .addIntegerOption(o =>
      o.setName('days').setDescription('Fenêtre en jours (défaut: 30)').setRequired(false)
    )
    .addBooleanOption(o =>
      o.setName('public').setDescription('Rendre le message public').setRequired(false)
    ),
  new SlashCommandBuilder().setName('flg_help').setDescription('Afficher l’aide interactive FLG')
].map(c => c.toJSON());

// =============================
// Client
// =============================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
  startWeeklySummaryScheduler(); // pas de .catch ici
});

// =============================
// Interactions
// =============================
client.on('interactionCreate', async (interaction) => {
  // ---------- Autocomplete ----------
  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused() ?? '';
    const q = focused.toLowerCase();
    let choices = CHAMPIONS;

    try {
      if (interaction.commandName === 'flg_remove') {
        const rows = listWins.all(interaction.guildId, interaction.user.id).map(r => r.champion);
        const mine = rows.filter(name => name.toLowerCase().includes(q));
        const others = CHAMPIONS.filter(name => name.toLowerCase().includes(q) && !rows.includes(name));
        choices = [...mine, ...others];
      } else {
        choices = CHAMPIONS.filter(c => c.toLowerCase().includes(q));
      }
    } catch {
      choices = CHAMPIONS.filter(c => c.toLowerCase().includes(q));
    }
    await interaction.respond(choices.slice(0, 25).map(c => ({ name: c, value: c })));
    return;
  }

  // ---------- Boutons ----------
  if (interaction.isButton()) {
    const [ns, action, authorId] = interaction.customId.split(':');

    // Onglets du help
    if (ns === 'help') {
      if (interaction.user.id !== authorId) {
        await interaction.reply({ content: `⛔ Seul <@${authorId}> peut utiliser ces boutons.`, ephemeral: true });
        return;
      }
      const page = action; // 'player' | 'leaders' | 'admin' | 'info'
      const embed = buildHelpEmbed(page);
      const row = buildHelpRow(page, authorId);
      await interaction.update({ embeds: [embed], components: [row] });
      return;
    }

    if (ns === 'fuzzy' && action === 'add') {
      // customId: fuzzy:add:<authorId>:<encodedChampion>
      const championEncoded = interaction.customId.split(':').slice(3).join(':');
      const champion = decodeURIComponent(championEncoded);

      if (interaction.user.id !== authorId) {
        await interaction.reply({ content: `⛔ Seul <@${authorId}> peut valider cette suggestion.`, ephemeral: true });
        return;
      }

      const res = insertWin.run(interaction.guildId, interaction.user.id, champion);
      if (res.changes === 0) {
        await interaction.reply({ content: `ℹ️ **${champion}** était déjà dans ta liste.`, ephemeral: true });
      } else {
        await interaction.reply({ content: `✅ Ajouté via suggestion : **${champion}**.`, ephemeral: true });
      }
      return;
    }

    // Confirmation remove_all
    if (ns === 'flg_remove_all') {
      if (interaction.user.id !== authorId) {
        await interaction.reply({ content: `⛔ Seul <@${authorId}> peut confirmer cette action.`, ephemeral: true });
        return;
      }
      if (action === 'confirm') {
        const info = deleteAllWins.run(interaction.guildId, interaction.user.id);
        await interaction.update({
          content: `🧹 Liste vidée. **${info.changes}** supprimé(s).`,
          components: []
        });
      } else if (action === 'cancel') {
        await interaction.update({ content: `❎ Annulé. Rien n’a été supprimé.`, components: [] });
      }
      return;
    }
  }

  // ---------- Slash commands ----------
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  try {
    // /flg_win
    if (commandName === 'flg_win') {
      const multiRaw = interaction.options.getString('champions', true);
      const champs = parseChampions(multiRaw);
      if (champs.length === 0) {
        await interaction.reply({
          content: `⚠️ Aucun nom valide détecté. Exemple : \`/flg_win champions: Jinx, Lee Sin, Ahri\``,
          ephemeral: true
        });
        return;
      }

      const added = [];
      const already = [];
      const notFound = [];

      for (const rawName of champs) {
        const exact = canonicalExact(rawName);
        if (!exact) {
          notFound.push(rawName);
          continue;
        }
        const res = insertWin.run(interaction.guildId, interaction.user.id, exact);
        if (res.changes === 0) already.push(exact);
        else added.push(exact);
      }

      const lines = [];
      if (added.length) {
        lines.push(`🏆 **Ajouté** (${added.length}) :`);
        lines.push(formatPerLineWithComma(added));
      }
      if (already.length) {
        lines.push(`✅ **Déjà présent** (${already.length}) :`);
        lines.push(formatPerLineWithComma(already));
      }
      if (notFound.length) {
        const suggestions = notFound.map(n => {
          const fuzzy = canonicalFuzzy(n);
          const hint = fuzzy ? `→ **${fuzzy}**` : '';
          return `• ${n} ${hint}`;
        });
        lines.push(`⚠️ **Inconnus / mal orthographiés** :\n${suggestions.join('\n')}`);
      }

      const fuzzyCandidates = [];
      for (const n of notFound) {
        const fuzzy = canonicalFuzzy(n);
        if (fuzzy && !added.includes(fuzzy) && !already.includes(fuzzy)) {
          if (!fuzzyCandidates.includes(fuzzy)) fuzzyCandidates.push(fuzzy);
        }
      }

      const embed = new EmbedBuilder()
      .setTitle(`Résultat — ${interaction.user.username}`)
      .setDescription(lines.join('\n'))
      .setColor(0x5865F2);

      let components = [];
      if (fuzzyCandidates.length) {
        const rows = [];
        for (let i = 0; i < fuzzyCandidates.length; i += 5) {
          const slice = fuzzyCandidates.slice(i, i + 5);
          const row = new ActionRowBuilder().addComponents(
            ...slice.map(name =>
              new ButtonBuilder()
                .setCustomId(`fuzzy:add:${interaction.user.id}:${encodeURIComponent(name)}`)
                .setLabel(`Ajouter ${name}`)
                .setStyle(ButtonStyle.Primary)
            )
          );
          rows.push(row);
        }
        components = rows;
      }

    await interaction.reply({ embeds: [embed], components, ephemeral: true });
    }

    // /flg_check
    else if (commandName === 'flg_check') {
      const raw = interaction.options.getString('champion') ?? 'Galio';
      const champion = normalizeChampion(raw);
      const row = hasWin.get(interaction.guildId, interaction.user.id, champion);
      const msg = row
        ? `✅ Oui, **${champion}** est dans ta liste TOP 1.`
        : `❌ Non, **${champion}** n’est pas dans ta liste TOP 1.`;
      await interaction.reply({ content: msg, ephemeral: true });
    }

    // /flg_list
    else if (commandName === 'flg_list') {
      const targetUser = interaction.options.getUser('user') ?? interaction.user;
      const rows = listWins.all(interaction.guildId, targetUser.id);
      const isPublicChannel = process.env.CHECKLIST_CHANNEL_ID && (interaction.channelId === process.env.CHECKLIST_CHANNEL_ID);
      const replyOpts = { ephemeral: !isPublicChannel };

      if (rows.length === 0) {
        const who = targetUser.id === interaction.user.id ? 'Tu' : `<@${targetUser.id}>`;
        await interaction.reply({ content: `📭 ${who} n’a encore aucun champion TOP 1.`, ...replyOpts });
      } else {
        const champs = rows.map(r => `• ${r.champion}`).join('\n');
        const chunks = chunkString(champs, 4000);
        const embeds = chunks.map((desc, i) =>
          new EmbedBuilder()
            .setTitle(`${targetUser.username} — ${rows.length} champion${rows.length>1?'s':''}${chunks.length>1?` (page ${i+1}/${chunks.length})`:''}`)
            .setDescription(desc)
        );
        await interaction.reply({ embeds, ...replyOpts });
      }
    }

    // /flg_remove
    else if (commandName === 'flg_remove') {
      const champRaw = interaction.options.getString('champion', true);
      if (champRaw.trim().toLowerCase() === 'all') {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`flg_remove_all:confirm:${interaction.user.id}`).setLabel('Oui, tout supprimer').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`flg_remove_all:cancel:${interaction.user.id}`).setLabel('Annuler').setStyle(ButtonStyle.Secondary)
        );
        await interaction.reply({
          content: `⚠️ Es-tu sûr de vouloir **vider toute ta liste** ?`,
          components: [row],
          ephemeral: true
        });
        return;
      }
      const champion = normalizeChampion(champRaw);
      const info = deleteWin.run(interaction.guildId, interaction.user.id, champion);
      const msg = info.changes === 0
        ? `ℹ️ ${champion} n’était pas dans ta liste.`
        : `🗑️ Retiré : **${champion}** de ta liste.`;
      await interaction.reply({ content: msg, ephemeral: true });
    }

    // /flg_remove_all
    else if (commandName === 'flg_remove_all') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`flg_remove_all:confirm:${interaction.user.id}`).setLabel('Oui, tout supprimer').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`flg_remove_all:cancel:${interaction.user.id}`).setLabel('Annuler').setStyle(ButtonStyle.Secondary)
      );
      await interaction.reply({
        content: `⚠️ Es-tu sûr de vouloir **vider toute ta liste** ?`,
        components: [row],
        ephemeral: true
      });
    }

    // /flg_leaders
    else if (commandName === 'flg_leaders') {
      const rows = countByUser.all(interaction.guildId);
      if (rows.length === 0) {
        await interaction.reply({ content: `🤷 Aucun TOP 1 enregistré.` });
        return;
      }

      const top = rows.slice(0, 10);
      const medals = ['🥇','🥈','🥉'];
      const lines = top.map((r, i) => {
        const rank = i + 1;
        const medal = medals[i] ?? `#${rank}`;
        return `${medal} <@${r.user_id}> — **${r.cnt}**`;
      }).join('\n');

      const embed = new EmbedBuilder()
        .setTitle('🏅 Classement TOP 1 (champions distincts)')
        .setDescription(lines)
        .setColor(0xF1C40F)
        .setFooter({ text: `${rows.length} joueur(s) au total` });

      await interaction.reply({ embeds: [embed] }); // public
    }

    // /flg_compare
    else if (commandName === 'flg_compare') {
      const other = interaction.options.getUser('user', true);
      const meId = interaction.user.id;
      const otherId = other.id;

      if (otherId === meId) {
        await interaction.reply({ content: `🙃 Compare-toi avec quelqu’un d’autre pour que ce soit utile.`, ephemeral: true });
        return;
      }

      const mineArr = listWins.all(interaction.guildId, meId).map(r => r.champion);
      const hisArr  = listWins.all(interaction.guildId, otherId).map(r => r.champion);

      const mine = new Set(mineArr);
      const his  = new Set(hisArr);

      const commons = [...mine].filter(c => his.has(c)).sort((a,b)=>a.localeCompare(b));
      const heNotMe = [...his].filter(c => !mine.has(c)).sort((a,b)=>a.localeCompare(b));
      const meNotHe = [...mine].filter(c => !his.has(c)).sort((a,b)=>a.localeCompare(b));

      const embed = new EmbedBuilder()
        .setTitle(`🔍 Comparaison — ${interaction.user.username} vs ${other.username}`)
        .addFields(
          { name: `✅ En commun (${commons.length})`, value: arrToBullets(commons), inline: false },
          { name: `🆚 ${other.username} a & pas toi (${heNotMe.length})`, value: arrToBullets(heNotMe), inline: false },
          { name: `🚫 Tu as & pas ${other.username} (${meNotHe.length})`, value: arrToBullets(meNotHe), inline: false },
        )
        .setColor(0x2ECC71);

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // /flg_fix_names (ADMIN)
    else if (commandName === 'flg_fix_names') {
      if (!hasAdmin(interaction)) {
        await interaction.reply({ content: '⛔ Il te faut la permission **Gérer le serveur** pour cette commande.', ephemeral: true });
        return;
      }

      const targetUser = interaction.options.getUser('user') ?? null;
      const dryRun = interaction.options.getBoolean('dry_run') ?? true;
      const forceFuzzy = interaction.options.getBoolean('force_fuzzy') ?? false;

      const changes = [];
      const noMatch = [];

      const processRow = (userId, fromName) => {
        const exact = canonicalExact(fromName);
        if (exact) {
          if (exact !== fromName) {
            changes.push({ userId, from: fromName, to: exact, type: 'case' });
            if (!dryRun) applyRenameTx(interaction.guildId, userId, fromName, exact);
          }
          return;
        }
        const fuzzy = forceFuzzy ? canonicalFuzzy(fromName) : null;
        if (fuzzy) {
          changes.push({ userId, from: fromName, to: fuzzy, type: 'fuzzy' });
          if (!dryRun) applyRenameTx(interaction.guildId, userId, fromName, fuzzy);
        } else {
          noMatch.push({ userId, name: fromName });
        }
      };

      if (targetUser) {
        const rows = listWins.all(interaction.guildId, targetUser.id);
        for (const r of rows) processRow(targetUser.id, r.champion);
      } else {
        const rows = listAllByGuild.all(interaction.guildId);
        for (const r of rows) processRow(r.user_id, r.champion);
      }

      const caseCnt  = changes.filter(c => c.type === 'case').length;
      const fuzzyCnt = changes.filter(c => c.type === 'fuzzy').length;

      const lines = [];
      lines.push(`🎯 Portée : ${targetUser ? `<@${targetUser.id}>` : 'serveur entier'}`);
      lines.push(`🧪 Mode : ${dryRun ? 'Aperçu (aucune modification appliquée)' : 'Application'}`);
      lines.push(`🔎 Fuzzy : ${forceFuzzy ? 'activé (≤2)' : 'désactivé'}`);
      lines.push(`\n✅ Corrections de casse/forme : **${caseCnt}**`);
      lines.push(`✨ Corrections fuzzy : **${fuzzyCnt}**`);
      lines.push(`❓ Non reconnus : **${noMatch.length}**`);
      if (changes.length) {
        const sample = changes.slice(0, 20).map(c => `• <@${c.userId}> : **${c.from}** → **${c.to}** (${c.type})`).join('\n');
        lines.push(`\nExemples :\n${sample}${changes.length>20?`\n… (${changes.length-20} de plus)`:''}`);
      }
      if (noMatch.length) {
        const sampleN = noMatch.slice(0, 20).map(n => `• <@${n.userId}> : ${n.name}`).join('\n');
        lines.push(`\nÀ revoir manuellement :\n${sampleN}${noMatch.length>20?`\n… (${noMatch.length-20} de plus)`:''}`);
      }

      const embed = new EmbedBuilder()
        .setTitle(`🛠️ Normalisation des noms — ${targetUser ? targetUser.username : 'serveur'}`)
        .setDescription(lines.join('\n'))
        .setColor(dryRun ? 0x95A5A6 : 0x27AE60);

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // /flg_summary
    else if (commandName === 'flg_summary') {
      const days = interaction.options.getInteger('days') ?? 7;
      const makePublic = interaction.options.getBoolean('public') ?? false;

      const cutoff = toSqliteDateTime(Date.now() - days * 86400000);

      const total = countWinsSince.get(interaction.guildId, cutoff)?.cnt ?? 0;
      const active = countActiveUsersSince.get(interaction.guildId, cutoff)?.cnt ?? 0;
      const topUserRow = topUserSince.get(interaction.guildId, cutoff);
      const topUserLine = topUserRow ? `<@${topUserRow.user_id}> (**${topUserRow.cnt}**)` : '—';

      const champs = topChampsSince.all(interaction.guildId, cutoff);
      const champsLines = champs.length
        ? champs.map((c, i) => `${i+1}. **${c.champion}** (${c.cnt}×)`).join('\n')
        : '—';

      const embed = new EmbedBuilder()
        .setTitle(`📅 Résumé — derniers ${days} jour(s)`)
        .setColor(0x3498DB)
        .addFields(
          { name: '🏆 Nouveaux TOP 1', value: String(total), inline: true },
          { name: '👥 Joueurs actifs', value: String(active), inline: true },
          { name: '⭐ Meilleur joueur', value: topUserLine, inline: false },
          { name: '📊 Champions les plus ajoutés', value: champsLines, inline: false }
        )
        .setFooter({ text: `Fenêtre depuis ${cutoff} (UTC)` });

      const inPublicArena = process.env.CHECKLIST_CHANNEL_ID && (interaction.channelId === process.env.CHECKLIST_CHANNEL_ID);
      const ephemeral = !(makePublic || inPublicArena);

      await interaction.reply({ embeds: [embed], ephemeral });
    }

    // /flg_completion
    else if (commandName === 'flg_completion') {
      const targetUser = interaction.options.getUser('user') ?? interaction.user;
      const makePublic = interaction.options.getBoolean('public') ?? false;

      const rows = listWins.all(interaction.guildId, targetUser.id);
      const have = rows.length;
      const total = CHAMPIONS.length;
      const p = percent(have, total);
      const bar = textBar(have, total, 24);

      const embed = new EmbedBuilder()
        .setTitle(`🏆 Progression — ${targetUser.username}`)
        .setColor(0x9B59B6)
        .setDescription(`${bar}  **${have}/${total}**  (${p})`)
        .addFields(
          { name: 'Derniers ajouts', value: rows.slice(-5).map(r => `• ${r.champion}`).join('\n') || '—', inline: false }
        );

      const inPublicArena = process.env.CHECKLIST_CHANNEL_ID && (interaction.channelId === process.env.CHECKLIST_CHANNEL_ID);
      const ephemeral = !(makePublic || inPublicArena);

      await interaction.reply({ embeds: [embed], ephemeral });
    }

    else if (commandName === 'flg_stats') {
      const targetUser = interaction.options.getUser('user') ?? interaction.user;
      const days = interaction.options.getInteger('days') ?? 30;
      const makePublic = interaction.options.getBoolean('public') ?? false;

      const cutoff = toSqliteDateTime(Date.now() - days * 86400000);

      const rowsDesc = listWinsWithDates.all(interaction.guildId, targetUser.id);
      const have = rowsDesc.length;
      const total = CHAMPIONS.length;

      const recent = countUserWinsSince.get(interaction.guildId, targetUser.id, cutoff)?.cnt ?? 0;

      const last = rowsDesc[0];
      const lastLine = last
        ? `**${last.champion}** — <t:${toUnixTs(last.created_at)}:R>`
        : '—';

      const recentList = rowsDesc.slice(0, 5)
        .map(r => `• ${r.champion} — <t:${toUnixTs(r.created_at)}:R>`)
        .join('\n') || '—';

      const p = percent(have, total);
      const bar = textBar(have, total, 24);

      const embed = new EmbedBuilder()
        .setTitle(`📊 Stats — ${targetUser.username}`)
        .setColor(0x00A8FF)
        .setDescription(`${bar}  **${have}/${total}**  (${p})`)
        .addFields(
          { name: `Ajouts sur ${days} j`, value: String(recent), inline: true },
          { name: 'Dernier ajout', value: lastLine, inline: true },
          { name: '5 derniers', value: recentList, inline: false }
        );

      const inPublicArena = process.env.CHECKLIST_CHANNEL_ID && (interaction.channelId === process.env.CHECKLIST_CHANNEL_ID);
      const ephemeral = !(makePublic || inPublicArena);

      await interaction.reply({ embeds: [embed], ephemeral });
    }

    // /flg_help — interactif
    else if (commandName === 'flg_help') {
      const page = 'player';
      const embed = buildHelpEmbed(page);
      const row = buildHelpRow(page, interaction.user.id);
      await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

  } catch (err) {
    console.error(err);
    const msg = { content: '❌ Une erreur est survenue.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg);
    else await interaction.reply(msg);
  }
});

// =============================
// Auto-récap hebdo — Samedi 23:42 Europe/Paris
// =============================
async function postWeeklySummaryIfDue() {
  const channelId = process.env.CHECKLIST_CHANNEL_ID;
  if (!channelId) return; // rien à faire
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return;

  const nowParis = getParisDate();
  const day = nowParis.getDay(); // 0=dimanche ... 6=samedi
  const hour = nowParis.getHours();
  const minute = nowParis.getMinutes();

  // Samedi 23:42
  if (!(day === 6 && hour === 23 && minute === 42)) return;

  // Empêche double post le même jour
  const todayKey = `weekly_summary_${parisYMD(nowParis)}`;
  const already = kvGet.get(todayKey)?.v;
  if (already === 'done') return;

  // Fenêtre = 7 jours glissants
  const cutoff = toSqliteDateTime(Date.now() - 7 * 86400000);
  const guild = ch.guild;

  const total = countWinsSince.get(guild.id, cutoff)?.cnt ?? 0;
  const active = countActiveUsersSince.get(guild.id, cutoff)?.cnt ?? 0;
  const topUserRow = topUserSince.get(guild.id, cutoff);
  const topUserLine = topUserRow ? `<@${topUserRow.user_id}> (**${topUserRow.cnt}**)` : '—';
  const champs = topChampsSince.all(guild.id, cutoff);
  const champsLines = champs.length ? champs.map((c, i) => `${i+1}. **${c.champion}** (${c.cnt}×)`).join('\n') : '—';

  const embed = new EmbedBuilder()
    .setTitle(`🗞️ Récap — Semaine`)
    .setColor(0x1ABC9C)
    .addFields(
      { name: '🏆 Nouveaux TOP 1', value: String(total), inline: true },
      { name: '👥 Joueurs actifs', value: String(active), inline: true },
      { name: '⭐ Meilleur joueur', value: topUserLine, inline: false },
      { name: '📊 Champions les plus ajoutés', value: champsLines, inline: false }
    )
    .setFooter({ text: `Période depuis ${cutoff} (UTC) • Posté automatiquement` });

  await ch.send({ embeds: [embed] });
  kvSet.run(todayKey, 'done');
}

function startWeeklySummaryScheduler() {
  // Tick chaque 30s pour réduire le risque de louper la minute
  setInterval(() => {
    postWeeklySummaryIfDue().catch(err => console.error('postWeeklySummaryIfDue error:', err));
  }, 30 * 1000);
}

client.login(process.env.DISCORD_TOKEN);
