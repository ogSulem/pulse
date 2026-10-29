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
| POST | `/accounts` | добавить (`platform`: `reels` / `tiktok` / `youtube`, `project_id` — бренд аккаунта) |
| PATCH | `/accounts/{id}` | лимиты, окно, статус, качество, площадка, `project_id` (`""` — универсальный) |
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

### Интеллект: расписание, прогноз, A/B

| Метод | Путь | Что возвращает |
|-------|------|----------------|
| GET | `/insights/schedule?days=&projectId=` | профиль 24 часов по площадкам, лучшие часы, источник (`prior`/`data`), следующий слот с причиной |
| GET | `/insights/forecast?episodeId=` | прогноз охвата, дохода, прибыли и ROI ролика + разложение по множителям |
| GET | `/insights/growth?days=` | здоровье проектов (`scale`/`hold`/`fix`/`pause`), A/B-сводка, качество аккаунтов, рейтинг роликов по прогнозу |
| POST | `/insights/apply-policy` | применить темп автопилота по деньгам (1–6 постов в день), вернуть что изменилось |
| GET | `/abtest/summary?projectId=` | сколько тестов закрыто, средний разрыв, предпочитаемый вариант проекта |
| POST | `/abtest/evaluate` | принудительно закрыть созревшие тесты и вернуть решения |
| POST | `/insights/recalibrate` | пересчитать веса вирусного скора на своих роликах |

```bash
curl -s "http://localhost:8080/api/insights/schedule" -H "Authorization: Bearer $TOKEN"
# → { "timezone": "Europe/Moscow",
#     "platforms": [{ "platform": "reels", "learned": true, "samples": 153,
#                     "best": [{ "hour": 19, "score": 1.02, "samples": 54, "source": "data" }, …] }],
#     "plan": { "at": "2026-10-22T16:07:00.000Z", "hour": 19, "source": "data",
#               "reason": "19:07 — ваш лучший час по 54 публикациям (скор 1.02)" } }

curl -s "http://localhost:8080/api/insights/forecast?episodeId=ep_…" -H "Authorization: Bearer $TOKEN"
# → { "expectedViews": 4628, "revenue": 63.4, "cost": 66, "profit": -2.6, "roi": -4,
#     "factors": { "baseline": 3200, "baselineSource": "project", "viral": {…}, "hour": {…}, "account": {…} } }
```

`POST /abtest/evaluate` отвечает списком решений: `{ episodeId, winner: "A"|"B"|"tie", lift, ctrA, ctrB }`.
Разница считается симметрично (A/B = 5000/2000 → `+60%`), а при разнице меньше 8% тест закрывается как `tie`.

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

---

## 11. Реклама: бренды, кампании, маркировка

Каждая кампания — это данные, а не переписка в мессенджере: бюджет, модель оплаты, сроки, @бренд,
хештеги, erid и бриф. Конвейер читает их сам.

| Метод | Путь | Что делает |
|-------|------|------------|
| GET | `/api/ads/overview` | кампании со статистикой, итоги (начислено / оплачено / дебиторка / CPM / ROI), риски маркировки, ближайшие дедлайны |
| GET | `/api/brands` | список брендов (юрлицо, ИНН, контакт) |
| POST | `/api/brands` | создать бренд |
| GET | `/api/campaigns` | кампании со статистикой (`stats`) |
| POST | `/api/campaigns` | создать кампанию (можно сразу с новым брендом по `brandName`) |
| GET | `/api/campaigns/{id}` | кампания + выходы (`posts`) + привязанные ролики (`episodes`) + текст маркировки |
| PATCH | `/api/campaigns/{id}` | изменить бюджет, ставку, статус, дедлайн, erid и т. д. |
| DELETE | `/api/campaigns/{id}` | удалить кампанию вместе с историей выходов |
| POST | `/api/campaigns/{id}/pay` | записать оплату (`{ "amount": 20000 }`) — дебиторка уменьшается |
| POST | `/api/campaigns/{id}/attach` | привязать кампанию к ролику (`{ "episodeId": "ep_…" }`) |
| GET | `/api/episodes/{id}/campaign` | кампания ролика, готовый текст маркировки и превью описания |
| DELETE | `/api/episodes/{id}/campaign` | отвязать кампанию от ролика |
| POST | `/api/ads/autofill` | разложить кампании по свободным роликам (`{ "limit": 5 }`) |

### Создание кампании

```http
POST /api/campaigns
Authorization: Bearer <token>
Content-Type: application/json

{
  "brandName": "Nordwind", "legalName": "ООО «Нордвинд»", "inn": "7701234567",
  "name": "Зимняя капсула", "model": "fixed",
  "budget": 180000, "rate": 45000, "postsTarget": 4, "dailyCap": 1,
  "endsAt": "2026-12-01", "erid": "2VtzqxP9dKf",
  "mention": "@nordwind", "hashtags": ["#nordwind", "#зима"],
  "brief": "Показать 3 вещи из капсулы, без «купите»"
}
```

`model`:

| Модель | Как считается начисление за выход |
|--------|-----------------------------------|
| `fixed` | `rate / posts_target` — фиксированная сумма, разложенная по выходам договора |
| `cpm` | `просмотры / 1000 × rate` |
| `cpa` | `конверсии × rate` (конверсии по публикации из `conversions`) |
| `barter` | 0 — деньги не начисляются, но выходы, сроки и маркировка учитываются |

### Ответ `/api/ads/overview`

```json
{
  "campaigns": [
    { "id": "cm_…", "name": "FitFlow — приложение тренировок", "modelLabel": "за 1000 показов",
      "brand_name": "FitFlow", "status": "active", "erid": "2VtzqwR4mNp",
      "stats": { "posts": 14, "postsTarget": 24, "revenue": 25765.76, "paid": 10874.3,
                 "receivable": 14891.46, "cpm": 320, "views": 80471, "postsLeft": 10,
                 "budgetLeft": 64234.24, "todayPosts": 0, "dailyCap": 2, "canPost": true } }
  ],
  "totals": { "active": 2, "all": 4, "revenue": 93565.76, "paid": 69554.3, "receivable": 24011.46,
              "spend": 1056, "profit": 92509.76, "roi": 8760, "budget": 420000,
              "budgetLeft": 326434.24, "views": 212657, "cpm": 439.98, "posts": 36 },
  "risks": [],
  "deadlines": [{ "campaignId": "cm_…", "name": "FitFlow — приложение тренировок", "postsLeft": 10, "days": 20 }]
}
```

### Маркировка

Пометка собирается из данных кампании и попадает в описание при публикации (идемпотентно —
повторная обработка не дублирует блок):

```
Реклама. ООО «Нордвинд». ИНН 7701234567. erid: 2VtzqxP9dKf
```

`GET /api/episodes/{id}/campaign` возвращает готовый `disclosure` и `preview` описания:

```json
{ "campaign": { "name": "…", "modelLabel": "фикс за ролик", "stats": { "…": "…" } },
  "disclosure": "Реклама. ИП Соколова А. В. ИНН 770987654321. erid: 2VtzqwR4mNp",
  "preview": "Три вещи из капсулы…\n\n@nordwind\n\n#nordwind #зима\n\n#реклама\n\nРеклама. …" }
```

Если у кампании `marking = "erid"` нет токена, публикация блокируется проверкой комплаенса
(`ad-erid-missing`), а отсутствие пометки «Реклама» в описании — правилом `ad-marking-missing`.

---

## 12. Рост (v6): портфель, хуки, удержание, монетизация

Экран «Рост» опирается на шесть эндпоинтов. Все они читают те же таблицы, что и движок, поэтому
цифры в интерфейсе и в решениях автопилота совпадают.

| Метод | Путь | Назначение |
|-------|------|-----------|
| GET | `/growth/overview?days=30` | всё для экрана одним запросом |
| GET | `/growth/trends?days=30` | радар трендов и собственные форматы |
| GET | `/growth/hooks?topic=…&platform=…` | лаборатория хуков |
| POST | `/growth/retention` | проверка удержания по сценарию |
| GET | `/growth/monetization` | путь к деньгам по всем каналам |
| GET | `/growth/playbook/{accountId}` | план ведения аккаунта |
| GET | `/episodes/{id}/gate` | вердикт перед публикацией |

### `GET /api/growth/overview`

```json
{ "portfolio": { "accounts": [ { "handle": "pulse.studio", "platform": "youtube", "platformLabel": "YouTube Shorts",
      "followers": 9800, "views30": 113000, "retention": 62.3, "retentionTarget": 65,
      "usedToday": 0, "leftToday": 2, "health": 95,
      "nextAction": { "tone": "success", "text": "Продолжать темп и тестировать новый хук", "action": "scale" } } ],
    "platforms": [ { "platform": "youtube", "label": "YouTube Shorts", "accounts": 3, "followers": 14150,
      "retention": 60.7, "retentionTarget": 65, "idealSec": [22, 45], "capacity": 5 } ],
    "totals": { "accounts": 8, "followers": 117250, "views30": 1591761, "avgRetention": 58.6,
      "capacityPerDay": 16, "demandPerDay": 5, "headroom": 11 } },
  "trends": { "trends": [ { "label": "Зацикленный ролик (loop)", "status": "hot", "verdict": "снимай сейчас" } ] },
  "monetization": { "programs": [ { "id": "youtube-ypp-1", "progress": 69, "etaText": "204 дн." } ] },
  "ads": { "totals": { "revenue": 83286 }, "campaigns": [] },
  "platforms": { "…": "плейбуки площадок: окно хука, длительность, темп" } }
```

`days` принимает 7/14/30; влияет на окно охвата в портфеле и на радар трендов.

### `GET /api/growth/hooks`

```bash
curl -s "http://localhost:8080/api/growth/hooks?topic=привычки&platform=youtube" -H "Authorization: Bearer $TOKEN"
```

```json
{ "topic": "привычки", "platform": "youtube", "platformLabel": "YouTube Shorts",
  "best": { "id": "pain-question", "text": "Почему «привычки» не даёт результата?",
            "score": 70, "hookScore": 76, "viralScore": 54, "fitsWindow": true, "readableSec": 2.8 },
  "hooks": [ "…7 вариантов с оценками…" ],
  "guidance": [ "Решение о свайпе: 2.1 с — хук должен звучать сразу, без «привет, друзья».",
                "Длительность: 22–45 с, досмотр целимся в 65%." ] }
```

`topic` необязателен: без него берётся тема проекта или эпизода (`projectId` / `episodeId`).

### `POST /api/growth/retention`

```json
{ "platform": "youtube", "title": "Почему Shorts не залетают",
  "scenes": [ { "text": "Первые 2 секунды решают всё", "seconds": 4 } ],
  "hashtags": ["#shorts", "#youtube", "#контент"] }
```

```json
{ "verdict": "tune", "predictedCompletion": 71, "targetCompletion": 65, "durationSec": 9,
  "hook": { "text": "Первые 2 секунды решают всё", "seconds": 2, "score": 76, "windowSec": 2.1 },
  "checks": [ { "id": "duration", "ok": false, "severity": "warn",
                "text": "Длительность 9 с (оптимум 22–45 с)", "fix": "Добавьте смысла до 22 с" } ] }
```

`verdict`: `ready` (0–1 замечание), `tune` (2–3), `rewrite` (4+), `fix` (есть блокирующее).
Без `hashtags` теги считаются из описания.

### `GET /api/growth/monetization`

Пять программ с прогрессом по каждому условию и ETA по фактической скорости:

```json
{ "totals": { "followers": 117250, "views30": 1591761, "youtubeAccounts": 3, "tiktokFollowers": 53800 },
  "programs": [
    { "id": "youtube-ypp-1", "name": "YouTube Partner Program — ранний доступ", "progress": 69,
      "etaText": "204 дн.", "requirements": [ { "label": "просмотры Shorts за 90 дней", "have": 224000, "need": 3000000 } ] },
    { "id": "youtube-ypp-2", "progress": 51, "etaText": "больше года",
      "note": "Shorts-просмотры не конвертируются в 4000 часов: у Shorts свой порог." },
    { "id": "tiktok-rewards", "progress": 100, "regionLimited": true,
      "regionNote": "Только US, UK, DE, FR, JP, KR, MX, BR" },
    { "id": "brand-deals", "progress": 84 }, { "id": "own-product", "progress": 100 } ] }
```

`regionLimited` — не украшение: TikTok Creator Rewards реально недоступна РФ-аккаунтам, и UI
проговаривает это прямо, вместо обещания «100% готово».

### `GET /api/episodes/{id}/gate`

```json
{ "verdict": "go", "score": 89, "platform": "reels", "platformLabel": "Instagram Reels",
  "blockers": [], "warnings": [],
  "retention": { "predictedCompletion": 60, "targetCompletion": 60 },
  "viral": { "score": 67 }, "forecast": { "expectedViews": 1642 },
  "quota": { "left": 7, "cap": 50 } }
```

`verdict`: `go` — можно публиковать, `fix` — есть замечания (публикация возможна, но хуже),
`block` — блокирующее правило (комплаенс, маркировка, нет файла). `score` 0..100 — та же величина,
которую видит автопилот при решении.

### `GET /api/growth/playbook/{accountId}`

```json
{ "account": { "handle": "fitflow.daily", "platform": "reels", "status": "warmup", "followers": 6122 },
  "phase": "warmup", "phaseLabel": "Прогрев",
  "cadence": { "daily": 2, "weekly": 14 },
  "ramp": [ { "week": 1, "perDay": 1 } ],
  "rules": [ "…" ], "issues": [ "…" ],
  "benchmarks": { "hookWindowSec": 1.3, "idealSec": [20, 45], "completionTarget": 0.6 } }
```


---

## 13. План, аудит и база знаний (v6.1)

| Метод | Путь | Назначение |
|-------|------|-----------|
| GET | `/growth/plan?days=7&projectId=` | календарь: что, когда и на какой аккаунт выйдет |
| GET | `/growth/audit` | что мешает охвату и деньгам, с действиями |
| GET | `/growth/knowledge` | лимиты, алгоритмы, монетизация и границы |

### `GET /api/growth/plan`

```json
{ "days": 7,
  "plan": [ { "date": "2026-10-22", "weekday": "чт", "slots": [
      { "platform": "tiktok", "platformLabel": "TikTok", "project": "Pulse Studio",
        "account": { "id": "ac_…", "handle": "pulse.studio" }, "time": "12:07",
        "topic": "Нейросети, которые реально делают работу за тебя",
        "format": "before-after",
        "hook": "Почему «Нейросети, которые реально делают» не даёт результата?",
        "hookScore": 70, "fitsWindow": true, "expectedViews": 2900, "expectedRevenue": 29.5,
        "targetSec": "45–90", "why": "1.3 с на хук · досмотр 55% · тема из библиотеки" } ] } ],
  "totals": { "posts": 68, "perWeek": 68, "expectedViews": 184775, "expectedRevenue": 4147.94,
              "byPlatform": { "reels": 42, "tiktok": 14, "youtube": 12 } },
  "rules": [ "Один ролик — один аккаунт внутри площадки…" ] }
```

Слоты создаются только для активных аккаунтов бренда и в пределах `daily_limit`; у Shorts — не больше
одного выхода в день и 4 дней в неделю.

### `GET /api/growth/audit`

```json
{ "score": 56, "counts": { "block": 0, "warn": 3, "info": 2 },
  "issues": [ { "id": "tiktok-private", "severity": "warn",
                "title": "TikTok публикует SELF_ONLY",
                "impact": "Ролики в TikTok видны только вам — просмотров и подписчиков не будет",
                "fix": "Подать клиент TikTok Content Posting на аудит…",
                "action": { "label": "Открыть настройки", "to": "#/settings" } } ] }
```

`severity`: `block` — публикация или охват невозможны, `warn` — теряются охват/деньги, `info` — улучшение.

### `GET /api/growth/knowledge`

```json
{ "platforms": [ { "platform": "youtube", "label": "YouTube Shorts",
    "api": { "per24h": 100, "initPerMin": 6, "note": "…", "official": "https://…" },
    "fields": { "captionMax": 5000, "titleMax": 100, "tagRange": [3, 5], "hashtagsMax": 15, "videoMaxSec": 180 },
    "algorithm": { "hookWindowSec": 2.1, "idealSec": [22, 45], "completionTarget": 65 },
    "demotions": [ "…" ], "notes": [ "…" ] } ],
  "monetization": [ { "id": "tiktok-rewards", "region": "только US, UK, DE, FR, JP, KR, MX, BR — в РФ недоступна" } ],
  "general": { "quotas": [ "…" ], "marking": { "ru": "…", "ai": "…" }, "truth": [ "…" ] } }
```

Все числа берутся из `engine/limits.js` и `engine/compliance.js` — база знаний не может противоречить
проверкам публикации.

## 14. Студия: креатив под ключ (v7)

### `GET /api/studio/options`

Что можно собрать: проекты, активные продукты, площадки с лимитами и текущая доля продающих
роликов (`promoShare`).

### `POST /api/studio`

Собирает пакет под площадку. Тело: `{ projectId, ideaId?, platform, durationSec, promo, productId?, count? }`,
где `promo` — `auto` (решает правило 80/20) | `direct` | `soft` | `none`.

Ответ: `{ project, platform, durationSec, promo, best, candidates, guidance }`.
Каждый кандидат содержит `scenes` (текст титра + роль + секунды), `captions` для всех трёх площадок,
`title`, `coverText`, `pinnedComment`, `hashtags`, `scores { total, hook, viral, retention, retentionTarget, compliance }`,
`warnings[]` и `alternativeHooks[]`.

### `POST /api/studio/queue`

Ставит готовый пакет в очередь. Тело: `{ projectId, platform, durationSec, promo, productId?, package? }`.
Если `package` не передан, пакет собирается заново. Возвращает созданный эпизод со статусом `queued`;
сцены, описание под площадку, `promo` и паспорт креатива уже записаны.

### `POST /api/episodes/{id}/package/regenerate`

Пересобирает креатив существующего ролика (`{ platform?, promo? }`) и возвращает
`{ episode, candidates, guidance }`. Старые сцены и описание заменяются, продукт и промо-режим
остаются, если не переданы явно.

### `POST /api/pipeline/drain`

Прогоняет очередь. По умолчанию отвечает сразу: `{ started: true, limit, queue }` — рендер
продолжается в фоне. Для сценариев и CI: `{ "wait": true }` → `{ processed, queue, waited: true }`.

## 15. Сериалы (v8): библия, сезон, серии, сборка и деньги

Все маршруты требуют токен (`Authorization: Bearer …`). Сериал — отдельная сущность,
не связанная с `episodes` короткого формата.

### `GET /api/series`

Сводка: `{ series[], genres[], render, totals, pipeline }`. `totals` содержит число серий,
опубликованных, суммарные минуты, просмотры, доход, часы просмотра и остаток до 4000 часов YPP.
`pipeline` — шесть шагов производства с пояснениями для интерфейса.

### `GET /api/series/genres`

Жанры с RPM-диапазонами (`₽/1000`): `zombie 120–260`, `mystery 140–300`, `noir 160–340`,
`scifi 150–320`, `folk 110–240`.

### `POST /api/series`

Тело: `{ title, genre?, premise?, tone?, projectId?, episodes_planned?, episode_sec? }`.
Создаёт сериал, сразу строит **библию** и **план сезона** (3–8 серий с аркой).
Возвращает сериал с `bible`, `season_plan` и счётчиками.

### `GET /api/series/{id}`

Сериал целиком: библия, план сезона, `episode_list` и `economics` (доход, расход,
окупаемость серии, часы до YPP, прогноз по охватам).

### `PATCH /api/series/{id}`

Правит `title, genre, premise, tone, status, playlist_id, show_id, project_id, notes,
episodes_planned, episode_sec, bible`.

### `POST /api/series/{id}/bible`

Тело: `{ variant? }`. Пересобирает библию (другой мир и герои при том же названии).

### `POST /api/series/{id}/plan`

Тело: `{ startAt?, perWeek? }`. Пересобирает арку сезона: названия, логлайны, крючки,
даты выхода. Возвращает `{ ok, plan, series }`.

### `GET /api/series/{id}/episodes`

Список серий: `scenes`, `chapters`, `scores`, `authenticity`, `forecast`, `frames`,
`cover_paths`, `cuts`, `video_path`, `stage`.

### `POST /api/series/{id}/episodes`

Тело: `{ episodeNo?, targetSec?, variant? }`. Генерирует сценарий серии и сохраняет его.
По умолчанию берёт следующий номер и длительность сериала.

Ответ серии: `durationSec`, `minutes`, `words`, `wpm`, `midRolls`, `rollsAt`, `scenes[]`
(`n, beat, beatLabel, at, text, seconds, visual, shot, frame{prompt}, sfx, roll`),
`chapters[]`, `description` (с таймкодами глав), `tags`, `thumbText`, `titleVariants[]`,
`scores{total,hook,retention,authenticity,monetization}`, `authenticity{score,checks,verdict,similarity}`,
`forecast`, `disclosure`, `frames[]`.

### `POST /api/series/{id}/preview`

То же, что генерация серии, но **без сохранения** — для «покажи, что получится».

### `GET /api/series/episodes/{id}` · `PATCH /api/series/episodes/{id}`

Чтение и правка серии (`title, description, thumb_text, publish_at, stage, tags,
title_variants, script, scenes`).

### `POST /api/series/episodes/{id}/recompose`

Тело: `{ variant? }`. Переписывает сценарий (по умолчанию следующая вариация) и заново
прогоняет аудит оригинальности с учётом соседних серий.

### `POST /api/series/episodes/{id}/voice`

Тело: `{ voiceId? }`. Режет серию на секции ≤3200 знаков, синтезирует каждую, пишет mp3
в `data/media`, считает себестоимость. В demo-режиме файлов нет, но тайминг и стоимость
считаются: `{ ok, sections, chars, audioSec, costCents, files, demo }`.

### `POST /api/series/episodes/{id}/render`

Собирает видео 16:9: фото-ряд (свой кадр на сцену), субтитры, озвучка. По умолчанию
запускает в фоне и отвечает `202 { accepted: true }`. С `?wait=1` ждёт результат:
`{ ok, videoPath, posterPath, coverPaths{A,B,C}, bytes, durationSec, width:1920, height:1080,
scenes, captions, audio, renderMs }`.

### `POST /api/series/episodes/{id}/cuts`

Тело: `{ count? }`. Планирует вертикальные нарезки 15–60 с из самых сильных сцен:
`{ ok, cuts[{ index, startAt, seconds, title, scenery, episodeNo }] }`.

### `POST /api/series/episodes/{id}/cuts/queue`

Тело: `{ platform?, count? }`. Отправляет нарезки в **общий конвейер коротких роликов**:
создаёт эпизоды в `episodes` со сценами (крючок → тело → «полная серия в профиле»),
описанием с CTA на сериал, `promo: 'soft'` и меткой источника. Дальше их публикует обычная
очередь: креатив, комплаенс и лимиты площадок берутся из существующего конвейера.
Возвращает `{ ok, queued, episodes[{ episodeId, title, scenes }] }`.

### `POST /api/series/episodes/{id}/cuts/render`

Собирает нарезки 1080×1920 с текстом-крючком. Возвращает `cuts` с `videoPath`.

### `POST /api/series/episodes/{id}/publish`

Тело: `{ privacy? }`. Загружает серию как **обычное видео** (не Shorts), создаёт плейлист
сезона при первой публикации, добавляет серию в него и подставляет ссылку на плейлист в
описание — так сессия продолжается следующей серией, а не заканчивается на одной. Возвращает
`{ ok, url, videoId, privacy, playlistId, inPlaylist, checklist[] }`.

### `POST /api/series/episodes/{id}/schedule`

Тело: `{ publishAt? }`. Переводит **собранную** серию в `stage = 'scheduled'` (без `video_path`
возвращает `schedule_failed`). Дальше `sweepDueSeriesEpisodes()` ставит задачу `series.publish`
в очередь, и серия выходит сама — если в настройках включено «Серии выходят по расписанию сами»
(`series_autopublish = 1`, по умолчанию включено). Ошибка публикации возвращает серию в
`review` с текстом причины, поэтому цикл не повторяется бесконечно.

### `POST /api/series/metrics/refresh`

Пересчитывает метрики опубликованных серий: в live — из YouTube Data API, в demo — по
модели роста. Обновляет `views`, `rpm`, `revenue_cents`. Вызывается и планировщиком
(раз в ~20 с вместе с остальной аналитикой).

### `GET /api/series/{id}/economics?targetRub=50000`

Экономика: `totalViews, totalRevenueRub, watchHours, ypp{hoursLeft}, target{viewsNeeded,
episodesNeeded}, costRub, profitRub, margin, perEpisodeCost, breakevenViews, rpm, forecast,
plan, advice[]`.

## 16. Студия, OAuth и нейро-кадры (v9)

### `GET /api/oauth/status`

Что настроено из OAuth и какой redirect URI вставлять в кабинет площадки:

```json
{ "configured": false, "publicUrl": "",
  "platforms": [{ "id": "youtube", "label": "YouTube", "configured": false,
    "redirectUri": "https://pulse.example.com/api/oauth/youtube/callback",
    "scopes": ["youtube.upload", "youtube.readonly"],
    "missing": ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"],
    "docs": "https://console.cloud.google.com/apis/credentials" }] }
```

Без `PULSE_PUBLIC_URL` в `redirectUri` подставляется origin запроса. `missing` — точные имена
переменных, которых не хватает (их видно в интерфейсе, не нужно гадать).

### `GET /api/oauth/{platform}/start[?accountId=…]`

`platform ∈ youtube | tiktok | reels`. Возвращает `{ url, state, platform, redirectUri }` —
фронтенд делает `location.href = url`. Без ключей приложения — `400 oauth_not_configured`
с текстом, какие переменные добавить. `accountId` — привязать вход к уже созданной карточке
аккаунта, иначе аккаунт заведётся сам по профилю канала.

### `GET /api/oauth/{platform}/callback?code=…&state=…`

Публичный (до auth-middleware). Обменивает код, тянет профиль канала, шифрует токены и
редиректит на `/#/accounts?connected=1` либо `/#/accounts?error=<причина>`.

### `GET /api/studio/overview`

Чек-лист запуска и состояние интеграций:

```json
{ "mode": "live", "progress": 64, "nextStep": { "id": "product", "title": "Добавить свой продукт" },
  "steps": [{ "id": "account", "done": true, "weight": 3, "title": "…", "text": "…",
              "action": { "label": "Аккаунты", "to": "#/accounts" } }],
  "stats": { "accounts": 3, "connected": 2, "withTopic": 2, "products": 1, "series": 1,
             "seriesEpisodes": 4, "shortsPublished": 37 },
  "integrations": { "frames": { "enabled": true, "active": "pollinations", "mode": "auto", "minGapSec": 15, "cached": 42 },
                    "oauth": { "platforms": ["…"] }, "providers": { "…": ["…"] },
                    "render": { "available": true }, "settings": { "series_frames": "auto" } },
  "secrets": { "passwordIsDefault": false, "publicUrl": "https://pulse.example.com" } }
```

### `GET /api/health`

Добавлен блок `frames` (`enabled, active, mode, minGapSec, cached`): по нему видно, пойдёт
нейро-ряд или процедурные плашки, ещё до запуска серии.

### Аккаунты: тема и персона

`PATCH /api/accounts/{id}` принимает `topic, language, visual_style, persona` (объект: тон,
обращение, чего не говорить). `GET /api/accounts` отдаёт `auth_state` (`ok | expired | none`),
`refreshable`, `expires_at` и распарсенный `persona`.

### Продукты: где показывать

`POST /api/products` и `PATCH /api/products/{id}` принимают `placement` (`video | caption | both`,
по умолчанию `both`) и `always` (0/1). `placement = video` убирает ссылку из описания и
pin-комментария, `caption` — не пускает продукт в сцены, `always = 1` даёт прямой CTA в каждом
ролике (маркировка рекламы сохраняется).

### Сериалы: автопилот и фото-ряд

`PATCH /api/series/{id}` дополнительно принимает `auto_compose`, `auto_render`, `lookahead` (1–6)
и `frame_mode` (`auto | neural | procedural`). `GET /api/series` отдаёт `frames` и `autopilot`
(`enabled, render[], lookahead, due{composed, queued, planned}`) — `due` считается в режиме
`dryRun` и не меняет данные.

---

## 15. ИИ: статус, живой тест и пересборка текста

### `GET /api/ai/status`

Показывает реальную цепочку, а не «включено/выключено»:

```json
{ "enabled": true, "mode": "live", "active": "nvidia", "cached": 12,
  "providers": [
    { "id": "nvidia", "label": "NVIDIA NIM", "model": "meta/llama-3.3-70b-instruct",
      "keyEnv": "NVIDIA_API_KEY", "configured": true, "free": true,
      "rpm": 40, "rpd": null, "callsToday": 7, "active": true,
      "note": "100+ открытых моделей, 40 запросов/мин, карта не нужна",
      "docs": "build.nvidia.com → Get API Key (nvapi-…)" }
  ] }
```

`configured` — есть ли ключ (для локальной Ollama — включена ли она), `free` — есть ли бесплатный
уровень, `callsToday` — расход суточной квоты из `data/ai-cache/usage.json`.

### `POST /api/ai/test`

Живой запрос к первому доступному провайдеру. Успех — `200`:

```json
{ "ok": true, "provider": "nvidia", "model": "meta/llama-3.3-70b-instruct", "ms": 812, "text": "{\"ok\":true}" }
```

Ошибка — `400` с `{ "ok": false, "reason": "…" }`. Кнопка в UI — «Настройки → ИИ-движок».
Результат не кэшируется: проверяется именно канал связи и ключ.

### `POST /api/series/episodes/{id}/ai`

Пересобрать текст серии моделью: нарратив режется по уже существующим сценам (пропорционально
секундам), чистит остатки шаблона, пересчитывает WPM и заново прогоняет аудит оригинальности.
Сцены, тайминг фото-ряда и обложки не меняются — операция безопасная.

```json
{ "ok": true, "words": 1056, "wpm": 133, "audit": { "score": 88, "similarity": 12 },
  "episode": { "id": "se_…", "title": "Мёртвая станция · Серия 1" } }
```

`409 ai_unavailable` — нет ключа или `PULSE_AI=off`; `400 ai_compose_failed` — модель ответила,
но текста меньше 60 % от нужного объёма (серия не портится, остаётся прежняя версия).

### `POST /api/series/{id}/bible`

Пересобрать библию сериала (мир, герои, визуальный стиль). С `{ "ai": false }` — только шаблонный
движок, без запросов к модели. Ответ содержит `bible.ai` (`provider`, `model`), если сработал ИИ.

### `POST /api/ideas/generate`

Теперь отдаёт источник:

```json
{ "created": 4, "source": "ai",
  "ideas": [{ "title": "…", "hook": "…", "format": "talking_head", "tags": ["…"], "score": 82, "source": "ai" }] }
```

`source = "template"` — модель недоступна, сработал встроенный Content Brain. Оценка вирусности
считается в обоих случаях, поэтому сортировка в интерфейсе не ломается.
