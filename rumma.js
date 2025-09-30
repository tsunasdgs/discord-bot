export const handleCommand = async (interaction) => {
  if (interaction.commandName === 'gacha_pull') {
    // 仮実装: SR/SSR確率でアイテムを返す
    await interaction.reply({ content:'ガチャを引きました（仮）', ephemeral:true });
  }
};
