import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import Icon from '../components/Icons.jsx';
import { Badge, Confirm, Empty, Progress, ScoreRing, Segmented, useToast } from '../components/ui.jsx';
import { relative } from '../lib/format.js';

// ─────────────────────────────────────────────────────────────────────────────
// Нарезка из фильма.
//
// Экран повторяет один сценарий: загрузил файл → ИИ нашёл моменты → клипы
// ушли в график. Всё остальное (аккаунты, лимиты, маркировка, деньги) уже
// работает в конвейере, поэтому здесь его не дублируем: после «В очередь»
// клипы живут обычной жизнью ролика.
//
// Опрос здесь свой и включается только когда что-то реально идёт (разбор или
// сборка): в простое страница не делает ни одного запроса, иначе телефон
// тратил бы трафик на экран, который никто не меняет.
// ─────────────────────────────────────────────────────────────────────────────

const mmss = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
const gb = (bytes) => (bytes > 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} ГБ` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} МБ`);

const STATUS = {
  new: { label: 'новый', tone: 'muted' },
  analyzing: { label: 'разбор', tone: 'accent' },
  analyzed: { label: 'разобран', tone: 'success' },
  failed: { label: 'ошибка', tone: 'danger' },
};
const CLIP_STATUS = {
  candidate: { label: 'кандидат', tone: 'muted' },
  rendering: { label: 'сборка', tone: 'warn' },
  ready: { label: 'готов', tone: 'success' },
  queued: { label: 'в очереди', tone: 'accent' },
  failed: { label: 'ошибка', tone: 'danger' },
};
const STAGE = {
  queued: 'в очереди на разбор',
  probe: 'читаю параметры файла',
  text: 'ищу текст: субтитры',
  scenes: 'ищу смены планов и паузы',
  asr: 'слушаю речь',
  rank: 'ИИ выбирает лучшие моменты',
};
const SUBTITLE_LABEL = {
  srt: 'свои субтитры',
  uploaded: 'свои субтитры',
  embedded: 'субтитры из файла',
  asr: 'речь распознана',
  none: 'без текста',
};

function Steps() {
  const items = [
    { n: 1, title: 'Загрузите фильм', hint: 'mp4, mkv, mov — до 4 ГБ через панель или копией на сервер' },
    { n: 2, title: 'ИИ находит моменты', hint: 'сцены, паузы, реплики — и выбор лучших кусков' },
    { n: 3, title: 'Клипы в графике', hint: '9:16, 1080×1920, аккаунты и публикация — сами' },
  ];
  return (
    <div className="clip-steps">
      {items.map((s) => (
        <div className="clip-step" key={s.n}>
          <div className="clip-step-n">{s.n}</div>
          <div>
            <div className="clip-step-title">{s.title}</div>
            <div className="clip-step-hint">{s.hint}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ClipCard({ clip, busy, onRender, onDelete, onQueue }) {
  const tone = CLIP_STATUS[clip.status] || CLIP_STATUS.candidate;
  const cover = clip.coverPaths?.A || clip.coverPaths?.B || null;
  return (
    <div className={`clip-card ${clip.status === 'queued' ? 'is-queued' : ''}`}>
      <div className="clip-poster">
        {clip.videoPath ? (
          <video
            src={clip.videoPath}
            poster={cover || undefined}
            muted
            playsInline
            preload="none"
            controls
          />
        ) : cover ? (
          <img src={cover} alt="" loading="lazy" />
        ) : (
          <div className="clip-poster-empty">
            <Icon name="film" size={22} />
            <span>{mmss(clip.start)}–{mmss(clip.end)}</span>
          </div>
        )}
        <div className="clip-poster-top">
          <span className="clip-time">{mmss(clip.start)}–{mmss(clip.end)}</span>
          <Badge tone={tone.tone}>{tone.label}</Badge>
        </div>
        {clip.status === 'rendering' && (
          <div className="clip-poster-progress">
            <Progress value={clip.progress ?? 8} striped />
          </div>
        )}
      </div>
      <div className="clip-body">
        <div className="clip-title">{clip.title || `Фрагмент ${mmss(clip.start)}`}</div>
        {clip.hook && <div className="clip-hook">«{clip.hook}»</div>}
        {clip.transcript && <div className="clip-text clamp-3">{clip.transcript}</div>}
        <div className="clip-foot">
          <ScoreRing value={clip.score} size={30} />
          <span className="muted" style={{ fontSize: 10.5 }}>
            {clip.seconds ? `${Math.round(clip.seconds)} с · 1080×1920` : 'вертикаль 9:16'}
          </span>
        </div>
        {clip.reason && <div className="clip-reason">{clip.reason}</div>}
        {clip.error && <div className="clip-error">{clip.error}</div>}
        <div className="clip-actions">
          {clip.status === 'queued' ? (
            <a className="btn btn-ghost btn-sm" href="#/create/queue">
              <Icon name="film" size={14} />В очереди
            </a>
          ) : (
            <button className="btn btn-soft btn-sm" disabled={busy || clip.status === 'rendering'} onClick={() => onRender(clip)}>
              <Icon name={clip.status === 'ready' ? 'refresh' : 'scissors'} size={14} className={clip.status === 'rendering' ? 'spin' : ''} />
              {clip.status === 'ready' ? 'Пересобрать' : clip.status === 'failed' ? 'Повторить' : 'Собрать'}
            </button>
          )}
          {clip.status === 'ready' && (
            <button className="btn btn-primary btn-sm" onClick={() => onQueue(clip)}>
              <Icon name="calendar" size={14} />В очередь
            </button>
          )}
          <button className="btn btn-ghost btn-icon" title="Удалить клип" onClick={() => onDelete(clip)} disabled={clip.status === 'queued'}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Clips() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [info, setInfo] = useState(null);
  const [detail, setDetail] = useState(null);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState(null); // { percent, name }
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [count, setCount] = useState(5);
  const fileRef = useRef(null);
  const subRef = useRef(null);
  const stopped = useRef(false);
  const dragDepth = useRef(0);

  const applyList = useCallback((payload) => {
    setList(payload);
    if (payload?.info) setInfo(payload.info);
  }, []);

  const refresh = useCallback(async (sourceId = null) => {
    try {
      const payload = await api.movies();
      applyList(payload);
      const id = sourceId || selected;
      if (id && payload.sources.some((s) => s.id === id)) {
        setDetail(await api.movie(id));
      } else if (!id && payload.sources[0]) {
        setSelected(payload.sources[0].id);
        setDetail(await api.movie(payload.sources[0].id));
      } else if (id && !payload.sources.some((s) => s.id === id)) {
        setSelected(payload.sources[0]?.id || null);
        setDetail(payload.sources[0] ? await api.movie(payload.sources[0].id) : null);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }, [applyList, selected, toast]);

  useEffect(() => {
    stopped.current = false;
    (async () => {
      try {
        const payload = await api.movies();
        applyList(payload);
        if (payload.sources[0]) {
          setSelected(payload.sources[0].id);
          setDetail(await api.movie(payload.sources[0].id));
        }
      } catch (err) {
        toast(err.message, 'error');
      }
    })();
    return () => { stopped.current = true; };
  }, [applyList, toast]);

  // Опрос только во время работы: самопланирующийся таймаут вместо setInterval,
  // иначе период нельзя поменять и запросы продолжаются после ухода со вкладки.
  useEffect(() => {
    if (!busy) return undefined;
    let timer = null;
    const loop = async () => {
      if (stopped.current) return;
      try {
        const payload = await api.movies();
        applyList(payload);
        if (selected) setDetail(await api.movie(selected));
        const stillBusy = payload.sources.some((s) => s.status === 'analyzing')
          || (payload.totals?.rendering || 0) > 0;
        if (!stillBusy) { setBusy(false); return; }
      } catch { /* сеть моргнула — попробуем на следующем тике */ }
      timer = setTimeout(loop, 4000);
    };
    timer = setTimeout(loop, 2500);
    return () => { if (timer) clearTimeout(timer); };
  }, [busy, selected, applyList]);

  const select = async (id) => {
    setSelected(id);
    try { setDetail(await api.movie(id)); } catch (err) { toast(err.message, 'error'); }
  };

  const startUpload = async (file) => {
    if (!file) return;
    if (!/\.(mp4|mkv|mov|m4v|avi|webm|ts|mpg|mpeg|flv|wmv|m2ts)$/i.test(file.name)) {
      toast('Нужен видеофайл: mp4, mkv, mov, m4v, avi или webm', 'error');
      return;
    }
    setUpload({ percent: 0, name: file.name });
    try {
      const source = await api.uploadMovie(file, {
        onProgress: (percent) => setUpload({ percent, name: file.name }),
      });
      setUpload(null);
      toast(`«${source.title}» загружен`, 'success');
      setSelected(source.id);
      setDetail(source);
      const payload = await api.movies();
      applyList(payload);
      // сразу запускаем разбор: отдельный клик тут ничего не решает
      await api.analyzeMovie(source.id, count);
      setBusy(true);
    } catch (err) {
      setUpload(null);
      toast(err.message, 'error');
    }
  };

  const onDrop = (event) => {
    event.preventDefault();
    dragDepth.current = 0;
    const file = event.dataTransfer?.files?.[0];
    if (file) startUpload(file);
  };

  const analyze = async () => {
    if (!selected) return;
    try {
      await api.analyzeMovie(selected, count);
      setBusy(true);
      toast('Разбор запущен: обычно 1–3 минуты на час видео', 'success');
      setDetail(await api.movie(selected));
    } catch (err) { toast(err.message, 'error'); }
  };

  const renderAll = async () => {
    if (!selected) return;
    try {
      const out = await api.renderMovie(selected);
      setBusy(true);
      toast(`Сборка клипов запущена: ${out.queued}`, 'success');
    } catch (err) { toast(err.message, 'error'); }
  };

  const renderOne = async (clip) => {
    try {
      await api.renderClip(clip.id);
      setBusy(true);
      setDetail(await api.movie(selected));
    } catch (err) { toast(err.message, 'error'); }
  };

  const queue = async (onlyClip = null) => {
    if (!selected) return;
    try {
      const out = await api.queueMovie(selected, onlyClip ? { clipIds: [onlyClip.id] } : { count });
      toast(`В очередь поставлено: ${out.queued}. Публикация — по графику`, 'success');
      setDetail(out.source || await api.movie(selected));
      applyList(await api.movies());
    } catch (err) { toast(err.message, 'error'); }
  };

  const saveSetting = async (patch) => {
    setSettingsBusy(true);
    try {
      await api.updateSettings(patch);
      if (patch.clip_default_count) setCount(Number(patch.clip_default_count));
      setInfo(await api.movieInfo());
    } catch (err) { toast(err.message, 'error'); } finally { setSettingsBusy(false); }
  };

  const attachSubtitles = async (file) => {
    if (!file || !selected) return;
    try {
      const text = await file.text();
      const out = await api.uploadSubtitles(selected, text, file.name);
      toast(`Субтитры привязаны: ${out.cues} реплик. Запустите разбор заново`, 'success');
      setDetail(await api.movie(selected));
    } catch (err) { toast(err.message, 'error'); }
  };

  const remove = (target) => {
    setConfirm(target);
  };

  const doRemove = async () => {
    if (!confirm) return;
    try {
      if (confirm.kind === 'source') {
        await api.deleteMovie(confirm.id);
        setDetail(null);
        setSelected(null);
        await refresh(null);
      } else {
        await api.deleteClip(confirm.id);
        setDetail(await api.movie(selected));
        applyList(await api.movies());
      }
      toast('Удалено', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };

  const sources = list?.sources || [];
  const totals = list?.totals || {};
  const ready = detail?.clips?.filter((c) => c.status === 'ready') || [];
  const queued = detail?.clips?.filter((c) => c.status === 'queued') || [];
  const stageHint = detail && STAGE[detail.stage];

  return (
    <div className="page">
      <div className="row-between wrap" style={{ gap: 14, alignItems: 'flex-end' }}>
        <div>
          <div className="eyebrow">второй способ получить контент</div>
          <h1 className="page-h1">Нарезка из фильма</h1>
          <p className="page-sub">
            Загрузите видео — ИИ найдёт самые цепкие моменты, соберёт вертикальные клипы 1080×1920
            и поставит их в график публикаций. Дальше работает обычный конвейер: аккаунты, лимиты
            площадок, маркировка, аналитика и деньги.
          </p>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => refresh(null)} title="Обновить список">
            <Icon name="refresh" size={14} />Обновить
          </button>
          <button
            className="btn btn-ghost btn-sm"
            title="Найти файлы, скопированные на сервер напрямую"
            onClick={async () => {
              try {
                const out = await api.scanMovies();
                toast(out.added ? `Найдено новых файлов: ${out.added}` : 'Новых файлов нет', out.added ? 'success' : 'info');
                applyList(out);
              } catch (err) { toast(err.message, 'error'); }
            }}
          >
            <Icon name="search" size={14} />Найти на сервере
          </button>
        </div>
      </div>

      {!sources.length && <Steps />}

      <div className="page-grid grid-2">
        <div
          className="card drop-zone"
          onDragEnter={(e) => { e.preventDefault(); dragDepth.current += 1; }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); }}
          onDrop={onDrop}
        >
          <div className="drop-icon"><Icon name="upload" size={20} /></div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="card-title">
              {upload ? `Загружаю «${upload.name}»…` : 'Перетащите фильм сюда или выберите файл'}
            </div>
            <div className="card-sub">
              mp4, mkv, mov, m4v, webm — до {info?.uploadLimitMb || 4096} МБ. Файл остаётся на вашем сервере.
            </div>
            {upload ? (
              <div style={{ marginTop: 10 }}>
                <Progress value={upload.percent} striped />
                <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                  {upload.percent}% · не закрывайте вкладку до окончания
                </div>
              </div>
            ) : (
              <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
                <button className="btn btn-primary btn-sm" onClick={() => fileRef.current?.click()}>
                  <Icon name="upload" size={14} />Выбрать файл
                </button>
                <span className="muted" style={{ fontSize: 11 }}>
                  Разбор начнётся сразу после загрузки
                </span>
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="video/*,.mkv,.m4v,.ts"
              hidden
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; startUpload(f); }}
            />
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Настройки нарезки</div>
              <div className="card-sub">Действуют на следующие разборы</div>
            </div>
          </div>
          <div className="card-body col" style={{ gap: 12 }}>
            <div>
              <div className="field-label">Сколько клипов из одного видео</div>
              <Segmented
                size="sm"
                value={count}
                onChange={(v) => { setCount(v); saveSetting({ clip_default_count: String(v) }); }}
                options={[3, 5, 7, 10].map((n) => ({ value: n, label: String(n) }))}
              />
            </div>
            <div>
              <div className="field-label">Кадр</div>
              <Segmented
                size="sm"
                value={info?.defaults?.style || 'blur'}
                onChange={(v) => !settingsBusy && saveSetting({ clip_style: v })}
                options={[
                  { value: 'blur', label: 'полный кадр' },
                  { value: 'fill', label: 'заполнить' },
                ]}
              />
              <div className="field-hint" style={{ marginTop: 6 }}>
                «Полный кадр» — фильм целиком на размытом фоне, ничего не теряется.
                «Заполнить» — обрезка по центру, лица крупнее.
              </div>
            </div>
            <div className="hint-row">
              <Badge tone="muted">1080×1920</Badge>
              <Badge tone="muted">30 кадров/с</Badge>
              <Badge tone="muted">громкость −14 LUFS</Badge>
            </div>
          </div>
        </div>
      </div>

      {!sources.length ? (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Без загрузки: файл уже на сервере</div>
              <div className="card-sub">На VPS так быстрее всего — файл не идёт через браузер</div>
            </div>
          </div>
          <div className="card-body col" style={{ gap: 8 }}>
            <div className="notice">
              <Icon name="terminal" size={15} />
              <span>
                Скопируйте файл в <code>{info?.sourceDir || 'data/sources'}</code> и нажмите
                «Найти на сервере»: каталог лежит в том же томе, что база и ролики.
              </span>
            </div>
            <div className="notice">
              <Icon name="shield" size={15} />
              <span>
                Права: берите своё видео или материал, на который есть разрешение. Чужой фильм
                площадки находят автоматически и снимают звук или блокируют ролик.
              </span>
            </div>
            {info && !info.available && (
              <div className="alert">
                <Icon name="alert" size={15} />
                <span>
                  На сервере нет ffmpeg/ffprobe — нарезка недоступна. В Docker-образе они уже есть;
                  на своём VPS поставьте пакет <code>ffmpeg</code> (внутри оба бинаря).
                </span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Исходники</div>
              <div className="card-sub">
                {totals.sources || 0} файлов · {gb(totals.bytes || 0)} · клипов готово {totals.ready || 0}, в очереди {totals.queued || 0}
              </div>
            </div>
          </div>
          <div className="card-body col" style={{ gap: 8 }}>
            {sources.map((s) => {
              const st = STATUS[s.status] || STATUS.new;
              return (
                <button key={s.id} className={`source-row ${selected === s.id ? 'is-active' : ''}`} onClick={() => select(s.id)}>
                  <div className="source-main">
                    <div className="source-title">{s.title}</div>
                    <div className="source-meta">
                      <span><Icon name="clock" size={11} />{s.duration ? mmss(s.duration) : 'длительность неизвестна'}</span>
                      <span className="dot-sep" />
                      <span>{s.width && s.height ? `${s.width}×${s.height}` : '—'}</span>
                      <span className="dot-sep" />
                      <span>{gb(s.bytes || 0)}</span>
                      <span className="dot-sep" />
                      <span>{SUBTITLE_LABEL[s.subtitleKind] || 'текст не найден'}</span>
                    </div>
                  </div>
                  <Badge tone={st.tone} live={s.status === 'analyzing'}>{st.label}</Badge>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {detail ? (
        <div className="card">
          <div className="card-head">
            <div style={{ minWidth: 0 }}>
              <div className="card-title">{detail.title}</div>
              <div className="card-sub">{detail.next}</div>
            </div>
            <Badge tone={(STATUS[detail.status] || STATUS.new).tone} live={detail.status === 'analyzing'}>
              {(STATUS[detail.status] || STATUS.new).label}
            </Badge>
          </div>
          <div className="card-body col" style={{ gap: 12 }}>
            <div className="grid-3">
              <div className="mini">
                <div className="mini-label">Длительность</div>
                <div className="mini-value">{detail.duration ? mmss(detail.duration) : '—'}</div>
              </div>
              <div className="mini">
                <div className="mini-label">Кадр</div>
                <div className="mini-value">{detail.width ? `${detail.width}×${detail.height}` : '—'}</div>
              </div>
              <div className="mini">
                <div className="mini-label">Текст</div>
                <div className="mini-value" style={{ fontSize: 13 }}>{SUBTITLE_LABEL[detail.subtitleKind] || 'не найден'}</div>
              </div>
            </div>

            {detail.status === 'analyzing' && (
              <div className="col" style={{ gap: 6 }}>
                <Progress value={detail.stage === 'rank' ? 90 : detail.stage === 'scenes' ? 45 : detail.stage === 'asr' ? 65 : 20} striped />
                <span className="muted" style={{ fontSize: 11 }}>{stageHint || 'разбор'}</span>
              </div>
            )}
            {detail.error && <div className="alert"><Icon name="alert" size={15} /><span>{detail.error}</span></div>}

            <div className="row wrap" style={{ gap: 8 }}>
              <button className="btn btn-soft btn-sm" onClick={analyze} disabled={detail.status === 'analyzing'}>
                <Icon name="sparkles" size={14} className={detail.status === 'analyzing' ? 'spin' : ''} />
                {detail.status === 'analyzed' ? 'Разобрать заново' : 'Разобрать'}
              </button>
              {!!detail.clips?.length && (
                <button
                  className="btn btn-soft btn-sm"
                  onClick={renderAll}
                  disabled={!detail.clips.some((c) => c.status === 'candidate' || c.status === 'failed' || c.status === 'ready')}
                >
                  <Icon name="scissors" size={14} />Собрать клипы
                </button>
              )}
              {!!ready.length && (
                <button className="btn btn-primary btn-sm" onClick={() => queue()}>
                  <Icon name="calendar" size={14} />В очередь · {ready.length}
                </button>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => subRef.current?.click()}>
                <Icon name="upload" size={14} />Субтитры
              </button>
              <button className="btn btn-ghost btn-icon" title="Удалить исходник и файл" onClick={() => remove({ kind: 'source', id: detail.id })}>
                <Icon name="trash" size={14} />
              </button>
              <input
                ref={subRef}
                type="file"
                accept=".srt,.vtt,text/plain"
                hidden
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; attachSubtitles(f); }}
              />
            </div>

            <div className="muted" style={{ fontSize: 11 }}>
              {detail.clips?.length
                ? `${detail.clips.length} фрагментов · готово ${ready.length} · в очереди ${queued.length}`
                : 'Клипов пока нет: запустите разбор'}
              {detail.updatedAt ? ` · обновлено ${relative(detail.updatedAt)}` : ''}
            </div>

            {!!detail.clips?.length && (
              <div className="clip-grid">
                {detail.clips.map((clip) => (
                  <ClipCard
                    key={clip.id}
                    clip={clip}
                    busy={busy && clip.status === 'rendering'}
                    onRender={renderOne}
                    onQueue={(c) => queue(c)}
                    onDelete={(c) => remove({ kind: 'clip', id: c.id })}
                  />
                ))}
              </div>
            )}

            {detail.status === 'analyzed' && !detail.clips?.length && (
              <Empty
                icon="film"
                title="Не нашлось подходящих фрагментов"
                text="Приложите субтитры (SRT) и запустите разбор заново: по тексту моменты находятся намного точнее."
              />
            )}
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-body">
            <Empty
              icon="scissors"
              title="Здесь появятся клипы"
              text="Загрузите видео: платформа сама найдёт моменты, сделает вертикальные нарезки и предложит поставить их в график."
            />
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-body col" style={{ gap: 8 }}>
          <div className="card-title" style={{ fontSize: 13 }}>Как это работает</div>
          <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
            Текст берётся из ваших субтитров, из дорожки внутри файла или распознаётся речью
            (Groq Whisper, бесплатно). Затем модель выбирает моменты, ffmpeg режет вертикаль,
            а публикацией занимается тот же конвейер, что и у остальных роликов: аккаунты,
            лимиты площадок, маркировка и аналитика.
          </div>
          <div className="hint-row">
            <Badge tone={info?.asr?.enabled ? 'success' : 'muted'}>
              {info?.asr?.enabled ? 'речь распознаётся' : 'без ключа Groq речь не распознаётся'}
            </Badge>
            <Badge tone="muted">{info?.ffprobe ? 'ffmpeg и ffprobe на месте' : 'нет ffmpeg'}</Badge>
            <Badge tone="muted">свои субтитры — лучший результат</Badge>
          </div>
        </div>
      </div>

      <Confirm
        open={!!confirm}
        title={confirm?.kind === 'source' ? 'Удалить исходник?' : 'Удалить клип?'}
        text={confirm?.kind === 'source'
          ? 'Файл фильма и черновые нарезки будут удалены с сервера. Клипы, уже стоящие в очереди, останутся.'
          : 'Видео и обложки этого клипа будут удалены. Ролик в очереди не затрагивается.'}
        onConfirm={doRemove}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
