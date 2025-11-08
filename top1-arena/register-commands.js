import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './index.js';

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

const GUILD_ID = process.env.GUILD_ID; // ← à définir dans .env

(async () => {
  try {
    if (!GUILD_ID) throw new Error('GUILD_ID manquant dans .env');
    console.log('💡 Enregistrement des commandes (guild)...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('✅ Commandes enregistrées sur la guild.');
  } catch (error) {
    console.error('Erreur register:', error);
  }
})();
