/**
 * 사용자별 데이터: 나의 질문기록 · 캘린더 · 맞춤 추천 질문 · 날씨
 *  - 질문기록은 익명 질문이 아닐 때만, 본인 확인용으로 저장 (data/history.json)
 *  - 캘린더: 법정 공휴일 + 사내 일정(시연용 예시) + 나의 연차(시연용) + 직접 추가 + 사규 개정 시행일
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return d; } };
const write = (f, v) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(v, null, 2)); };
const kst = () => new Date(Date.now() + 9 * 3600e3);
const todayKST = () => kst().toISOString().slice(0, 10);
const nowKST = () => kst().toISOString().replace('T', ' ').slice(0, 16);
const uid = () => crypto.randomBytes(5).toString('hex');

// ════════════════════════════════════════════════════════════════
// 1) 나의 질문기록
// ════════════════════════════════════════════════════════════════
const CATEGORIES = [
  ['출산·육아', /출산|육아|임신|태아|난임|자녀|보육|모성/],
  ['휴가·휴직', /휴가|연차|반차|휴직|병가|공가|청원|경조/],
  ['급여·복지', /급여|월급|연봉|수당|보수|상여|퇴직금|성과급|복지|포인트|학자금|의료비|사택|주택|여비/],
  ['근무·복무', /근무|유연|재택|시간외|연장|야근|출퇴근|복무|겸직|출장|국외/],
  ['인사·평가', /평가|승진|고과|채용|전보|발령|임용|징계|교육|연수/],
];
const category = (q) => (CATEGORIES.find(([, re]) => re.test(q)) || ['기타'])[0];

function addHistory(user, { question, answer, sources = [], ehr = [] }) {
  const all = read('history.json', {});
  const list = all[user] || [];
  const plain = String(answer || '').replace(/\[\d+\]/g, '').replace(/[#*`>|]/g, '').replace(/\n{2,}/g, '\n').trim();
  list.unshift({
    id: `Q-${todayKST().replace(/-/g, '')}-${uid().slice(0, 4)}`,
    at: nowKST(),
    category: category(question),
    question: String(question).slice(0, 300),
    answer: plain.slice(0, 700),
    basis: sources.slice(0, 2).map((s) => `${s.doc} ${s.label || ''}`.trim()),
    ehr: (ehr[0] && ehr[0].path) || '',
  });
  all[user] = list.slice(0, 200);
  write('history.json', all);
}
const getHistory = (user) => read('history.json', {})[user] || [];
function deleteHistory(user, id) {
  const all = read('history.json', {});
  all[user] = (all[user] || []).filter((x) => id !== '*' && x.id !== id);
  write('history.json', all);
}

// 직급별 많이 질문한 분야: 시연용 기본 집계 + 실제 질문기록(프로필 직급 기준) 합산
const GRADE_BASE = {
  '5급': { '휴가·휴직': 48, '급여·복지': 24, '근무·복무': 18, '출산·육아': 6, '인사·평가': 4 },
  '4급': { '급여·복지': 38, '휴가·휴직': 32, '출산·육아': 15, '근무·복무': 10, '인사·평가': 5 },
  '3급': { '출산·육아': 34, '근무·복무': 28, '인사·평가': 20, '휴가·휴직': 12, '급여·복지': 6 },
  '2급': { '인사·평가': 45, '근무·복무': 25, '휴가·휴직': 20, '급여·복지': 10 },
  '1급': { '인사·평가': 52, '근무·복무': 28, '급여·복지': 12, '휴가·휴직': 8 },
  사무직원: { '급여·복지': 40, '휴가·휴직': 35, '근무·복무': 15, '출산·육아': 10 },
};
function gradeStats(profiles) {
  const out = JSON.parse(JSON.stringify(GRADE_BASE));
  const hist = read('history.json', {});
  for (const [user, list] of Object.entries(hist)) {
    const g = (profiles[user] || {}).grade;
    if (!g) continue;
    out[g] = out[g] || {};
    for (const h of list) out[g][h.category] = (out[g][h.category] || 0) + 1;
  }
  return Object.entries(out).map(([grade, m]) => {
    const total = Object.values(m).reduce((a, b) => a + b, 0) || 1;
    return { grade, top: Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => ({ key: k, pct: Math.round((v / total) * 100) })) };
  });
}

// ════════════════════════════════════════════════════════════════
// 2) 캘린더
// ════════════════════════════════════════════════════════════════
// 법정 공휴일 (대체공휴일 포함)
const HOLIDAYS = {
  '2026-01-01': '신정', '2026-02-16': '설날 연휴', '2026-02-17': '설날', '2026-02-18': '설날 연휴', '2026-03-01': '삼일절', '2026-03-02': '대체공휴일(삼일절)',
  '2026-05-05': '어린이날', '2026-05-24': '부처님오신날', '2026-05-25': '대체공휴일(부처님오신날)', '2026-06-03': '전국동시지방선거', '2026-06-06': '현충일',
  '2026-08-15': '광복절', '2026-08-17': '대체공휴일(광복절)', '2026-09-24': '추석 연휴', '2026-09-25': '추석', '2026-09-26': '추석 연휴', '2026-10-03': '개천절',
  '2026-10-05': '대체공휴일(개천절)', '2026-10-09': '한글날', '2026-12-25': '성탄절',
  '2027-01-01': '신정', '2027-02-06': '설날 연휴', '2027-02-07': '설날', '2027-02-08': '설날 연휴', '2027-02-09': '대체공휴일(설날)', '2027-03-01': '삼일절',
  '2027-05-05': '어린이날', '2027-05-13': '부처님오신날', '2027-06-06': '현충일', '2027-08-15': '광복절', '2027-08-16': '대체공휴일(광복절)',
  '2027-09-14': '추석 연휴', '2027-09-15': '추석', '2027-09-16': '추석 연휴', '2027-10-03': '개천절', '2027-10-04': '대체공휴일(개천절)', '2027-10-09': '한글날',
  '2027-10-11': '대체공휴일(한글날)', '2027-12-25': '성탄절',
};
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
function firstWeekday(y, m, wd) { // m: 1~12, wd: 0=일
  const d = new Date(Date.UTC(y, m - 1, 1));
  while (d.getUTCDay() !== wd) d.setUTCDate(d.getUTCDate() + 1);
  return d.getUTCDate();
}
// 사내 일정 (시연용 예시)
function companyEvents(y, m) {
  const ev = [{ date: ymd(y, m, firstWeekday(y, m, 1)), title: '월간 업무회의', memo: '매월 첫째 주 월요일 (시연용 예시 일정)' }];
  if (m === 1) ev.push({ date: ymd(y, 1, 2), title: '시무식' });
  if (m === 3) ev.push({ date: ymd(y, 3, 31), title: '상반기 법정의무교육 이수 마감' });
  if (m === 6) ev.push({ date: ymd(y, 6, 30), title: '상반기 성과평가 자기평가 마감' });
  if (m === 7) ev.push({ date: ymd(y, 7, 1), title: '연차 사용촉진 1차 안내', memo: '근로기준법 제61조: 사용기간 끝나기 6개월 전 기준' });
  if (m === 11) ev.push({ date: ymd(y, 11, 2), title: '연차 사용촉진 2차 통보', memo: '근로기준법 제61조: 사용기간 끝나기 2개월 전 기준' }, { date: ymd(y, 11, 27), title: '하반기 법정의무교육 이수 마감' });
  if (m === 12) ev.push({ date: ymd(y, 12, 15), title: '연말정산 사전 안내' }, { date: ymd(y, 12, 30), title: '종무식' });
  return ev.map((e) => ({ ...e, type: 'company', memo: e.memo || '시연용 예시 일정' }));
}
// 나의 연차 (시연용): 연 15일, 지난 날짜는 사용, 앞으로는 예정
function leaveEvents(y) {
  return [
    { date: ymd(y, 3, 13), title: '연차', days: 1 },
    { date: ymd(y, 5, 4), title: '연차 (징검다리)', days: 1 },
    { date: ymd(y, 7, 28), title: '하계휴가 (연차)', days: 1 }, { date: ymd(y, 7, 29), title: '하계휴가 (연차)', days: 1 },
    { date: ymd(y, 7, 30), title: '하계휴가 (연차)', days: 1 }, { date: ymd(y, 7, 31), title: '하계휴가 (연차)', days: 1 },
    { date: ymd(y, 10, 16), title: '오후 반차', days: 0.5 },
    { date: ymd(y, 11, 20), title: '오전 반차', days: 0.5 },
    { date: ymd(y, 12, 24), title: '연차', days: 1 },
  ].map((e) => ({ ...e, type: 'leave', memo: '시연용 예시 (e-HR 근태 연동 시 실제 사용 내역으로 대체)' }));
}
function leaveSummary() {
  const today = todayKST(), y = Number(today.slice(0, 4));
  const ev = leaveEvents(y);
  const used = ev.filter((e) => e.date <= today).reduce((a, e) => a + e.days, 0);
  const planned = ev.filter((e) => e.date > today).reduce((a, e) => a + e.days, 0);
  const total = 15;
  return { total, used, planned, remaining: total - used, deadline: `${y}-12-31` };
}
function nextHoliday() {
  const today = todayKST();
  const d = Object.keys(HOLIDAYS).sort().find((x) => x > today);
  if (!d) return null;
  return { date: d, name: HOLIDAYS[d], days: Math.round((new Date(d) - new Date(today)) / 86400e3) };
}
function calendar(user, month, regChanges = []) {
  const [y, m] = month.split('-').map(Number);
  const inMonth = (d) => d.startsWith(month);
  const events = [];
  for (const [d, name] of Object.entries(HOLIDAYS)) if (inMonth(d)) events.push({ date: d, title: name, type: 'holiday', memo: '법정 공휴일' });
  events.push(...companyEvents(y, m));
  events.push(...leaveEvents(y).filter((e) => inMonth(e.date)));
  for (const n of regChanges) if (n.effective && inMonth(n.effective)) events.push({ date: n.effective, title: `${n.docLabel || n.law || '규정'} 개정 시행`, type: 'company', memo: n.title, link: `/notifications.html?id=${encodeURIComponent(n.id)}` });
  const mine = (read('calendar.json', {})[user] || []).filter((e) => inMonth(e.date));
  events.push(...mine.map((e) => ({ ...e, type: 'personal' })));
  events.sort((a, b) => a.date.localeCompare(b.date));
  return { month, today: todayKST(), events, leave: leaveSummary(), nextHoliday: nextHoliday() };
}
function addEvent(user, { date, title, memo = '' }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('날짜 형식이 올바르지 않아요.');
  const t = String(title || '').trim().slice(0, 40);
  if (!t) throw new Error('일정 제목을 입력하세요.');
  const all = read('calendar.json', {});
  const ev = { id: uid(), date, title: t, memo: String(memo).slice(0, 200), createdAt: nowKST() };
  all[user] = [...(all[user] || []), ev];
  write('calendar.json', all);
  return ev;
}
function deleteEvent(user, id) {
  const all = read('calendar.json', {});
  all[user] = (all[user] || []).filter((e) => e.id !== id);
  write('calendar.json', all);
}

// ════════════════════════════════════════════════════════════════
// 3) 맞춤 추천 질문 (기존 데이터 기반)
//  - 나와 관련된 최근 사규 개정 → 관심 주제·최근 질문 주제 → 전사 많이 묻는 주제 → 게시된 FAQ
// ════════════════════════════════════════════════════════════════
const TOPIC_Q = {
  '휴가·휴직': ['올해 남은 연차는 어떻게 확인하나요?', '연차를 쓰지 못하면 수당으로 받을 수 있나요?', '병가는 며칠까지 쓸 수 있나요?'],
  '출산·육아': ['배우자 출산휴가는 며칠인가요?', '육아휴직은 몇 번까지 나눠 쓸 수 있나요?', '태아검진휴가 신청 방법을 알려주세요.'],
  '급여·수당': ['시간외근무수당은 어떻게 계산하나요?', '퇴직금은 어떻게 산정되나요?'],
  복지: ['경조휴가 일수와 신청 방법을 알려주세요.', '선택적 복지포인트는 어디에 쓸 수 있나요?'],
  '평가·승진': ['승진 소요연한은 직급별로 어떻게 되나요?', '평가 결과에 이의신청하는 방법은?'],
  '징계·복무': ['겸직 허가는 어떻게 받나요?', '징계 절차는 어떻게 진행되나요?'],
  '채용·인사이동': ['전보 주기와 기준을 알려주세요.'],
  '근무시간·유연근무': ['유연근무제 신청 조건이 궁금해요.', '연장근무 사전 승인은 어떻게 받나요?'],
  국외근무: ['국외 근무 시 받는 수당이 궁금해요.', '특수지 근무 특례는 어떤 내용인가요?'],
  '교육·연수': ['자기개발 교육비 지원 기준을 알려주세요.'],
};
const STAT_Q = {
  '연차 사용 및 촉진': '연차 사용촉진 제도는 어떻게 운영되나요?',
  '육아휴직 급여 및 기간': '육아휴직 기간과 급여 기준을 알려주세요.',
  '복지포인트 사용처 및 마감': '복지포인트 사용처와 마감일을 알려주세요.',
  '연장근무 사전승인 절차': '연장근무 사전 승인은 어떻게 받나요?',
  '경조휴가 증빙서류 제출': '경조휴가 증빙서류는 무엇을 내야 하나요?',
  '급여·퇴직금': '퇴직금은 어떻게 산정되나요?',
};
function suggest({ admin, profile = {}, recent = [], related = [], stats = {}, faq = [], risks = [], reports = [] }) {
  const out = [];
  const push = (q, tag) => { if (q && !out.some((x) => x.q === q)) out.push({ q, tag }); };
  if (admin) {
    const openRisk = risks.find((r) => r.status !== '조치완료');
    if (openRisk) push(`${openRisk.category} 사안 대응 절차와 관련 법령을 정리해줘`, '미조치 리스크');
    const fix = reports.find((r) => { const c = (r.summary && r.summary.판정건수) || {}; return (c.위반 || 0) + (c.미반영 || 0) > 0; });
    if (fix) push(`${fix.law.name} 개정 사항 중 사규에 반영해야 할 내용은?`, '정합성 분석');
  }
  let regQ = 0;
  for (const n of related.filter((x) => x.kind === 'reg-change')) {
    for (const c of (n.changes || []).filter((x) => x.reasons && x.reasons.length)) {
      const t = (String(c.label || '').match(/\(([^)]+)\)/) || [])[1];
      if (t && regQ < 2) { push(`${t} 규정이 이번에 어떻게 바뀌었나요?`, '나와 관련된 개정'); regQ++; }
    }
  }
  const topics = [...new Set([...(recent || []), ...(profile.topics || [])])];
  for (const t of topics) for (const q of (TOPIC_Q[t] || []).slice(0, 1)) push(q, recent.includes(t) ? '최근 질문 주제' : '관심 주제');
  for (const s of (stats.topics || [])) push(STAT_Q[s.key], '많이 묻는 질문');
  for (const f of faq.filter((x) => x.status === '게시')) push(f.question, 'FAQ');
  if (admin) push('무단결근 직원 처리 절차를 알려줘', '추천');
  return out.slice(0, 4);
}

// ════════════════════════════════════════════════════════════════
// 4) 날씨 (Open-Meteo, 키 불필요) — 본사(서울 종로) 기준, 20분 캐시
// ════════════════════════════════════════════════════════════════
const WMO = [
  [[0], '맑음', 'sunny'], [[1], '대체로 맑음', 'sunny'], [[2], '구름 조금', 'partly_cloudy_day'], [[3], '흐림', 'cloud'],
  [[45, 48], '안개', 'foggy'], [[51, 53, 55, 56, 57], '이슬비', 'rainy'], [[61, 63, 65, 66, 67, 80, 81, 82], '비', 'rainy'],
  [[71, 73, 75, 77, 85, 86], '눈', 'weather_snowy'], [[95, 96, 99], '뇌우', 'thunderstorm'],
];
let wCache = null;
async function weather() {
  if (wCache && Date.now() - wCache.at < 20 * 60e3) return wCache.data;
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=37.5697&longitude=126.9800&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min&timezone=Asia%2FSeoul&forecast_days=1';
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`날씨 조회 실패 (${r.status})`);
  const j = await r.json();
  const code = j.current.weather_code;
  const [, text, icon] = WMO.find(([cs]) => cs.includes(code)) || [[], '알 수 없음', 'thermostat'];
  const data = {
    place: '서울',
    temp: Math.round(j.current.temperature_2m),
    max: Math.round(j.daily.temperature_2m_max[0]),
    min: Math.round(j.daily.temperature_2m_min[0]),
    text,
    icon: !j.current.is_day && icon === 'sunny' ? 'clear_night' : icon,
    at: nowKST(),
  };
  wCache = { at: Date.now(), data };
  return data;
}

module.exports = { CATEGORIES: CATEGORIES.map(([k]) => k).concat('기타'), addHistory, getHistory, deleteHistory, gradeStats, calendar, addEvent, deleteEvent, suggest, weather };
