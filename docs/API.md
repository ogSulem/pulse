# Pulse API

Базовый URL: `http://<host>:<port>/api` · формат: JSON · кодировка: UTF-8.
Авторизация: `Authorization: Bearer <token>` (кроме `/health`, `/covers/*`, `/auth/login`).

```bash
# вход
curl -s -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"pulse"}'
# → { "token": "eyJzdWIi…", "user": { "name": "Owner", "role": "owner" } }
```

Дальше во всех примерах `TOKEN` — это значение `token`.

**Коды ошибок**

| Код | Тело | Когда |
|-----|------|-------|
| 400 | `{ "error": "validation", "message": "…" }` | не хватает полей |
| 401 | `{ "error": "unauthorized", "message": "Требуется вход в панель" }` | нет/просрочен токен |
| 404 | `{ "error": "not_found" }` | объект не найден |
| 429 | `{ "error": "too_many_attempts" }` | >12 попыток входа в минуту |
| 500 | `{ "error": "server_error", "message": "…" }` | внутренняя ошибка (пишется в журнал) |

---

## 1. Проекты

Создать проект (минимум два поля — название и ниша; в ответе сразу приходят первые темы):

```bash
curl -s -X POST http://localhost:8080/api/projects \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "name": "Momentum",
    "niche": "психология привычек и продуктивность",
    "description": "Приложение-трекер привычек для 20–35 лет",
    "product_url": "https://momentum.app",
    "format": "before-after",
    "posts_per_day": 2,
    "ab_tests": true
  }'
```

```json
{
  "id": "pr_9f2c…",
  "name": "Momentum",
  "autopilot": true,
  "posts_per_day": 2,
  "ideas": [
    { "id": "id_71ab…", "title": "Почему отдых не восстанавливает", "score": 82, "format": "before-after" }
  ]
}
```

| Метод | Путь | Назначение |
|-------|------|-----------|
| GET | `/projects` | список с числом роликов |
| GET | `/projects/{id}` | один проект |
| PATCH | `/projects/{id}` | изменить ритм, формат, автопилот, A/B |
| DELETE | `/projects/{id}` | в архив (данные сохраняются) |

---

## 2. Темы и сценарии

```bash
# сгенерировать ещё 6 тем
curl -s -X POST http://localhost:8080/api/ideas/generate \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"projectId":"pr_9f2c…","count":6}'

# отправить тему в конвейер
curl -s -X POST http://localhost:8080/api/ideas/id_71ab…/episodes \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'

# поправить сценарий вручную
curl -s -X PATCH http://localhost:8080/api/scripts/sc_55de… \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "hook": "Ты не ленивый. Ты просто устал.",
    "scenes": [
      { "n": 1, "text": "Ты не ленивый. Ты просто устал.", "visual": "кадр на камеру", "seconds": 5 },
      { "n": 2, "text": "Отдых не помогает, если мозг не выключил задачи.", "visual": "схема на экране", "seconds": 8 },
      { "n": 3, "text": "Одна привычка вечером меняет утро.", "visual": "b-roll: чай, окно", "seconds": 7 }
    ],
    "hashtags": ["привычки", "психология", "саморазвитие"]
  }'
```

| Метод | Путь | Назначение |
|-------|------|-----------|
| GET | `/ideas?projectId=&status=` | библиотека тем с оценками |
| POST | `/ideas/generate` | сгенерировать темы |
| PATCH | `/ideas/{id}` | править текст/статус |
| DELETE | `/ideas/{id}` | отклонить тему |
| GET | `/scripts?projectId=` | сценарии |
| PATCH | `/scripts/{id}` | правка сцен/CTA/описания |

---

## 3. Запуск конвейера

```bash
curl -s -X POST http://localhost:8080/api/pipeline/run \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"projectId":"pr_9f2c…","count":3,"startInMinutes":5}'
```

```json
{
  "started": 3,
  "episodes": [
    { "id": "ep_2a91…", "title": "Почему отдых не восстанавливает",
      "status": "queued", "stage": "idea", "progress": 4 },
    { "id": "ep_88f0…", "status": "queued", "stage": "idea", "progress": 4 },
    { "id": "ep_1c47…", "status": "queued", "stage": "idea", "progress": 4 }
  ]
}
```

| Метод | Путь | Назначение |
|-------|------|-----------|
| POST | `/pipeline/run` | создать N роликов и поставить задачи |
| GET | `/pipeline/status` | статусы, этапы, очередь, активные ролики, провайдеры |
| POST | `/pipeline/drain` | принудительно обработать пачку задач (демо/отладка) |
| POST | `/pipeline/requeue` | вернуть dead-letter и зависшие lease |

**Статус конвейера:**

```bash
curl -s http://localhost:8080/api/pipeline/status -H "Authorization: Bearer $TOKEN"
```

```json
{
  "byStatus": { "queued": 1, "generating": 2, "review": 1, "scheduled": 3, "published": 104, "failed": 1 },
  "stages": [{ "stage": "voice", "n": 1 }, { "stage": "footage", "n": 1 }],
  "queue": { "pending": 3, "running": 0, "done": 128, "dead": 0, "nextRunAt": "2026-10-21T08:12:00.000Z" },
  "active": [
    { "id": "ep_2a91…", "title": "Почему отдых не восстанавливает",
      "status": "generating", "stage": "voice", "progress": 46, "risk": 22 }
  ],
  "upcoming": [{ "id": "ep_88f0…", "scheduled_at": "2026-10-21T09:30:00.000Z" }]
}
```

---

## 4. Ролики: просмотр, правки, действия

| Метод | Путь | Назначение |
|-------|------|-----------|
| GET | `/episodes?status=active&projectId=&limit=` | список (`active` = queued+generating+review) |
| GET | `/episodes/{id}` | ролик + публикации + события |
| POST | `/episodes` | создать вручную |
| PATCH | `/episodes/{id}` | title, description, hashtags, scenes, scheduled_at, autopilot |
| POST | `/episodes/{id}/action` | `approve`, `publish_now`, `pause`, `resume`, `retry`, `reschedule`, `duplicate` |
| DELETE | `/episodes/{id}` | удалить и снять задачи |

```bash
# подтвердить спорный ролик и поставить на 19:30
curl -s -X POST http://localhost:8080/api/episodes/ep_2a91…/action \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"action":"approve","scheduledAt":"2026-10-21T19:30:00+03:00"}'

# снять с конвейера
curl -s -X POST http://localhost:8080/api/episodes/ep_2a91…/action \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"action":"pause"}'
```

---

## 5. Аналитика

```bash
curl -s "http://localhost:8080/api/analytics/overview?days=14&projectId=all" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "days": 14,
  "totals": {
    "views": 891234, "likes": 61234, "comments": 4210, "shares": 7030,
    "clicks": 17012, "followers": 3120, "posts": 168,
    "avgViews": 5305, "engagement": 8.2, "ctr": 1.9,
    "viewsChange": 18.4, "clicksChange": 12.1, "followersChange": 9.7
  },
  "series": [{ "day": "2026-10-20", "label": "10.20", "views": 74600, "clicks": 1410, "followers": 260 }],
  "byProject": [{ "id": "pr_9f2c…", "name": "Momentum", "posts": 62, "views": 402311, "clicks": 7810, "followers": 1401 }],
  "byFormat": [{ "format": "meme", "label": "Мем / новость", "posts": 18, "views": 198442, "avg_views": 11024 }],
  "byTheme": [{ "theme": "почему отдых не восстанавливает", "views": 88120, "posts": 4, "clicks": 1502 }],
  "top": [{ "id": "pb_77aa…", "title": "Нейросети, которые делают работу", "platform": "reels",
            "views": 76293, "clicks": 1421, "ctr": 1.9, "cover_seed": "ep_…-A" }],
  "ab": [{ "episode_id": "ep_88f0…", "a_views": 45079, "b_views": 36170, "winner": "A", "lift": 24 }]
}
```

| Метод | Путь | Назначение |
|-------|------|-----------|
| GET | `/analytics/overview?days=&projectId=` | KPI, ряды, разрезы, топ, A/B |
| GET | `/analytics/publications?limit=&projectId=` | таблица публикаций с CTR |
| GET | `/export/{ideas\|episodes\|scripts\|analytics\|publications}` | CSV (UTF-8 BOM, `;`) |
| GET | `/backup` | полный JSON-дамп |

---

## 6. Аккаунты и квоты

```bash
# добавить аккаунт (стартует в прогреве)
curl -s -X POST http://localhost:8080/api/accounts \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"platform":"reels","handle":"momentum.app","daily_limit":3,"min_gap_min":95}'

# перевести в блокировку — нагрузка уйдёт на другие аккаунты
curl -s -X PATCH http://localhost:8080/api/accounts/ac_31bd… \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"blocked"}'
```

| Метод | Путь | Назначение |
|-------|------|-----------|
| GET | `/accounts` | аккаунты + остаток квоты на сегодня |
| POST | `/accounts` | добавить |
| PATCH | `/accounts/{id}` | лимиты, окно, статус, качество |
| DELETE | `/accounts/{id}` | удалить |
| POST | `/accounts/{id}/connect` | подключить реальный API: `{ token, externalId?, expiresAt? }` |
| DELETE | `/accounts/{id}/connect` | отозвать токен (аккаунт остаётся в списке) |
| GET | `/accounts/{id}/limit` | остаток квоты площадки из её же API |

### Подключение реального аккаунта

```bash
# токен приходит один раз, в БД уходит шифротекст AES-256-GCM
curl -s -X POST http://localhost:8080/api/accounts/ac_31bd…/connect \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"token":"EAAG…","externalId":"17841400000000000"}'
# → { "ok": true, "account": { "id":"ac_…", "connected": true, "has_token": true, "token_hint": "…9f2c" } }

# сколько ещё можно постить по мнению площадки
curl -s http://localhost:8080/api/accounts/ac_31bd…/limit -H "Authorization: Bearer $TOKEN"
# → { "platform":"reels", "connected":true, "limit":{"quota_total":50,"usage":7,"remaining":43,"window_sec":86400}, "source":"api" }
```

Правила ответов:

* токен **никогда** не возвращается — только `has_token`, `token_hint` (4 последних знака), `connected`;
* `POST` принимает токен длиной ≥16 символов, иначе `400`; `has_token` становится `true` сразу;
* `GET /limit` в demo-режиме или без токена возвращает `connected:false`, `limit:null` и `note` с причиной,
  а не выдуманные числа;
* `DELETE` оставляет историю публикаций — отвязывается только доступ.

---

## 7. Продукты (монетизация)

```bash
curl -s -X POST http://localhost:8080/api/products \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "name":"Pulse Pro",
    "url":"https://pulse.studio/pro",
    "pitch":"30 роликов в месяц без монтажёра",
    "proof":"18 000 роликов за квартал",
    "template":"review",
    "utm_campaign":"pro-launch"
  }'
```

`GET/PATCH/DELETE /products/{id}` — то же поле объекта.

---

## 8. Настройки, журнал, служебное

| Метод | Путь | Назначение |
|-------|------|-----------|
| GET | `/bootstrap` | всё для первого рендера панели (проекты, аккаунты, продукты, настройки, статусы, журнал) |
| GET | `/settings` · PATCH `/settings` | `autopilot_global`, `manual_review`, `risk_threshold`, `max_daily_per_account`, `timezone` |
| GET | `/logs?limit=&level=&q=` | журнал действий |
| GET | `/health` | **без токена**: `{ ok, mode, uptimeSec, queue }` |
| GET | `/covers/{seed}.svg?title=&sub=&i=` | **без токена**: детерминированная обложка 9:16 |
| POST | `/demo/reseed` | пересоздать демо-данные |

---

## 9. Live-режим: реальная публикация и OAuth

Публикация через API площадок уже реализована в провайдерах (`providers/social/tiktok.js`,
`providers/social/instagram.js`) и включается автоматически, когда у аккаунта есть токен и `PULSE_MODE=live`.
Ниже — контракты, которые остаются на стороне OAuth и вебхуков.

```http
POST /providers/video/jobs          → { externalId, provider }
GET  /providers/video/jobs/{id}     → { status: "queued|rendering|done|failed", url, thumb }
POST /providers/tts                 → { audioUrl, durationSec }

POST /accounts/{id}/oauth/start     → { authUrl }        # Meta / TikTok OAuth
GET  /oauth/callback?code=&state=   → сохраняет токен в Vault, возвращает secret_ref

POST /publications/{id}/publish     → { url, externalId }  # идемпотентно по (episode, platform, variant)
POST /webhooks/meta                 → приём статусов публикации
POST /webhooks/tiktok               → приём статусов публикации

GET  /r/{publicationId}             → 302 на продукт с UTM (считает клик и подмешивает партнёрский параметр)
```

**Идемпотентность.** Все изменяющие вызовы принимают заголовок `Idempotency-Key`.
Для публикации ключ по умолчанию `episode_id:platform:variant` — повторный запрос
возвращает существующую публикацию, а не создаёт дубль.

**Вебхуки** проверяются по подписи (`X-Hub-Signature-256` для Meta, `TikTok-Signature`),
без валидной подписи — `401`. Тело складывается в `logs` с `action = "webhook.received"`
и обрабатывается асинхронно.

**Swagger** в .NET-версии: `/swagger/v1/swagger.json`, доступ только из внутренней сети
(наружу — через BFF).

## 10. v2: медиа, проверки, деньги и postback

### Медиа

```http
GET /media/<episodeId>.mp4          # готовый ролик (Range-запросы, кеш 7 дней)
GET /media/<episodeId>-A.jpg        # обложка A
GET /media/<episodeId>-B.jpg        # обложка B
```

Публичные маршруты, без токена: файл можно скачать и загрузить в площадку вручную.

### Проверка ролика до публикации

```http
POST /api/episodes/{id}/check
Content-Type: application/json
{ "description": "текст описания", "hashtags": ["тег"], "platform": "tiktok" }
```

Ответ:

```json
{
  "compliance": {
    "ok": false, "score": 60, "platform": "tiktok",
    "blocking": [{ "id": "health-cure", "reason": "Медицинские обещания лечения…" }],
    "warnings": [{ "id": "ad-disclosure", "reason": "Есть признаки рекламы, но нет пометки" }],
    "limits": { "captionMax": 2200, "hashtagsRecommended": 6, "publishPer24h": 15 }
  },
  "viral": {
    "score": 60, "grade": "medium",
    "factors": [{ "id": "hook", "label": "Хук первой фразы", "value": 68, "weight": 0.3, "detail": "…" }],
    "advice": ["Перепишите первую фразу: вопрос, число или конфликт…"],
    "confidence": "эвристика по 6 признакам, не прогноз алгоритма"
  },
  "disclosure": "Реклама: Pulse Studio. Видео создано с помощью ИИ."
}
```

Результат сохраняется в эпизод — его видно в списке и на экране «Прозрачность».

```http
PATCH /api/episodes/{id}/caption
{ "description": "новое описание", "hashtags": ["тег1", "тег2"] }
```

Быстрая правка перед публикацией: текст и теги, без пересборки ролика.

### Деньги

```http
GET /api/money?days=30&projectId=all
```

```json
{
  "currency": "₽",
  "totals": {
    "views": 989158, "clicks": 11835, "conversions": 41,
    "revenue": 76712.46, "revenueAds": 20562.96, "revenueConv": 56149.5,
    "cost": 6864, "profit": 69848.46, "roi": 1017.6,
    "rpmAvg": 20.79, "ctr": 1.2, "cr": 0.35, "epc": 4.74,
    "profitPerVideo": 313.22, "costPerVideo": 30.78
  },
  "byPlatform": [{ "id": "reels", "name": "Instagram Reels", "profit": 40082.48, "roi": 787.01 }],
  "byProject": [{ "id": "prj_…", "name": "Pulse Studio", "profit": 70805.46 }],
  "top": [{ "title": "…", "profit": 211.3, "rpm": 25, "ctr": 1.4 }],
  "series": [{ "day": "2026-10-20", "views": 41230, "ads": 1030.75, "conversions": 3, "convRevenue": 4108.5 }],
  "assumptions": { "rpmReels": 25, "rpmTiktok": 10, "convRate": 1.6, "price": 2490, "margin": 0.55, "costPerVideo": 66 }
}
```

### Короткая ссылка и postback

```http
GET /t/{click_token}
```
Публичный маршрут: пишет клик в `clicks`, увеличивает `publications.clicks`, редиректит 302 на лендинг продукта.
Если токен неизвестен — 404 с человеческим текстом.

```http
POST /api/postback
Content-Type: application/json
{ "click_id": "cl_…", "value": 2490, "status": "paid", "external_id": "order-1234" }
```
или `{ "token": "<click_token>", "value": 2490 }`.
Если в настройках задан `postback_key`, обязателен заголовок `x-pulse-key` (или `?key=`).
Идемпотентно по `external_id`: повторный вызов не создаёт вторую конверсию.

### Прозрачность

```http
GET /api/transparency
```

Возвращает проверки системы (`ok`/`warn`), фактическое потребление лимитов площадок за 24 ч,
эпизоды, заблокированные правилами, эпизоды с низким вирусным скором, ошибки конвейера,
статистику медиа и состояние рендера (`ffmpeg`, `sharp`, шрифты, размер кадра).
