#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Railway: один скрипт — один сервис с постоянным томом.
#
# Что делает:
#   1. проверяет Railway CLI и вход (railway login);
#   2. создаёт/подключает проект и сервис;
#   3. генерирует PULSE_SECRET и PULSE_PASSWORD (если не заданы) и кладёт их в
#      переменные сервиса — на публичном адресе дефолтный пароль недопустим;
#   4. подключает том к /app/data — без него база и видео исчезают при рестарте;
#   5. переносит бесплатные ключи ИИ из .env, если они там есть;
#   6. деплоит и печатает публичный адрес (Instagram/TikTok берут его сами из
#      RAILWAY_PUBLIC_DOMAIN — дублировать в PULSE_PUBLIC_URL не нужно).
#
# Использование:
#   bash deploy/railway.sh                    # спросит пароль или сгенерирует
#   PULSE_PASSWORD='…' bash deploy/railway.sh # пароль заранее
#   PULSE_MODE=live bash deploy/railway.sh    # сразу боевой режим
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

MODE="${PULSE_MODE:-demo}"
TZ_VALUE="${PULSE_TZ:-Europe/Moscow}"
MOUNT="/app/data"

say() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }
ok()  { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
die() { printf '\n  \033[1;31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

# ── 1. CLI ──────────────────────────────────────────────────────────────────
say "Проверяю Railway CLI"
if ! command -v railway >/dev/null 2>&1; then
  echo "  Railway CLI не установлен. Один из вариантов:"
  echo "    npm i -g @railway/cli"
  echo "    brew install railway"
  echo "    curl -fsSL https://railway.com/install.sh | sh"
  die "установите Railway CLI и запустите скрипт снова"
fi
ok "$(railway --version 2>/dev/null | head -n1)"

if ! railway whoami >/dev/null 2>&1; then
  say "Вход в Railway"
  echo "  Откроется браузер. Токен хранится локально в ~/.railway/config.json"
  railway login
fi
ok "вход выполнен: $(railway whoami 2>/dev/null | head -n1)"

# ── 2. Проект и сервис ──────────────────────────────────────────────────────
if railway status >/dev/null 2>&1; then
  ok "проект уже подключён ($(railway status 2>/dev/null | head -n1))"
else
  say "Создаю проект"
  # --name не даёт CLI уйти в интерактивный выбор шаблона
  railway init --name pulse || die "не удалось создать проект: войдите через railway login и повторите"
fi

# ── 3. Секреты ──────────────────────────────────────────────────────────────
say "Секреты приложения"
SECRET="${PULSE_SECRET:-$(openssl rand -hex 32 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')}"
PASSWORD="${PULSE_PASSWORD:-$(openssl rand -base64 18 2>/dev/null | tr -d '/+=' || node -e 'console.log(require("crypto").randomBytes(14).toString("base64url"))')}"

railway variables --set "PULSE_SECRET=${SECRET}" >/dev/null
railway variables --set "PULSE_PASSWORD=${PASSWORD}" >/dev/null
railway variables --set "PULSE_MODE=${MODE}" >/dev/null
railway variables --set "PULSE_TZ=${TZ_VALUE}" >/dev/null
railway variables --set "PULSE_DATA_DIR=/app/data" >/dev/null
railway variables --set "PULSE_DB_PATH=/app/data/pulse.db" >/dev/null
railway variables --set "PULSE_MEDIA_DIR=/app/data/media" >/dev/null
ok "PULSE_SECRET и PULSE_PASSWORD заданы"
ok "PULSE_MODE=${MODE}, PULSE_TZ=${TZ_VALUE}"

# Бесплатные ключи ИИ из локального .env — если есть, переносим (это и есть «ИИ
# из коробки»: один бесплатный ключ заметно поднимает качество текстов).
if [ -f .env ]; then
  for KEY in NVIDIA_API_KEY GITHUB_TOKEN GEMINI_API_KEY GROQ_API_KEY CEREBRAS_API_KEY \
             OPENROUTER_API_KEY MISTRAL_API_KEY CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_AI_TOKEN \
             PULSE_TELEGRAM_BOT_TOKEN PULSE_TELEGRAM_CHAT_ID; do
    VALUE="$(grep -E "^${KEY}=" .env | tail -n1 | cut -d= -f2- | tr -d '"' || true)"
    if [ -n "${VALUE:-}" ]; then
      railway variables --set "${KEY}=${VALUE}" >/dev/null
      ok "перенёс ${KEY} из .env"
    fi
  done
  if [ -n "${NVIDIA_API_KEY:-}${GITHUB_TOKEN:-}${GEMINI_API_KEY:-}${GROQ_API_KEY:-}" ]; then
    railway variables --set "PULSE_AI=on" >/dev/null
    ok "PULSE_AI=on (есть бесплатный ключ)"
  fi
fi

# ── 4. Том ──────────────────────────────────────────────────────────────────
say "Постоянный диск"
if railway volume list 2>/dev/null | grep -q "${MOUNT}"; then
  ok "том уже смонтирован в ${MOUNT}"
else
  railway volume add --mount-path "${MOUNT}" >/dev/null || die "не удалось подключить том — сделайте это в дашборде: Settings → Volumes → ${MOUNT}"
  ok "том подключён к ${MOUNT}"
fi

# ── 5. Деплой ───────────────────────────────────────────────────────────────
say "Собираю и деплою образ (первая сборка 3–6 минут)"
railway up --detach

say "Жду готовности сервиса"
URL=""
for _ in $(seq 1 40); do
  URL="$(railway domain 2>/dev/null | grep -Eo 'https://[^ ]+' | head -n1 || true)"
  [ -n "${URL}" ] && break
  railway domain >/dev/null 2>&1 || true
  sleep 5
done
[ -n "${URL}" ] || die "домен не появился: сделайте railway domain (Generate Domain) и проверьте railway logs"

for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "${URL}/api/health" >/dev/null 2>&1; then
    ok "сервис отвечает: ${URL}/api/health"
    break
  fi
  sleep 5
done

cat <<EOF

────────────────────────────────────────────────────────────────────────────
  Pulse на Railway: ${URL}
  Логин:            owner
  Пароль:           ${PASSWORD}

  Проверить готовность:  ${URL}/#/studio  (карточка «Готовность хостинга»)
  Логи:                  railway logs
  Обновить:              railway up --detach
  Переменные:            railway variables

  Публичный адрес Instagram/TikTok берут из RAILWAY_PUBLIC_DOMAIN — вручную
  ничего дублировать не нужно.
────────────────────────────────────────────────────────────────────────────
EOF
