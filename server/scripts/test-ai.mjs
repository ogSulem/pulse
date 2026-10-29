// ─────────────────────────────────────────────────────────────────────────────
// Живая проверка ИИ-контура: роутер, кэш, лимиты, деградация, гигиена ключей.
//
// Запуск:  npm run test:ai
//
// Проверка идёт на локальном мок-сервере, OpenAI-совместимом: наружу ничего не
// уходит, платить не за что, но проверяется именно боевой путь — настоящий HTTP,
// выбор провайдера, разбор ответа, повтор при мусоре, кэш на диске.
// Затем ключ убирается, и проверяется бесплатный режим: ИИ честно выключен,
// сценарий всё равно собирается шаблонным Content Brain.
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = [];
const ok = (name, detail = '') => { results.push({ name, ok: true, detail }); console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`); };
const fail = (name, detail = '') => { results.push({ name, ok: false, detail }); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); };
const check = (name, cond, detail = '') => (cond ? ok(name, detail) : fail(name, detail));

// ── мок OpenAI-совместимого провайдера ──────────────────────────────────────
let hits = 0;
let mode = 'good'; // good | 429 | garbage
const MOCK_SCENES = {
  title: 'Проверка контура',
  hook: 'Первые три секунды решают всё',
  scenes: [
    { text: 'Сцена первая: тишина и звук капель в коридоре.', visual: 'тёмный коридор' },
    { text: 'Сцена вторая: тень медленно проходит мимо двери.', visual: 'тень' },
    { text: 'Сцена третья: дверь закрывается сама по себе.', visual: 'дверь' },
  ],
  caption: 'Проверка описания под площадку',
  hashtags: ['pulse', 'test'],
};
const mock = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    hits += 1;
    if (mode === '429') {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
    }
    if (mode === 'garbage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: 'конечно! вот ваш JSON: ...' } }] }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'mock',
      model: 'mock-70b',
      choices: [{ message: { role: 'assistant', content: JSON.stringify(MOCK_SCENES) } }],
      usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
    }));
  });
});

// изолированные данные: тест не должен писать в рабочую базу и кэш
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-ai-'));
process.env.PULSE_DATA_DIR = tmp;
process.env.PULSE_DB_PATH = path.join(tmp, 'test.db');
process.env.PULSE_MODE = 'demo';
process.env.PULSE_AI = 'on';
process.env.PULSE_PASSWORD = 'test';
// реальные ключи убираем: тест не должен потратить чужой лимит
for (const k of ['NVIDIA_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'CEREBRAS_API_KEY',
  'MISTRAL_API_KEY', 'OPENROUTER_API_KEY', 'CLOUDFLARE_AI_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GITHUB_TOKEN',
  'GITHUB_MODELS_TOKEN', 'PULSE_LLM_ORDER', 'PULSE_LLM_PROVIDER', 'PULSE_LLM_BASE_URL']) delete process.env[k];

console.log('\nPulse · проверка ИИ-контура\n');
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const port = mock.address().port;
// Ollama-провайдер — тот же OpenAI-совместимый путь, ключ не нужен
process.env.PULSE_OLLAMA = 'on';
process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.OLLAMA_MODEL = 'mock-70b';

const { db, migrate } = await import('../src/core/db.js');
migrate(); // схема нужна журналу: роутер пишет аудит каждого вызова
const llm = await import('../src/providers/llm.js');
const ai = await import('../src/engine/ai.js');

// ── 1. провайдер из env виден в статусе и в цепочке ─────────────────────────
const status = llm.status();
check('роутер видит свой OpenAI-совместимый провайдер', status.providers.some((p) => p.id === 'ollama' && p.configured));
check('ИИ включён при наличии ключа', status.enabled === true, `цепочка: ${status.chain.join(' → ')}`);

// ── 2. вызов модели отдаёт разобранный JSON ─────────────────────────────────
const first = await llm.completeJson({ prompt: 'Верни JSON со сценами ролика', system: 'Ты сценарист', maxTokens: 200 });
check('ответ модели разобран в объект', Boolean(first?.ok && first.data?.scenes?.length === 3), `${first?.provider} / ${first?.model}`);
check('в ответе учтён расход токенов', Number(first?.usage?.total_tokens) === 180, `tokens: ${first?.usage?.total_tokens}`);

// ── 3. кэш: повторный запрос не идёт в сеть ─────────────────────────────────
const before = hits;
const second = await llm.completeJson({ prompt: 'Верни JSON со сценами ролика', system: 'Ты сценарист', maxTokens: 200 });
check('повторный запрос взят из кэша', second?.cached === true && hits === before, `обращений к сети: ${hits - before}`);

// ── 4. лимит провайдера (429) не роняет конвейер ────────────────────────────
mode = '429';
const limited = await llm.completeJson({ prompt: 'промпт под 429, чтобы кэш не мешал', maxTokens: 80 });
check('429 обработан как отказ, а не падение', limited?.ok === false, String(limited?.reason).slice(0, 90));
mode = 'good';

// ── 5. мусор вместо JSON отсекается ─────────────────────────────────────────
mode = 'garbage';
const garbage = await llm.completeJson({ prompt: 'промпт под мусорный ответ', maxTokens: 80 });
check('невалидный JSON отсечён повторной попыткой', garbage?.ok === false, String(garbage?.reason || 'bad_json').slice(0, 60));
mode = 'good';

// ── 6. кэш и счётчик квоты лежат на диске ───────────────────────────────────
const cacheDir = path.join(tmp, 'ai-cache');
const cacheFiles = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json')) : [];
check('кэш ответов пишется на диск', cacheFiles.length > 0, `файлов: ${cacheFiles.length}`);
check('счётчик дневной квоты сохраняется', fs.existsSync(path.join(cacheDir, 'usage.json')));

// ── 7. секреты не утекают в статус ──────────────────────────────────────────
check('ключи не попадают в статус для панели', !JSON.stringify(llm.status()).includes(String(process.env.OLLAMA_BASE_URL)));
check('в статусе есть где взять бесплатный ключ', llm.status().providers.every((p) => Boolean(p.docs)));

// ── 8. сквозной путь: движок ИИ пишет сценарий через роутер ─────────────────
const pack = await ai.shortPack({ project: { name: 'Тест', niche: 'тест' }, idea: { title: 'Тема' }, durationSec: 36, platform: 'reels' });
check('движок ИИ собрал сценарий', Boolean(pack?.scenes?.length === 3 && pack.provider), `${pack?.scenes?.length} сцен, ${pack?.provider}`);
check('движок отфильтровал сцены по языку и длине', pack?.scenes?.every((s) => s.text.split(/\s+/).length >= 4));

// ── 9. деградация: без ключа ИИ честно выключен ─────────────────────────────
delete process.env.PULSE_OLLAMA;
delete process.env.PULSE_AI;
check('без ключа ИИ выключен', llm.enabled() === false);
check('движок ИИ сообщает о недоступности', ai.available() === false);
const fallback = await ai.shortPack({ project: { name: 'Тест' }, idea: { title: 'Тема' } });
check('без ИИ движок возвращает null, а не падает', fallback === null);
const selfTest = await llm.selfTest();
check('selftest объясняет, почему ИИ не работает', selfTest.ok === false && Boolean(selfTest.reason), String(selfTest.reason).slice(0, 70));

mock.close();
try { db.close(); } catch { /* база могла быть уже закрыта */ }
fs.rmSync(tmp, { recursive: true, force: true });

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed === results.length ? '✓' : '✗'} ИИ-контур: ${passed}/${results.length}\n`);
process.exit(passed === results.length ? 0 : 1);
