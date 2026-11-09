/**
 * 사내 알림: 사규 개정 · 관련 법령 개정 · 시행일 임박 · (담당자) 정합성 분석·리스크
 *
 *  저장 파일 (data/, 공개 저장소에 올리지 않음)
 *   notifications.json   알림 목록
 *   notify-state.json    사규 스냅샷(조문별 본문), 법령 버전, 마지막 확인 시각, 사용자별 읽음
 *   profiles.json        사용자 프로필(직급·직위·근무지·관심 주제·개인 상황)
 *
 *  "나와 관련" 판단 = 개정 조문마다 LLM이 붙인 태그(적용 대상·주제·상황)와 사용자 프로필 비교
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseFile, hasTrackChanges } = require('./parse');
const { chunkDocument, docMeta } = require('./chunk');
const { chat } = require('./llm');

const DATA = path.join(__dirname, '..', 'data');
const F = { notes: path.join(DATA, 'notifications.json'), state: path.join(DATA, 'notify-state.json'), profiles: path.join(DATA, 'profiles.json') };
const read = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const write = (f, v) => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 1));
};
const nowKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const id = () => crypto.randomBytes(5).toString('hex');
const norm = (s) => String(s || '').replace(/\s+/g, '');

// 태그 사전 (마이페이지 선택지와 같음)
const OPTIONS = {
  grades: ['1급', '2급', '3급', '4급', '5급', '사무직원', '별정직원'],
  positions: ['팀원', '팀장', '부서장', '지사장'],
  locations: ['국내', '국외'],
  topics: ['휴가·휴직', '출산·육아', '급여·수당', '복지', '평가·승진', '징계·복무', '채용·인사이동', '근무시간·유연근무', '국외근무', '교육·연수'],
  situations: ['임신 중', '출산 예정', '육아 중', '휴직 중', '질병·치료 중', '국외 근무 예정', '신규 입사', '퇴직 예정'],
};

// ════════════════════════════════════════════════════════════════
// 1) 조문 단위 비교
// ════════════════════════════════════════════════════════════════
/** 청크 → { key: { label, text } } (부칙 제외, 분할 조각은 합침) */
function articleMap(chunks) {
  const m = {};
  for (const c of chunks) {
    if (c.type === '부칙') continue;
    const key = `${c.type}|${c.articleNo || c.label.replace(/\s*\(\d+\/\d+\)$/, '')}`;
    if (!m[key]) m[key] = { label: c.label.replace(/\s*\(\d+\/\d+\)$/, ''), type: c.type, articleNo: c.articleNo, header: c.header.replace(/^\[|\]$/g, ''), text: '' };
    m[key].text += (m[key].text ? '\n' : '') + c.text;
  }
  return m;
}

function diffArticles(before, after) {
  const changes = [];
  for (const k of Object.keys(after)) {
    if (!(k in before)) changes.push({ key: k, change: '신설', ...pick(after[k]), before: '', after: after[k].text });
    else if (norm(before[k].text) !== norm(after[k].text)) changes.push({ key: k, change: '변경', ...pick(after[k]), before: before[k].text, after: after[k].text });
  }
  for (const k of Object.keys(before)) if (!(k in after)) changes.push({ key: k, change: '삭제', ...pick(before[k]), before: before[k].text, after: '' });
  return changes;
}
const pick = (a) => ({ label: a.label, type: a.type, articleNo: a.articleNo, header: a.header });

/** 최신 부칙에서 시행일 추출 ("이 규정(요강)은 2026년 9월 30일부터 시행한다") */
function effectiveDate(chunks, revised) {
  const adds = chunks.filter((c) => c.type === '부칙');
  for (const c of adds.reverse()) {
    const m = c.text.match(/(\d{4})\s*[.년]\s*(\d{1,2})\s*[.월]\s*(\d{1,2})\s*[.일]?\s*(?:일)?\s*부터\s*시행/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    if (/공포한\s*날부터\s*시행|발령일부터\s*시행/.test(c.text) && revised) return revised.length === 10 ? revised : '';
  }
  return revised && revised.length === 10 ? revised : '';
}

// ════════════════════════════════════════════════════════════════
// 2) 개정 조문 요약·태깅 (LLM, 10개씩 묶어서)
// ════════════════════════════════════════════════════════════════
async function tagChanges(docLabel, changes) {
  const out = [];
  for (let i = 0; i < changes.length; i += 8) {
    const batch = changes.slice(i, i + 8);
    const body = batch
      .map((c, k) => `#${k}\n[${c.change}] ${c.label}\n<이전>\n${(c.before || '(없음)').slice(0, 1200)}\n<현행>\n${(c.after || '(삭제됨)').slice(0, 1200)}`)
      .join('\n\n');
    let res = [];
    try {
      const r = await chat(
        [
          {
            role: 'system',
            content: `사내 규정 개정 내용을 직원에게 알리기 위해 조문별로 요약하고 태그를 답니다. JSON으로만 답하세요.
선택지 (이 값만 사용):
grades ${JSON.stringify(OPTIONS.grades)}
positions ${JSON.stringify(OPTIONS.positions)}
locations ${JSON.stringify(OPTIONS.locations)}
topics ${JSON.stringify(OPTIONS.topics)}
situations ${JSON.stringify(OPTIONS.situations)}
규칙: grades/positions/locations 는 조문이 특정 대상에만 적용될 때만 채우고, 전 직원 공통이면 빈 배열. situations 는 해당 상황의 직원에게 특히 중요할 때만.`,
          },
          {
            role: 'user',
            content: `[규정] ${docLabel}\n\n${body}\n\n출력: {"items":[{"i":0,"summary":"무엇이 어떻게 바뀌었는지 한 문장 (예: 배우자 출산휴가가 10일에서 20일로 늘었어요)","grades":[],"positions":[],"locations":[],"topics":[],"situations":[]}]}`,
          },
        ],
        { json: true, maxTokens: 1500, temperature: 0 }
      );
      res = JSON.parse(r.text).items || [];
    } catch {}
    batch.forEach((c, k) => {
      const t = res.find((x) => Number(x.i) === k) || {};
      const only = (arr, opts) => (Array.isArray(arr) ? arr.filter((x) => opts.includes(x)) : []);
      out.push({
        ...c,
        summary: String(t.summary || `${c.label} 조문이 ${c.change}되었습니다.`).slice(0, 200),
        tags: {
          grades: only(t.grades, OPTIONS.grades),
          positions: only(t.positions, OPTIONS.positions),
          locations: only(t.locations, OPTIONS.locations),
          topics: only(t.topics, OPTIONS.topics),
          situations: only(t.situations, OPTIONS.situations),
        },
      });
    });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// 3) 알림 저장
// ════════════════════════════════════════════════════════════════
function addNotification(n) {
  const list = read(F.notes, []);
  const item = { id: id(), createdAt: nowKST(), ...n };
  list.unshift(item);
  write(F.notes, list.slice(0, 500));
  return item;
}
const notifications = () => read(F.notes, []);
const state = () => read(F.state, { snapshots: {}, laws: {}, lastChecks: {}, reads: {}, reminders: {} });
const saveState = (s) => write(F.state, s);

async function regulationChangeNotice(meta, chunks, changes, { source }) {
  const tagged = await tagChanges(meta.docLabel, changes);
  const counts = tagged.reduce((m, c) => ((m[c.change] = (m[c.change] || 0) + 1), m), {});
  const eff = effectiveDate(chunks, meta.revised);
  return addNotification({
    kind: 'reg-change',
    audience: 'all',
    title: `${meta.docLabel} 개정 (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')})`,
    summary: tagged.slice(0, 3).map((c) => c.summary).join(' '),
    doc: meta.doc,
    docLabel: meta.docLabel,
    revised: meta.revised,
    effective: eff,
    source,
    changes: tagged,
  });
}

/**
 * 색인 결과(문서별 청크)와 스냅샷 비교 → 바뀐 규정마다 알림 생성, 스냅샷 갱신
 * 첫 실행(스냅샷 없음)은 기준점만 저장. 단, HWPX에 변경 추적 이력이 있으면 그 이력으로 시연용 개정 알림 생성
 */
async function detectRegulationChanges(chunks, docs, { docsDir, source = '정기 확인', log = () => {} } = {}) {
  const st = state();
  const created = [];
  for (const d of docs) {
    const mine = chunks.filter((c) => c.doc === d.doc);
    const after = articleMap(mine);
    const snap = st.snapshots[d.doc];
    if (!snap) {
      // 기준점: 변경 추적 이력이 있으면 "이전 판"으로 기준을 잡아 실제 개정 내역을 알림으로
      const file = path.join(docsDir, d.file);
      if (await hasTrackChanges(file)) {
        const prev = chunkDocument(await parseFile(file, { trackChanges: 'reject' }), d.file).chunks;
        const changes = diffArticles(articleMap(prev), after);
        if (changes.length) {
          created.push(await regulationChangeNotice(d, mine, changes, { source: '문서 변경 추적 이력' }));
          log(`  ${d.docLabel}: 변경 추적 이력에서 개정 조문 ${changes.length}개 → 알림 생성`);
        }
      }
    } else if (snap.hash !== d.hash) {
      const changes = diffArticles(snap.articles, after);
      if (changes.length) {
        created.push(await regulationChangeNotice(d, mine, changes, { source }));
        log(`  ${d.docLabel}: 개정 조문 ${changes.length}개 → 알림 생성`);
      }
    }
    st.snapshots[d.doc] = { hash: d.hash, revised: d.revised, file: d.file, articles: after, at: nowKST() };
  }
  saveState({ ...state(), snapshots: st.snapshots });
  return created;
}

// ════════════════════════════════════════════════════════════════
// 4) 관련 법령 개정 확인 (담당자용)
// ════════════════════════════════════════════════════════════════
async function checkLaws({ log = () => {} } = {}) {
  const lawsources = require('./lawsources');
  const st = state();
  const created = [];
  let changed = false;
  for (const name of lawsources.LAWS) {
    let info;
    try {
      info = await lawsources.lawVersion(name);
    } catch (e) {
      log(`  ⚠ ${name}: ${e.message}`);
      continue;
    }
    if (!info) continue;
    const prev = st.laws[name];
    if (prev && prev.mst !== info.mst) {
      changed = true;
      created.push(
        addNotification({
          kind: 'law-change',
          audience: 'admin',
          title: `${name} ${info.revision || '개정'} (${info.promulgated} 공포 · ${info.effective} 시행)`,
          summary: `관련 법령이 개정되었습니다. 사내 규정과의 정합성 분석을 실행해 보세요.`,
          law: name,
          promulgated: info.promulgated,
          effective: info.effective,
          link: `/compliance.html?law=${encodeURIComponent(name)}`,
        })
      );
      log(`  ${name}: 개정 감지 → 알림`);
    }
    st.laws[name] = info;
  }
  saveState({ ...state(), laws: st.laws });
  return { created, changed };
}

// ════════════════════════════════════════════════════════════════
// 5) 시행일 임박 알림 (D-7, D-day)
// ════════════════════════════════════════════════════════════════
function checkEffectiveDates() {
  const today = todayKST();
  const st = state();
  const created = [];
  for (const n of notifications()) {
    if (!['reg-change', 'law-change'].includes(n.kind) || !n.effective) continue;
    const days = Math.round((new Date(n.effective) - new Date(today)) / 86400e3);
    const tag = days === 7 ? 'D-7' : days === 0 ? 'D-day' : null;
    const key = `${n.id}|${tag}`;
    if (!tag || st.reminders[key]) continue;
    st.reminders[key] = today;
    created.push(
      addNotification({
        kind: 'effective',
        audience: n.audience,
        title: `[${tag}] ${n.docLabel || n.law} 개정 내용 ${days === 0 ? '오늘부터 시행' : '시행 7일 전'}`,
        summary: n.summary,
        ref: n.id,
        effective: n.effective,
        changes: n.changes,
        doc: n.doc,
        docLabel: n.docLabel,
      })
    );
  }
  saveState({ ...state(), reminders: st.reminders });
  return created;
}

// ════════════════════════════════════════════════════════════════
// 6) 사용자별 조회: 관련도 판단 + 읽음
// ════════════════════════════════════════════════════════════════
const profiles = () => read(F.profiles, {});
function getProfile(user) {
  return { grade: '', position: '', location: '', topics: [], situations: [], ...(profiles()[user] || {}) };
}
function saveProfile(user, p) {
  const all = profiles();
  const clean = (v, opts) => (opts.includes(v) ? v : '');
  const arr = (v, opts) => (Array.isArray(v) ? v.filter((x) => opts.includes(x)) : []);
  all[user] = {
    grade: clean(p.grade, OPTIONS.grades),
    position: clean(p.position, OPTIONS.positions),
    location: clean(p.location, OPTIONS.locations),
    topics: arr(p.topics, OPTIONS.topics),
    situations: arr(p.situations, OPTIONS.situations),
    updatedAt: nowKST(),
  };
  write(F.profiles, all);
  return all[user];
}

/** 개정 조문 1개 × 사용자 → 관련 이유 목록 (빈 배열이면 관련 없음) */
function reasonsFor(tags, profile, recentTopics) {
  const r = [];
  const t = tags || {};
  // 적용 대상(직급·직위·근무지)이 정해진 조문: 내가 입력한 항목은 모두 맞아야 함 (예: "3급 이상 팀장" → 3급 팀원은 해당 없음)
  // 입력하지 않은 항목은 판단에서 제외
  const dims = [
    [t.grades, profile.grade, `${profile.grade} 대상`],
    [t.positions, profile.position, `${profile.position} 대상`],
    [t.locations, profile.location, `${profile.location} 근무 대상`],
  ].filter(([list, mine]) => list && list.length && mine);
  if (dims.some(([list, mine]) => !list.includes(mine))) return [];
  // 국내·국외 모두 적용처럼 선택지 전체가 대상이면 "대상" 이유로는 보지 않음
  r.push(...dims.filter(([list]) => !(list === t.locations && list.length >= OPTIONS.locations.length)).map(([, , label]) => label));
  for (const x of (t.topics || []).filter((x) => profile.topics.includes(x))) r.push(`관심 주제: ${x}`);
  for (const x of (t.situations || []).filter((x) => profile.situations.includes(x))) r.push(`내 상황: ${x}`);
  for (const x of (t.topics || []).filter((x) => recentTopics.includes(x) && !profile.topics.includes(x))) r.push(`최근 질문: ${x}`);
  return r;
}

function listFor(user, role, { recentTopics = [] } = {}) {
  const profile = getProfile(user);
  const reads = new Set((state().reads || {})[user] || []);
  const items = notifications().filter((n) => n.audience === 'all' || (n.audience === 'admin' && role === 'admin'));
  return items.map((n) => {
    const changes = (n.changes || []).map((c) => ({ ...c, reasons: reasonsFor(c.tags, profile, recentTopics) }));
    const reasons = [...new Set(changes.flatMap((c) => c.reasons))];
    // 관련 조문을 앞으로
    changes.sort((a, b) => (b.reasons.length > 0) - (a.reasons.length > 0));
    const related = n.kind === 'law-change' || n.kind === 'risk' || n.kind === 'compliance' ? true : reasons.length > 0;
    return { ...n, changes, related, reasons: n.kind === 'law-change' ? ['담당 업무: 관련 법령'] : reasons, read: reads.has(n.id) };
  });
}

function markRead(user, ids) {
  const st = state();
  const set = new Set(st.reads[user] || []);
  for (const x of ids) set.add(x);
  st.reads[user] = [...set].slice(-1000);
  saveState({ ...state(), reads: st.reads });
}

/** 최근 N일 안에 개정된 조문 목록 (챗봇 "최근 개정" 배지용) */
function recentChanges(days = 30) {
  const since = Date.now() - days * 86400e3;
  const out = [];
  for (const n of notifications()) {
    if (n.kind !== 'reg-change') continue;
    if (new Date(n.createdAt.replace(' ', 'T') + ':00+09:00').getTime() < since) continue;
    for (const c of n.changes || []) out.push({ doc: n.doc, docLabel: n.docLabel, articleNo: c.articleNo, label: c.label, change: c.change, summary: c.summary, notificationId: n.id, at: n.createdAt, effective: n.effective });
  }
  return out;
}

module.exports = {
  OPTIONS,
  articleMap,
  diffArticles,
  detectRegulationChanges,
  checkLaws,
  checkEffectiveDates,
  addNotification,
  notifications,
  listFor,
  markRead,
  getProfile,
  saveProfile,
  recentChanges,
  state,
  saveState,
  nowKST,
};
