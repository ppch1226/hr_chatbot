/**
 * KT IS 인사해삐 (HR Happy AI) 서버
 * - 정적 화면 제공 (public/)
 * - 인사 제규정 RAG 챗봇 (BGE-M3 + Qdrant 하이브리드 검색 + 리랭커 + OpenRouter LLM)
 * - 국가법령정보센터 Open API 조회 → 사규 RAG 기반 정합성 분석
 * - 정합성 리포트 · FAQ · 리스크 알림 · 비식별 질문 통계 저장 (data/*.json)
 */
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));

const ROOT = __dirname;
const nm = (...p) => path.join(ROOT, 'node_modules', ...p);

// ── 정적 파일 (오프라인에서도 동작하도록 라이브러리·폰트를 로컬에서 제공)
// 화면 파일(html/js/css)은 매번 새로 확인해 예전 캐시가 보이지 않게
app.use(express.static(path.join(ROOT, 'public'), { setHeaders: (res, p) => { if (/\.(html|js|css)$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); } }));
app.use('/vendor/tailwind', express.static(nm('@tailwindcss', 'browser', 'dist')));
app.use('/vendor/marked', express.static(nm('marked')));
app.use('/vendor/dompurify', express.static(nm('dompurify', 'dist')));
app.use('/vendor/pretendard', express.static(nm('pretendard', 'dist', 'web', 'static')));
app.use('/vendor/symbols', express.static(nm('material-symbols')));
app.use('/vendor/chartjs', express.static(nm('chart.js', 'dist')));

// ── 설정
const PORT = Number(process.env.PORT || 3000);
const LAW_OC = (process.env.LAW_OC || '').trim();
const rag = require('./rag/answer');
const compliance = require('./rag/compliance');
const llm = require('./rag/llm');
const qdrant = require('./rag/qdrant');
const models = require('./rag/models');
const sensitive = require('./rag/sensitive');
const lawsources = require('./rag/lawsources');
const notify = require('./rag/notify');
const scheduler = require('./rag/scheduler');
const userdata = require('./rag/userdata');

// ── JSON 저장소
const DATA_DIR = path.join(ROOT, 'data');
const SEED_DIR = path.join(ROOT, 'seed');
function load(name) {
  const file = path.join(DATA_DIR, name);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(path.join(SEED_DIR, name), file);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function save(name, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data, null, 2));
}

const todayKST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const nowKST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
const fmtDate = (s) => (s && /^\d{8}$/.test(String(s)) ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6, 8)}` : s || '');

// ════════════════════════════════════════════════════════════════
// 비식별 질문 통계 (질문 원문·사용자 정보는 저장하지 않고 분류만 기록)
// ════════════════════════════════════════════════════════════════
const TOPICS = [
  { key: '연차 사용 및 촉진', words: ['연차', '반차', '휴가 사용', '촉진'] },
  { key: '육아휴직 급여 및 기간', words: ['육아', '출산', '임신', '모성', '배우자 출산'] },
  { key: '복지포인트 사용처 및 마감', words: ['복지', '포인트', '건강검진'] },
  { key: '연장근무 사전승인 절차', words: ['연장근무', '연장 근무', '야근', '초과근무', '시간외'] },
  { key: '경조휴가 증빙서류 제출', words: ['경조', '결혼', '부고', '조의', '청원'] },
  { key: '급여·퇴직금', words: ['급여', '월급', '퇴직', '연금', 'irp', 'IRP'] },
];
const SENSITIVE = [
  { key: '괴롭힘', words: ['괴롭힘', '폭언', '따돌림', '왕따'] },
  { key: '부당(인사·처우)', words: ['부당', '전보', '대기발령', '차별'] },
  { key: '갑질', words: ['갑질'] },
  { key: '해고 / 징계', words: ['해고', '징계', '면직', '무단결근'] },
  { key: '성희롱 예방·상담', words: ['성희롱', '성추행', '성적'] },
];
const classify = (text, list) => list.filter((t) => t.words.some((w) => text.includes(w))).map((t) => t.key);

function recordQuestion(role, text) {
  const stats = load('stats.json');
  for (const k of classify(text, TOPICS)) stats.topics[k] = (stats.topics[k] || 0) + 1;
  for (const k of classify(text, SENSITIVE)) stats.sensitive[k] = (stats.sensitive[k] || 0) + 1;
  stats.total = (stats.total || 0) + 1;
  stats.updatedAt = nowKST();
  save('stats.json', stats);
  return classify(text, SENSITIVE);
}

// 시연 환경의 사용자 식별: 역할 + 이름 (실서비스에서는 사내 SSO 사번으로 대체)
const userKey = (q) => `${q.role === 'admin' ? 'admin' : 'employee'}:${String(q.user || 'OO').slice(0, 40)}`;

// ════════════════════════════════════════════════════════════════
// API: 상태 / RAG 챗봇
// ════════════════════════════════════════════════════════════════
function ragDocs() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rag-docs.json'), 'utf8'));
  } catch {
    return null;
  }
}

app.get('/api/status', async (req, res) => {
  const index = await qdrant.info();
  res.json({
    rag: { llm: llm.configured(), model: llm.MODEL(), index: !!(index && index.points), chunks: index ? index.points : 0, docs: (ragDocs() || {}).docs || [] },
    // 국가법령정보센터: 직원용 = 법령 / 담당자용 = 법령·판례·행정규칙·행정해석·노동위원회
    law: { ...(await lawsources.status()), employee: ['법령'], admin: ['법령', '판례', '행정규칙', '행정해석', '노동위원회'] },
    lawApi: !!LAW_OC,
    today: todayKST(),
  });
});

// 스트리밍 답변 (Server-Sent Events): 검색 단계 → 답변 토큰 → 최종 결과(출처·시각화·후속 질문)
app.post('/api/chat/stream', async (req, res) => {
  const { role = 'employee', message = '', sessionId = 'default', anonymous = false, user = '' } = req.body || {};
  const who = role === 'admin' ? 'admin' : 'employee';
  const text = String(message).trim();
  if (!text) return res.status(400).json({ error: '질문을 입력하세요.' });
  if (text.length > 1000) return res.status(400).json({ error: '질문은 1,000자 이내로 입력하세요.' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  let closed = false;
  res.on('close', () => (closed = true));
  const sensitiveTopics = recordQuestion(who, text);
  send({ type: 'stage', stage: 'searching' });
  try {
    const r = await rag.answer({ question: text, role: who, sessionId: `${who}:${sessionId}`, anonymous: !!anonymous, onEvent: (e) => !closed && send(e) });
    // 나의 질문기록: 익명 질문이 아니고 사용자를 알 때만 본인용으로 저장
    if (!anonymous && user) userdata.addHistory(userKey({ role: who, user }), { question: text, answer: r.answer, sources: r.sources, ehr: r.ehr });
    if (!closed) send({ type: 'done', ...r, sensitive: sensitiveTopics });
  } catch (e) {
    console.error('[chat/stream]', e.message);
    if (!closed) send({ type: 'error', error: e.message });
  }
  res.end();
});

app.post('/api/chat', async (req, res) => {
  const { role = 'employee', message = '', sessionId = 'default', reset = false, anonymous = false, user = '' } = req.body || {};
  const who = role === 'admin' ? 'admin' : 'employee';
  const key = `${who}:${sessionId}`;
  if (reset) {
    rag.reset(key);
    return res.json({ ok: true });
  }
  const text = String(message).trim();
  if (!text) return res.status(400).json({ error: '질문을 입력하세요.' });
  if (text.length > 1000) return res.status(400).json({ error: '질문은 1,000자 이내로 입력하세요.' });

  // 통계는 원래부터 주제별 건수만 기록 (질문 원문·사용자 정보 없음)
  const sensitive = recordQuestion(who, text);
  try {
    const r = await rag.answer({ question: text, role: who, sessionId: key, anonymous: !!anonymous });
    if (!anonymous && user) userdata.addHistory(userKey({ role: who, user }), { question: text, answer: r.answer, sources: r.sources, ehr: r.ehr });
    res.json({ ...r, sensitive });
  } catch (e) {
    console.error('[chat]', e.message); // 질문 원문은 로그에 남기지 않음
    res.status(502).json({ error: e.message });
  }
});

// 입력 중인 질문이 민감한 내용인지 판단 (익명 질문 체크박스 표시용). 입력 문장은 저장하지 않음
app.post('/api/sensitivity', async (req, res) => {
  const text = String((req.body || {}).text || '').slice(0, 500);
  try {
    const r = await sensitive.detect(text);
    res.json({ sensitive: r.sensitive, category: r.category || null });
  } catch (e) {
    res.json({ sensitive: false, category: null });
  }
});

// 답변 평가·개선 피드백. 익명 질문이면 질문·답변 내용은 저장하지 않음
const FEEDBACK_TAGS = ['정확하지 않아요', '근거가 부족해요', '이해하기 어려워요', '너무 길어요', '원하는 답이 아니에요', '정확해요', '이해하기 쉬워요', '근거가 확실해요'];
function loadFeedback() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'feedback.json'), 'utf8'));
  } catch {
    return [];
  }
}
app.post('/api/feedback', (req, res) => {
  const b = req.body || {};
  const rating = Math.round(Number(b.rating));
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: '1~5점으로 평가해 주세요.' });
  const anon = !!b.anonymous;
  const item = {
    id: crypto.randomBytes(4).toString('hex'),
    createdAt: nowKST(),
    role: b.role === 'admin' ? 'admin' : 'employee',
    rating,
    tags: (Array.isArray(b.tags) ? b.tags : []).filter((t) => FEEDBACK_TAGS.includes(t)),
    // 익명 질문: 점수·태그만 저장 (자유 의견·질문·답변·근거 조문은 저장하지 않음)
    comment: anon ? null : String(b.comment || '').slice(0, 1000),
    anonymous: anon,
    question: anon ? null : String(b.question || '').slice(0, 1000),
    answer: anon ? null : String(b.answer || '').slice(0, 4000),
    sources: anon ? [] : (Array.isArray(b.sources) ? b.sources : []).slice(0, 10).map(String),
  };
  const list = loadFeedback();
  list.unshift(item);
  save('feedback.json', list);
  res.json({ ok: true, id: item.id });
});
app.get('/api/feedback', (req, res) => {
  const list = loadFeedback();
  const avg = list.length ? Math.round((list.reduce((s, x) => s + x.rating, 0) / list.length) * 100) / 100 : null;
  res.json({ count: list.length, average: avg, items: list.slice(0, 200) });
});

// ════════════════════════════════════════════════════════════════
// API: 사내 알림 · 프로필 · 사규 업로드
// ════════════════════════════════════════════════════════════════

app.get('/api/notifications', (req, res) => {
  const role = req.query.role === 'admin' ? 'admin' : 'employee';
  const recentTopics = String(req.query.recent || '').split(',').filter(Boolean).slice(0, 20);
  let items = notify.listFor(userKey(req.query), role, { recentTopics });
  if (role === 'admin') {
    // 리스크 조기 알림(미확인)도 담당자 알림함에 함께 표시
    const reads = new Set(((notify.state().reads || {})[userKey(req.query)]) || []);
    const risks = load('risks.json')
      .filter((r) => r.status === '미확인')
      .map((r) => ({ id: 'risk-' + r.id, kind: 'risk', audience: 'admin', createdAt: r.detectedAt, title: r.title, summary: r.diagnosis, level: r.level, link: '/risk.html', related: true, reasons: ['담당 업무: 리스크'], read: reads.has('risk-' + r.id) }));
    items = [...items, ...risks].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  res.json({
    items,
    unread: items.filter((n) => !n.read).length,
    unreadRelated: items.filter((n) => !n.read && n.related).length,
  });
});
app.post('/api/notifications/read', (req, res) => {
  const b = req.body || {};
  const ids = b.all ? notify.listFor(userKey(b), b.role === 'admin' ? 'admin' : 'employee').map((n) => n.id).concat(load('risks.json').map((r) => 'risk-' + r.id)) : (b.ids || []).map(String);
  notify.markRead(userKey(b), ids);
  res.json({ ok: true });
});

app.get('/api/profile', (req, res) => res.json({ profile: notify.getProfile(userKey(req.query)), options: notify.OPTIONS }));
app.put('/api/profile', (req, res) => res.json({ profile: notify.saveProfile(userKey(req.body || {}), req.body || {}) }));

// ── 마이페이지: 나의 질문기록 · 직급별 통계 · 캘린더 · 맞춤 추천 질문 · 날씨
const readProfiles = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'profiles.json'), 'utf8')); } catch { return {}; } };
// 시연용 계정 (seed/personas.json): 아이디·비밀번호(텍스트)와 페르소나 정보
const loadAccounts = () => JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'personas.json'), 'utf8'));
const publicPersona = ({ questions, calendar, password, ...p }) => p;
app.get('/api/personas', (req, res) => res.json(loadAccounts().map(publicPersona)));
app.post('/api/login', (req, res) => {
  const { id = '', password = '' } = req.body || {};
  const acc = loadAccounts().find((a) => a.loginId === String(id).trim().toLowerCase());
  const ok = acc && acc.password === String(password);
  if (!ok) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  res.json(publicPersona(acc));
});
app.get('/api/history', (req, res) => res.json({ items: userdata.getHistory(userKey(req.query)), categories: userdata.CATEGORIES }));
app.delete('/api/history/:id', (req, res) => { userdata.deleteHistory(userKey(req.query), req.params.id); res.json({ ok: true }); });
app.get('/api/grade-stats', (req, res) => res.json({ items: userdata.gradeStats(readProfiles()), note: '시연용 기본 집계에 실제 질문기록(직급 설정 사용자)을 더한 비율' }));
app.get('/api/calendar', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : todayKST().slice(0, 7);
  const regs = notify.listFor(userKey(req.query), req.query.role === 'admin' ? 'admin' : 'employee').filter((n) => n.kind === 'reg-change');
  res.json(userdata.calendar(userKey(req.query), month, regs));
});
app.post('/api/calendar', (req, res) => {
  try { res.json(userdata.addEvent(userKey(req.body || {}), req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/calendar/:id', (req, res) => { userdata.deleteEvent(userKey(req.query), req.params.id); res.json({ ok: true }); });
app.get('/api/suggest', (req, res) => {
  const role = req.query.role === 'admin' ? 'admin' : 'employee';
  const recent = String(req.query.recent || '').split(',').filter(Boolean).slice(0, 10);
  const user = userKey(req.query);
  const s = load('stats.json');
  res.json({
    items: userdata.suggest({
      admin: role === 'admin',
      profile: notify.getProfile(user),
      recent,
      related: notify.listFor(user, role, { recentTopics: recent }).filter((n) => n.related),
      stats: { topics: ranked(s.topics) },
      faq: load('faq.json'),
      risks: role === 'admin' ? load('risks.json') : [],
      reports: role === 'admin' ? load('reports.json') : [],
    }),
  });
});
app.get('/api/weather', async (req, res) => {
  try { res.json(await userdata.weather()); } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/notify/status', (req, res) => res.json(scheduler.status()));
app.post('/api/notify/check', async (req, res) => {
  const what = (req.body || {}).what === 'laws' ? 'laws' : 'regs';
  try {
    const r = await scheduler.run(what, { source: '담당자 수동 확인', log: (m) => console.log(m) });
    if (r.busy) return res.status(409).json({ error: '다른 확인 작업이 진행 중입니다. 잠시 후 다시 시도하세요.' });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 새 개정본 업로드 (담당자): 파일명에서 규정명·개정일을 읽고, 같은 규정의 이전 파일은 _archive 로
app.post('/api/regulations/upload', express.raw({ type: 'application/octet-stream', limit: '30mb' }), async (req, res) => {
  const name = path.basename(decodeURIComponent(String(req.headers['x-file-name'] || '')));
  if (!/\.hwpx?$/i.test(name)) return res.status(400).json({ error: 'HWP 또는 HWPX 파일만 올릴 수 있습니다.' });
  if (!/\(\d{4}년도\s*\d{1,2}월/.test(name)) return res.status(400).json({ error: '파일명에 개정일을 넣어 주세요. 예: 인사관리규정(2026년도 12월 1일 개정).hwp' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: '빈 파일입니다.' });
  const { DOCS_DIR } = require('./rag/ingest');
  fs.writeFileSync(path.join(DOCS_DIR, name), req.body);
  try {
    const r = await scheduler.run('regs', { source: '담당자 업로드', log: (m) => console.log(m) });
    if (r.busy) return res.status(202).json({ ok: true, queued: true, message: '업로드했습니다. 진행 중인 확인이 끝나면 다음 확인 때 반영됩니다.' });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
// API: 국가법령정보센터
// ════════════════════════════════════════════════════════════════
const LAW_BASE = 'https://www.law.go.kr/DRF';
function flat(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(flat).filter(Boolean).join('\n');
  if (typeof v === 'object') return Object.values(v).map(flat).filter(Boolean).join('\n');
  return '';
}
async function lawFetchJson(url) {
  const r = await fetch(url);
  const body = await r.text();
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('법령 API 응답을 해석할 수 없습니다. OC 값과 등록 IP를 확인하세요. 응답: ' + body.slice(0, 120));
  }
}
async function lawSearch(query) {
  if (!LAW_OC) throw new Error('.env에 LAW_OC(법령 API 인증키)를 설정하세요.');
  const j = await lawFetchJson(`${LAW_BASE}/lawSearch.do?OC=${encodeURIComponent(LAW_OC)}&target=law&type=JSON&display=10&query=${encodeURIComponent(query)}`);
  let list = (j.LawSearch && j.LawSearch.law) || [];
  if (!Array.isArray(list)) list = [list];
  return list.map((x) => ({
    name: x['법령명한글'],
    mst: x['법령일련번호'],
    id: x['법령ID'],
    kind: x['법령구분명'],
    revision: x['제개정구분명'],
    promulgated: fmtDate(x['공포일자']),
    effective: fmtDate(x['시행일자']),
  }));
}
async function lawDetail(mst) {
  const j = await lawFetchJson(`${LAW_BASE}/lawService.do?OC=${encodeURIComponent(LAW_OC)}&target=law&type=JSON&MST=${encodeURIComponent(mst)}`);
  const L = j['법령'] || j;
  const info = L['기본정보'] || {};
  // 부칙: 이번 공포일자와 같은 부칙만 추림
  let addenda = '';
  const units = L['부칙'] && L['부칙']['부칙단위'];
  if (Array.isArray(units)) {
    const hit = units.find((u) => String(u['부칙공포일자']) === String(info['공포일자'])) || units[units.length - 1];
    addenda = flat(hit && hit['부칙내용']);
  } else addenda = flat(L['부칙']);
  return {
    name: info['법령명_한글'] || info['법령명한글'] || '',
    promulgated: fmtDate(info['공포일자']),
    effective: fmtDate(info['시행일자']),
    revision: flat(info['제개정구분']) || info['제개정구분명'] || '',
    reason: flat(L['제개정이유']),
    amendment: flat(L['개정문']),
    addenda,
  };
}

app.get('/api/law/search', async (req, res) => {
  try {
    res.json({ items: await lawSearch(String(req.query.query || '')) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
// API: 정합성 분석
// ════════════════════════════════════════════════════════════════
/** 법령 1건 정합성 분석 → 리포트 저장 → 담당자 알림 */
async function saveAnalysis(law, { requestId, trigger }) {
  requestId = requestId || `${todayKST().replace(/-/g, '')}-${crypto.randomBytes(2).toString('hex')}`;
  const parsed = await compliance.analyze(law, { requestId, today: todayKST() });
  const reports = load('reports.json');
  const item = {
    id: requestId,
    createdAt: nowKST(),
    trigger,
    law: { name: law.name, promulgated: law.promulgated, effective: law.effective, revision: law.revision },
    summary: parsed.summary,
    report: parsed.report,
    sources: parsed.sources,
    status: '미검토',
  };
  reports.unshift(item);
  save('reports.json', reports);
  const c = (item.summary && item.summary.판정건수) || {};
  const n = notify.addNotification({ kind: 'compliance', audience: 'admin', title: `정합성 분석 완료: ${law.name}`, summary: `위반 ${c.위반 || 0} · 미반영 ${c.미반영 || 0} · 보완권고 ${c.보완권고 || 0} · 정합 ${c.정합 || 0}`, link: '/compliance.html', effective: law.effective || '', reportId: item.id, trigger });
  item.notificationId = n && n.id;
  return item;
}

// ── 자동 정합성 분석: 매주 정기 법령 확인 때 개정된 법령을 자동 분석, '지금 분석하기'로 즉시 실행
const RUNS_FILE = path.join(DATA_DIR, 'compliance-runs.json');
const loadRuns = () => { try { return JSON.parse(fs.readFileSync(RUNS_FILE, 'utf8')); } catch { return []; } };
let autoProgress = null; // { source, startedAt, step }
scheduler.onLawsChecked = async ({ changedLaws, source, log }) => {
  const run = { id: crypto.randomBytes(4).toString('hex'), source, startedAt: (autoProgress && autoProgress.startedAt) || nowKST(), checked: lawsources.LAWS.length, changed: changedLaws, analyzed: [], errors: [] };
  // 대상: 이번에 개정이 감지된 법령 + (지금 분석하기) 아직 현행 버전으로 분석한 적 없는 최근 개정 법령 최대 2건
  const targets = [...changedLaws];
  if (source === '지금 분석하기') {
    const versions = notify.state().laws || {};
    const done = new Set(load('reports.json').map((r) => `${r.law.name}|${r.law.promulgated}`));
    const pending = Object.entries(versions)
      .filter(([name, v]) => !targets.includes(name) && !done.has(`${name}|${v.promulgated}`))
      .sort((a, b) => String(b[1].promulgated).localeCompare(String(a[1].promulgated)))
      .slice(0, Math.max(0, 2 - targets.length));
    targets.push(...pending.map(([name]) => name));
    run.pending = pending.map(([name, v]) => ({ name, promulgated: v.promulgated }));
  }
  if (!llm.configured() || !LAW_OC) run.errors.push('LLM 또는 법령 API 키가 설정되지 않아 분석을 건너뜀');
  else {
    for (const [i, name] of targets.entries()) {
      if (autoProgress) autoProgress.step = `정합성 분석 중 (${i + 1}/${targets.length}): ${name}`;
      try {
        const found = (await lawSearch(name)).find((x) => x.name === name);
        if (!found) throw new Error('법령을 찾지 못함');
        const item = await saveAnalysis(await lawDetail(found.mst), { trigger: source });
        run.analyzed.push({ law: name, reportId: item.id, counts: (item.summary && item.summary.판정건수) || {} });
      } catch (e) {
        run.errors.push(`${name}: ${e.message}`);
        log && log(`  자동 정합성 분석 실패(${name}): ${e.message}`);
      }
    }
  }
  run.finishedAt = nowKST();
  const runs = loadRuns();
  runs.unshift(run);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RUNS_FILE, JSON.stringify(runs.slice(0, 100), null, 2));
};
app.get('/api/compliance/auto', (req, res) => {
  const st = scheduler.status();
  res.json({ schedule: st.schedule.laws, enabled: st.schedule.enabled, next: st.next.laws, lastCheck: st.last.laws || null, running: autoProgress, runs: loadRuns().slice(0, 20), laws: lawsources.LAWS.length });
});
app.post('/api/compliance/auto/run', (req, res) => {
  if (autoProgress || scheduler.status().running) return res.status(409).json({ error: '이미 분석이 진행 중이에요. 잠시 후 다시 확인하세요.', running: autoProgress });
  autoProgress = { source: '지금 분석하기', startedAt: nowKST(), step: `법령 ${lawsources.LAWS.length}개 개정 여부 확인 중` };
  scheduler
    .run('laws', { source: '지금 분석하기', log: (m) => console.log(m) })
    .catch((e) => console.error('  지금 분석하기 실패:', e.message))
    .finally(() => (autoProgress = null));
  res.status(202).json({ started: true, running: autoProgress });
});

app.post('/api/compliance/run', async (req, res) => {
  const { mst, name } = req.body || {};
  const requestId = `${todayKST().replace(/-/g, '')}-${crypto.randomBytes(2).toString('hex')}`;
  try {
    let law;
    if (!llm.configured()) throw new Error('.env에 OPENROUTER_API_KEY를 설정하세요.');
    if (mst && LAW_OC) law = await lawDetail(mst);
    else if (name && LAW_OC) {
      const found = (await lawSearch(name))[0];
      if (!found) throw new Error(`"${name}" 법령을 찾지 못했습니다.`);
      law = await lawDetail(found.mst);
    } else law = { name: name || '(법령명 미입력)', promulgated: '', effective: '', revision: '', reason: '', amendment: '', addenda: '' };

    res.json(await saveAnalysis(law, { requestId, trigger: '직접 실행' }));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/compliance/reports', (req, res) => res.json(load('reports.json')));
app.patch('/api/compliance/reports/:id', (req, res) => {
  const reports = load('reports.json');
  const r = reports.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (req.body.status) r.status = req.body.status;
  r.updatedAt = nowKST();
  save('reports.json', reports);
  res.json(r);
});
app.delete('/api/compliance/reports/:id', (req, res) => {
  save('reports.json', load('reports.json').filter((x) => x.id !== req.params.id));
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════
// API: FAQ / 리스크 / 통계 / 사규 목록
// ════════════════════════════════════════════════════════════════
app.get('/api/faq', (req, res) => {
  let list = load('faq.json');
  if (req.query.status) list = list.filter((f) => f.status === req.query.status);
  res.json(list);
});
app.post('/api/faq', (req, res) => {
  const list = load('faq.json');
  const nextId = String(Math.max(0, ...list.map((f) => Number(f.id) || 0)) + 1).padStart(3, '0');
  const item = { id: nextId, category: req.body.category || '기타', question: req.body.question || '', answer: req.body.answer || '', basis: req.body.basis || '', status: '대기', createdAt: todayKST() };
  list.unshift(item);
  save('faq.json', list);
  res.json(item);
});
app.patch('/api/faq/:id', (req, res) => {
  const list = load('faq.json');
  const f = list.find((x) => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'not found' });
  ['question', 'answer', 'basis', 'category', 'status'].forEach((k) => req.body[k] !== undefined && (f[k] = req.body[k]));
  f.updatedAt = nowKST();
  save('faq.json', list);
  res.json(f);
});

app.get('/api/risks', (req, res) => res.json(load('risks.json')));
app.patch('/api/risks/:id', (req, res) => {
  const list = load('risks.json');
  const r = list.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (req.body.status) r.status = req.body.status;
  save('risks.json', list);
  res.json(r);
});

function ranked(obj) {
  const total = Object.values(obj).reduce((a, b) => a + b, 0) || 1;
  return Object.entries(obj)
    .map(([key, count]) => ({ key, count, pct: Math.round((count / total) * 100) }))
    .sort((a, b) => b.count - a.count);
}
app.get('/api/stats', (req, res) => {
  const s = load('stats.json');
  res.json({ topics: ranked(s.topics), sensitive: ranked(s.sensitive), total: s.total, updatedAt: s.updatedAt });
});

app.get('/api/regulations', (req, res) => {
  const idx = ragDocs();
  if (!idx) return res.json(load('regulations.json'));
  res.json(idx.docs.map((d) => ({ name: d.docLabel, revised: d.revised, desc: `조문 ${d.articles}개 · 청크 ${d.chunks}개`, ask: `${d.docLabel}의 주요 내용을 요약해줘` })));
});


app.listen(PORT, async () => {
  console.log(`\n  인사해삐 HR Happy AI  →  http://localhost:${PORT}`);
  console.log(`  LLM: ${llm.configured() ? llm.MODEL() + ' (OpenRouter)' : '미설정 (OPENROUTER_API_KEY)'}`);
  console.log(`  법령 API: ${LAW_OC ? '설정됨' : '미설정 (LAW_OC)'}`);
  try {
    await qdrant.ensureRunning();
    const i = await qdrant.info();
    console.log(`  Qdrant: ${i ? i.points + '개 청크 색인됨' : '색인 없음 → npm run ingest 실행 필요'}`);
    const ls = await lawsources.status();
    if (ls.configured && !ls.lawArticles) {
      console.log('  노동 법령 색인이 없어 국가법령정보센터에서 받아옵니다…');
      await lawsources.ingestLaws({ log: (m) => console.log(m) }).catch((e) => console.error('  법령 색인 실패:', e.message));
    } else console.log(`  법령: ${ls.lawArticles}개 조문 색인됨 (판례·행정해석 등은 질문 시 실시간 조회)`);
    process.stdout.write('  임베딩·리랭커 모델 로딩 중… ');
    await models.warmup();
    await sensitive.warmup();
    scheduler.start((m) => console.log(m));
    console.log('완료\n');
  } catch (e) {
    console.error('  RAG 준비 실패:', e.message, '\n');
  }

});
