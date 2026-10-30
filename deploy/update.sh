#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Обновление Pulse на своём сервере — одна команда, без сюрпризов.
#
#   sudo bash deploy/update.sh
#   sudo bash deploy/update.sh --domain edu.каркастайги.рф
#
# Что делает:
#   1) забирает свежий main (ваши данные в ./data не трогаются);
#   2) приводит домен к рабочему виду — кириллицу в punycode, схему добавляет сам;
#   3) пересобирает образ и поднимает контейнер (с HTTPS, если домен задан);
#   4) ждёт /api/health и говорит, что открыть;
#   5) если новая версия не поднялась — печатает команду отката на прошлый коммит.
#
# Почему отдельный скрипт. install.sh — установка «с нуля», а обновление нужно
# часто и на живой системе: там нельзя перезаписывать .env, нельзя терять том и
# нельзя падать из-за того, что домен записан русскими буквами. Именно на этом
# раньше и спотыкались сторонние скрипты обновления: sed с не-ASCII, Caddy без
# punycode, «адрес без https».
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DIR="${PULSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO="${PULSE_REPO:-ogSulem/pulse}"
BRANCH="${PULSE_BRANCH:-main}"
DOMAIN_ARG=""
KEEP_ENV=1

say()  { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN_ARG="${2:-}"; shift 2 ;;
    --domain=*) DOMAIN_ARG="${1#*=}"; shift ;;
    --reset-env) KEEP_ENV=0; shift ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
      exit 0 ;;
    *) die "неизвестный ключ: $1 (есть --domain, --reset-env, --help)" ;;
  esac
done

# ── домен: одна нормализация на все скрипты ─────────────────────────────────
# shellcheck source=deploy/domain.sh
. "$DIR/deploy/domain.sh"

[ -d "$DIR" ] || die "каталог не найден: $DIR (задайте PULSE_DIR)"
cd "$DIR"

command -v docker >/dev/null 2>&1 || die "Docker не установлен. Сначала: bash deploy/install.sh"
docker compose version >/dev/null 2>&1 || die "нет docker compose v2 (docker-compose-plugin)"

# ── 1. код ──────────────────────────────────────────────────────────────────
PREV="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ -d "$DIR/.git" ]; then
  say "Обновляем код: $BRANCH (сейчас ${PREV})"
  git -C "$DIR" fetch --depth 1 origin "$BRANCH"
  # локальные правки кода не наши: они мешают fast-forward и «ломают обновление»
  git -C "$DIR" reset --hard "origin/$BRANCH"
else
  die "в $DIR нет .git — это не клон репозитория. Поставьте заново: bash deploy/install.sh"
fi
NEW="$(git -C "$DIR" rev-parse --short HEAD)"
[ "$PREV" = "$NEW" ] && say "Код уже свежий (${NEW})" || ok "Код обновлён: ${PREV} → ${NEW}"

mkdir -p data

# ── 2. домен и .env ─────────────────────────────────────────────────────────
# .env не перезаписываем: там пароль, секрет и ключи. Меняем только строки
# адреса, и только если домен задан явно (аргументом или переменной).
RAW_DOMAIN="${DOMAIN_ARG:-${PULSE_DOMAIN:-}}"

if [ ! -f .env ]; then
  [ "$KEEP_ENV" = "1" ] && warn ".env нет — создаём минимальный (пароль сгенерируем)"
  SECRET="$(openssl rand -hex 32)"
  PASS="${PULSE_PASSWORD:-$(openssl rand -hex 8)}"
  cat > .env <<EOF
PULSE_PASSWORD=${PASS}
PULSE_SECRET=${SECRET}
PULSE_MODE=${PULSE_MODE:-demo}
PULSE_TZ=${PULSE_TZ:-Europe/Moscow}
PULSE_PORT=${PULSE_PORT:-8080}
EOF
  chmod 600 .env
  printf '\n  Пароль входа: \033[1;32m%s\033[0m (в %s/.env)\n' "$PASS" "$DIR"
fi

set_env_line() { # key value
  local key="$1" value="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    # через временный файл: sed -i с «|» в значении ведёт себя по-разному в BSD/GNU
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' .env > .env.tmp
    mv .env.tmp .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}
get_env_line() { grep -m1 "^$1=" .env 2>/dev/null | cut -d= -f2- || true; }

: "${RAW_DOMAIN:=$(get_env_line PULSE_DOMAIN)}"
: "${RAW_DOMAIN:=}"

if [ -n "$RAW_DOMAIN" ]; then
  ASCII_DOMAIN="$(pulse_to_ascii "$RAW_DOMAIN")"
  PUBLIC="$(pulse_public_url "$RAW_DOMAIN")"
  [ -n "$ASCII_DOMAIN" ] || die "домен не разобрался: $RAW_DOMAIN"

  if pulse_is_unicode "$RAW_DOMAIN"; then
    ok "Домен: ${RAW_DOMAIN} → ${ASCII_DOMAIN} (так его понимают Caddy и Let's Encrypt)"
  else
    ok "Домен: ${ASCII_DOMAIN}"
  fi
  if [ "$ASCII_DOMAIN" = "$(pulse_host "$RAW_DOMAIN")" ] && pulse_is_unicode "$RAW_DOMAIN"; then
    warn "Не нашлось конвертера кириллицы (idn2/python3/node) — поставим: apt-get install -y idn2"
  fi

  # В .env и Caddy идёт латиница; кириллицу храним отдельной строкой только для справки
  set_env_line PULSE_DOMAIN "$ASCII_DOMAIN"
  set_env_line PULSE_PUBLIC_URL "$PUBLIC"
  echo "  PULSE_DOMAIN=${ASCII_DOMAIN}"
  echo "  PULSE_PUBLIC_URL=${PUBLIC}"
else
  say "Домен не задан — панель поднимется на IP:$(get_env_line PULSE_PORT || echo 8080) без HTTPS"
fi

# ── 3. сборка и запуск ──────────────────────────────────────────────────────
say "Пересобираем образ (код изменился, зависимости — по кэшу)"
docker compose build --pull

if [ -n "$(get_env_line PULSE_DOMAIN)" ]; then
  say "Поднимаем с HTTPS"
  docker compose --profile tls up -d --remove-orphans
else
  docker compose up -d --remove-orphans
fi

# ── 4. проверка живости ─────────────────────────────────────────────────────
PORT="$(get_env_line PULSE_PORT)"; PORT="${PORT:-8080}"
say "Ждём /api/health на порту ${PORT}"
HEALTHY=0
for _ in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 2
done

if [ "$HEALTHY" != "1" ]; then
  warn "Панель не ответила за 90 секунд. Последние строки лога:"
  docker compose logs --tail 40 pulse || true
  printf '\nОткат на прошлую версию:\n  git -C %s reset --hard %s && docker compose up -d --build\n' "$DIR" "$PREV"
  die "обновление не удалось — данные в $DIR/data не тронуты"
fi
ok "Панель отвечает"

# ── 5. что открыть ──────────────────────────────────────────────────────────
IP="$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)"
DOMAIN_ENV="$(get_env_line PULSE_DOMAIN)"
printf '\n\033[1;32mГотово.\033[0m\n'
if [ -n "$DOMAIN_ENV" ]; then
  if pulse_is_unicode "$RAW_DOMAIN"; then
    printf '  Открыть: https://%s  (в конфигах %s)\n' "$RAW_DOMAIN" "$DOMAIN_ENV"
  else
    printf '  Открыть: https://%s\n' "$DOMAIN_ENV"
  fi
else
  printf '  Открыть: http://%s\n' "${IP:-127.0.0.1}:${PORT}"
fi
printf '  Версия: %s\n' "$NEW"
printf '  Данные: %s/data (база, видео, бэкапы — на месте)\n\n' "$DIR"
