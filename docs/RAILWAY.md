# Pulse на Railway: от репозитория до работающей панели

Railway — самый короткий путь: он собирает `Dockerfile`, выдаёт https-домен, умеет
постоянный том и переменные окружения. Ниже два равнозначных сценария — **скрипт** и **дашборд** —
плюс то, что Railway не сделает за вас (том!), и честные цифры по деньгам.

---

## 0. Что важно знать заранее

| Вопрос | Ответ |
|---|---|
| Что собирается? | `Dockerfile` из корня: фронтенд `vite build` + Node-сервер + ffmpeg. Ничего ставить вручную не нужно |
| Какой порт? | Railway передаёт `PORT`; сервер слушает его сам. `railway.json` уже указывает healthcheck `/api/health` |
| Где данные? | `/app/data` внутри контейнера. **Без тома они пропадают при каждом деплое** — это пункт №1 |
| Нужен ли домен? | Нет. Railway выдаёт `https://<имя>.up.railway.app`, а Pulse сам берёт его из `RAILWAY_PUBLIC_DOMAIN` — Instagram и TikTok смогут скачивать видео |
| Сколько стоит? | Hobby $5/мес (в эту сумму входит $5 кредита на ресурсы). Пробный период — $5 на 30 дней |
| Реплики? | Ровно 1. База — SQLite на томе: две реплики дадут блокировки и дубли публикаций |

Тарифы Railway (2026): RAM $10/ГБ-мес, vCPU $20/vCPU-мес, том $0.15/ГБ-мес, трафик $0.05/ГБ.
Pulse на 0.5 ГБ RAM и 0.25 vCPU обычно укладывается в $5 кредита. Ограничение тома в Hobby — 5 ГБ,
поэтому в проекте включена уборка медиа (`PULSE_MEDIA_RETENTION_DAYS`, по умолчанию 14 дней).

---

## 1. Скрипт: две команды

```bash
cd pulse
bash deploy/railway.sh
```

Скрипт проверяет Railway CLI и вход, создаёт проект `pulse`, генерирует `PULSE_SECRET` и
`PULSE_PASSWORD`, переносит бесплатные ключи ИИ из локального `.env`, подключает том к `/app/data`,
деплоит и ждёт, пока `/api/health` ответит. В конце печатает адрес и пароль.

Если Railway CLI не установлен:

```bash
npm i -g @railway/cli     # или: brew install railway
railway login
```

Полезные переменные запуска:

```bash
PULSE_MODE=live bash deploy/railway.sh          # боевой режим сразу
PULSE_PASSWORD='мой-пароль' bash deploy/railway.sh
PULSE_TZ=Europe/Moscow bash deploy/railway.sh   # по умолчанию и так Москва
```

---

## 2. Дашборд: то же самое руками

1. **New Project → Deploy from GitHub repo** → выберите репозиторий.
   Railway сам найдёт `Dockerfile` и `railway.json` (builder `DOCKERFILE`, healthcheck `/api/health`).
2. **Variables** → добавьте:

   | Переменная | Значение | Обязательно |
   |---|---|---|
   | `PULSE_PASSWORD` | длинный пароль (16+ символов) | да |
   | `PULSE_SECRET` | `openssl rand -hex 32` | да |
   | `PULSE_MODE` | `demo` на первый запуск, потом `live` | да |
   | `PULSE_TZ` | `Europe/Moscow` | желательно |
   | `NVIDIA_API_KEY` / `GITHUB_TOKEN` / `GEMINI_API_KEY` / `GROQ_API_KEY` | любой один бесплатный ключ | для качества текстов |
   | `PULSE_AI` | `on` (если добавили ключ) | вместе с ключом |
   | `PULSE_TELEGRAM_BOT_TOKEN`, `PULSE_TELEGRAM_CHAT_ID` | сводки о поломках | по желанию |
   | `PULSE_MEDIA_RETENTION_DAYS` | `14` | по желанию |

   `PULSE_PUBLIC_URL` задавать **не нужно**: адрес берётся из `RAILWAY_PUBLIC_DOMAIN`.
3. **Settings → Volumes → Add Volume**, mount path: `/app/data`. Без этого шага база и ролики
   исчезнут после первого же рестарта.
4. **Settings → Networking → Generate Domain** — получите `https://<имя>.up.railway.app`.
5. Дождитесь зелёного деплоя и откройте адрес. Логин — пароль из `PULSE_PASSWORD`
   (если не задавали, Pulse напечатает сгенерированный в логе и в `data/first-login.txt`).

Через CLI то же самое:

```bash
railway login
railway init --name pulse
railway variables --set "PULSE_PASSWORD=$(openssl rand -base64 18)"
railway variables --set "PULSE_SECRET=$(openssl rand -hex 32)"
railway variables --set "PULSE_MODE=demo"
railway volume add --mount-path /app/data
railway up --detach
railway domain            # печатает публичный адрес
railway logs              # поток логов
```

---

## 3. Проверка после деплоя (2 минуты)

Откройте **Настройки → Хостинг** — это самодиагностика Pulse:

- том подключён и данные на постоянном диске;
- пароль не дефолтный;
- публичный адрес есть и он https (с указанием, откуда взят);
- режим `live`/`demo`;
- ffmpeg и шрифты на месте (иначе ролики не соберутся);
- сколько занято медиа и сколько свободно;
- включён ли автопилот.

Тот же расчёт доступен как API и печатается в лог при старте:

```bash
curl -s "$URL/api/health" | head -c 200
railway logs | head -20          # строка «Хостинг: ok … предупреждений …»
```

`GET /api/deploy/ready` возвращает список проверок с уровнями `ok | warn | error` и готовой
подсказкой «что сделать». Это же используется в smoke-тестах.

---

## 4. Обновления и откат

```bash
railway up --detach      # пересобрать и задеплоить текущий код
railway redeploy         # повторить последний деплой (например, после смены переменных)
railway logs             # смотреть, что происходит (Ctrl+C — выйти)
```

Каждый деплой Railway хранит как отдельный деплоймент: в дашборде **Deployments → … → Rollback**
возвращает предыдущий образ. База и медиа живут на томе и переживают откат.

Бэкап базы (без остановки сервиса): проще всего забрать файл SQLite прямо с тома —
`db.backup()` не нужен, потому что WAL уже лежит рядом.

```bash
railway volume files download /app/data/pulse.db ./pulse.db
# для полного комплекта (медиа и бэкапы): /app/data целиком
railway volume files download /app/data ./pulse-data
```

---

## 5. Что делать, если что-то не так

| Симптом | Причина | Решение |
|---|---|---|
| Сборка падает на `better-sqlite3` | нет toolchain в builder-стадии | В образе уже стоят `python3 make g++`; если меняли Dockerfile — верните их |
| `502` / healthcheck красный | сервис слушает не тот порт | Не задавайте `PORT` вручную: Railway передаёт его сам, `PULSE_PORT` только для compose |
| После рестарта пусто (нет проектов, роликов) | нет тома | Settings → Volumes → `/app/data` (или `railway volume add --mount-path /app/data`) |
| Панель открывается, публикаций нет | `PULSE_MODE=demo` | Поставьте `live` и подключите каналы (OAuth) |
| Instagram не забирает видео | адрес без https или том не тот | Адрес Railway всегда https; проверьте «Проверить публичный адрес» в студии |
| Рендер падает с `ENOSPC` | кончилось место на томе | `POST /api/storage/prune` или кнопка «Почистить медиа»; увеличьте том |
| Долгие рендеры, всё тормозит | 0.25 vCPU мало для ffmpeg | Уменьшите `PULSE_RENDER_QUALITY=medium` или возьмите больше CPU |
| Два деплоя пишут в одну базу | несколько реплик | Оставьте 1 реплику (`numReplicas: 1` уже в `railway.json`) |

---

## 6. После деплоя: чтобы заработало

1. **Каналы**: Аккаунты → «Войти через YouTube/TikTok/Instagram». Redirect URI уже
   подставляется из `RAILWAY_PUBLIC_DOMAIN`; скопируйте его в кабинет разработчика площадки.
2. **Тема канала** у каждого аккаунта — без неё ролики будут «средними».
3. **Продукт**: своя ссылка с UTM (или CPA). Pulse вставит её в описание и, если разрешите, в видео.
4. **Создать → Студия → «Включить полный автопилот»** — ролики и серии пойдут сами.
5. **Telegram-сводка** — чтобы узнавать о поломках, а не искать их.

Дальше система работает без вас; ваша роль — раз в несколько дней посмотреть сводку и
поправить то, что она отметила.

---

## 7. Если Railway не подходит

| Вариант | Стоимость | Когда выбирать |
|---|---|---|
| **Oracle Cloud Always Free** (ARM 4 OCPU / 24 ГБ) | 0 ₽ навсегда | нужен ноль расходов; инструкция — `docs/DEPLOY.md` |
| **Свой VPS** + `docker compose --profile tls` | 200–400 ₽/мес | нужен свой домен и полный контроль |
| **Локально** + `deploy/tunnel.sh` | 0 ₽ | попробовать и понять, что внутри |
| **Render / Koyeb free** | 0 ₽ | только демонстрация: диск временный, сервис засыпает |
