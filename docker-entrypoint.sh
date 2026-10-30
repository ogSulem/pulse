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
if [ -f /usr/local/bin/pulse-domain.sh ]; then
  . /usr/local/bin/pulse-domain.sh
else
  pulse_to_ascii() { printf '%s' "$1"; }
  pulse_public_url() {
    case "$1" in http://*) printf 'http://%s' "$(printf '%s' "$1" | sed 's|^http://||')" ;; *) printf 'https://%s' "$1" ;; esac
  }
fi

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
