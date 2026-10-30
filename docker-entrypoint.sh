#!/bin/sh
set -e

DATA="${PULSE_DATA_DIR:-/app/data}"
mkdir -p "$DATA"

# ── Публичный адрес ─────────────────────────────────────────────────────────
# В профиле tls панель живёт за Caddy на домене PULSE_DOMAIN. Instagram и TikTok
# забирают видео по публичной ссылке, поэтому адрес нужен самому приложению —
# подставляем его здесь, чтобы человеку не приходилось дублировать одну и ту же
# строку в двух переменных.
# Домен может быть записан по-русски (edu.каркастайги.рф). Приложению и площадкам
# нужен punycode, поэтому переводим здесь же — один раз, при старте.
# В образе всегда есть node, поэтому конвертер надёжный; если node вдруг нет —
# оставляем строку как есть, чтобы контейнер всё равно поднялся.
pulse_to_ascii() {
  if command -v node >/dev/null 2>&1; then
    node -e '
      const raw = String(process.argv[1] || "").replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0];
      try { process.stdout.write(new URL("http://" + raw).host); } catch (e) { process.stdout.write(raw); }
    ' "$1"
  else
    printf '%s' "$1" | sed -e 's|^[A-Za-z][A-Za-z0-9+.-]*://||' -e 's|/.*$||'
  fi
}
pulse_public_url() {
  case "$1" in
    http://*) printf 'http://%s' "$(pulse_to_ascii "$1")" ;;
    *) printf 'https://%s' "$(pulse_to_ascii "$1")" ;;
  esac
}

if [ -n "${PULSE_DOMAIN}" ] && [ "${PULSE_DOMAIN}" != "localhost" ]; then
  ASCII_DOMAIN="$(pulse_to_ascii "${PULSE_DOMAIN}")"
  if [ -z "${PULSE_PUBLIC_URL}" ]; then
    export PULSE_PUBLIC_URL="$(pulse_public_url "${PULSE_DOMAIN}")"
    echo "  → PULSE_PUBLIC_URL=${PULSE_PUBLIC_URL} (из PULSE_DOMAIN=${PULSE_DOMAIN})"
  fi
  # Caddy обычно получает домен из .env, но в облаке он приходит переменной.
  # Отдаём латиницу — TLS на кириллице не выпустится.
  if [ "${ASCII_DOMAIN}" != "${PULSE_DOMAIN}" ]; then
    export PULSE_DOMAIN="${ASCII_DOMAIN}"
    echo "  → PULSE_DOMAIN=${PULSE_DOMAIN} (кириллица → латиница)"
  fi
fi

# ── Права на том ────────────────────────────────────────────────────────────
# Том ./data монтируется с хоста и может принадлежать root (особенно если каталог
# создан до первого запуска). Контейнер стартует от root ровно на один шаг:
# выровнять права и уйти в пользователя node.
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA" 2>/dev/null || true
  exec gosu node node server/src/index.js
fi

exec node server/src/index.js
