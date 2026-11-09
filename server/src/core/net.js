// ─────────────────────────────────────────────────────────────────────────────
// Сеть: у каждого исходящего запроса есть потолок времени.
//
// Node не ставит тайм-аут на fetch. Если провайдер принял соединение и «завис»
// (так бывает у бесплатных тарифов), задача висела до общего лимита очереди
// (7 минут), а сокет оставался открытым: через месяцы такого поведения процесс
// копил висящие соединения и память. Теперь по умолчанию 120 секунд на запрос,
// а явный `signal` вызывающего всегда главнее.
//
// Настройка: PULSE_FETCH_TIMEOUT_SEC (0 — выключить потолок).
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SEC = Number(process.env.PULSE_FETCH_TIMEOUT_SEC ?? 120);

if (Number.isFinite(DEFAULT_SEC) && DEFAULT_SEC > 0) {
  const baseFetch = globalThis.fetch;
  if (typeof baseFetch === 'function' && !baseFetch.__pulseTimeout) {
    const wrapped = (input, init = {}) => {
      if (init.signal) return baseFetch(input, init);
      return baseFetch(input, { ...init, signal: AbortSignal.timeout(DEFAULT_SEC * 1000) });
    };
    wrapped.__pulseTimeout = true;
    globalThis.fetch = wrapped;
  }
}

export const fetchTimeoutSec = () => (Number.isFinite(DEFAULT_SEC) && DEFAULT_SEC > 0 ? DEFAULT_SEC : null);

/** fetch с явным таймаутом — когда нужен свой лимит, а не общий. */
export async function fetchWithTimeout(input, init = {}, timeoutMs = null) {
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : (DEFAULT_SEC > 0 ? DEFAULT_SEC * 1000 : null);
  if (!ms || init.signal) return fetch(input, init);
  return fetch(input, { ...init, signal: AbortSignal.timeout(ms) });
}
