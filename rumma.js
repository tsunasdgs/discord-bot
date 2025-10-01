import { v4 as uuidv4 } from 'uuid';
import { 
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, 
  TextInputBuilder, TextInputStyle, EmbedBuilder, 
  SelectMenuBuilder, InteractionType 
} from 'discord.js';

// --- 環境変数からルムマ可能チャンネルを設定 ---
const ALLOWED_CHANNELS = [process.env.RUMMA_CHANNEL_ID];

let users = {}; // { userId: { balance: 1000 } }
let races = {}; // { raceId: { name, hostId, status, horses, bets } }

// --- ユーザー取得/初期化 ---
function getUser(userId) {
  if (!users[userId]) users[userId] = { balance: 1000 };
  return users[userId];
}

// --- オッズ計算 ---
function calculateOdds(race) {
  const total = race.bets.reduce((sum, b) => sum + b.amount, 0);
  const horseTotals = {};
  race.horses.forEach(h => horseTotals[h.id] = 0);
  race.bets.forEach(b => horseTotals[b.horseId] += b.amount);
  const odds = {};
  for (let hId in horseTotals) {
    odds[hId] = horseTotals[hId] > 0 ? (total / horseTotals[hId]) : 0;
  }
  return odds;
}

// --- 配当計算 ---
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
    bets: []
  };
  return raceId;
}

// --- レースUIを指定チャンネルに送信 ---
export function sendRaceUI(channel, raceId) {
  const race = races[raceId];
  if (!race) return;

  const embed = new EmbedBuilder()
    .setTitle(`ルムマ: ${race.name}`)
    .setDescription(race.horses.map(h => `- ${h.name}`).join('\n'))
    .setColor('Green');

  const row = new ActionRowBuilder();
  race.horses.forEach(h => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`bet_${raceId}_${h.id}`)
        .setLabel(`単勝: ${h.name}`)
        .setStyle(ButtonStyle.Primary)
    );
  });

  channel.send({ embeds: [embed], components: [row] });
}

// ---- ルムマ用 Interaction handler ----
export async function handleInteraction(interaction) {
  if (!ALLOWED_CHANNELS.includes(interaction.channelId)) return;

  // --- ボタン処理 ---
  if (interaction.isButton()) {
    const [action, raceId, horseId] = interaction.customId.split('_');
    const race = races[raceId];

    if (action === 'bet') {
      if (!race || race.status !== 'open') {
        return interaction.reply({ content: '投票締切済みです。', ephemeral: true });
      }

      // 投票モーダル
      const modal = new ModalBuilder()
        .setCustomId(`bet_modal_${raceId}_${horseId}`)
        .setTitle(`単勝: ${race.horses.find(h => h.id === horseId)?.name}`)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('amount')
              .setLabel('投票金額(S)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          )
        );
      return interaction.showModal(modal);
    }

    if (action === 'close') {
      if (interaction.user.id !== race.hostId) {
        return interaction.reply({ content: '部屋建てユーザーのみ締切可能です。', ephemeral: true });
      }
      race.status = 'closed';
      return interaction.reply({ content: '投票を締切ました。', ephemeral: false });
    }

    if (action === 'declare') {
      if (interaction.user.id !== race.hostId) {
        return interaction.reply({ content: '部屋建てユーザーのみ勝者入力可能です。', ephemeral: true });
      }
      const select = new SelectMenuBuilder()
        .setCustomId(`winner_select_${raceId}`)
        .setPlaceholder('勝者を選択してください')
        .addOptions(race.horses.map(h => ({ label: h.name, value: h.id })));
      const row = new ActionRowBuilder().addComponents(select);
      return interaction.reply({ content: '勝者を選択してください', components: [row], ephemeral: true });
    }
  }

  // --- モーダル送信（投票） ---
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith('bet_modal')) {
    const [_, raceId, horseId] = interaction.customId.split('_').slice(1);
    const race = races[raceId];
    if (!race || race.status !== 'open') {
      return interaction.reply({ content: '投票締切済みです。', ephemeral: true });
    }

    const user = getUser(interaction.user.id);
    const amount = parseInt(interaction.fields.getTextInputValue('amount'));
    if (isNaN(amount) || amount <= 0) {
      return interaction.reply({ content: '正しい金額を入力してください', ephemeral: true });
    }
    if (user.balance < amount) {
      return interaction.reply({ content: '残高不足です。', ephemeral: true });
    }

    user.balance -= amount;
    race.bets.push({ userId: interaction.user.id, horseId, amount, payout: 0 });

    const odds = calculateOdds(race);
    const embed = new EmbedBuilder()
      .setTitle(`ルムマ: ${race.name} (投票中)`)
      .setDescription(race.horses.map(h => {
        const total = race.bets.filter(b => b.horseId === h.id).reduce((s,b)=>s+b.amount,0);
        const odd = odds[h.id].toFixed(2);
        return `- ${h.name} 投票合計: ${total}S オッズ: ${odd}倍`;
      }).join('\n'))
      .setColor('Green');

    await interaction.reply({ content: '投票完了！', ephemeral: true });
    return interaction.channel.send({ embeds: [embed] });
  }
}
