'use strict';

const axios = require('axios');
const { STATUS_CODES } = require('node:http');

// ================= CONFIG =================
// Эти три значения задаются в переменных окружения Bot-Hosting.net.
const API_URL = process.env.API_URL;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Все интервалы указаны в миллисекундах.
const POLL_MIN_DELAY = 15_000;   // 15 секунд
const POLL_MAX_DELAY = 30_000;   // 30 секунд
const SUCCESS_PAUSE = 300_000;   // 5 минут
const ERROR_PAUSE = 1_800_000;   // 30 минут
const API_TIMEOUT = 15_000;     // 15 секунд

// Параметры доставки уведомлений Telegram.
const TELEGRAM_TIMEOUT = 10_000;
const TELEGRAM_MAX_ATTEMPTS = 5; // Включая первую попытку
const TELEGRAM_RETRY_DELAYS = [2_000, 4_000, 8_000, 16_000];
const MAX_TIMEOUT = 2_147_483_647;
// ==========================================

let noResponseCount = 0;
let outageNotified = false;
let stopping = false;
let stopReason = null;
let fatalInProgress = false;
let apiAbortController = null;
let telegramAbortController = null;
let interruptibleSleep = null;

function redact(value) {
  let output = String(value ?? '');
  if (TELEGRAM_TOKEN) output = output.split(TELEGRAM_TOKEN).join('[REDACTED_TOKEN]');
  if (API_URL) output = output.split(API_URL).join('[REDACTED_API_URL]');
  return output;
}

function log(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${redact(message)}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}

function validateConfig() {
  for (const [name, value] of Object.entries({ API_URL, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID })) {
    if (!value || !value.trim()) throw new Error(`Отсутствует переменная окружения ${name}`);
  }

  let url;
  try {
    url = new URL(API_URL);
  } catch {
    throw new Error('API_URL должен быть корректным URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('API_URL должен использовать протокол HTTP или HTTPS');
  }
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatDelay(delayMs) {
  return `${(delayMs / 1_000).toFixed(1)} сек.`;
}

// Retry-After в HTTP может содержать количество секунд или HTTP-дату.
function parseRetryAfter(value, now = Date.now()) {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? seconds * 1_000 : 0;
  }
  const dateMs = Date.parse(text);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - now) : 0;
}

// Ожидание по абсолютному времени. Обычное ожидание прерывается SIGTERM/SIGINT.
async function sleepUntil(deadline, { allowDuringShutdown = false } = {}) {
  while (Date.now() < deadline) {
    if (stopping && !allowDuringShutdown) return false;

    await new Promise((resolve) => {
      const remaining = Math.min(MAX_TIMEOUT, Math.max(1, deadline - Date.now()));
      let timer;
      const finish = () => {
        clearTimeout(timer);
        if (interruptibleSleep === finish) interruptibleSleep = null;
        resolve();
      };
      timer = setTimeout(finish, remaining);
      if (!allowDuringShutdown) interruptibleSleep = finish;
    });
  }
  return allowDuringShutdown || !stopping;
}

function getTelegramRetryAfter(error) {
  const bodySeconds = error.response?.data?.parameters?.retry_after;
  if (typeof bodySeconds === 'number' && Number.isFinite(bodySeconds) && bodySeconds > 0) {
    return bodySeconds * 1_000;
  }
  return parseRetryAfter(error.response?.headers?.['retry-after']);
}

// true означает, что Telegram подтвердил приём сообщения.
// При неудаче — всего 5 попыток, затем только лог (без очереди на диске).
async function safeNotify(message, { allowDuringShutdown = false } = {}) {
  for (let attempt = 1; attempt <= TELEGRAM_MAX_ATTEMPTS; attempt++) {
    if (stopping && !allowDuringShutdown) return false;

    const controller = new AbortController();
    if (!allowDuringShutdown) telegramAbortController = controller;
    try {
      const result = await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        { chat_id: TELEGRAM_CHAT_ID, text: message },
        { timeout: TELEGRAM_TIMEOUT, signal: controller.signal },
      );
      if (result.data?.ok !== true) throw new Error('Telegram вернул ответ без ok=true');
      log('INFO', `Telegram: сообщение доставлено (попытка ${attempt}/${TELEGRAM_MAX_ATTEMPTS}).`);
      return true;
    } catch (error) {
      if (stopping && !allowDuringShutdown) return false;
      const status = error.response?.status;
      const errorText = status ? `HTTP ${status}` : (error.code || error.message || 'неизвестная ошибка');
      log('WARN', `Telegram: ошибка отправки (${attempt}/${TELEGRAM_MAX_ATTEMPTS}): ${errorText}`);

      if (attempt === TELEGRAM_MAX_ATTEMPTS) break;
      let waitMs = TELEGRAM_RETRY_DELAYS[attempt - 1];
      if (status === 429) waitMs = Math.max(waitMs, getTelegramRetryAfter(error));
      if (!await sleepUntil(Date.now() + waitMs, { allowDuringShutdown })) return false;
    } finally {
      if (telegramAbortController === controller) telegramAbortController = null;
    }
  }

  log('ERROR', `Telegram: не удалось доставить сообщение после ${TELEGRAM_MAX_ATTEMPTS} попыток.`);
  return false;
}

function extractApiErrorMessage(data) {
  let value;
  if (typeof data === 'string') value = data;
  else if (data && typeof data === 'object') {
    if (typeof data.message === 'string') value = data.message;
    else if (typeof data.error === 'string') value = data.error;
    else if (data.error && typeof data.error.message === 'string') value = data.error.message;
    else if (typeof data.detail === 'string') value = data.detail;
  }
  if (!value || !value.trim()) return null;
  const cleaned = redact(value.replace(/\s+/g, ' ').trim());
  return cleaned.length > 500 ? `${cleaned.slice(0, 500)}…` : cleaned;
}

function makeHttpErrorMessage(response) {
  const code = response.status;
  const description = redact(response.statusText || STATUS_CODES[code] || 'Неизвестный HTTP-статус');
  const bodyMessage = extractApiErrorMessage(response.data);
  return [
    '❌ Ошибка API:',
    `Код: ${code}`,
    `Описание: ${description}`,
    ...(bodyMessage ? [`Сообщение: ${bodyMessage}`] : []),
  ].join('\n');
}

async function handleResponse(response, detectedAt) {
  if (response.status !== 200) {
    log('ERROR', `API: HTTP ${response.status} ${response.statusText || STATUS_CODES[response.status] || ''}`);
    const pauseMs = response.status === 429
      ? Math.max(ERROR_PAUSE, parseRetryAfter(response.headers?.['retry-after'], detectedAt))
      : ERROR_PAUSE;

    const delivered = await safeNotify(makeHttpErrorMessage(response));
    if (delivered) outageNotified = true;
    log('WARN', `Пауза после HTTP-ошибки: ${formatDelay(pauseMs)}.`);
    return { nextAt: detectedAt + pauseMs, resetErrorsAfterPause: true };
  }

  noResponseCount = 0;
  if (outageNotified) {
    // Восстановление сообщаем только после ранее ДОСТАВЛЕННОГО уведомления о сбое.
    // Даже если доставка восстановления не удалась, второй раз его не дублируем.
    outageNotified = false;
    log('INFO', 'API восстановлен.');
    await safeNotify('✅ API восстановлен.');
  }

  if (response.data?.allow_order === true) {
    log('INFO', 'allow_order = true. Пауза на 5 минут.');
    await safeNotify('✅ ORDER ALLOWED!');
    return { nextAt: detectedAt + SUCCESS_PAUSE };
  }

  log('INFO', 'allow_order = false (или поле отсутствует/имеет другой тип).');
  return { nextAt: detectedAt + randomDelay(POLL_MIN_DELAY, POLL_MAX_DELAY) };
}

async function handleNoResponse(error, detectedAt) {
  noResponseCount++;
  log('WARN', `API не ответил (${noResponseCount}/5). ${error.code || redact(error.message) || 'Нет HTTP-ответа'}`);

  if (noResponseCount >= 5) {
    const delivered = await safeNotify('⚠️ API не отвечает.\n5 последовательных ошибок.');
    if (delivered) outageNotified = true;
    log('WARN', 'Достигнуто 5 последовательных ошибок. Пауза на 30 минут.');
    return { nextAt: detectedAt + ERROR_PAUSE, resetErrorsAfterPause: true };
  }

  // Согласованная формула: R(15,30) + R(15,30) * countError * 0.5.
  const delay = Math.round(
    randomDelay(POLL_MIN_DELAY, POLL_MAX_DELAY)
    + randomDelay(POLL_MIN_DELAY, POLL_MAX_DELAY) * noResponseCount * 0.5,
  );
  return { nextAt: Date.now() + delay };
}

async function checkOnce() {
  const startedAt = Date.now();
  log('INFO', 'Запрос к API...');
  const controller = new AbortController();
  apiAbortController = controller;

  let response;
  let error;
  try {
    response = await axios.get(API_URL, {
      timeout: API_TIMEOUT,
      signal: controller.signal,
      validateStatus: () => true, // 2xx, 3xx, 4xx и 5xx обрабатываем самостоятельно.
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
      },
    });
  } catch (caughtError) {
    error = caughtError;
  } finally {
    if (apiAbortController === controller) apiAbortController = null;
  }

  if (stopping) return null;

  const detectedAt = Date.now();
  const duration = ((detectedAt - startedAt) / 1_000).toFixed(2);
  if (response) {
    log('INFO', `API: HTTP ${response.status}, длительность запроса ${duration} сек.`);
    return handleResponse(response, detectedAt);
  }
  if (axios.isAxiosError(error) && !error.response) {
    log('WARN', `API: нет ответа, длительность запроса ${duration} сек.`);
    return handleNoResponse(error, detectedAt);
  }
  throw error || new Error('Неизвестная ошибка запроса к API');
}

function requestStop(reason) {
  if (stopping || fatalInProgress) return;
  stopping = true;
  stopReason = reason;
  log('INFO', `Получен ${reason}: завершаем мониторинг.`);
  apiAbortController?.abort();
  telegramAbortController?.abort();
  interruptibleSleep?.();
}

async function run() {
  validateConfig();
  log('INFO', 'Мониторинг API запущен.');
  await safeNotify('🚀 Мониторинг API запущен.');

  while (!stopping) {
    const action = await checkOnce();
    if (stopping || !action) break;

    const msRemaining = Math.max(0, action.nextAt - Date.now());
    log('INFO', `Следующий запрос через ${formatDelay(msRemaining)}.`);
    const completed = await sleepUntil(action.nextAt);
    if (!completed) break;
    if (action.resetErrorsAfterPause) noResponseCount = 0;
  }

  if (stopReason && !fatalInProgress) {
    log('INFO', `Мониторинг остановлен (${stopReason}).`);
    await safeNotify('⛔ Мониторинг API остановлен.', { allowDuringShutdown: true });
  }
}

function fatal(error) {
  if (fatalInProgress) return;
  fatalInProgress = true;
  stopping = true;
  apiAbortController?.abort();
  telegramAbortController?.abort();
  interruptibleSleep?.();
  const details = redact(error instanceof Error ? error.message : String(error));
  log('ERROR', `Критическая ошибка: ${details}`);
  (async () => {
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
      await safeNotify(`💥 Критическая ошибка мониторинга: ${details.slice(0, 500)}`, {
        allowDuringShutdown: true,
      });
    }
  })().catch((notifyError) => {
    log('ERROR', `Не удалось обработать критическую ошибку: ${notifyError.message}`);
  }).finally(() => {
    process.exit(1);
  });
}

process.once('SIGINT', () => requestStop('SIGINT'));
process.once('SIGTERM', () => requestStop('SIGTERM'));
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

run().catch(fatal);
