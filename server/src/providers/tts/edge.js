// ─────────────────────────────────────────────────────────────────────────────
// Edge TTS — бесплатная нейронная озвучка без ключа и без лимитов.
//
// Тот же движок, что читает текст в Microsoft Edge: голоса ru-RU-DmitryNeural,
// ru-RU-SvetlanaNeural и сотни других. Для сериалов это принципиально: 15 минут
// текста в ElevenLabs стоят денег, а здесь — 0 ₽ и качество выше, чем у любого
// бесплатного «робота» локального синтеза.
//
// Протокол неофициальный, но стабильный годами:
//   1) WebSocket wss://speech.platform.bing.com/.../edge/v1 с TrustedClientToken
//      и Sec-MS-GEC (sha256 от 5-минутного окна времени + токен);
//   2) кадр speech.config (формат audio-24khz-48kbitrate-mono-mp3);
//   3) кадр Path:ssml с <speak><voice><prosody>;
//   4) обратно идут бинарные кадры Path:audio до turn.end.
//
// Если сервис недоступен (сеть, смена протокола) — бросаем ошибку, а вызывающий
// код откатывается на другой TTS. Никаких «тихих» роликов без звука.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import WSClient from 'ws';
import { log } from '../../core/logger.js';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_VERSION.split('.')[0];
const WSS_HOST = 'speech.platform.bing.com';
const WSS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';

export const EDGE_VOICES = {
  'ru-narrator': 'ru-RU-DmitryNeural',
  'ru-female': 'ru-RU-SvetlanaNeural',
  'en-narrator': 'en-US-AndrewMultilingualNeural',
  'en-female': 'en-US-AvaMultilingualNeural',
};

/** Голос из настроек → имя голоса Edge (короткие алиасы удобны в .env). */
export function resolveVoice(voiceId) {
  if (!voiceId) return EDGE_VOICES['ru-narrator'];
  if (EDGE_VOICES[voiceId]) return EDGE_VOICES[voiceId];
  return /^[a-z]{2}-[A-Z]{2}-\w+Neural$/.test(voiceId) ? voiceId : EDGE_VOICES['ru-narrator'];
}

/**
 * Sec-MS-GEC: sha256(hex) от «тиков» Windows-времени (100-нс с 1601 года),
 * округлённых вниз до 5 минут, склеенных с публичным токеном клиента.
 * Без этого сервис отвечает 403 — так отсекают сторонние клиенты.
 */
export function secMsGec(nowMs = Date.now()) {
  const WIN_EPOCH_OFFSET_SEC = 11644473600n;
  const ticks = (BigInt(Math.floor(nowMs / 1000)) + WIN_EPOCH_OFFSET_SEC) * 10000000n;
  const rounded = ticks - (ticks % 3000000000n); // окно 5 минут
  return crypto.createHash('sha256').update(`${rounded}${TRUSTED_CLIENT_TOKEN}`).digest('hex').toUpperCase();
}

const timestamp = () => new Date().toISOString();
const requestId = () => crypto.randomUUID().replace(/-/g, '');

/** Экранирование текста для SSML: иначе «&» или «<» ломают разметку. */
export function escapeSsml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Разбиваем длинный текст по предложениям: у сервиса лимит на один запрос. */
export function splitText(text, maxChars = 2600) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return [clean];
  const parts = [];
  let current = '';
  for (const sentence of clean.match(/[^.!?…]+[.!?…]+[»"']?|[^.!?…]+$/g) || [clean]) {
    if ((current + sentence).length > maxChars && current) { parts.push(current.trim()); current = ''; }
    if (sentence.length > maxChars) {
      // предложение-монстр: режем по словам
      for (const word of sentence.split(' ')) {
        if ((current + ' ' + word).length > maxChars && current) { parts.push(current.trim()); current = ''; }
        current += (current ? ' ' : '') + word;
      }
    } else {
      current += sentence;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

function ssmlFor(text, voice, rate = 0, pitch = 0) {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ru-RU'>`
    + `<voice name='${voice}'><prosody pitch='${pitch >= 0 ? '+' : ''}${pitch}Hz' rate='${rate >= 0 ? '+' : ''}${rate}%' volume='+0%'>`
    + `${escapeSsml(text)}</prosody></voice></speak>`;
}

/**
 * Синтез одного куска текста. Возвращает Buffer с mp3.
 * `WebSocketImpl` можно подменить (в тестах — сервер на `ws`).
 */
export async function synthesizeChunk({
  text, voice = EDGE_VOICES['ru-narrator'], rate = 0, pitch = 0, timeoutMs = 60000, WebSocketImpl = null, url = null,
} = {}) {
  const WS = WebSocketImpl || WSClient;
  if (!WS) throw new Error('Edge TTS: нет WebSocket-клиента (нужен пакет ws)');

  const endpoint = url || `wss://${WSS_HOST}${WSS_PATH}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
    + `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}`;

  return new Promise((resolve, reject) => {
    const chunks = [];
    const id = requestId();
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* уже закрыт */ }
      if (err) reject(err);
      else if (!chunks.length) reject(new Error('Edge TTS: сервис вернул пустой звук'));
      else resolve(Buffer.concat(chunks));
    };

    const socket = new WS(endpoint, {
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
        Cookie: `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};`,
      },
    });

    const timer = setTimeout(() => finish(new Error(`Edge TTS: таймаут ${Math.round(timeoutMs / 1000)} с`)), timeoutMs);

    socket.onopen = () => {
      socket.send(
        `X-Timestamp:${timestamp()}\r\n`
        + 'Content-Type:application/json; charset=utf-8\r\n'
        + 'Path:speech.config\r\n\r\n'
        + JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        }),
      );
      socket.send(
        `X-RequestId:${id}\r\n`
        + 'Content-Type:application/ssml+xml\r\n'
        + `X-Timestamp:${timestamp()}\r\n`
        + 'Path:ssml\r\n\r\n'
        + ssmlFor(text, voice, rate, pitch),
      );
    };

    socket.onmessage = (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        if (data.includes('Path:turn.end')) finish(null);
        else if (data.includes('Path:turn.start') === false && /Path:error/i.test(data)) finish(new Error('Edge TTS: сервис вернул ошибку'));
        return;
      }
      // бинарный кадр: 2 байта длины заголовков, заголовки, затем mp3
      try {
        const buf = Buffer.from(data);
        if (buf.length < 2) return;
        const headerLen = buf.readUInt16BE(0);
        const header = buf.subarray(2, 2 + headerLen).toString('ascii');
        if (!/Path:audio/i.test(header)) return;
        const audio = buf.subarray(2 + headerLen);
        if (audio.length) chunks.push(audio);
      } catch { /* битый кадр пропускаем */ }
    };

    socket.onerror = () => finish(new Error('Edge TTS: соединение не установлено (403/сеть/прокси)'));
    socket.onclose = (event) => {
      if (!settled) finish(chunks.length ? null : new Error(`Edge TTS: соединение закрыто (код ${event?.code ?? '?'})`));
    };
  });
}

/**
 * Синтез произвольного текста: режем на куски и склеиваем mp3.
 * Для mp3 прямое склеивание корректно (кадры независимы), поэтому ffmpeg не нужен.
 */
export async function synthesize({ text, voiceId = null, rate = 0, pitch = 0, onProgress = null } = {}) {
  const voice = resolveVoice(voiceId);
  const parts = splitText(text);
  const started = Date.now();
  const buffers = [];
  for (const [i, part] of parts.entries()) {
    // 403 у Edge TTS — почти всегда расхождение часов (Sec-MS-GEC считается по
    // времени сервера). Один ретрай с новым токеном лечит это, а не роняет серию.
    let buf;
    try {
      buf = await synthesizeChunk({ text: part, voice, rate, pitch });
    } catch (err) {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        buf = await synthesizeChunk({ text: part, voice, rate, pitch });
      } catch (retryErr) {
        log({
          level: 'warn', actor: 'provider.tts.edge', action: 'tts.failed',
          message: `Edge TTS не ответил дважды: ${String(retryErr.message || retryErr).slice(0, 160)}`,
          meta: { part: i + 1, total: parts.length, first: String(err.message || err).slice(0, 120) },
        });
        throw retryErr;
      }
    }
    buffers.push(buf);
    if (onProgress) onProgress({ part: i + 1, total: parts.length });
  }
  const audio = Buffer.concat(buffers);
  log({
    level: 'info', actor: 'provider.tts.edge', action: 'tts.generated',
    message: `Edge TTS: ${parts.length} частей, ${audio.length} байт, ${voice}`,
    meta: { voice, ms: Date.now() - started, chars: String(text).length },
  });
  return {
    provider: 'edge',
    voice,
    audioBuffer: audio,
    audioFormat: 'mp3',
    // ~15 символов в секунду для нейронной озвучки на русском
    durationSec: Math.max(2, Math.round(String(text).length / 15)),
    parts: parts.length,
  };
}
