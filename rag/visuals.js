/**
 * 답변 시각화 블록 (LLM이 본문과 함께 JSON으로 출력 → 화면에서 컴포넌트로 렌더링)
 *   stats    : 핵심 수치 카드
 *   steps    : 절차 흐름
 *   timeline : 기간 타임라인 (기준일 0을 중심으로 상대 일수/주수)
 *   chart    : 막대·선·범위 그래프 (Chart.js)
 * 숫자는 근거 원문에 있는 값만 허용. 계산으로 만든 값은 formula(계산식)를 함께 내야 하며 화면에 계산식을 표시.
 */
const MARK = '<<<VISUALS>>>';

const SPEC = `[시각화 블록] 답변을 한눈에 보이게 하는 블록입니다. 아래 조건에 해당하면 반드시 만드세요 (최대 2개, 해당 없으면 []).
- 핵심 숫자(일수·금액·횟수·기한·비율)가 2개 이상 나오면 → stats
  {"type":"stats","title":"배우자 출산휴가 한눈에","items":[{"label":"휴가 일수","value":"20","unit":"일","note":"유급","cite":1},{"label":"분할 사용","value":"3","unit":"회","cite":1}]}
- 신청·승인·징계·신고 등 순서가 3단계 이상이면 → steps
  {"type":"steps","title":"휴직 신청 절차","items":[{"title":"휴직원 제출","desc":"휴직 30일 전까지","cite":1},{"title":"부서장 검토","desc":"...","cite":1}]}
- 기준일(출산일·입사일·사유 발생일 등) 전후로 쓸 수 있는 기간이 있으면 → timeline (기준일=0, 이전은 음수). startFrom/endFrom에는 근거 원문에서 시작·끝이 각각 어느 날짜 기준인지 그대로 쓰세요
  {"type":"timeline","title":"사용 가능 기간","unit":"일","anchor":"출산일","items":[{"label":"사용 가능 기간","start":-50,"startFrom":"출산예정일","end":120,"endFrom":"출산예정일","cite":1}]}
- 3개 이상 항목의 숫자를 비교하면 → chart ("bar" 막대 | "line" 선 | "range" 최소~최대 범위, range의 data는 [[최소,최대],...])
  {"type":"chart","chart":"range","title":"직급별 기본연봉 한계액","unit":"천원","labels":["1급","2급","3급"],"series":[{"name":"기본연봉","data":[[51029,90602],[45822,80188],[40732,71280]]}],"cite":1}
주의: timeline은 시작과 끝이 같은 기준일에서 계산될 때만 만드세요 (예: 시작은 "출산예정일" 기준, 끝은 "출산일" 기준처럼 기준일이 다르면 만들지 말고 stats로 표현). 숫자는 근거 원문 값 그대로. 규정의 계산식으로 직접 계산한 값(예: 근속연수별 연차 일수)을 넣으면 "formula":"계산식 설명"을 반드시 함께 쓰세요. 본문 표를 그대로 반복하는 chart는 만들지 마세요. 개인별 수치는 지어내지 마세요.`;

const num = (s) => Number(String(s).replace(/,/g, ''));

/** 근거 원문에 나오는 숫자 집합 */
function sourceNumbers(texts) {
  const set = new Set();
  for (const t of texts) for (const m of String(t).matchAll(/\d[\d,]*(?:\.\d+)?/g)) set.add(num(m[0]));
  return set;
}

function cleanStr(s, n = 80) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
}

/** 시각화 블록 검증·정리. 근거에 없는 숫자가 있으면(계산식 없이) 해당 블록은 버림 */
function validate(raw, { sourceTexts, maxCite }) {
  const nums = sourceNumbers(sourceTexts);
  const known = (v) => {
    const n = Math.abs(num(v));
    return !Number.isFinite(n) || n === 0 || nums.has(n);
  };
  const cite = (c) => (Number.isInteger(Number(c)) && Number(c) >= 1 && Number(c) <= maxCite ? Number(c) : null);
  const out = [];
  for (const v of Array.isArray(raw) ? raw.slice(0, 2) : []) {
    if (!v || typeof v !== 'object') continue;
    const formula = cleanStr(v.formula, 160);
    try {
      if (v.type === 'stats') {
        const items = (v.items || []).slice(0, 4).map((x) => ({ label: cleanStr(x.label, 30), value: cleanStr(x.value, 16), unit: cleanStr(x.unit, 8), note: cleanStr(x.note, 40), cite: cite(x.cite) }));
        if (items.length < 1 || items.some((x) => !x.label || !x.value)) continue;
        // 수치 카드는 근거 원문 숫자만 허용 (계산 값 불가)
        if (items.some((x) => (x.value.match(/\d[\d,]*(?:\.\d+)?/g) || []).some((n) => !known(n)))) continue;
        out.push({ type: 'stats', title: cleanStr(v.title, 40), items });
      } else if (v.type === 'steps') {
        const items = (v.items || []).slice(0, 7).map((x) => ({ title: cleanStr(x.title, 30), desc: cleanStr(x.desc, 120), cite: cite(x.cite) }));
        if (items.length < 2 || items.some((x) => !x.title)) continue;
        out.push({ type: 'steps', title: cleanStr(v.title, 40), items });
      } else if (v.type === 'timeline') {
        const raw = (v.items || []).slice(0, 5);
        // 시작·끝의 기준일이 다르면(예: 출산예정일 50일 전 ~ 출산일 후 120일) 한 축에 그릴 수 없으므로 버림
        const ref = (x, k) => cleanStr(x[k] || '', 16).replace(/s+/g, '');
        if (raw.some((x) => !ref(x, 'startFrom') || !ref(x, 'endFrom') || ref(x, 'startFrom') !== ref(x, 'endFrom'))) continue;
        const items = raw.map((x) => ({ label: cleanStr(x.label, 30), start: Number(x.start), end: Number(x.end), note: cleanStr(x.note, 50), cite: cite(x.cite) }));
        if (!items.length || items.some((x) => !Number.isFinite(x.start) || !Number.isFinite(x.end) || x.end < x.start)) continue;
        if (!formula && items.some((x) => !known(x.start) || !known(x.end))) continue;
        out.push({ type: 'timeline', title: cleanStr(v.title, 40), unit: cleanStr(v.unit || '일', 4), anchor: cleanStr(v.anchor || '기준일', 16), items, formula });
      } else if (v.type === 'chart') {
        const kind = ['bar', 'line', 'range'].includes(v.chart) ? v.chart : 'bar';
        const labels = (v.labels || []).slice(0, 12).map((l) => cleanStr(l, 20));
        const series = (v.series || []).slice(0, 3).map((s) => ({
          name: cleanStr(s.name, 24),
          data: (s.data || []).slice(0, labels.length).map((d) => (kind === 'range' ? (Array.isArray(d) ? d.slice(0, 2).map(Number) : null) : Number(d))),
        }));
        if (labels.length < 2 || !series.length) continue;
        const flat = series.flatMap((s) => s.data.flat());
        if (flat.some((d) => d === null || !Number.isFinite(d))) continue;
        if (!formula && flat.some((d) => !known(d))) continue;
        out.push({ type: 'chart', chart: kind, title: cleanStr(v.title, 40), unit: cleanStr(v.unit, 8), labels, series, formula, cite: cite(v.cite) });
      }
    } catch {}
  }
  return out;
}

/** 본문에서 <<<VISUALS>>> 블록 분리 */
function split(text) {
  const i = text.lastIndexOf(MARK);
  if (i < 0) return { body: text, raw: [] };
  const rest = text.slice(i + MARK.length);
  // 블록 끝 = 다음 마커(<<<EHR>>> 등) 전까지
  const end = rest.search(/<<<[A-Z]+>>>/);
  const jsonPart = end >= 0 ? rest.slice(0, end) : rest;
  let raw = [];
  try {
    const m = jsonPart.match(/\[[\s\S]*\]/);
    raw = JSON.parse(m ? m[0] : '[]');
  } catch {}
  return { body: (text.slice(0, i) + (end >= 0 ? rest.slice(end) : '')).trim(), raw };
}

const FOLLOWUP_SPEC = `[후속 질문] 이 질문에 대한 답(근거 기준)을 들은 사용자가 이어서 물어볼 질문 0~3개.
- 답에 나오는 다음 행동·용어·절차·창구·서류에 대한 질문 (예: "고충처리 창구에 신고하세요" → "고충처리 창구는 어디에 있나요?")
- 1인칭 구어체, 30자 이내, 방금 질문 반복 금지, 인사 규정이나 eHR로 답할 수 있는 것만`;

/**
 * 질문 + 근거 → 시각화 블록·후속 질문·eHR 메뉴 (JSON 모드, 본 답변과 병렬 호출)
 * ehrCatalog 가 있으면 신청·조회 경로로 안내할 eHR 메뉴도 고름
 */
async function generate(question, chunks, { ehrCatalog = '' } = {}) {
  const { chat } = require('./llm');
  const ctx = chunks.map((c, i) => `[${i + 1}] ${c.docLabel} ${c.label}\n${c.text}`).join('\n\n---\n\n');
  const ehrSpec = ehrCatalog
    ? `\n\n[eHR 메뉴] 질문이 신청·조회·출력·발급 방법이나 경로를 물으면 아래 목록에서 해당 메뉴를 고르세요 (목록에 있는 이름 그대로, 최대 2개).\n${ehrCatalog}`
    : '';
  const shape = `{"visuals":[...],"followups":["..."]${ehrCatalog ? ',"ehr":[{"menu":"근태/휴가신청","note":"휴가구분: 태아검진휴가"}]' : ''}}`;
  const out = await chat(
    [
      {
        role: 'system',
        content: `당신은 인사 규정 챗봇의 답변 보조 도우미입니다. [근거]와 [질문]을 보고 JSON으로만 출력합니다.\n\n${SPEC}\n\n${FOLLOWUP_SPEC}${ehrSpec}\n\n출력 형식: ${shape}`,
      },
      { role: 'user', content: `[근거]\n${ctx}\n\n[질문]\n${question}` },
    ],
    { json: true, maxTokens: 1000, temperature: 0 }
  );
  let j = {};
  try {
    j = JSON.parse(out.text);
  } catch {}
  const raw = Array.isArray(j) ? j : Array.isArray(j.visuals) ? j.visuals : j.type ? [j] : [];
  const followups = (Array.isArray(j.followups) ? j.followups : [])
    .filter((q) => typeof q === 'string')
    .map((q) => q.trim())
    .filter((q) => q && q.length <= 60)
    .slice(0, 3);
  return {
    raw,
    visuals: validate(raw, { sourceTexts: chunks.map((c) => c.text), maxCite: chunks.length }),
    followups,
    ehr: Array.isArray(j.ehr) ? j.ehr : [],
  };
}

module.exports = { MARK, SPEC, split, validate, generate, sourceNumbers };
