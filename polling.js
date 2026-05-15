const axios = require('axios');
const { exec } = require('child_process');

// ================= CONFIG =================
const API_URL = process.env.API_URL;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_CHAT_IDD = process.env.TELEGRAM_CHAT_IDD;

// ==========================================

let isRunning = true;
let errorCount = 0;

// ---------- Telegram ----------
async function sendTelegram(message) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
  });
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: TELEGRAM_CHAT_IDD,
    text: message,
  });
}

// безопасная отправка (чтобы не упала)
async function safeNotify(message) {
  try {
    await sendTelegram(message);
  } catch (e) {
    console.error('❌ Telegram error:', e.message);
  }
}

// ---------- Utils ----------
function getRandomDelay() {
  return Math.floor(Math.random() * (10000 - 3000 + 1)) + 3000;
}

// ---------- Core Poll ----------
async function poll() {
  if (!isRunning) return;

  try {
    console.log('⏳ Запрос к API...');

    const response = await axios.get(API_URL, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      },
    });

    const data = response.data;

    if (data?.allow_order === true) {
      console.log('✅ allow_order = true');

      isRunning = false;

      const message = '🚀 ORDER ALLOWED! Срочно проверь!';

      await safeNotify(message);

      // Windows popup (опционально)
      exec('start cmd /k echo ORDER ALLOWED!', () => {});

      process.exit(0);
    } else {
      console.log('❌ allow_order = false');
      errorCount = 0;
    }

  } catch (error) {
    errorCount++;

    if (error.response) {
      console.error('API ошибка:', error.response.status);
    } else if (error.request) {
      console.error('Нет ответа от сервера');
    } else {
      console.error('Ошибка:', error.message);
    }

    // уведомление если много ошибок подряд
    if (errorCount >= 5) {
      await safeNotify('⚠️ API не отвечает 5 раз подряд');
      errorCount = 0;
    }
  }

  const delay = getRandomDelay();
  console.log(`🔁 Следующий запрос через ${delay / 1000} сек\n`);

  setTimeout(safePoll, delay);
}

// ---------- Safe wrapper ----------
async function safePoll() {
  try {
    await safeNotify('🚀 Старт пулинга...');
    await poll();
  } catch (err) {
    console.error('💥 Критическая ошибка в poll:', err);

    await safeNotify(`💥 Ошибка в poll: ${err.message}`);

    setTimeout(safePoll, 5000);
  }
}

// ---------- Global crash handlers ----------
process.on('uncaughtException', async (err) => {
  console.error('💥 Uncaught Exception:', err);

  await safeNotify(`💥 CRASH: ${err.message}`);

  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('💥 Unhandled Rejection:', reason);

  await safeNotify(`💥 CRASH: ${reason}`);

  process.exit(1);
});

// ---------- Graceful shutdown ----------
process.on('SIGINT', async () => {
  console.log('⛔ SIGINT (Ctrl+C)');
  await safeNotify('⛔ Скрипт остановлен вручную');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('⛔ SIGTERM');
  await safeNotify('⛔ Скрипт остановлен системой');
  process.exit(0);
});

// ---------- Start ----------
console.log('🚀 Старт пулинга...');
safePoll();
