// Register (or update) Clank's global commands on Discord: /clank, "Summon Clank", /credits.
// One-time after creating the app, and again whenever the command shape changes.
// Global commands can take up to ~1h to propagate the first time.
//
// Run once DISCORD_APP_ID + DISCORD_BOT_TOKEN are in .env:
//   node --env-file=.env --import tsx scripts/register-discord-command.ts
//
// PUT replaces the full global command set with this one command (idempotent).

import { REST } from '@discordjs/rest';

const APP_ID = process.env.DISCORD_APP_ID;
const TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!APP_ID || !TOKEN) {
    console.error('Set DISCORD_APP_ID and DISCORD_BOT_TOKEN in .env first.');
    process.exit(1);
}

// Discord command types: 1 = CHAT_INPUT (slash), 3 = MESSAGE (context menu).
// Option types: 3 = STRING.
const CHAT_INPUT = 1;
const MESSAGE = 3;
const STRING = 3;

// Clank is a per-server COMMUNITY bot, not a personal "use everywhere" app, so
// both commands are locked to GUILD install + GUILD context:
//   integration_types: [0] = GUILD_INSTALL only (no user install)
//   contexts:          [0] = usable in guild channels only (no DMs)
// This keeps the tenancy model honest (one mind per server that opts in) and
// removes the "Add to My Apps / use everywhere" install option.
const GUILD_ONLY = { integration_types: [0], contexts: [0] };

const commands = [
    // /clank <prompt> — the slash command.
    {
        name: 'clank',
        type: CHAT_INPUT,
        description: 'Have Clank draw something',
        options: [{ name: 'prompt', description: 'What should Clank draw?', type: STRING, required: true }],
        ...GUILD_ONLY,
    },
    // "Summon Clank" — right-click a message → Apps → Summon Clank. Summons
    // Clank onto that message. MESSAGE commands take NO description and NO options.
    {
        name: 'Summon Clank',
        type: MESSAGE,
        ...GUILD_ONLY,
    },
    // /credits — check balance + buy more (renders premium buy buttons).
    {
        name: 'credits',
        type: CHAT_INPUT,
        description: 'Check your Clank credits and buy more',
        ...GUILD_ONLY,
    },
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

// PUT replaces the FULL global command set with exactly these (idempotent).
const result = await rest.put(`/applications/${APP_ID}/commands`, { body: commands });
console.log('Registered global commands:', JSON.stringify(result, null, 2));
console.log(
    '\n/clank + "Summon Clank" + /credits registered. (Global commands can take up to ~1h to appear the first time.)'
);
