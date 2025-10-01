import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder,
  SelectMenuBuilder, InteractionType
} from 'discord.js';

const RUMMA_CHANNEL_ID = process.env.RUMMA_CHANNEL_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;

class RaceManager {
  constructor() {
    this.users = {};
    this.races = {};
  }

  getUser(userId) {
    if (!this.users[userId]) this.users[userId] = { balance: 1000 };
    return this.users[userId];
  }

  createRace(name, hostId, horseNames) {
    const raceId = uuidv4();
    this.races[raceId] = {
      id: raceId,
      name,
      hostId,
      status: 'open',
      horses: horseNames.map((name, idx) => ({ id: String(idx), name })),
      bets: [],
      messageId: null
    };
    return raceId;
  }

  calculateOdds(race) {
    const total = race.bets.reduce((sum, b) => sum + b.amount, 0);
    const horseTotals = {};
    race.horses.forEach(h => horseTotals[h.id] = 0);
    race.bets.forEach(b => horseTotals[b.horseId] += b.amount);
    const odds = {};
    for (let hId in horseTotals) odds[hId] = horseTotals[hId] > 0 ? (total / horseTotals[hId]) : 0;
    return odds;
  }

  distributeWinnings(race, winnerId) {
    const odds = this.calculateOdds(race);
    race.bets.forEach(b => {
      if (b.horseId === winnerId) {
        const payout = Math.floor(b.amount * odds[winnerId]);
        this.getUser(b.userId).balance += payout;
        b.payout = payout;
      } else {
        b.payout = 0;
      }
    });
  }

  async sendRaceUI(channel, raceId) {
    const race = this.races[raceId];
    if (!race) return console.log('sendRaceUI: race not found', raceId);

    const odds = this.calculateOdds(race);
    let description = race.horses.map(h => {
      const total = race.bets.filter(b => b.horseId === h.id).reduce((s,b)=>s+b.amount,0);
      return `- ${h.name} 投票合計: ${total}S オッズ: ${odds[h.id].toFixed(2)}倍`;
    }).join('\n');

    if (race.status === 'finished') {
      const winnerBets = race.bets.filter(b => b.payout > 0);
      if (winnerBets.length > 0) {
        description += `\n\n💰 配当:\n`;
        winnerBets.forEach(b => description += `<@${b.userId}>: ${b.payout}S\n`);
      } else description += `\n\n※勝者に投票したユーザーはいません。`;
    }

    const embed = new EmbedBuilder()
      .setTitle(`ルムマ: ${race.name} (${race.status === 'open' ? '投票中' : race.status === 'closed' ? '締切' : '結果'})`)
      .setDescription(description)
      .setColor(race.status === 'finished' ? 'Gold' : 'Green');

    const components = [];
    if (race.status === 'open') {
      const betRow = new ActionRowBuilder();
      race.horses.forEach(h => betRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`bet_${raceId}_${h.id}`)
          .setLabel(`単勝: ${h.name}`)
          .setStyle(ButtonStyle.Primary)
      ));

      const controlRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`close_${raceId}`)
          .setLabel('投票締切')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`declare_${raceId}`)
          .setLabel('勝者宣言')
          .setStyle(ButtonStyle.Success)
      );

      components.push(betRow, controlRow);
    }

    try {
      if (race.messageId) {
        const msg = await channel.messages.fetch(race.messageId);
        await msg.edit({ embeds: [embed], components });
      } else {
        const msg = await channel.send({ embeds: [embed], components });
        race.messageId = msg.id;
      }
    } catch (err) {
      console.error('sendRaceUI error:', err);
    }
  }

  async handleInteraction(interaction) {
    if (interaction.channelId !== RUMMA_CHANNEL_ID) return;

    if (interaction.isButton()) {
      const [action, raceId, horseId] = interaction.customId.split('_');
      const race = this.races[raceId];
      if (!race) return;

      if (action === 'bet') {
        if (race.status !== 'open') return interaction.reply({ content: '投票締切済みです。', ephemeral: true });
        const modal = new ModalBuilder()
          .setCustomId(`bet_modal_${raceId}_${horseId}`)
          .setTitle(`単勝: ${race.horses.find(h => h.id === horseId)?.name}`)
          .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('amount')
              .setLabel('投票金額(S)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          ));
        return interaction.showModal(modal);
      }

      if (action === 'close') {
        if (interaction.user.id !== race.hostId) return interaction.reply({ content: '部屋建てユーザーのみ締切可能です。', ephemeral: true });
        race.status = 'closed';
        await this.sendRaceUI(interaction.channel, raceId);
        return interaction.reply({ content: '投票を締切ました。', ephemeral: false });
      }

      if (action === 'declare') {
        if (interaction.user.id !== race.hostId) return interaction.reply({ content: '部屋建てユーザーのみ勝者入力可能です。', ephemeral: true });
        const select = new SelectMenuBuilder()
          .setCustomId(`winner_select_${raceId}`)
          .setPlaceholder('勝者を選択してください')
          .addOptions(race.horses.map(h => ({ label: h.name, value: h.id })));
        return interaction.reply({ content: '勝者を選択してください', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      }
    }

    if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith('bet_modal')) {
      const [_, raceId, horseId] = interaction.customId.split('_').slice(1);
      const race = this.races[raceId];
      if (!race || race.status !== 'open') return interaction.reply({ content: '投票締切済みです。', ephemeral: true });

      const user = this.getUser(interaction.user.id);
      const amount = parseInt(interaction.fields.getTextInputValue('amount'));
      if (isNaN(amount) || amount <= 0) return interaction.reply({ content: '正しい金額を入力してください', ephemeral: true });
      if (user.balance < amount) return interaction.reply({ content: '残高不足です。', ephemeral: true });

      user.balance -= amount;
      race.bets.push({ userId: interaction.user.id, horseId, amount, payout: 0 });
      await this.sendRaceUI(interaction.channel, raceId);
      return interaction.reply({ content: '投票完了！', ephemeral: true });
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('winner_select')) {
      const raceId = interaction.customId.split('_')[2];
      const winnerId = interaction.values[0];
      const race = this.races[raceId];
      if (!race || interaction.user.id !== race.hostId) return;

      this.distributeWinnings(race, winnerId);
      race.status = 'finished';
      await this.sendRaceUI(interaction.channel, raceId);
      return interaction.update({ content: '勝者確定！', components: [] });
    }
  }
}

// --- Bot初期化 ---
async function initBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });

  const manager = new RaceManager();

  // --- スラッシュコマンド登録 ---
  const commands = [
    new SlashCommandBuilder()
      .setName('race')
      .setDescription('レースを作成します')
      .addStringOption(option => 
        option.setName('name')
          .setDescription('レース名')
          .setRequired(true))
      .addStringOption(option => 
        option.setName('horses')
          .setDescription('馬名をカンマ区切りで入力')
          .setRequired(true))
      .toJSON()
  ];

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });

  client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
  });

  client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === 'race') {
      const name = interaction.options.getString('name');
      const horses = interaction.options.getString('horses').split(',').map(s => s.trim()).filter(s => s);
      const channel = await client.channels.fetch(RUMMA_CHANNEL_ID);
      const raceId = manager.createRace(name, interaction.user.id, horses);
      await manager.sendRaceUI(channel, raceId);
      return interaction.reply({ content: `レース "${name}" を作成しました！`, ephemeral: false });
    }

    await manager.handleInteraction(interaction);
  });

  await client.login(BOT_TOKEN);
}

initBot();
