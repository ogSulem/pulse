# ─────────────────────────────────────────────────────────────────────────────
# Pulse в Docker.
#
# Один образ, три способа запуска:
#   • локально:            docker compose up -d --build
#   • свой сервер + HTTPS: docker compose --profile tls up -d --build   (Caddy, домен)
#   • платформа:           Railway / Render / Fly читают этот же Dockerfile и PORT
#
# Что важно и почему именно так:
#   • ffmpeg ставим системный (пакет Debian), а не npm-биндинг: @ffmpeg-installer
#     есть не под все архитектуры, а рендер нужен всегда — в том числе на ARM;
#   • tzdata обязателен: в образе по умолчанию нет зоны Europe/Moscow, а от неё
#     зависят часы публикаций и дата в сводке;
#   • tini как PID 1: ffmpeg-дети корректно получают SIGTERM при рестарте, иначе
#     остаются зомби и «битые» mp4 в томе;
#   • контейнер стартует от root ровно на один шаг (выровнять права тома) и сразу
#     уходит в пользователя node — так том, смонтированный с хоста, работает, а
#     сервис не работает от root;
#   • база и медиа — только в /app/data. Тома платформ и docker compose монтируют
#     именно этот каталог, поэтому «данные пропали после рестарта» невозможно.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV NODE_ENV=development \
    npm_config_update_notifier=false \
    npm_config_fund=false

# Нативные сборки better-sqlite3 (если под платформу нет prebuilt-бинаря)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Зависимости отдельным слоем: правка исходников не пересобирает npm ci
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
RUN npm ci --no-audit --no-fund

# Интерфейс собирается внутри образа: наружу отдаётся готовый SPA
COPY web ./web
RUN npm --workspace web run build \
    && npm prune --omit=dev --no-audit --no-fund

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Pulse" \
      org.opencontainers.image.description="Конвейер коротких видео: идея → сценарий → озвучка → видео → публикация → деньги" \
      org.opencontainers.image.source="https://github.com/ogSulem/pulse" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# PORT не задаём: Railway/Render/Fly передают свой, docker compose — PULSE_PORT.
# PULSE_DATA_DIR — единственный каталог состояния: его и надо монтировать томом.
ENV NODE_ENV=production \
    PULSE_DATA_DIR=/app/data \
    PULSE_DB_PATH=/app/data/pulse.db \
    PULSE_MEDIA_DIR=/app/data/media \
    PULSE_TZ=Europe/Moscow \
    TZ=Europe/Moscow

RUN apt-get update && apt-get install -y --no-install-recommends \
      gosu ffmpeg tini tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/web/dist ./web/dist
COPY package.json ./package.json
COPY server ./server

RUN mkdir -p /app/data && chown -R node:node /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080
VOLUME ["/app/data"]
STOPSIGNAL SIGTERM

# Healthcheck работает и на платформе (PORT), и локально (PULSE_PORT/8080).
# Проверяем не «процесс жив», а что API отвечает — этого же ждут Railway и compose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.PULSE_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
