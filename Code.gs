function keepBotAwake() {
  // ここに先ほど確認したRenderのURLを入力
  const url = 'https://discord-bot-1y6u.onrender.com/';
  
  try {
    const response = UrlFetchApp.fetch(url);
    console.log('✅ Bot wake up successful:', response.getResponseCode());
  } catch (error) {
    console.error('❌ Bot wake up failed:', error);
  }
}

// 手動テスト用関数
function testKeepAwake() {
  keepBotAwake();
}