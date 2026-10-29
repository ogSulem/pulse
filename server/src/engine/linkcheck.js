// ─────────────────────────────────────────────────────────────────────────────
// Проверка ссылки продукта: единственное место, где трафик превращается в деньги.
//
// Зачем это нужно. Битая ссылка не видна в панели: ролики выходят, просмотры
// идут, а денег нет — потому что страница отдаёт 404, домен припаркован или
// редирект уводит на чужой сайт. Человек узнаёт об этом через месяц по нулям в
// статистике. Здесь та же проверка, что делает зритель: GET с сервера, с
// настоящими редиректами, таймаутом и человеческим вердиктом.
//
// Контракт: checkLink(url) → { ok, level, status, finalUrl, note, … }.
// Ничего не бросает: чтобы вызывающий код (кнопка в панели, smoke, автопилот)
// не обрастал try/catch.
// ─────────────────────────────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (compatible; PulseLinkCheck/1.0; +https://github.com/ogSulem/pulse)';

/** Ссылка с UTM-метками — та, что реально попадает в описание ролика. */
export function withUtm(rawUrl, { source = null, medium = null, campaign = null, content = null } = {}) {
  try {
    const u = new URL(String(rawUrl || '').trim());
    if (source) u.searchParams.set('utm_source', source);
    if (medium) u.searchParams.set('utm_medium', medium);
    if (campaign) u.searchParams.set('utm_campaign', campaign);
    if (content) u.searchParams.set('utm_content', content);
    return u.toString();
  } catch {
    return String(rawUrl || '');
  }
}

/** Есть ли на ссылке разметка кампании (без неё клики не с чем сравнивать). */
export function utmOf(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '').trim());
    return {
      source: u.searchParams.get('utm_source') || '',
      medium: u.searchParams.get('utm_medium') || '',
      campaign: u.searchParams.get('utm_campaign') || '',
      content: u.searchParams.get('utm_content') || '',
    };
  } catch {
    return { source: '', medium: '', campaign: '', content: '' };
  }
}

/**
 * @returns {Promise<{ok:boolean, level:'ok'|'warn'|'error', status:number|null,
 *   finalUrl:string, redirected:boolean, hostChanged:boolean, https:boolean,
 *   ms:number, note:string, error?:string}>}
 */
export async function checkLink(rawUrl, { timeoutMs = 8000 } = {}) {
  const started = Date.now();
  const finish = (patch) => ({
    ok: false, level: 'error', status: null, finalUrl: String(rawUrl || ''),
    redirected: false, hostChanged: false, https: false,
    ms: Date.now() - started, note: '', ...patch,
  });

  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    return finish({ error: 'invalid_url', note: 'Это не похоже на ссылку: нужен адрес вида https://сайт/страница' });
  }
  if (!/^https?:$/.test(url.protocol)) {
    return finish({ error: 'bad_protocol', note: `Протокол ${url.protocol} не поддерживается: нужен http или https` });
  }
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') {
    return finish({ error: 'bad_host', note: `В адресе нет домена: «${url.hostname}» — зритель такую ссылку не откроет` });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 8000));
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
    });
    // тело нам не нужно: закрываем поток, чтобы не тянуть мегабайты картинок
    try { await res.body?.cancel(); } catch { /* поток мог быть пустым */ }

    const finalUrl = res.url || url.toString();
    let finalHost = url.host;
    let finalProto = url.protocol;
    try {
      const final = new URL(finalUrl);
      finalHost = final.host;
      finalProto = final.protocol;
    } catch { /* оставляем исходные значения */ }

    const status = res.status;
    const redirected = finalUrl !== url.toString();
    const hostChanged = finalHost !== url.host;
    const https = finalProto === 'https:';
    const base = { status, finalUrl, redirected, hostChanged, https };
    const ms = Date.now() - started;

    if (status === 404 || status === 410) {
      return finish({ ...base, ms, error: 'not_found', note: `Страница не найдена (${status}): трафик из роликов уходит в пустоту` });
    }
    if (status === 403 || status === 401) {
      return finish({ ...base, ms, error: 'forbidden', note: `${status}: сайт закрыт от ботов. Скорее всего ссылка живая — проверьте вручную в браузере` });
    }
    if (status === 429) {
      return finish({ ...base, ms, error: 'rate_limited', note: '429: сайт ограничивает частоту запросов — повторите проверку позже' });
    }
    if (status >= 500) {
      return finish({ ...base, ms, error: 'server_error', note: `${status}: сайт отвечает ошибкой — сейчас трафик не конвертируется` });
    }
    if (status >= 400) {
      return finish({ ...base, ms, error: 'client_error', note: `${status}: страница не отдаётся. Проверьте адрес и права доступа` });
    }
    if (status >= 300) {
      return finish({ ...base, ms, ok: true, level: 'warn', note: `${status}: редирект без перехода — браузер может показать пустую страницу` });
    }
    if (hostChanged) {
      return finish({ ...base, ms, ok: true, level: 'warn', note: `Открывается, но редирект уводит на «${finalHost}» — убедитесь, что это ваш продукт, а не парковка домена` });
    }
    if (!https) {
      return finish({ ...base, ms, ok: true, level: 'warn', note: 'Открывается по http: браузеры и площадки помечают такие ссылки небезопасными' });
    }
    return finish({
      ...base, ms, ok: true, level: 'ok',
      note: redirected ? `Открывается (${status}), редирект внутри сайта — это нормально` : `Открывается (${status}) по https, без редиректов`,
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return finish({
      error: aborted ? 'timeout' : 'unreachable',
      note: aborted
        ? `Сайт не ответил за ${Math.round((Number(timeoutMs) || 8000) / 1000)} с — для зрителя это выглядит как «не работает»`
        : `Не удалось открыть: ${String(err?.message || err).slice(0, 120)}`,
    });
  } finally {
    clearTimeout(timer);
  }
}
