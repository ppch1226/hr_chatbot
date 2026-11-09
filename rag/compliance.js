/**
 * 법령 개정 ↔ 사규 정합성 분석 (RAG)
 * 개정 법령의 제개정이유·개정문으로 관련 사규 조문을 검색하고, LLM이 조문별로 판정합니다.
 */
const { search } = require('./retrieve');
const { chat } = require('./llm');

const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + ' …(이하 생략)' : s || '');

const SYSTEM = `당신은 한국무역보험공사 인사·노무 컴플라이언스 분석가입니다. 개정 법령과 사내 규정 조문을 비교해 정합성을 판정합니다.
판정 기준: 위반(법령 기준에 미달하거나 상충) / 미반영(법령 개정 사항이 규정에 없음) / 보완권고(취지는 맞지만 문구·절차 보완 필요) / 정합.
제공된 [사규] 조문만 근거로 쓰고, 조문을 인용할 때 [번호]를 붙이세요. 사규에 관련 조문이 없으면 '미반영'으로 판정하고 신설이 필요한 위치를 제안하세요.`;

const FORMAT = [
  '아래 형식으로 답하세요.',
  '## 1. 요약',
  '## 2. 조문별 비교 (표: 법령 개정 사항 | 관련 사규 조문 | 판정 | 근거)',
  '## 3. 개정 문안 초안 (위반·미반영·보완권고 항목만)',
  '## 4. 조치 권고 및 시행일 대응',
  '',
  '마지막에 ```json 코드블록으로 다음 요약을 붙이세요 (담당자는 지어내지 말고 빈 배열로 두세요):',
  '{"판정건수":{"위반":0,"미반영":0,"보완권고":0,"정합":0},"최고위험도":"상|중|하","관련사규":["규정명 제N조"],"담당자":[]}',
].join('\n');

function parseSummary(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) return { summary: null, report: text };
  let summary = null;
  try {
    summary = JSON.parse(m[1]);
  } catch {}
  return { summary, report: text.replace(m[0], '').trim() };
}

async function relatedRegulations(law) {
  const queries = [
    [law.name, cut(law.reason, 600), cut(law.amendment, 600)].filter(Boolean).join('\n'),
    `${law.name} 관련 사내 규정`,
    cut(law.amendment, 300),
  ].filter((q) => q && q.trim());
  const seen = new Map();
  for (const q of queries) {
    const r = await search(q, { topK: 6 });
    for (const c of r.chunks) if (!seen.has(c.id) || seen.get(c.id).score < c.score) seen.set(c.id, c);
  }
  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 8);
}

async function analyze(law, { requestId, today }) {
  const related = await relatedRegulations(law);
  const ctx = related.map((c, i) => `[${i + 1}] ${c.docLabel} ${c.label} (개정 ${c.revised})\n${c.text}`).join('\n\n---\n\n');
  const user = [
    `[법령]\n법령명: ${law.name}\n공포일: ${law.promulgated}\n시행일: ${law.effective}\n제개정구분: ${law.revision}`,
    `[제개정이유]\n${cut(law.reason, 3000) || '(없음)'}`,
    `[개정문]\n${cut(law.amendment, 5000) || '(없음)'}`,
    `[부칙]\n${cut(law.addenda, 1200) || '(없음)'}`,
    `[사규]\n${ctx || '(관련 조문 검색 결과 없음)'}`,
    FORMAT,
  ].join('\n\n');
  const out = await chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], { maxTokens: 3000 });
  const parsed = parseSummary(out.text);
  parsed.summary = {
    요청ID: requestId,
    법령명: law.name,
    공포일자: law.promulgated,
    시행일자: law.effective,
    분석기준일: today,
    ...(parsed.summary || {}),
    담당자: [],
    Teams게시: '미게시',
  };
  parsed.sources = related.map((c, i) => ({ n: i + 1, doc: c.docLabel, label: c.label, revised: c.revised, score: Math.round(c.score * 1000) / 1000 }));
  return parsed;
}

module.exports = { analyze };
