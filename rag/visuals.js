/**
 * 답변 시각화 블록 (LLM이 본문과 함께 JSON으로 출력 → 화면에서 컴포넌트로 렌더링)
 *   stats    : 핵심 수치 카드
 *   steps    : 절차 흐름
 *   timeline : 기간 타임라인 (기준일 0을 중심으로 상대 일수/주수)
 *   chart    : 막대·가로 막대(hbar)·선·범위 그래프 (Chart.js)
 *   info     : 숫자 없는 기준(대상·방식·조건·제한)을 아이콘 카드로
 * 검증: 근거에 없는 숫자 · 질문과 다른 주제 · 단위가 섞인 금액 · 값이 모두 같은 그래프는 버림. 전부 버려지면 이유를 알려 주고 1회 재요청
 * 숫자는 근거 원문에 있는 값만 허용. 계산으로 만든 값은 formula(계산식)를 함께 내야 하며 화면에 계산식을 표시.
 */
const MARK = '<<<VISUALS>>>';

const SPEC = `[시각화 블록] 답변 내용을 한눈에 보이게 하는 도표·그래프입니다.
근거에 질문의 답이 있으면 **반드시 1개 이상** 만드세요 (최대 2개).
질문이 묻는 세부 사항(예: 차감 기준)은 근거에 없지만 **같은 제도**(예: 선택적 복지)의 기준은 있으면, 그 제도의 기준을 info로 보여 주세요.
근거가 질문과 다른 제도뿐이면 [].
아래 순서로 가장 잘 맞는 것을 고르고, 서로 다른 정보를 보여 줄 수 있으면 2개를 조합하세요 (예: chart + stats, steps + stats).

1) 사유·직급·근속연수·지역 등 **항목별로 일수·금액·횟수가 다른 표나 목록(3개 이상)** → chart
   - 항목 이름이 길거나 5개 이상이면 "hbar"(가로 막대), 짧고 4개 이하면 "bar", 시간에 따른 변화면 "line", 최소~최대면 "range"(data는 [[최소,최대],...])
   - 표의 행을 빠짐없이 옮기세요 (최대 16개). 같은 값끼리 묶지 말고, 항목 이름은 근거 표현을 짧게 줄여 쓰세요
   {"type":"chart","chart":"hbar","title":"청원휴가 사유별 일수","unit":"일","labels":["본인 결혼","배우자 출산","부모 사망","자녀 결혼"],"series":[{"name":"휴가 일수","data":[5,20,5,1]}],"cite":1}
   {"type":"chart","chart":"range","title":"직급별 기본연봉 한계액","unit":"천원","labels":["1급","2급","3급"],"series":[{"name":"기본연봉","data":[[51029,90602],[45822,80188],[40732,71280]]}],"cite":1}
   - 규정이 표가 아니라 계산 규칙이면(예: "15일 + 최초 1년 초과 매 2년마다 1일, 한도 25일") 대표 구간의 값을 계산해 line/bar로 그리고 formula를 쓰세요
   {"type":"chart","chart":"line","title":"근속연수별 연차 일수","unit":"일","labels":["1년","3년","5년","11년","21년 이상"],"series":[{"name":"연차 일수","data":[15,16,17,20,25]}],"formula":"15일 + (근속연수−1)÷2 가산, 최대 25일","cite":1}
2) 핵심 숫자(일수·금액·횟수·기한·비율)가 2개 이상 → stats (최대 4개, **첫 항목은 질문에 대한 직접적인 답**)
   {"type":"stats","title":"배우자 출산휴가 한눈에","items":[{"label":"휴가 일수","value":"20","unit":"일","note":"유급","cite":1},{"label":"분할 사용","value":"3","unit":"회","cite":1}]}
3) 신청·승인·징계·신고 등 순서가 3단계 이상 → steps
   {"type":"steps","title":"휴직 신청 절차","items":[{"title":"휴직원 제출","desc":"휴직 30일 전까지","cite":1},{"title":"부서장 검토","desc":"...","cite":1}]}
4) 기준일(출산일·입사일·사유 발생일 등) 전후로 쓸 수 있는 기간 → timeline (기준일=0, 이전은 음수). startFrom/endFrom에는 시작·끝이 각각 어느 날짜 기준인지 근거 표현 그대로
   {"type":"timeline","title":"사용 가능 기간","unit":"일","anchor":"출산일","items":[{"label":"사용 가능 기간","start":-50,"startFrom":"출산예정일","end":120,"endFrom":"출산예정일","cite":1}]}
5) 숫자가 거의 없고 **대상·방식·조건·제한·서류 같은 기준**을 설명하는 답 → info (2~4개, icon은 group|payments|event|rule|block|description|schedule|verified|info 중 하나)
   {"type":"info","title":"선택적 복지 운영 기준","items":[{"icon":"group","label":"대상","text":"국내 근무 직원과 배우자, 직계 존·비속","cite":1},{"icon":"payments","label":"운용 방식","text":"개인별 가용 예산 안에서 복지항목 선택","cite":1}]}

주의:
- **질문이 묻는 내용만** 시각화하세요. 근거에 비슷한 다른 제도(예: 경조금을 물었는데 재해부조금 표, 출장 숙박비를 물었는데 국외지사 주택임차 한도)가 있어도 그리지 마세요.
- 근거가 특정 대상에만 적용되면(국외근무 직원, 특정 직급 등) title에 그 대상을 꼭 쓰세요 (예: "국외근무 직원 자녀 학자금 한도").
- 한 chart에는 **같은 단위**만 (통화가 다른 금액, 일과 회 등을 섞지 마세요).
- 모든 값이 같으면(예: 전부 1일) chart 대신 stats나 info로 보여 주세요. 조건부 값(예: "1개월 개근 시 1일")을 0으로 넣지 마세요.
- chart의 data에는 **숫자만** 넣으세요 (문장·"15 + 가산" 같은 표현 금지).
- 숫자는 근거 원문 값 그대로. 원문 값을 바꾸거나 계산한 값(예: "1년 5개월"→17개월, "10분의 39"→3.9, 근속연수별 연차 일수)을 넣으면 "formula":"계산식 설명"을 반드시 함께 쓰세요.
- timeline은 시작과 끝이 같은 기준일일 때만 (기준일이 다르면 stats로). 개인별 수치는 지어내지 마세요.`;

const INFO_ICONS = ['group', 'payments', 'event', 'rule', 'block', 'description', 'schedule', 'verified', 'info'];

const num = (s) => Number(String(s).replace(/,/g, ''));

/** 근거 원문에 나오는 숫자 집합 */
function sourceNumbers(texts) {
  const set = new Set();
  for (const t of texts) {
    const s = String(t);
    for (const m of s.matchAll(/\d[\d,]*(?:\.\d+)?/g)) set.add(num(m[0]));
    // 원문 표현을 단위만 바꾼 값도 허용 (계산식 없이 그려도 되는 단순 환산)
    for (const m of s.matchAll(/(\d+)\s*년(?:\s*(\d+)\s*개월)?/g)) {
      const y = Number(m[1]), mo = Number(m[2] || 0);
      set.add(y * 12 + mo); // 1년 5개월 → 17개월
      if (!mo) set.add(y * 365); // 1년 → 365일
    }
    for (const m of s.matchAll(/(\d+)\s*만\s*(?:원|달러|명|$|\s)/g)) set.add(Number(m[1]) * 10000); // 4만달러 → 40,000
    for (const m of s.matchAll(/(\d+)\s*분의\s*(\d+)/g)) {
      const r = Number(m[2]) / Number(m[1]);
      set.add(Math.round(r * 1000) / 1000); // 10분의 39 → 3.9
      set.add(Math.round(r * 100 * 10) / 10); // → 390(%)
    }
  }
  return set;
}

function cleanStr(s, n = 80) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
}

// 질문과 시각화가 같은 주제인지: 질문의 핵심 낱말(조사 뗀 2글자 이상)이 시각화 제목·항목에 나오는지
const COMMON = new Set(['알려줘', '알려', '어떻게', '얼마나', '얼마', '얼마까지', '며칠', '몇', '어떤', '무엇', '언제', '기준', '방법', '규정', '사규', '관련', '경우', '대해', '해야', '하면', '나와', '받을', '있나요', '있어', '되나요', '인가요', '하나요', '돼', '수', '갈', '때', '중', '해', '줘', '주나요', '근무하면', '나눠', '쓸', '받으려면', '계산돼', '계산']);
const PARTICLE = /(은|는|이|가|을|를|에|의|도|로|으로|과|와|에서|까지|부터|이고|이면|인가요|인가|나요|요)$/;
function keywords(s) {
  return (String(s).match(/[가-힣A-Za-z]{2,}/g) || [])
    .map((w) => (w.length > 2 ? w.replace(PARTICLE, '') : w))
    .filter((w) => w.length >= 2 && !COMMON.has(w));
}
function onTopic(question, v) {
  const q = keywords(question);
  if (!q.length) return true;
  const text = [v.title, ...(v.labels || []), ...(v.items || []).map((x) => `${x.label || ''} ${x.title || ''} ${x.text || ''}`)].join(' ');
  // 낱말 전체가 나오거나, 3글자 이상 낱말은 앞 2글자 어간(예: 겸직→겸업은 불가, 출산휴가→출산)도 허용
  return q.some((w) => text.includes(w) || (w.length >= 4 && text.includes(w.slice(0, 2)) && text.includes(w.slice(-2))));
}

/** 시각화 블록 검증·정리. 근거에 없는 숫자가 있으면(계산식 없이) 해당 블록은 버림 */
function validate(raw, { sourceTexts, sourceLabels = [], maxCite, reasons = [], question = '' }) {
  const nums = sourceNumbers(sourceTexts);
  const known = (v) => {
    const n = Math.abs(num(v));
    return !Number.isFinite(n) || n === 0 || nums.has(n);
  };
  const cite = (c) => (Number.isInteger(Number(c)) && Number(c) >= 1 && Number(c) <= maxCite ? Number(c) : null);
  const out = [];
  for (const v of Array.isArray(raw) ? raw.slice(0, 2) : []) {
    if (!v || typeof v !== 'object') continue;
    if (question && !onTopic(question, v)) { reasons.push(`${v.type}: 질문과 다른 주제 (${cleanStr(v.title, 30)})`); continue; }
    // 근거가 특정 대상(국외근무)에만 해당하면 제목에 대상을 붙임
    const ci = (Number(v.cite) || (v.items && v.items[0] && Number(v.items[0].cite)) || 0) - 1;
    // 장·절 경로(예: "복지규정 시행요강 > 제3장 국외복지 > …")로만 판단 (본문에 국외근무가 잠깐 나오는 조문은 제외)
    if (/국외|해외/.test(String(sourceLabels[ci] || '')) && v.title && !/국외|해외/.test(v.title)) v.title = `(국외근무) ${v.title}`;
    const formula = cleanStr(v.formula, 160);
    try {
      if (v.type === 'stats') {
        const items = (v.items || []).slice(0, 4).map((x) => ({ label: cleanStr(x.label, 30), value: cleanStr(x.value, 16), unit: cleanStr(x.unit, 8), note: cleanStr(x.note, 40), cite: cite(x.cite) }));
        if (items.length < 1 || items.some((x) => !x.label || !x.value)) { reasons.push('stats: 빈 항목'); continue; }
        // 수치 카드는 근거 원문 숫자만 허용 (계산 값 불가)
        const bad = items.flatMap((x) => (x.value.match(/\d[\d,]*(?:\.\d+)?/g) || []).filter((n) => !known(n)));
        if (bad.length) { reasons.push('stats: 근거에 없는 숫자 ' + bad.join(',')); continue; }
        out.push({ type: 'stats', title: cleanStr(v.title, 40), items });
      } else if (v.type === 'steps') {
        const items = (v.items || []).slice(0, 7).map((x) => ({ title: cleanStr(x.title, 30), desc: cleanStr(x.desc, 120), cite: cite(x.cite) }));
        if (items.length < 2 || items.some((x) => !x.title)) { reasons.push('steps: 단계 부족'); continue; }
        out.push({ type: 'steps', title: cleanStr(v.title, 40), items });
      } else if (v.type === 'timeline') {
        const raw = (v.items || []).slice(0, 5);
        // 시작·끝의 기준일이 다르면(예: 출산예정일 50일 전 ~ 출산일 후 120일) 한 축에 그릴 수 없으므로 버림
        const ref = (x, k) => cleanStr(x[k] || '', 16).replace(/\s+/g, '');
        if (raw.some((x) => !ref(x, 'startFrom') || !ref(x, 'endFrom') || ref(x, 'startFrom') !== ref(x, 'endFrom'))) { reasons.push('timeline: 시작·끝 기준일 다름'); continue; }
        const items = raw.map((x) => ({ label: cleanStr(x.label, 30), start: Number(x.start), end: Number(x.end), note: cleanStr(x.note, 50), cite: cite(x.cite) }));
        if (!items.length || items.some((x) => !Number.isFinite(x.start) || !Number.isFinite(x.end) || x.end < x.start)) { reasons.push('timeline: 범위 오류'); continue; }
        if (!formula && items.some((x) => !known(x.start) || !known(x.end))) { reasons.push('timeline: 근거에 없는 숫자'); continue; }
        out.push({ type: 'timeline', title: cleanStr(v.title, 40), unit: cleanStr(v.unit || '일', 4), anchor: cleanStr(v.anchor || '기준일', 16), items, formula });
      } else if (v.type === 'info') {
        const items = (v.items || []).slice(0, 4).map((x) => ({ icon: INFO_ICONS.includes(x.icon) ? x.icon : 'info', label: cleanStr(x.label, 20), text: cleanStr(x.text, 90), cite: cite(x.cite) }));
        if (items.length < 2 || items.some((x) => !x.label || !x.text)) { reasons.push('info: 항목 부족'); continue; }
        const bad = items.flatMap((x) => (x.text.match(/\d[\d,]*(?:\.\d+)?/g) || []).filter((n) => !known(n)));
        if (bad.length) { reasons.push('info: 근거에 없는 숫자 ' + bad.join(',')); continue; }
        out.push({ type: 'info', title: cleanStr(v.title, 40), items });
      } else if (v.type === 'chart') {
        const kind = ['bar', 'hbar', 'line', 'range'].includes(v.chart) ? v.chart : 'bar';
        const labels = (v.labels || []).slice(0, 16).map((l) => cleanStr(l, 24));
        const series = (v.series || []).slice(0, 3).map((s) => ({
          name: cleanStr(s.name, 24),
          data: (s.data || []).slice(0, labels.length).map((d) => (kind === 'range' ? (Array.isArray(d) ? d.slice(0, 2).map(Number) : null) : Number(d))),
        }));
        // 선 그래프 맨 앞의 0(조건부 값을 0으로 넣은 경우)은 빼고 그림
        if (kind === 'line' && series.length === 1) {
          while (labels.length > 2 && Number(series[0].data[0]) === 0) { labels.shift(); series[0].data.shift(); }
        }
        if (labels.length < 2 || !series.length) { reasons.push('chart: 항목 부족'); continue; }
        const flat = series.flatMap((s) => s.data.flat());
        if (flat.some((d) => d === null || !Number.isFinite(d))) { reasons.push('chart: 숫자 아님'); continue; }
        // 값이 전부 같으면 그래프로 비교할 의미가 없음
        if (kind !== 'range' && series.length === 1 && new Set(series[0].data).size === 1) { reasons.push('chart: 값이 모두 같음'); continue; }
        // 단위가 섞인 금액(나라별 통화 등)은 한 축에 비교할 수 없음
        const pos = flat.filter((d) => d > 0);
        if (/통화|별\s*단위|현지/.test(String(v.unit)) || (pos.length > 1 && Math.max(...pos) / Math.min(...pos) > 100 && !/%|일|회|개월|년/.test(String(v.unit)))) { reasons.push('chart: 단위가 섞임'); continue; }
        if (!formula && flat.some((d) => !known(d))) { reasons.push('chart: 근거에 없는 숫자 ' + flat.filter((d) => !known(d)).join(',')); continue; }
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
  const { expandQuery } = require('./retrieve');
  const ctx = chunks.map((c, i) => `[${i + 1}] ${c.docLabel} ${c.label}\n${c.text}`).join('\n\n---\n\n');
  const ehrSpec = ehrCatalog
    ? `\n\n[eHR 메뉴] 질문이 신청·조회·출력·발급 방법이나 경로를 물으면 아래 목록에서 해당 메뉴를 고르세요 (목록에 있는 이름 그대로, 최대 2개).\n${ehrCatalog}`
    : '';
  const shape = `{"visuals":[...],"followups":["..."]${ehrCatalog ? ',"ehr":[{"menu":"근태/휴가신청","note":"휴가구분: 태아검진휴가"}]' : ''}}`;
  const messages = [
    {
      role: 'system',
      content: `당신은 인사 규정 챗봇의 답변 보조 도우미입니다. [근거]와 [질문]을 보고 JSON으로만 출력합니다.\n\n${SPEC}\n\n${FOLLOWUP_SPEC}${ehrSpec}\n\n출력 형식: ${shape}`,
    },
    { role: 'user', content: `[근거]\n${ctx}\n\n[질문]\n${question}` },
  ];
  const parse = (text) => { try { return JSON.parse(text); } catch { return {}; } };
  const rawOf = (j) => (Array.isArray(j) ? j : Array.isArray(j.visuals) ? j.visuals : j.type ? [j] : []);
  const check = (raw, reasons) => validate(raw, { sourceTexts: chunks.map((c) => c.text), sourceLabels: chunks.map((c) => c.label), maxCite: chunks.length, reasons, question: expandQuery(question) });

  const out = await chat(messages, { json: true, maxTokens: 1500, temperature: 0 });
  const j = parse(out.text);
  let raw = rawOf(j);
  let reasons = [];
  let visuals = check(raw, reasons);
  // 한 번만 다시 요청하는 경우
  //  ① 제안한 블록이 전부 검증에서 떨어짐 (질문과 다른 주제라서 떨어진 경우는 제외)
  //  ② 아무것도 안 만들었지만 1순위 근거가 질문과 같은 제도 (예: 복지포인트 → 선택적 복지 조문)
  const failed = raw.length && !visuals.length && !reasons.every((r) => r.includes('다른 주제'));
  const skipped = !raw.length && chunks[0] && onTopic(expandQuery(question), { title: chunks[0].label });
  if (failed || skipped) {
    const ask = failed
      ? `위 visuals는 다음 이유로 쓸 수 없습니다: ${reasons.join(' / ')}\n같은 근거로 규칙에 맞게 visuals만 다시 만드세요 (예: 값이 모두 같으면 stats, 숫자 표현이 어려우면 info).`
      : `근거 [1]은 질문과 같은 제도입니다. 질문의 세부 사항이 근거에 없더라도 그 제도의 대상·방식·조건을 info(2~4항목)로 만드세요. 근거에 없는 내용은 쓰지 마세요.`;
    const retry = await chat(
      [...messages, { role: 'assistant', content: out.text }, { role: 'user', content: `${ask} 출력 형식: {"visuals":[...]}` }],
      { json: true, maxTokens: 1200, temperature: 0 }
    ).catch(() => null);
    if (retry) {
      const raw2 = rawOf(parse(retry.text));
      const reasons2 = [];
      const v2 = check(raw2, reasons2);
      if (v2.length) { raw = raw2; visuals = v2; }
      reasons = [...reasons, ...reasons2.map((r) => '재시도 ' + r)];
    }
  }
  const followups = (Array.isArray(j.followups) ? j.followups : [])
    .filter((q) => typeof q === 'string')
    .map((q) => q.trim())
    .filter((q) => q && q.length <= 60)
    .slice(0, 3);
  return { raw, visuals, reasons, followups, ehr: Array.isArray(j.ehr) ? j.ehr : [] };
}

module.exports = { MARK, SPEC, split, validate, generate, sourceNumbers };
