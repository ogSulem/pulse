#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Один разбор домена для всех скриптов: install.sh, update.sh, docker-entrypoint.sh.
#
# Зачем. Домен пишут так, как он выглядит в браузере: `edu.каркастайги.рф`.
# Caddy, Let's Encrypt и API площадок понимают только латиницу (`xn--…`),
# поэтому раньше приходилось вручную переводить домен в punycode — и почти всегда
# в этом месте что-то ругалось: то «адрес без схемы», то Caddy не берёт
# сертификат, то скрипт обновления падал на не-ASCII в sed.
#
# Теперь переводят сами скрипты. Если ни idn2, ни python3, ни node не нашлись —
# возвращаем строку как есть и честно предупреждаем, а не падаем.
# ─────────────────────────────────────────────────────────────────────────────

# Отрезает схему, путь, логин; оставляет host[:port]
pulse_host() {
  printf '%s' "$1" \
    | sed -e 's|^[A-Za-z][A-Za-z0-9+.-]*://||' \
          -e 's|/.*$||' \
          -e 's|^.*@||' \
          -e 's|[[:space:]]||g'
}

# Печатает домен в латинице (punycode). Пустая строка — если не разобрался.
pulse_to_ascii() {
  _host="$(pulse_host "$1")"
  [ -n "$_host" ] || return 0

  # Порт отделяем: idna-конвертеры не любят «домен:8443»
  _port=""
  case "$_host" in
    *:*:*) : ;;                     # IPv6 — не трогаем
    *:*) _port=":${_host##*:}"; _host="${_host%%:*}" ;;
  esac

  _ascii=""
  if command -v idn2 >/dev/null 2>&1; then
    _ascii="$(printf '%s' "$_host" | idn2 2>/dev/null || true)"
  fi
  if [ -z "$_ascii" ] && command -v python3 >/dev/null 2>&1; then
    _ascii="$(python3 -c 'import sys;sys.stdout.write(sys.argv[1].encode("idna").decode())' "$_host" 2>/dev/null || true)"
  fi
  if [ -z "$_ascii" ] && command -v node >/dev/null 2>&1; then
    _ascii="$(node -e 'try{process.stdout.write(new URL("http://"+process.argv[1]).hostname)}catch(e){}' "$_host" 2>/dev/null || true)"
  fi
  # Конвертера нет — оставляем как есть (Caddy так не сможет, но скрипт не падает)
  [ -n "$_ascii" ] || _ascii="$_host"

  # localhost и IP не трогаем
  printf '%s%s' "$_ascii" "$_port"
}

# Публичный адрес: https:// + punycode. http:// сохраняется, только если явно задан.
pulse_public_url() {
  _raw="$1"
  [ -n "$_raw" ] || return 0
  case "$_raw" in
    http://*) _scheme="http" ;;
    *) _scheme="https" ;;
  esac
  _ascii="$(pulse_to_ascii "$_raw")"
  [ -n "$_ascii" ] || return 0
  printf '%s://%s' "$_scheme" "$_ascii"
}

# Есть ли в строке не-ASCII (то есть домен записан кириллицей)
pulse_is_unicode() {
  printf '%s' "$1" | LC_ALL=C grep -q '[^ -~]'
}
