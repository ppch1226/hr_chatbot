/**
 * 정기 확인 스케줄러
 *  - 사규: 매일 REG_CHECK_TIME (기본 07:00, KST) — 규정 폴더 파일이 바뀌었으면 재색인 + 조문 비교 → 알림
 *  - 법령: 매주 LAW_CHECK_DAY 요일(기본 1=월) LAW_CHECK_TIME (기본 07:00) — 노동법 16개 개정 확인 → 담당자 알림
 *  - 시행일 임박(D-7, D-day): 사규 확인 때 함께 계산
 * 서버가 꺼져 있던 동안 지난 확인은 서버를 켤 때 한 번 실행
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const notify = require('./notify');

const CFG = {
  regTime: process.env.REG_CHECK_TIME || '07:00',
  lawTime: process.env.LAW_CHECK_TIME || '07:00',
  lawDay: Number(process.env.LAW_CHECK_DAY ?? 1), // 0=일 … 6=토
  enabled: (process.env.NOTIFY_SCHEDULE || 'on') !== 'off',
};
const DAY = ['일', '월', '화', '수', '목', '금', '토'];

let running = null; // 동시에 하나만
const kstNow = () => new Date(Date.now() + 9 * 3600e3);
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

/** 가장 최근에 지났어야 할 확인 시각 (KST, ISO 문자열) */
function lastDue(time, weekday) {
  const [h, m] = time.split(':').map(Number);
  const d = kstNow();
  const due = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m));
  if (weekday != null) {
    while (due.getUTCDay() !== weekday || due > d) due.setUTCDate(due.getUTCDate() - 1);
  } else if (due > d) due.setUTCDate(due.getUTCDate() - 1);
  return due.toISOString().slice(0, 16).replace('T', ' ');
}
function nextDue(time, weekday) {
  const [h, m] = time.split(':').map(Number);
  const d = kstNow();
  const due = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m));
  while (due <= d || (weekday != null && due.getUTCDay() !== weekday)) due.setUTCDate(due.getUTCDate() + 1);
  return due.toISOString().slice(0, 16).replace('T', ' ');
}

/** 사규 확인: 파일이 바뀐 규정만 찾아 재색인 → 비교 → 알림 */
async function checkRegulations({ source = '정기 확인', log = console.log } = {}) {
  const { ingestAll, listDocFiles, DOCS_DIR } = require('./ingest');
  const { parseFile } = require('./parse');
  const { chunkDocument } = require('./chunk');
  const st = notify.state();
  const files = listDocFiles();
  // 파일 해시로 변경 여부 판단 (임베딩 없이 빠르게)
  const current = files.map((f) => ({ file: f, hash: sha1(fs.readFileSync(path.join(DOCS_DIR, f))) }));
  const snaps = st.snapshots || {};
  const firstRun = !Object.keys(snaps).length;
  const known = new Set(Object.values(snaps).map((s) => s.hash));
  const changedFiles = current.filter((c) => !known.has(c.hash));
  let created = [];
  let reindexed = false;
  if (firstRun) {
    // 처음: 현재 색인을 기준점으로 저장 (변경 추적 이력이 있는 문서는 시연용 개정 알림 생성)
    const chunks = [];
    const docs = [];
    for (const c of current) {
      const { meta, chunks: cs } = chunkDocument(await parseFile(path.join(DOCS_DIR, c.file)), c.file);
      chunks.push(...cs);
      docs.push({ ...meta, hash: c.hash });
    }
    created = await notify.detectRegulationChanges(chunks, docs, { docsDir: DOCS_DIR, source, log });
  } else if (changedFiles.length) {
    log(`  사규 변경 감지: ${changedFiles.map((c) => c.file).join(', ')} → 재색인`);
    const { docs, chunks } = await ingestAll({ log });
    reindexed = true;
    created = await notify.detectRegulationChanges(chunks, docs, { docsDir: DOCS_DIR, source, log });
  }
  created.push(...notify.checkEffectiveDates());
  const s2 = notify.state();
  s2.lastChecks = { ...(s2.lastChecks || {}), regs: notify.nowKST(), regsResult: `${changedFiles.length && !firstRun ? `변경 ${changedFiles.length}건` : '변경 없음'} · 알림 ${created.length}건` };
  notify.saveState(s2);
  return { created: created.length, changedFiles: firstRun ? 0 : changedFiles.length, reindexed };
}

/** 법령 확인: 개정되면 담당자 알림 + 법령 색인 갱신 */
async function checkLawsNow({ log = console.log } = {}) {
  const lawsources = require('./lawsources');
  const { created, changed } = await notify.checkLaws({ log });
  if (changed) await lawsources.ingestLaws({ log }).catch((e) => log('  법령 재색인 실패: ' + e.message));
  const s2 = notify.state();
  s2.lastChecks = { ...(s2.lastChecks || {}), laws: notify.nowKST(), lawsResult: `개정 ${created.length}건` };
  notify.saveState(s2);
  return { created: created.length };
}

async function run(what, opts) {
  if (running) return { busy: true, running };
  running = what;
  try {
    return what === 'laws' ? await checkLawsNow(opts) : await checkRegulations(opts);
  } finally {
    running = null;
  }
}

async function tick(log) {
  const lc = notify.state().lastChecks || {};
  if (!lc.regs || lc.regs < lastDue(CFG.regTime)) await run('regs', { source: '정기 확인', log }).catch((e) => log('  사규 확인 실패: ' + e.message));
  if (!lc.laws || lc.laws < lastDue(CFG.lawTime, CFG.lawDay)) await run('laws', { log }).catch((e) => log('  법령 확인 실패: ' + e.message));
}

function start(log = console.log) {
  if (!CFG.enabled) return log('  알림 정기 확인: 꺼짐 (NOTIFY_SCHEDULE=off)');
  log(`  알림 정기 확인: 사규 매일 ${CFG.regTime} · 법령 매주 ${DAY[CFG.lawDay]}요일 ${CFG.lawTime} (KST)`);
  setTimeout(() => tick(log), 5000); // 서버 시작 직후 밀린 확인 실행
  setInterval(() => tick(log), 5 * 60e3);
}

function status() {
  const lc = notify.state().lastChecks || {};
  return {
    running,
    schedule: { regs: `매일 ${CFG.regTime}`, laws: `매주 ${DAY[CFG.lawDay]}요일 ${CFG.lawTime}`, enabled: CFG.enabled },
    last: lc,
    next: { regs: nextDue(CFG.regTime), laws: nextDue(CFG.lawTime, CFG.lawDay) },
  };
}

module.exports = { start, run, status };
