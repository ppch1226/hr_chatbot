/**
 * 국가법령정보센터(law.go.kr) Open API 근거
 *
 *  직원용 챗봇      : 법령
 *  인사담당자용 챗봇 : 법령 + 판례 + 행정규칙 + 고용노동부 행정해석 + 노동위원회 결정례
 *
 *  - 법령: 본문 검색 API는 관련 없는 법령까지 섞여 나오므로, 주요 노동 법령을 미리 받아
 *          조문 단위로 BGE-M3 색인(Qdrant 컬렉션 labor_laws) → 질문과 의미 검색
 *          (npm run ingest:laws / 서버 시작 시 색인이 없으면 자동 생성)
 *  - 판례·행정규칙·행정해석·노동위원회: 질문마다 실시간 검색 → 상세 조회 → 질문과 유사도 순 정렬
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { embed, rerank } = require('./models');
const sparse = require('./sparse');
const { chat } = require('./llm');

const B = 'https://www.law.go.kr/DRF';
const OC = () => (process.env.LAW_OC || '').trim();
const LAW_COLLECTION = 'labor_laws';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'law-articles.json');

// 색인할 주요 노동·인사 법령 (법령명 정확히 일치)
const LAWS = [
  '근로기준법',
  '근로기준법 시행령',
  '남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률',
  '남녀고용평등과 일ㆍ가정 양립 지원에 관한 법률 시행령',
  '근로자퇴직급여 보장법',
  '최저임금법',
  '기간제 및 단시간근로자 보호 등에 관한 법률',
  '파견근로자 보호 등에 관한 법률',
  '노동조합 및 노동관계조정법',
  '근로자참여 및 협력증진에 관한 법률',
  '산업안전보건법',
  '산업재해보상보험법',
  '고용보험법',
  '모자보건법',
  '부정청탁 및 금품등 수수의 금지에 관한 법률',
  '공익신고자 보호법',
];

const KIND = { law: '법령', prec: '판례', admrul: '행정규칙', moelCgmExpc: '행정해석', nlrc: '노동위원회' };

// ── 공통: API 호출 (키는 서버에서만 사용, 화면에 노출하지 않음)
const memo = new Map(); // 같은 요청 재사용 (최대 500개)
async function api(kind, params, { timeoutMs = 8000 } = {}) {
  if (!OC()) throw new Error('LAW_OC 미설정');
  const qs = new URLSearchParams({ OC: OC(), type: 'JSON', ...params }).toString();
  const url = `${B}/${kind}.do?${qs}`;
  if (memo.has(url)) return memo.get(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const t = await r.text();
    const j = JSON.parse(t);
    if (memo.size > 500) memo.delete(memo.keys().next().value);
    memo.set(url, j);
    return j;
  } finally {
    clearTimeout(timer);
  }
}
const listOf = (j) => {
  const r = Object.values(j || {})[0] || {};
  const k = Object.keys(r).find((x) => Array.isArray(r[x]) || (r[x] && typeof r[x] === 'object' && x !== '키워드'));
  return k ? [].concat(r[k]) : [];
};
const clean = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
const ymd = (s) => (/^\d{8}$/.test(String(s)) ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6, 8)}` : String(s || '').replace(/\./g, '-').replace(/-$/, ''));

// ════════════════════════════════════════════════════════════════
// 1) 법령: 조문 단위 색인
// ════════════════════════════════════════════════════════════════
function articleText(u) {
  const parts = [];
  if (u['조문내용']) parts.push(clean(u['조문내용']));
  for (const h of [].concat(u['항'] || [])) {
    if (h['항내용']) parts.push(clean(h['항내용']));
    for (const ho of [].concat(h['호'] || [])) {
      if (ho['호내용']) parts.push('  ' + clean(ho['호내용']));
      for (const mok of [].concat(ho['목'] || [])) if (mok['목내용']) parts.push('    ' + clean(mok['목내용']));
    }
  }
  return parts.join('\n').trim();
}

async function fetchLawArticles(name) {
  const found = listOf(await api('lawSearch', { target: 'law', query: name, display: '20' })).find((x) => x['법령명한글'] === name);
  if (!found) throw new Error(`법령을 찾지 못함: ${name}`);
  const d = await api('lawService', { target: 'law', MST: found['법령일련번호'] }, { timeoutMs: 30000 });
  const L = d['법령'];
  const info = L['기본정보'] || {};
  const out = [];
  for (const u of [].concat((L['조문'] && L['조문']['조문단위']) || [])) {
    if (u['조문여부'] !== '조문') continue;
    const text = articleText(u);
    if (!text || /^제\d+조(의\d+)?\s*(\([^)]*\))?\s*삭제/.test(text)) continue;
    const no = `제${u['조문번호']}조${u['조문가지번호'] ? '의' + u['조문가지번호'] : ''}`;
    const title = clean(u['조문제목'] || '');
    out.push({
      kind: '법령',
      law: name,
      articleNo: no,
      title: `${name} ${no}${title ? `(${title})` : ''}`,
      date: ymd(info['시행일자']),
      text,
      url: `https://www.law.go.kr/법령/${encodeURIComponent(name.replace(/\s+/g, ''))}/${encodeURIComponent(no)}`,
    });
  }
  return out;
}

async function ingestLaws({ log = console.log } = {}) {
  const qdrant = require('./qdrant');
  const all = [];
  for (const name of LAWS) {
    try {
      const arts = await fetchLawArticles(name);
      all.push(...arts);
      log(`  ${name}: 조문 ${arts.length}개`);
    } catch (e) {
      log(`  ⚠ ${name}: ${e.message}`);
    }
  }
  if (!all.length) throw new Error('받아온 법령 조문이 없습니다. LAW_OC와 등록 IP를 확인하세요.');
  all.forEach((a, i) => (a.id = i + 1));
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), laws: LAWS, articles: all }, null, 1));
  log(`  임베딩 ${all.length}개 …`);
  const content = (a) => `[${a.title}]\n${a.text}`;
  const vecs = await embed(all.map(content));
  const avg = all.reduce((s, a) => s + sparse.tokenize(content(a)).length, 0) / all.length;
  await qdrant.ensureRunning();
  await qdrant.recreateCollection(vecs[0].length, LAW_COLLECTION);
  await qdrant.upsert(all.map((a, i) => ({ id: a.id, vector: { dense: vecs[i], sparse: sparse.docVector(content(a), avg) }, payload: { ...a, content: content(a) } })), LAW_COLLECTION);
  log(`  Qdrant 컬렉션 "${LAW_COLLECTION}" 저장: ${all.length}개`);
  return all.length;
}

/**
 * 법령 조문 검색: BGE-M3 코사인 유사도 상위 topK (임계값 이상)
 * 리랭커(약 1.7초, CPU)와 1순위가 비슷하고 일부는 더 정확해서 속도를 위해 유사도만 사용.
 * 관련 없는 조문이 섞여도 답변 프롬프트가 "질문과 관련 없는 법령은 언급하지 말 것"으로 걸러냄
 */
async function searchLaws(question, { dense, topK = 3, min = 0.6 } = {}) {
  const qdrant = require('./qdrant');
  const [v] = dense ? [dense] : await embed([question]);
  const hits = await qdrant.denseOnly({ dense: v, limit: topK, collection: LAW_COLLECTION, scoreThreshold: min });
  return hits.map((h) => ({ ...h.payload, score: h.score }));
}

// ════════════════════════════════════════════════════════════════
// 2) 판례·행정규칙·행정해석·노동위원회: 실시간 검색
// ════════════════════════════════════════════════════════════════
/** 질문 → API 검색어 (짧은 명사구 1~2개) */
// 노동법 검색어 사전 (질문 표현 → 판례·해석 검색에 쓰는 법률 용어). 위에서부터 우선
const TERMS = [
  [/직장\s*내\s*괴롭힘|괴롭힘|갑질|폭언|따돌림/, '직장 내 괴롭힘'],
  [/직장\s*내\s*성희롱|성희롱|성추행/, '직장 내 성희롱'],
  [/부당\s*해고|해고\s*(가|는|를|해도|하면|당)|해고/, '해고'],
  [/권고\s*사직/, '권고사직'], [/해고\s*예고/, '해고예고'], [/경영상\s*(이유|해고)|정리\s*해고/, '경영상 해고'],
  [/무단\s*결근|무단결근/, '무단결근'], [/징계\s*위원회/, '징계위원회'], [/소명/, '소명 기회'], [/징계|정직|감봉|견책/, '징계'],
  [/퇴사.{0,8}(압박|강요|하라)|그만두라|나가라/, '퇴직 강요'], [/복귀|복직/, '복직'], [/발령|부서\s*이동/, '전보'], [/직위\s*해제|대기\s*발령/, '대기발령'], [/전보|전직|인사\s*발령/, '전보'],
  [/연차|연가/, '연차휴가'], [/사용\s*촉진/, '사용촉진'], [/연차\s*수당|미사용\s*수당/, '연차휴가 미사용수당'],
  [/육아\s*휴직/, '육아휴직'], [/육아기\s*근로시간\s*단축/, '육아기 근로시간 단축'], [/출산\s*전후\s*휴가|출산\s*휴가/, '출산전후휴가'], [/배우자\s*출산/, '배우자 출산휴가'],
  [/태아\s*검진/, '태아검진'], [/난임/, '난임치료휴가'], [/가족\s*돌봄/, '가족돌봄휴직'], [/임신/, '임신 근로자'],
  [/연장\s*근로|연장\s*근무|야근|초과\s*근무|시간외/, '연장근로'], [/휴일\s*근로|주말\s*출근/, '휴일근로'], [/야간\s*근로/, '야간근로'], [/휴게\s*시간/, '휴게시간'], [/근로\s*시간/, '근로시간'],
  [/유연\s*근무|시차\s*출퇴근/, '유연근무'], [/재택/, '재택근무'], [/탄력/, '탄력적 근로시간제'],
  [/통상\s*임금/, '통상임금'], [/평균\s*임금/, '평균임금'], [/임금\s*체불|월급.{0,6}(안|못)\s*(나|받)|체불/, '임금체불'], [/최저\s*임금/, '최저임금'], [/퇴직금|퇴직\s*연금/, '퇴직금'], [/상여|성과급/, '상여금'],
  [/산재|산업\s*재해|업무\s*중\s*(다치|사고)/, '산업재해'], [/수습|시용/, '시용기간'], [/기간제|계약직/, '기간제근로자'], [/파견/, '파견근로자'],
  [/노조|노동\s*조합/, '노동조합'], [/부당\s*노동\s*행위/, '부당노동행위'], [/단체\s*협약/, '단체협약'], [/취업\s*규칙/, '취업규칙 불이익변경'],
  [/차별/, '차별'], [/공익\s*신고|내부\s*고발|신고자/, '공익신고자 보호'], [/청탁|금품/, '청탁금지'],
];
/** 질문 → 검색어 1~2개 (사전 매칭, 즉시). 매칭이 없을 때만 LLM으로 추출 */
function ruleKeywords(question) {
  // 질문에 먼저 나온 표현 순으로
  const found = [];
  for (const [re, term] of TERMS) {
    const m = question.match(re);
    if (m && !found.some((f) => f.term === term)) found.push({ term, at: m.index });
  }
  const hits = found.sort((a, b) => a.at - b.at).map((f) => f.term);
  if (!hits.length) return [];
  // 두 용어가 함께 나오면 조합 검색어(예: "연차휴가 사용촉진")를 먼저, 그다음 가장 구체적인 단일 용어
  const out = hits.length >= 2 ? [`${hits[0]} ${hits[1]}`, hits[0]] : [hits[0]];
  return out.slice(0, 2);
}

async function keywords(question) {
  const k = ruleKeywords(question);
  if (k.length) return k;
  return llmKeywords(question);
}

async function llmKeywords(question) {
  try {
    const out = await chat(
      [
        { role: 'system', content: '노동법 판례·행정해석 검색용 키워드를 뽑습니다. JSON으로만 답하세요.' },
        { role: 'user', content: `질문: ${question}\n\n법률 용어로 된 핵심 검색어 1~2개 (각 2~10자, 예: "연차휴가 사용촉진", "직장 내 괴롭힘", "부당해고"). {"keywords":["..."]}` },
      ],
      { json: true, maxTokens: 80, temperature: 0 }
    );
    const k = (JSON.parse(out.text).keywords || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 2);
    if (k.length) return k;
  } catch {}
  return [question.replace(/[?？!.]/g, '').split(/\s+/).slice(0, 3).join(' ')];
}

const LIVE = {
  prec: {
    search: (q) => ({ target: 'prec', query: q, search: '2', display: '6' }),
    id: (x) => x['판례일련번호'] || x.id,
    detail: (d) => {
      const p = d.PrecService || {};
      const text = [p['판시사항'] && '【판시사항】\n' + clean(p['판시사항']), p['판결요지'] && '【판결요지】\n' + clean(p['판결요지'])].filter(Boolean).join('\n\n');
      return text && {
        title: `${p['법원명'] || ''} ${ymd(p['선고일자'])} ${p['사건번호'] || ''} ${clean(p['사건명'] || '')}`.replace(/\s+/g, ' ').trim(),
        date: ymd(p['선고일자']),
        text,
        ref: clean(p['참조조문'] || ''),
        url: `https://www.law.go.kr/precInfoP.do?precSeq=${p['판례정보일련번호']}`,
      };
    },
  },
  moelCgmExpc: {
    search: (q) => ({ target: 'moelCgmExpc', query: q, search: '2', display: '6' }),
    id: (x) => x['법령해석일련번호'] || x.id,
    detail: (d) => {
      const p = d.CgmExpcService || {};
      const text = [p['질의요지'] && '【질의요지】\n' + clean(p['질의요지']), p['회답'] && '【회답】\n' + clean(p['회답'])].filter(Boolean).join('\n\n');
      return text && {
        title: `고용노동부 ${p['안건번호'] || ''} (${ymd(p['해석일자'])}) ${clean(p['안건명'] || '')}`.replace(/\s+/g, ' ').trim(),
        date: ymd(p['해석일자']),
        text,
        url: '',
      };
    },
  },
  nlrc: {
    search: (q) => ({ target: 'nlrc', query: q, search: '2', display: '6' }),
    id: (x) => x['결정문일련번호'] || x.id,
    detail: (d) => {
      const p = d.NlrcService || {};
      const text = [p['판정사항'] && '【판정사항】\n' + clean(p['판정사항']), p['판정요지'] && '【판정요지】\n' + clean(p['판정요지'])].filter(Boolean).join('\n\n');
      return text && {
        title: `${p['담당부서'] || '노동위원회'} ${p['사건번호'] || ''} ${clean(p['제목'] || '')} (${p['판정결과'] || ''})`.replace(/\s+/g, ' ').replace(/\(\)/, '').trim(),
        date: ymd(p['등록일']),
        text,
        url: '',
      };
    },
  },
  admrul: {
    // 행정규칙은 본문 검색이 너무 넓어서 고용노동부 소관 + 제목 검색
    search: (q) => ({ target: 'admrul', query: q, org: '1492000', display: '4' }),
    id: (x) => x['행정규칙일련번호'] || x.id,
    detail: (d) => {
      const p = d.AdmRulService || {};
      const info = p['행정규칙기본정보'] || p;
      const body = [].concat(p['조문내용'] || []).map(clean).join('\n');
      const text = clean(body).slice(0, 2500);
      return text && {
        title: `${clean(info['행정규칙명'] || '')} (${info['행정규칙종류'] || ''}, ${ymd(info['발령일자'])})`.trim(),
        date: ymd(info['발령일자']),
        text,
        url: '',
      };
    },
  },
};

async function searchLive(type, kw) {
  const L = LIVE[type];
  const seen = new Set();
  const items = [];
  // 검색어별 목록 조회를 동시에
  const lists = await Promise.all(kw.map((q) => api('lawSearch', L.search(q), { timeoutMs: 4000 }).then(listOf).catch(() => [])));
  for (const list of lists)
    for (const x of list.slice(0, 4)) {
      const id = L.id(x);
      if (id && !seen.has(id)) { seen.add(id); items.push(id); }
    }
  const details = await Promise.all(
    items.slice(0, 3).map(async (id) => {
      try {
        const d = L.detail(await api('lawService', { target: type, ID: String(id) }, { timeoutMs: 4000 }));
        return d && { kind: KIND[type], type, ...d };
      } catch {
        return null;
      }
    })
  );
  return details.filter(Boolean);
}

/**
 * 판례 등 후보 정렬: BGE-M3 유사도로 상위 10개만 추린 뒤 리랭커로 관련도 판정
 * (유사도만으로는 "부당노동행위" 결정례처럼 단어만 비슷한 문서가 섞여서 리랭커로 걸러냄)
 */
async function rankLive(question, docs, { perType = 2, total = 5, min = 0.3 } = {}) {
  if (!docs.length) return [];
  const textOf = (d) => `${d.title}\n${d.text.slice(0, 500)}`;
  const vecs = await embed([question, ...docs.map(textOf)]);
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const pre = docs.map((d, i) => ({ ...d, sim: dot(vecs[0], vecs[i + 1]) })).sort((a, b) => b.sim - a.sim).slice(0, 10);
  const scores = await rerank(question, pre.map(textOf));
  const per = {};
  return pre
    .map((d, i) => ({ ...d, score: scores[i] }))
    .filter((d) => d.score >= min)
    .sort((a, b) => b.score - a.score)
    .filter((d) => (per[d.kind] = (per[d.kind] || 0) + 1) <= perType)
    .slice(0, total);
}

/**
 * 역할별 법령정보 근거 수집
 *  employee: 법령
 *  admin   : 법령 + 판례 + 행정규칙 + 행정해석 + 노동위원회
 */
async function gather(question, role, { dense } = {}) {
  if (!OC()) return { items: [], timing: {} };
  const t0 = Date.now();
  const lawsP = searchLaws(question, { dense, topK: role === 'admin' ? 3 : 2 }).catch(() => []);
  let live = [];
  const timing = {};
  if (role === 'admin') {
    const kw = await keywords(question);
    timing.keywords = Date.now() - t0;
    const results = await Promise.all(Object.keys(LIVE).map((t) => searchLive(t, kw).catch(() => [])));
    timing.api = Date.now() - t0;
    const laws = await lawsP; // 법령 리랭크가 끝난 뒤 판례 등 리랭크 (CPU 경합 방지)
    live = await rankLive(question, results.flat());
    timing.total = Date.now() - t0;
    return { items: [...laws, ...live], keywords: kw, timing };
  }
  const laws = await lawsP;
  timing.total = Date.now() - t0;
  return { items: laws, timing };
}

/** 판례·행정규칙·행정해석·노동위원회만 (인사담당자용, 느린 실시간 조회 → 본 답변과 분리해서 사용) */
async function gatherCases(question) {
  if (!OC()) return { items: [], timing: {} };
  const t0 = Date.now();
  const kw = await keywords(question);
  const results = await Promise.all(Object.keys(LIVE).map((t) => searchLive(t, kw).catch(() => [])));
  const api = Date.now() - t0;
  const items = await rankLive(question, results.flat());
  return { items, keywords: kw, timing: { api, total: Date.now() - t0 } };
}

async function status() {
  const qdrant = require('./qdrant');
  const info = await qdrant.info(LAW_COLLECTION);
  return { configured: !!OC(), lawArticles: info ? info.points : 0 };
}

module.exports = { gather, gatherCases, ingestLaws, searchLaws, status, ruleKeywords, llmKeywords, LAWS, LAW_COLLECTION, KIND };

// CLI: node rag/lawsources.js ingest
if (require.main === module && process.argv[2] === 'ingest') {
  ingestLaws()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
