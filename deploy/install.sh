#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Pulse на чистом сервере (Ubuntu 22.04/24.04, Debian 12, Oracle Always Free ARM).
#
#   curl -fsSL https://raw.githubusercontent.com/ogSulem/pulse/main/deploy/install.sh | bash
#
# Скрипт идемпотентен: повторный запуск обновляет код и перезапускает контейнер,
# база и медиа в ./data остаются на месте.
#
# Переменные (необязательные):
#   PULSE_DIR      каталог установки      (по умолчанию /opt/pulse)
#   PULSE_REPO     git-репозиторий        (по умолчанию ogSulem/pulse)
#   PULSE_DOMAIN   домен для HTTPS        (если задан — поднимаем Caddy);
#                  можно писать по-русски: edu.каркастайги.рф
#   PULSE_PASSWORD свой пароль входа      (иначе сгенерируем и покажем)
#   PULSE_MODE     demo | live            (по умолчанию demo)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DIR="${PULSE_DIR:-/opt/pulse}"
REPO="${PULSE_REPO:-ogSulem/pulse}"
MODE="${PULSE_MODE:-demo}"

say() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }

[ "$(id -u)" = "0" ] || { warn "Запустите через sudo: sudo bash install.sh"; exit 1; }

# ── 1. Docker ────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  say "Ставим Docker"
  curl -fsSL https://get.docker.com | sh
else
  say "Docker уже установлен: $(docker --version)"
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# ── 2. Своп: сборка better-sqlite3 и рендер любят память ────────────────────
if [ ! -f /swapfile ] && [ "$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)" -lt 3500 ]; then
  say "Добавляем 2 ГБ свопа"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ── 3. Код ───────────────────────────────────────────────────────────────────
if [ -d "$DIR/.git" ]; then
  say "Обновляем код в $DIR"
  git -C "$DIR" fetch --depth 1 origin main && git -C "$DIR" reset --hard origin/main
else
  say "Клонируем $REPO в $DIR"
  if ! command -v git >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq git
  fi
  git clone --depth 1 "https://github.com/${REPO}.git" "$DIR"
fi
cd "$DIR"
mkdir -p data

# ── 3b. Домен → латиница ────────────────────────────────────────────────────
# Caddy и Let's Encrypt работают только с punycode. Человек пишет домен как в
# браузере (кириллицей) — переводим сами, чтобы не приходилось руками.
# shellcheck source=deploy/domain.sh
. "$DIR/deploy/domain.sh"
RAW_DOMAIN="${PULSE_DOMAIN:-}"
DOMAIN_ASCII=""
PUBLIC_URL=""
if [ -n "$RAW_DOMAIN" ]; then
  DOMAIN_ASCII="$(pulse_to_ascii "$RAW_DOMAIN")"
  PUBLIC_URL="$(pulse_public_url "$RAW_DOMAIN")"
  if pulse_is_unicode "$RAW_DOMAIN"; then
    say "Домен ${RAW_DOMAIN} → ${DOMAIN_ASCII}"
  fi
fi

# ── 4. Переменные окружения ─────────────────────────────────────────────────
set_env_line() { # key value
  local key="$1" value="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' .env > .env.tmp
    mv .env.tmp .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

if [ ! -f .env ]; then
  say "Генерируем .env (секрет и пароль — случайные)"
  SECRET="$(openssl rand -hex 32)"
  PASS="${PULSE_PASSWORD:-$(openssl rand -hex 8)}"
  cat > .env <<EOF
PULSE_PASSWORD=${PASS}
PULSE_SECRET=${SECRET}
PULSE_MODE=${MODE}
PULSE_TZ=Europe/Moscow
PULSE_PORT=8080
EOF
  chmod 600 .env
  printf '\n  Пароль входа: \033[1;32m%s\033[0m   (лежит в %s/.env)\n' "$PASS" "$DIR"
else
  say ".env уже есть — пароль и ключи не трогаем"
fi

if [ -n "$DOMAIN_ASCII" ]; then
  set_env_line PULSE_DOMAIN "$DOMAIN_ASCII"
  set_env_line PULSE_PUBLIC_URL "$PUBLIC_URL"
  echo "  PULSE_DOMAIN=${DOMAIN_ASCII}"
  echo "  PULSE_PUBLIC_URL=${PUBLIC_URL}"
fi

# ── 5. Сборка и запуск ──────────────────────────────────────────────────────
say "Собираем образ (первый раз 3–6 минут)"
docker compose build

if [ -n "$DOMAIN_ASCII" ]; then
  say "Поднимаем с HTTPS для ${DOMAIN_ASCII}"
  docker compose --profile tls up -d
else
  docker compose up -d
fi

# ── 6. Проверка ──────────────────────────────────────────────────────────────
say "Ждём /api/health"
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:8080/api/health" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS "http://127.0.0.1:8080/api/health" && echo

IP="$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
printf '\n\033[1;32mГотово.\033[0m Панель: http://%s:8080\n' "$IP"
[ -n "$DOMAIN_ASCII" ] && printf 'С доменом: https://%s%s\n' "$DOMAIN_ASCII" "$([ "$RAW_DOMAIN" = "$DOMAIN_ASCII" ] || printf '  (в браузере %s)' "$RAW_DOMAIN")"
cat <<'EOF'

Что дальше:
  1) войти с паролем выше;
  2) «Настройки» → режим demo → live, когда будут ключи провайдеров;
  3) бэкап: docker compose exec pulse npm run backup (или cron, см. docs/DEPLOY.md);
  4) обновление: bash deploy/update.sh (код обновится, data останется).
EOF
