/**
 * 시연용 테스트 계정 데이터 채우기 (seed/personas.json 기준)
 *   npm run seed:demo        ← 서버(npm start)가 켜져 있어야 함
 *
 * 페르소나마다: 알림 맞춤 프로필 → 캘린더 개인 일정 → 실제 챗봇에 질문해 질문기록 생성(시각은 과거로 분산)
 * 다시 실행하면 해당 페르소나의 질문기록·개인 일정만 새로 만듭니다 (다른 사용자 데이터는 그대로).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BASE = `http://localhost:${process.env.PORT || 3000}`;
const DATA = path.join(__dirname, '..', 'data');
const personas = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seed', 'personas.json'), 'utf8'));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return d; } };
const writeJson = (f, v) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, 2));
const key = (p) => `${p.role}:${p.name}`;

async function call(p, { method = 'GET', body } = {}) {
  const r = await fetch(BASE + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${j.error || ''}`);
  return j;
}
function kstAt(daysAgo, time) {
  const d = new Date(Date.now() + 9 * 3600e3 - daysAgo * 86400e3);
  return `${d.toISOString().slice(0, 10)} ${time}`;
}

(async () => {
  try { await call('/api/status'); } catch { console.error(`서버가 꺼져 있어요. 먼저 npm start 로 ${BASE} 를 켜 주세요.`); process.exit(1); }

  for (const p of personas) {
    const who = { user: p.name, role: p.role };
    console.log(`\n▶ ${p.role === 'admin' ? '인사담당자' : '직원'} ${p.name} (${p.title}, ${p.dept})`);

    await call('/api/profile', { method: 'PUT', body: { ...who, ...p.profile } });
    console.log('  알림 맞춤 프로필 저장');

    const cal = readJson('calendar.json', {});
    cal[key(p)] = p.calendar.map((e, i) => ({ id: `demo-${p.id}-${i}`, ...e, createdAt: kstAt(14, '09:00') }));
    writeJson('calendar.json', cal);
    console.log(`  개인 일정 ${p.calendar.length}건`);

    await call(`/api/history/*?user=${encodeURIComponent(p.name)}&role=${p.role}`, { method: 'DELETE' });
    for (const [i, x] of p.questions.entries()) {
      const t0 = Date.now();
      await call('/api/chat', { method: 'POST', body: { ...who, message: x.q, sessionId: `seed-${p.id}-${i}-${Date.now()}` } });
      console.log(`  질문 ${i + 1}/${p.questions.length} (${((Date.now() - t0) / 1000).toFixed(1)}초) ${x.q}`);
    }
    // 질문 시각을 페르소나 설정대로 과거에 분산
    const hist = readJson('history.json', {});
    const list = hist[key(p)] || [];
    for (const h of list) {
      const x = p.questions.find((q) => q.q === h.question);
      if (!x) continue;
      h.at = kstAt(x.daysAgo, x.time);
      h.id = `Q-${h.at.slice(0, 10).replace(/-/g, '')}-${h.id.slice(-4)}`;
    }
    list.sort((a, b) => b.at.localeCompare(a.at));
    hist[key(p)] = list;
    writeJson('history.json', hist);
    console.log(`  질문기록 ${list.length}건 (최근 ${Math.max(...p.questions.map((q) => q.daysAgo))}일 동안에 분산)`);
  }
  console.log('\n완료. 로그인 화면의 "테스트 계정으로 바로 시작"에서 로그인하세요.');
})().catch((e) => { console.error('실패:', e.message); process.exit(1); });
