#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Бесплатный публичный HTTPS-адрес для Pulse — без домена, без карты, без аккаунта.
#
# Зачем это нужно:
#   • Instagram Reels публикуется не файлом, а ссылкой: площадка сама скачивает
#     видео по адресу из PULSE_PUBLIC_URL. Без публичного адреса Reels не выйдет;
#   • TikTok и YouTube требуют точный redirect URI в кабинете разработчика;
#   • проверка «открывается ли панель снаружи» в студии смотрит именно этот адрес.
#
# Cloudflare Quick Tunnel даёт случайный https-адрес вида
#   https://what-ever-words.trycloudflare.com
# Он бесплатный и не требует аккаунта. Адрес живёт, пока запущен скрипт:
# для постоянного адреса нужен домен (Caddy-профиль в docker-compose).
#
# Использование:
#   bash deploy/tunnel.sh            # панель на порту 8080
#   PULSE_PORT=3000 bash deploy/tunnel.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PORT="${PULSE_PORT:-8080}"
LOG="${PULSE_TUNNEL_LOG:-/tmp/pulse-tunnel.log}"

echo "→ Проверяем, что Pulse отвечает на 127.0.0.1:${PORT}…"
if ! curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
  echo "  ✗ панель не отвечает. Сначала запустите: docker compose up -d (или npm start)"
  exit 1
fi
echo "  ✓ панель работает"

CF="$(command -v cloudflared || true)"
if [ -z "${CF}" ]; then
  echo "→ cloudflared не найден — скачиваем официальный бинарь (один файл, без установки)"
  case "$(uname -m)" in
    aarch64|arm64) ARCH=arm64 ;;
    armv7l) ARCH=arm ;;
    *) ARCH=amd64 ;;
  esac
  CF="${TMPDIR:-/tmp}/cloudflared"
  curl -fsSL -o "${CF}" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}"
  chmod +x "${CF}"
  echo "  ✓ ${CF}"
fi

echo "→ Поднимаем туннель на http://localhost:${PORT}"
echo "  (адрес появится ниже через 3–10 секунд; лог: ${LOG})"
: > "${LOG}"

"${CF}" tunnel --url "http://localhost:${PORT}" --no-autoupdate 2>&1 | tee -a "${LOG}" &
TUNNEL_PID=$!
trap 'kill ${TUNNEL_PID} 2>/dev/null || true' EXIT INT TERM

URL=""
for _ in $(seq 1 40); do
  URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "${LOG}" | head -n1 || true)"
  [ -n "${URL}" ] && break
  sleep 1
done

if [ -z "${URL}" ]; then
  echo "  ✗ не удалось получить адрес. Смотрите лог: ${LOG}"
  exit 1
fi

cat <<EOF

────────────────────────────────────────────────────────────────────────────
  Публичный адрес:  ${URL}

  Пропишите в .env и перезапустите контейнер:
      PULSE_PUBLIC_URL=${URL}

  Redirect URI для кабинетов разработчика:
      ${URL}/api/oauth/youtube/callback
      ${URL}/api/oauth/tiktok/callback
      ${URL}/api/oauth/reels/callback

  Проверка из панели: «Студия → Проверить публичный адрес».
  Туннель живёт, пока открыт этот терминал. Для постоянного адреса —
  домен + Caddy: docker compose --profile tls up -d
────────────────────────────────────────────────────────────────────────────
EOF

wait "${TUNNEL_PID}"
