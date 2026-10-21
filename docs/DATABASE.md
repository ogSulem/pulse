# Pulse — схема базы данных

Две версии одной схемы:

- **Демо/одна VPS** (реализовано): SQLite WAL, файл `data/pulse.db`, схема в `server/src/core/db.js`.
- **Production** (целевая): PostgreSQL 16, схема `pulse`, EF Core миграции. Ниже — DDL и маппинг.

Сущности одинаковые, отличаются типы: `TEXT` → `text/uuid`, `INTEGER 0/1` → `boolean`,
JSON-строки → `jsonb`.

---

## ER-обзор

```
projects 1─* ideas
projects 1─* scripts
projects 1─* episodes
ideas    1─1 scripts (idea_id)
episodes 1─* publications
publications 1─* metrics_daily
accounts 1─* publications
accounts 1─* accounts_daily
products 1─* episodes (product_id)
episodes 1─* jobs (через payload)     logs — независимый аудит
```

---

## Ключевые таблицы

### projects — проект/канал
| Поле | Тип | Смысл |
|------|-----|-------|
| id | uuid PK | |
| name, niche, description | text | что за канал и ниша |
| product_url | text | ссылка на продвигаемый продукт |
| language, tone | text | язык и тон коммуникации |
| format | text | базовый формат ролика |
| aspect, duration_sec | text/int | 9:16, длительность |
| autopilot | bool | публиковать без подтверждения |
| posts_per_day | int | ритм |
| ab_tests | bool | включить A/B |
| archived | bool | мягкое удаление |
| created_at / updated_at | timestamptz | |

### accounts — аккаунт площадки (главное для антиблока)
| Поле | Тип | Смысл |
|------|-----|-------|
| id | uuid PK | |
| platform | enum(`reels`,`tiktok`) | площадка |
| handle, display_name | text | @ник |
| status | enum(`healthy`,`warmup`,`cooldown`,`blocked`) | состояние |
| daily_limit | int | личная квота в день |
| min_gap_min | int | минимальный интервал между постами |
| window_start, window_end | time | разрешённое окно публикаций |
| timezone | text | IANA-зона |
| warmup_until, blocked_until | timestamptz | даты окончания режимов |
| quality | int 0–100 | влияет на приоритет выбора |
| secret_ref | text | **ссылка на секрет в Vault**, не сам токен |

### accounts_daily — израсходованная квота
`(account_id, day)` PK, `used int`. Обновляется атомарно при публикации:
`INSERT … ON CONFLICT DO UPDATE SET used = used + 1`.

### ideas — библиотека тем
`id, project_id, title, hook, angle, format, tags jsonb, score int, source, status(new|used|rejected), created_at`

### scripts — версионируемые сценарии
`id, idea_id, project_id, hook, scenes jsonb, cta, caption, hashtags jsonb, duration_sec, tone, status, created_at`

`scenes` — массив:
```json
[
  { "n": 1, "text": "Ты теряешь на этом каждый день…", "visual": "скринкаст дашборда", "seconds": 6 },
  { "n": 2, "text": "Проблема не в дисциплине…", "visual": "разговор в кадре", "seconds": 8 }
]
```

### episodes — единица конвейера (ролик)
| Поле | Тип | Смысл |
|------|-----|-------|
| id | uuid PK | |
| project_id, idea_id, script_id, product_id, account_id | uuid FK | связи |
| title, description | text | заголовок и описание |
| hashtags, scenes | jsonb | контент-план |
| cover_seed | text | детерминированная обложка |
| topic, format | text | для аналитики по темам/форматам |
| status | enum | `queued/generating/review/scheduled/published/failed/paused` |
| stage | enum | `idea/script/voice/footage/edit/ready/published` |
| progress | int 0–100 | прогресс для UI |
| risk | int 0–100 | риск-скоринг текста |
| error | text | последняя ошибка |
| attempts | int | сколько раз запускали |
| autopilot, ab_test | bool | флаги |
| scheduled_at, published_at | timestamptz | |

Индексы: `(status, scheduled_at)`, `(project_id, created_at desc)`.

### publications — факт публикации (и A/B-вариант)
| Поле | Тип | Смысл |
|------|-----|-------|
| id | uuid PK | |
| episode_id, project_id, account_id | uuid FK | |
| platform | enum | reels / tiktok |
| variant | char(1) | `A` / `B` |
| description, hashtags, cover_seed | | вариант контента |
| url | text | ссылка на пост |
| status | enum(`scheduled`,`published`,`failed`) | |
| scheduled_at, published_at | timestamptz | |
| views, likes, comments, shares, saves, clicks, followers | bigint | накопленные значения |
| watch_avg | numeric | среднее удержание, % |
| target_views | bigint | прогноз (для демо/оценки) |

Уникальность для идемпотентности: `UNIQUE (episode_id, platform, variant)`.

### metrics_daily — **приросты** метрик по дням
| Поле | Тип | Смысл |
|------|-----|-------|
| id | text PK `publicationId:date` | идемпотентный upsert |
| publication_id | uuid FK | |
| day | date | |
| views, likes, comments, shares, clicks, followers | int | **дельты за день**, не накопленные |

Почему дельты: сборщик метрик вызывается много раз в сутки, а площадки отдают накопленные значения.
Пишем только прирост `current − stored`, поэтому агрегаты не двоятся, а «сегодня» — честный частичный день.

В Postgres: партиционирование `PARTITION BY RANGE (day)`, партиция на месяц, ретеншн 24 месяца.

### jobs — очередь (outbox + lease)
`id, type, payload jsonb, status(pending|running|done|failed|dead), priority, attempts, max_attempts, run_after, lease_until, last_error, created_at, updated_at`

Индекс `(status, run_after)` — воркер забирает пачку `FOR UPDATE SKIP LOCKED` (Postgres) без гонок.

### logs — аудит
`id, ts, level, actor, action, entity_type, entity_id, message, meta jsonb`
Ретеншн 2000 записей в демо; в production — 90 дней + выгрузка в Loki.

### products — продвигаемые продукты
`id, name, url, pitch, proof, template(review|before-after|problem-solution|case|meme), utm_source, utm_medium, utm_campaign, active`

### settings — key/value
`key text PK, value text` — `mode`, `timezone`, `autopilot_global`, `manual_review`,
`risk_threshold`, `max_daily_per_account`.

---

## Production DDL (PostgreSQL, фрагмент)

```sql
CREATE SCHEMA IF NOT EXISTS pulse;

CREATE TYPE pulse.episode_status AS ENUM
  ('queued','generating','review','scheduled','published','failed','paused');

CREATE TABLE pulse.projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  niche         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  product_url   text NOT NULL DEFAULT '',
  language      text NOT NULL DEFAULT 'ru',
  tone          text NOT NULL DEFAULT 'friendly',
  format        text NOT NULL DEFAULT 'problem-solution',
  aspect        text NOT NULL DEFAULT '9:16',
  duration_sec  int  NOT NULL DEFAULT 32 CHECK (duration_sec BETWEEN 8 AND 90),
  autopilot     boolean NOT NULL DEFAULT true,
  posts_per_day int  NOT NULL DEFAULT 2 CHECK (posts_per_day BETWEEN 1 AND 12),
  ab_tests      boolean NOT NULL DEFAULT true,
  archived      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pulse.accounts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform     text NOT NULL CHECK (platform IN ('reels','tiktok')),
  handle       text NOT NULL,
  status       text NOT NULL DEFAULT 'warmup'
               CHECK (status IN ('healthy','warmup','cooldown','blocked')),
  daily_limit  int  NOT NULL DEFAULT 3,
  min_gap_min  int  NOT NULL DEFAULT 90,
  window_start time NOT NULL DEFAULT '09:00',
  window_end   time NOT NULL DEFAULT '23:00',
  timezone     text NOT NULL DEFAULT 'Europe/Moscow',
  quality      int  NOT NULL DEFAULT 70,
  secret_ref   text,
  warmup_until timestamptz,
  blocked_until timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, handle)
);

CREATE TABLE pulse.episodes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES pulse.projects(id) ON DELETE CASCADE,
  idea_id      uuid,
  script_id    uuid,
  product_id   uuid,
  account_id   uuid REFERENCES pulse.accounts(id),
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  hashtags     jsonb NOT NULL DEFAULT '[]'::jsonb,
  scenes       jsonb NOT NULL DEFAULT '[]'::jsonb,
  cover_seed   text NOT NULL DEFAULT '',
  topic        text NOT NULL DEFAULT '',
  format       text NOT NULL DEFAULT '',
  status       pulse.episode_status NOT NULL DEFAULT 'queued',
  stage        text NOT NULL DEFAULT 'idea',
  progress     int  NOT NULL DEFAULT 0,
  risk         int  NOT NULL DEFAULT 0,
  error        text,
  attempts     int  NOT NULL DEFAULT 0,
  autopilot    boolean NOT NULL DEFAULT true,
  ab_test      boolean NOT NULL DEFAULT false,
  scheduled_at timestamptz,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_episodes_due ON pulse.episodes (status, scheduled_at);
CREATE INDEX ix_episodes_project ON pulse.episodes (project_id, created_at DESC);

CREATE TABLE pulse.publications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id   uuid NOT NULL REFERENCES pulse.episodes(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL,
  account_id   uuid REFERENCES pulse.accounts(id),
  platform     text NOT NULL,
  variant      char(1) NOT NULL DEFAULT 'A',
  description  text NOT NULL DEFAULT '',
  hashtags     jsonb NOT NULL DEFAULT '[]'::jsonb,
  cover_seed   text NOT NULL DEFAULT '',
  url          text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'scheduled',
  scheduled_at timestamptz,
  published_at timestamptz,
  views        bigint NOT NULL DEFAULT 0,
  likes        bigint NOT NULL DEFAULT 0,
  comments     bigint NOT NULL DEFAULT 0,
  shares       bigint NOT NULL DEFAULT 0,
  clicks       bigint NOT NULL DEFAULT 0,
  followers    bigint NOT NULL DEFAULT 0,
  watch_avg    numeric(5,2) NOT NULL DEFAULT 0,
  target_views bigint NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (episode_id, platform, variant)
);

CREATE TABLE pulse.metrics_daily (
  publication_id uuid NOT NULL REFERENCES pulse.publications(id) ON DELETE CASCADE,
  day            date NOT NULL,
  views          bigint NOT NULL DEFAULT 0,
  likes          bigint NOT NULL DEFAULT 0,
  comments       bigint NOT NULL DEFAULT 0,
  shares         bigint NOT NULL DEFAULT 0,
  clicks         bigint NOT NULL DEFAULT 0,
  followers      bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (publication_id, day)
) PARTITION BY RANGE (day);

CREATE TABLE pulse.jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending',
  priority     int  NOT NULL DEFAULT 5,
  attempts     int  NOT NULL DEFAULT 0,
  max_attempts int  NOT NULL DEFAULT 4,
  run_after    timestamptz NOT NULL DEFAULT now(),
  lease_until  timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_jobs_due ON pulse.jobs (status, run_after) WHERE status IN ('pending','running');
```

---

## EF Core: как это описать

```csharp
public sealed class Episode
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
    public List<EpisodeScene> Scenes { get; set; } = new();   // jsonb
    public List<string> Hashtags { get; set; } = new();       // jsonb
    public EpisodeStatus Status { get; set; } = EpisodeStatus.Queued;
    public string Stage { get; set; } = "idea";
    public int Progress { get; set; }
    public int Risk { get; set; }
    public string? Error { get; set; }
    public bool Autopilot { get; set; } = true;
    public DateTimeOffset? ScheduledAt { get; set; }
    public DateTimeOffset? PublishedAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    public Project Project { get; set; } = null!;
    public ICollection<Publication> Publications { get; set; } = new List<Publication>();
}

public sealed class PulseDbContext(DbContextOptions<PulseDbContext> options) : DbContext(options)
{
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<Account> Accounts => Set<Account>();
    public DbSet<Episode> Episodes => Set<Episode>();
    public DbSet<Publication> Publications => Set<Publication>();
    public DbSet<MetricDaily> MetricsDaily => Set<MetricDaily>();
    public DbSet<Job> Jobs => Set<Job>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.HasDefaultSchema("pulse");

        b.Entity<Episode>(e =>
        {
            e.ToTable("episodes");
            e.Property(x => x.Status).HasConversion<string>().HasMaxLength(16);
            e.Property(x => x.Scenes).HasColumnType("jsonb");
            e.Property(x => x.Hashtags).HasColumnType("jsonb");
            e.HasIndex(x => new { x.Status, x.ScheduledAt });
            e.HasMany(x => x.Publications).WithOne(p => p.Episode!)
                .HasForeignKey(p => p.EpisodeId).OnDelete(DeleteBehavior.Cascade);
        });

        b.Entity<MetricDaily>(m =>
        {
            m.ToTable("metrics_daily");
            m.HasKey(x => new { x.PublicationId, x.Day });
        });

        b.Entity<Job>(j =>
        {
            j.ToTable("jobs");
            j.Property(x => x.Payload).HasColumnType("jsonb");
            j.HasIndex(x => new { x.Status, x.RunAfter })
                .HasFilter("status IN ('pending','running')");
        });
    }
}
```

Выбор задач воркером в Postgres (без дублей):

```sql
WITH next AS (
  SELECT id FROM pulse.jobs
  WHERE status = 'pending' AND run_after <= now()
  ORDER BY priority, run_after
  FOR UPDATE SKIP LOCKED
  LIMIT 10
)
UPDATE pulse.jobs j SET status = 'running',
       attempts = attempts + 1, lease_until = now() + interval '5 minutes'
FROM next WHERE j.id = next.id
RETURNING j.*;
```

---

## Миграция демо → production

1. Развернуть Postgres 16, создать схему `pulse`.
2. `dotnet ef migrations add Initial` в `Pulse.Api` → `dotnet ef database update`.
3. Перенести данные: экспорт из панели (`/api/backup`) → импорт-скрипт (маппинг 1:1, JSON-поля как есть).
4. Заменить репозиторий в `providers`/`core` на EF Core; обработчики конвейера не меняются —
   они работают через интерфейсы `IJobQueue`, `IEpisodeRepository`, `IProviderRegistry`.
5. Включить партиционирование `metrics_daily` и ретеншн-политику.

## v2: медиа, комплаенс, деньги

### Новые поля `episodes`

| Поле | Тип | Зачем |
|------|-----|-------|
| `video_path` | TEXT | путь к готовому mp4 (`/media/ep_….mp4`) |
| `video_bytes` | INTEGER | размер файла — виден в очереди и «Прозрачности» |
| `render_ms` | INTEGER | сколько длился рендер, для контроля нагрузки |
| `cover_paths` | TEXT (JSON) | `{"A": "...","B": "..."}` — обложки A/B |
| `compliance` | TEXT (JSON) | отчёт проверки правил: блокировки, предупреждения, лимиты |
| `viral` | INTEGER | вирусный скор 0–100 |
| `viral_meta` | TEXT (JSON) | разбор по факторам и рекомендации |
| `cost_cents` | INTEGER | себестоимость ролика в копейках |

### Новые поля `publications`

| Поле | Тип | Зачем |
|------|-----|-------|
| `cover_path` | TEXT | какая обложка ушла в публикацию |
| `click_token` | TEXT | токен короткой ссылки `/t/<token>` |
| `privacy` | TEXT | `public` или `SELF_ONLY` (неаудированный TikTok) |
| `cost_cents` | INTEGER | доля себестоимости эпизода |
| `revenue_cents` | INTEGER | накопленный доход, если нужно фиксировать факт |
| `external_id` | TEXT | id публикации на площадке |

### `clicks`

| Поле | Тип | Зачем |
|------|-----|-------|
| `id` | TEXT PK | идентификатор клика |
| `publication_id` | TEXT FK | из какого ролика пришли |
| `project_id` | TEXT | быстрый разрез без JOIN |
| `ts` | TEXT | время клика |
| `ua`, `ref`, `ip_hash` | TEXT | источник и антифрод (IP хранится только хешем) |

Индекс: `ix_clicks_pub(publication_id)`.

### `conversions`

| Поле | Тип | Зачем |
|------|-----|-------|
| `id` | TEXT PK | идентификатор конверсии |
| `click_id` | TEXT | клик, который привёл к покупке |
| `publication_id` | TEXT FK | ролик |
| `value_cents` | INTEGER | сумма маржи в копейках |
| `status` | TEXT | `paid` / `pending` / `refunded` |
| `external_id` | TEXT | id заказа, уникальный индекс для идемпотентности postback |
| `ts` | TEXT | время |

Индексы: `ix_conv_pub(publication_id)`, `ix_conv_ext(external_id) WHERE external_id IS NOT NULL`.

### Миграции

`migrate()` выполняет `CREATE TABLE IF NOT EXISTS`, затем `ensureColumns()` (безопасные `ALTER TABLE`
для новых полей) и разовую миграцию значений настроек v1 → v2 (`schema_v2`), чтобы ставки RPM и
себестоимость из прошлой версии не остались в долларах.
