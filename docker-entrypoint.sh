#!/bin/sh
set -e

DATA="${PULSE_DATA_DIR:-/app/data}"
mkdir -p "$DATA"

# ── Публичный адрес ─────────────────────────────────────────────────────────
# В профиле tls панель живёт за Caddy на домене PULSE_DOMAIN. Instagram и TikTok
# забирают видео по публичной ссылке, поэтому адрес нужен самому приложению —
# подставляем его здесь, чтобы человеку не приходилось дублировать одну и ту же
# строку в двух переменных.
if [ -z "${PULSE_PUBLIC_URL}" ] && [ -n "${PULSE_DOMAIN}" ] && [ "${PULSE_DOMAIN}" != "localhost" ]; then
  export PULSE_PUBLIC_URL="https://${PULSE_DOMAIN}"
  echo "  → PULSE_PUBLIC_URL=${PULSE_PUBLIC_URL} (из PULSE_DOMAIN)"
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
