#!/bin/sh
set -e

# Том ./data монтируется с хоста и может принадлежать root.
# Если контейнер стартует от root — выравниваем права и уходим на пользователя node.
mkdir -p "${PULSE_DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "${PULSE_DATA_DIR:-/app/data}" 2>/dev/null || true
  exec gosu node node server/src/index.js
fi

exec node server/src/index.js
