import { v4 as uuidv4 } from 'uuid';
import { 
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, 
  TextInputBuilder, TextInputStyle, EmbedBuilder, 
  SelectMenuBuilder, InteractionType 
} from 'discord.js';

const ALLOWED_CHANNELS = [process.env.RUMMA_CHANNEL_ID];

let users = {}; 
let races = {}; 

function getUser(userId) {
  if (!users[userId]) users[userId] = { balance: 1000 };
  return users[userId];
}

function calculateOdds(race) {
  const total = race.bets.reduce((sum, b) => sum + b.amount, 0);
  const horseTotals = {};
  race.horses.forEach(h => horseTotals[h.id] = 0);
  race.bets.forEach(b => horseTotals[b.horseId] += b.amount);
  const odds = {};
  for (let hId in horseTotals) odds[hId] = horseTotals[hId] > 0 ? (total / horseTotals[hId]) : 0;
  return odds;
}

function distributeWinnings(race, winnerId) {
  const odds = calculateOdds(race);
  race.bets.forEach(b => {
    if (b.horseId === winnerId) {
      const payout = Math.floor(b.amount * odds[winnerId]);
      getUser(b.userId).balance += payout;
      b.payout = payout;
    } else {
      b.payout = 0;
    }
  });
}

// --- レース作成 ---
export function createRace(name, hostId, horseNames) {
  const raceId = uuidv4();
  races[raceId] = {
    name,
    hostId,
    status: 'open',
    horses: horseNames.map((name, idx) => ({ id: String(idx), name })),
    bets: [],
    messageId: null
  };
  return raceId;
}

// --- Embed更新（投票中／締切／結果） ---
export async function updateRaceEmbed(channel, raceId) {
  const race = races[raceId];
  if (!race) return;

  const odds = calculateOdds(race);
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
    race.horses.forEach(h => {
      betRow.addComponents(
        new ButtonBuilder().setCustomId(`bet_${raceId}_${h.id}`).setLabel(`単勝: ${h.name}`).setStyle(ButtonStyle.Primary)
      );
    });
    const controlRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`close_${raceId}`).setLabel('投票締切').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`declare_${raceId}`).setLabel('勝者宣言').setStyle(ButtonStyle.Success)
    );
    components.push(betRow, controlRow);
  }

  if (race.messageId) {
    try {
      const msg = await channel.messages.fetch(race.messageId);
      await msg.edit({ embeds: [embed], components });
    } catch {
      const msg = await channel.send({ embeds: [embed], components });
      race.messageId = msg.id;
    }
  } else {
    const msg = await channel.send({ embeds: [embed], components });
    race.messageId = msg.id;
  }
}

// --- Interaction Handler ---
export async function handleInteraction(interaction) {
  if (!ALLOWED_CHANNELS.includes(interaction.channelId)) return;

  // --- ボタン ---
  if (interaction.isButton()) {
    const [action, raceId, horseId] = interaction.customId.split('_');
    const race = races[raceId];
    if (!race) return;

    if (action === 'bet') {
      if (race.status !== 'open') return interaction.reply({ content: '投票締切済みです。', ephemeral: true });
      const modal = new ModalBuilder()
        .setCustomId(`bet_modal_${raceId}_${horseId}`)
        .setTitle(`単勝: ${race.horses.find(h => h.id === horseId)?.name}`)
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('amount').setLabel('投票金額(S)').setStyle(TextInputStyle.Short).setRequired(true)
        ));
      return interaction.showModal(modal);
    }

    if (action === 'close') {
      if (interaction.user.id !== race.hostId) return interaction.reply({ content: '部屋建てユーザーのみ締切可能です。', ephemeral: true });
      race.status = 'closed';
      await updateRaceEmbed(interaction.channel, raceId);
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

  // --- モーダル（投票） ---
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith('bet_modal')) {
    const [_, raceId, horseId] = interaction.customId.split('_').slice(1);
    const race = races[raceId];
    if (!race || race.status !== 'open') return interaction.reply({ content: '投票締切済みです。', ephemeral: true });

    const user = getUser(interaction.user.id);
    const amount = parseInt(interaction.fields.getTextInputValue('amount'));
    if (isNaN(amount) || amount <= 0) return interaction.reply({ content: '正しい金額を入力してください', ephemeral: true });
    if (user.balance < amount) return interaction.reply({ content: '残高不足です。', ephemeral: true });

    user.balance -= amount;
    race.bets.push({ userId: interaction.user.id, horseId, amount, payout: 0 });
    await updateRaceEmbed(interaction.channel, raceId);
    return interaction.reply({ content: '投票完了！', ephemeral: true });
  }

  // --- 勝者セレクト ---
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('winner_select')) {
    const raceId = interaction.customId.split('_')[2];
    const winnerId = interaction.values[0];
    const race = races[raceId];
    if (!race || interaction.user.id !== race.hostId) return;

    distributeWinnings(race, winnerId);
    race.status = 'finished';
    await updateRaceEmbed(interaction.channel, raceId);
    return interaction.update({ content: '勝者確定！', components: [] });
  }
}
