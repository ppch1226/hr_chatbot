/**
 * RAG 답변 생성: 검색 → 근거 블록 구성 → LLM → 출처 정리
 */
const { search } = require('./retrieve');
const { embed } = require('./models');
const { chat, chatStream } = require('./llm');
const VIS = require('./visuals');
const lawsources = require('./lawsources');

// 개인별 수치(잔여 연차·내 급여 등)는 규정 문서에 없는 정형 데이터 → RAG로 추측하지 않음
const PERSONAL = /(내|나의|제|저의|우리\s*팀)\s*(남은|잔여|현재|이번\s*달)?\s*(연차|휴가|복지\s*포인트|급여|월급|연봉|보수|퇴직금|성과급|호봉|평가\s*등급)|(남은|잔여)\s*(연차|휴가|복지\s*포인트)\s*(는|가|이)?\s*(몇|얼마)/;

const sessions = new Map(); // sessionId -> [{role, content}] 최근 대화

const SYSTEM = (role) => `당신은 "${role === 'admin' ? '인사해삐M' : '인사해삐'}", 한국무역보험공사 인사 제규정을 안내하는 AI 비서입니다.
${role === 'admin' ? '사용자는 인사담당자입니다. 규정 근거, 처리 절차, 노무 리스크 관점의 유의사항을 실무적으로 정리하세요.' : '사용자는 임직원입니다. 쉬운 말로, 핵심부터 친절하게 설명하세요.'}

[답변 규칙]
1. 반드시 [근거]에 있는 내용만 사용하세요. 근거에 없는 내용은 추측하지 말고 "제공된 규정에서 확인되지 않습니다"라고 말한 뒤 인사담당 부서 문의를 안내하세요.
2. 문장마다 사용한 근거 번호를 [1], [2]처럼 붙이세요. [근거]에 있는 번호만 쓰고, [2-①]처럼 항 번호를 붙이지 마세요.
3. 숫자(일수, 금액, 비율, 기간)는 근거 원문 그대로 옮기세요. 계산이 필요하면 계산 과정을 보여주세요.
4. 규정과 시행요강의 내용이 서로 보완될 때만 어느 쪽 기준인지 구분하세요. "규정이 원칙이고 시행요강이 세부 기준입니다" 같은 일반론은 쓰지 마세요.
5. 본인의 잔여 연차·급여·포인트 같은 개인별 수치를 직접 물을 때만: 적용 기준만 설명하고 본인 수치는 [eHR 메뉴]의 조회 메뉴에서 확인하도록 안내하세요.
6. 마크다운으로 답하세요. 핵심 결론 1~2문장 → 세부 기준(목록/표). 맨 끝에 "근거" 목록은 쓰지 마세요.
7. [eHR 메뉴]가 주어졌고 신청·조회·출력·발급·변경 방법이나 경로를 물으면:
   - 규정상 핵심 기준(대상·일수·기간·서류 등 구체적 숫자)을 [근거]로 먼저 설명하세요. 규정 설명 문장에서 eHR이나 메뉴를 언급하지 마세요.
   - "### eHR에서 신청하기" 아래에 \`eHR > 개인용 > 근태 > 근태/휴가신청\` 형식의 경로와 1~4단계 입력 순서를 쓰세요 (근거 번호 없이). 경로는 [eHR 메뉴]에 있는 메뉴 이름만 쓰세요.

8. 본문만 쓰세요. 시각화·후속 질문·eHR 바로가기 카드는 화면에서 따로 만듭니다.
9. [근거]에는 사내 규정(사규)과 국가법령정보센터 자료가 함께 있습니다. 각 근거 앞의 (사규)/(법령)${role === 'admin' ? '/(판례)/(행정규칙)/(행정해석)/(노동위원회)' : ''} 표시를 보고 구분하세요.
   - 사규 기준을 먼저 설명하고, 관련 법령이 있으면 "### 관련 법령" 아래에 법령명·조문과 핵심 내용을 1~3줄로 덧붙이세요.
   - 사규가 법령 기준보다 유리하거나 같으면 그대로 안내하고, 사규가 법령보다 불리해 보이면 법령이 우선 적용된다는 점과 인사담당 부서 확인을 안내하세요.
   - 질문과 관련 없는 법령은 언급하지 마세요.${role === 'admin' ? `
   - 판례·행정해석·노동위원회 결정례·행정규칙은 "### 참고 판례·해석" 아래에 사건번호(또는 안건번호)와 요지를 1~2줄씩 정리하고, 이번 사안에 주는 시사점을 덧붙이세요. 질문과 직접 관련 없는 사례는 빼세요.
   - 판례·해석은 개별 사안의 판단이므로 "구체적 사실관계에 따라 결론이 달라질 수 있어 노무 담당과 검토가 필요하다"는 점을 짧게 밝히세요.` : ''}`;

const FOLLOWUP_MARK = '<<<FOLLOWUPS>>>';
const EHR_MARK = '<<<EHR>>>';

// ── eHR 메뉴 (시연용 카탈로그: rag/ehr-menu.json)
const EHR = require('./ehr-menu.json');
const EHR_ITEMS = EHR.groups.flatMap((g) => g.items.map((it) => ({ ...it, group: g.name, path: [EHR.system, EHR.root, g.name, it.name] })));
const EHR_CATALOG = EHR.groups
  .map((g) => `[${g.name}]\n` + g.items.map((it) => `- ${it.name}: ${it.desc}${it.option ? ` (입력: ${it.option})` : ''}`).join('\n'))
  .join('\n');
// 신청·조회 경로를 묻는 질문
const PROCEDURE = /(신청|신고|제출|등록|출력|발급|조회|변경|취소|정산|확인)\s*(은|는|을|를|하는|하려면|하면|해야|할\s*수|하나요|해\?|해야\s*돼|방법|경로|절차|어디)|(어디서|어디에서|어디로|어떻게)\s*(\S+\s*){0,2}(신청|신고|제출|등록|출력|발급|조회|봐|볼|확인|뽑)|경로|메뉴|eHR|이에이치알/i;

/** 메뉴 선택 목록 → 카탈로그에 있는 메뉴만 남김 */
function mapEhr(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => {
      const it = EHR_ITEMS.find((e) => e.name === String(x.menu || '').trim());
      return it && { menu: it.name, group: it.group, path: it.path, desc: it.desc, option: it.option || '', note: String(x.note || '').slice(0, 80), url: EHR.url };
    })
    .filter(Boolean)
    .slice(0, 3);
}

/** (호환) 본문에 <<<EHR>>> 블록이 남아 있으면 떼어 냄 */
function parseEhr(text) {
  const i = text.lastIndexOf(EHR_MARK);
  if (i < 0) return { body: text, ehr: [] };
  let list = [];
  try {
    const m = text.slice(i + EHR_MARK.length).match(/\[[\s\S]*?\](?=\s*$|\s*\n)/) || text.slice(i + EHR_MARK.length).match(/\[[\s\S]*\]/);
    list = JSON.parse(m ? m[0] : '[]');
  } catch {}
  return { body: text.slice(0, i).trim(), ehr: mapEhr(list) };
}

/** LLM 출력에서 후속 질문 블록을 떼어 냄 */
function splitFollowups(text) {
  const i = text.lastIndexOf(FOLLOWUP_MARK);
  if (i < 0) return { body: text, followups: [] };
  let followups = [];
  try {
    const m = text.slice(i + FOLLOWUP_MARK.length).match(/\[[\s\S]*\]/);
    followups = JSON.parse(m ? m[0] : '[]');
  } catch {}
  followups = (Array.isArray(followups) ? followups : [])
    .filter((q) => typeof q === 'string')
    .map((q) => q.trim())
    .filter((q) => q && q.length <= 60)
    .slice(0, 3);
  return { body: text.slice(0, i).trim(), followups };
}

/** 사규 청크 + 법령정보 항목 → 번호 매긴 근거 목록 */
function evidenceList(chunks, lawItems) {
  const regs = chunks.map((c) => ({
    kind: '사규',
    head: `${c.docLabel} ${c.type === '본문' ? c.label : c.type + ' ' + c.label} (개정 ${c.revised})`,
    text: c.text,
    chunk: c,
  }));
  const laws = lawItems.map((x) => ({
    kind: x.kind,
    head: `${x.title}${x.kind === '법령' && x.date ? ` (시행 ${x.date})` : ''}`,
    text: x.text.length > 1400 ? x.text.slice(0, 1400) + ' …' : x.text,
    law: x,
  }));
  return [...regs, ...laws].map((e, i) => ({ ...e, n: i + 1 }));
}
/** 이번 질문에 들어온 법령정보 근거를 번호로 알려 줘서 섹션을 빠뜨리지 않게 함 */
function lawHint(evidence) {
  const nums = (pred) => evidence.filter(pred).map((e) => `[${e.n}]`).join(', ');
  const law = nums((e) => e.kind === '법령');
  const cases = nums((e) => e.law && e.kind !== '법령');
  const lines = [];
  if (law) lines.push(`법령 근거 ${law}가 있습니다. 질문과 관련 있으면 답변에 "### 관련 법령" 소제목을 두고 법령명·조문과 핵심 내용을 쓰고 각 줄 끝에 해당 근거 번호를 붙이세요. 사규와의 관계(같음/사규가 더 유리/법령 우선)는 [근거]에 해당 사규 조문이 있을 때만 쓰고, 없으면 "사내 규정에서는 별도 조항을 찾지 못했습니다"라고 쓰세요.`);
  if (cases) lines.push(`판례·행정해석 등 참고 사례 ${cases}가 있습니다. 질문과 관련 있는 것은 "### 참고 판례·해석" 소제목 아래에 사건번호(안건번호)·요지·이번 사안에 주는 시사점을 쓰고 근거 번호를 붙이세요. 이 사례들은 사규가 아니므로 "판례도 있습니다"처럼 사규 설명과 섞지 말고 이 섹션에서만 다루세요.`);
  return lines.length ? '(참고: ' + lines.join(' ') + ')' : '';
}
/** 인사담당자용 "참고 판례·해석" 섹션 작성 (본 답변과 별도 호출) */
async function writeCases(question, items) {
  const ctx = items.map((e) => `[${e.n}] (${e.kind}) ${e.head}\n${e.text}`).join('\n\n---\n\n');
  const guide = [
    '작성 방법:',
    '- 첫 줄은 "### 참고 판례·해석"',
    '- 질문과 직접 관련 있는 사례만. 사례마다 한 항목: **사건번호 또는 안건번호** (기관·날짜) — 요지 1~2문장 — 이번 사안에 주는 시사점 1문장, 끝에 근거 번호 [n]',
    '- 마지막 줄: "※ 판례·해석은 개별 사안의 판단이므로 구체적 사실관계에 따라 결론이 달라질 수 있어 노무 담당과 검토가 필요합니다."',
    '- 관련 있는 사례가 하나도 없으면 "없음" 한 단어만 쓰세요.',
  ].join('\n');
  const out = await chat(
    [
      { role: 'system', content: '당신은 인사·노무 담당자를 돕는 노무 검토 비서입니다. 질문과 관련된 판례·행정해석·노동위원회 결정례·행정규칙만 골라 간결하게 정리합니다.' },
      { role: 'user', content: `[질문]\n${question}\n\n[참고 사례]\n${ctx}\n\n${guide}` },
    ],
    { maxTokens: 700 }
  );
  const t = out.text.trim();
  return /^없음\.?$/.test(t) ? '' : t;
}
function contextBlock(evidence) {
  return evidence.map((e) => `[${e.n}] (${e.kind}) ${e.head}\n${e.text}`).join('\n\n---\n\n');
}

function retrievalQuery(question, history) {
  // 짧은 후속 질문("그럼 3년차는?")은 직전 질문과 합쳐서 검색
  const prev = [...history].reverse().find((m) => m.role === 'user');
  if (prev && question.length < 25 && /^(그럼|그러면|그건|이건|그 경우|만약|또|그리고|추가로)|\?$|는요\??$/.test(question.trim())) return `${prev.content} ${question}`;
  return question;
}

/**
 * onEvent 가 있으면 스트리밍 모드: 진행 상황과 답변 토큰을 이벤트로 흘려보냄
 *   { type:'stage', stage:'retrieved', counts } / { type:'delta', text }
 */
async function answer({ question, role = 'employee', sessionId = 'default', anonymous = false, onEvent }) {
  const t0 = Date.now();
  // 익명 질문: 이전 대화와 연결하지 않고, 서버에 대화 이력도 남기지 않음
  const history = anonymous ? [] : sessions.get(sessionId) || [];
  // 같은 첫 질문은 캐시된 답변을 바로 반환 (후속 질문은 이전 대화에 따라 답이 달라지므로 캐시 안 함)
  const cacheKey = CACHE_TTL > 0 && !history.length ? `${role}|${normQ(question)}` : null;
  const cached = cacheKey && cacheGet(cacheKey);
  if (cached) {
    if (!anonymous) sessions.set(sessionId, [{ role: 'user', content: question }, { role: 'assistant', content: cached.answer }]);
    if (onEvent) onEvent({ type: 'delta', text: cached.answer });
    return { ...cached, anonymous, cached: true, elapsed: (Date.now() - t0) / 1000, timing: { cached: true, firstToken: Date.now() - t0 } };
  }
  const personal = PERSONAL.test(question);
  const rq = retrievalQuery(question, history);
  // 사규 검색과 국가법령정보센터 근거 수집(직원: 법령 / 담당자: 법령·판례·행정규칙·행정해석·노동위원회)을 동시에
  const prof = {}; // 단계별 소요 시간(ms)
  const timed = (k, p) => { const s0 = Date.now(); return Promise.resolve(p).then((v) => ((prof[k] = Date.now() - s0), v)); };
  // 질문 임베딩 1회 → 사규 검색·법령 검색이 함께 사용
  const [dense] = await timed('embed', embed([rq]));
  // 판례·행정해석 등(인사담당자용)은 실시간 조회라 느림 → 본 답변을 기다리게 하지 않고 따로 진행해 뒤에 붙임
  const casesP = role === 'admin' && !personal ? timed('cases', lawsources.gatherCases(rq).catch(() => ({ items: [], timing: {} }))) : null;
  const [r, lawItems] = await Promise.all([
    timed('regSearch', search(rq, { dense })),
    timed('lawGather', personal ? [] : lawsources.searchLaws(rq, { dense, topK: role === 'admin' ? 3 : 2 }).catch(() => [])),
  ]);
  const lawRes = { items: lawItems, timing: {} };
  prof.retrieval = Date.now() - t0;
  if (onEvent) {
    const counts = {};
    for (const x of [...r.chunks.map(() => '사규'), ...lawRes.items.map((i) => i.kind)]) counts[x] = (counts[x] || 0) + 1;
    onEvent({ type: 'stage', stage: 'retrieved', counts });
  }
  const chunks = r.chunks;
  const evidence = evidenceList(chunks, lawRes.items);

  // 신청·조회 경로를 묻거나 개인별 수치를 물으면 eHR 메뉴 목록을 함께 제공
  const procedure = personal || PROCEDURE.test(question);
  const userMsg = [
    `[근거]\n${evidence.length ? contextBlock(evidence) : '(검색된 근거 없음)'}`,
    procedure ? `[eHR 메뉴] (${EHR.system} > ${EHR.root} > 그룹 > 메뉴)\n${EHR_CATALOG}` : '',
    `[질문]\n${question}`,
    personal ? '(참고: 개인별 수치를 묻는 질문입니다. 답변 규칙 5를 따르세요.)' : '',
    procedure ? '(참고: 신청·조회 경로를 묻는 질문입니다. 답변 규칙 7을 따르세요.)' : '(참고: [eHR 메뉴]가 없으므로 eHR 경로나 메뉴 이름을 쓰지 마세요.)',
    lawHint(evidence),
    casesP ? '(참고: 판례·행정해석·노동위원회 결정례는 답변 아래에 별도 섹션으로 붙으니, 본문에서는 "참고 판례·해석" 섹션을 쓰지 마세요.)' : '',
  ].filter(Boolean).join('\n\n');
  const messages = [{ role: 'system', content: SYSTEM(role) }, ...history.slice(-6), { role: 'user', content: userMsg }];
  // 본문 답변과 보조 정보(시각화·후속 질문·eHR 메뉴)를 동시에 생성
  //  - 보조 정보는 JSON 모드 별도 호출 → 형식이 안정적이고, 병렬이라 대기 시간 증가 없음
  const empty = { raw: [], visuals: [], followups: [], ehr: [] };
  // 판례 조회 완료 → 곧바로 판례 섹션 작성 (본 답변 스트리밍과 동시에)
  const casesDoneP = (casesP || Promise.resolve({ items: [] })).then(async (caseRes) => {
    const caseEvidence = caseRes.items.map((x, i) => ({ kind: x.kind, head: x.title, text: x.text.length > 1400 ? x.text.slice(0, 1400) + ' …' : x.text, law: x, n: evidence.length + i + 1 }));
    let caseText = '';
    if (caseEvidence.length) {
      const tc = Date.now();
      caseText = await writeCases(question, caseEvidence).catch(() => '');
      prof.casesWrite = Date.now() - tc;
    }
    return { caseRes, caseEvidence, caseText };
  });
  const t1 = Date.now();
  const [out, vis] = await Promise.all([
    timed(
      'llmAnswer',
      onEvent
        ? chatStream(messages, {
            maxTokens: 1800,
            onDelta: (d) => {
              if (prof.firstToken == null) prof.firstToken = Date.now() - t0;
              onEvent({ type: 'delta', text: d });
            },
          })
        : chat(messages, { maxTokens: 1800 })
    ),
    evidence.length
      ? timed('llmVisuals', VIS.generate(question, evidence.map((e) => ({ docLabel: `(${e.kind})`, label: e.head, text: e.text })), { ehrCatalog: procedure ? EHR_CATALOG : '' }).catch(() => empty))
      : empty,
  ]);
  prof.generation = Date.now() - t1;
  prof.promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  prof.answerTokens = out.usage && out.usage.completion_tokens;
  prof.promptTokens = out.usage && out.usage.prompt_tokens;
  // 판례 섹션: 판례 조회가 끝나는 즉시 작성 시작(아래 casesDoneP) → 본 답변 생성과 겹쳐 진행, 여기서는 결과만 기다림
  const { caseRes, caseEvidence, caseText } = await casesDoneP;
  if (caseText && onEvent) onEvent({ type: 'delta', text: '\n\n' + caseText });
  const visuals = vis.visuals;
  const split1 = splitFollowups(out.text);
  const split2 = parseEhr(split1.body);
  const followups = vis.followups.length ? vis.followups : split1.followups;
  const ehr = procedure ? (mapEhr(vis.ehr).length ? mapEhr(vis.ehr) : split2.ehr) : [];
  // 끝에 붙는 "근거" 목록·"근거: [1]" 줄은 화면의 출처 목록과 중복되므로 제거
  out.text = split2.body
    .trim()
    .replace(/(\n\s*)+(\*\*)?근거(\*\*)?\s*[:：]\s*(\[\d+\]\s*,?\s*)+$/, '')
    .replace(/\n\s*(#{1,4}\s*|\*\*)?근거(\*\*)?\s*:?\s*\n((\s*[-*]\s+.*\n?){1,8})\s*$/, '')
    .trim();
  // "[2-①]", "[1, 3]" 같은 변형 인용을 "[2]", "[1][3]" 으로 정리 (출처 표시가 빠지지 않게)
  out.text = out.text
    .replace(/\[(\d{1,2})\s*-\s*[^\]]{1,8}\]/g, '[$1]')
    .replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})+)\]/g, (m, list) => list.split(',').map((n) => `[${n.trim()}]`).join(''));
  if (caseText) out.text += '\n\n' + caseText;

  // 대화 이력에는 근거 블록 없이 질문/답변만 보관
  if (!anonymous) {
    history.push({ role: 'user', content: question }, { role: 'assistant', content: out.text });
    sessions.set(sessionId, history.slice(-12));
  }

  // 답변에 실제로 인용된 번호만 출처로 표시 (인용이 없으면 상위 근거 전체)
  const cited = new Set([...out.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  const sources = [...evidence, ...caseEvidence]
    .map((e) =>
      e.chunk
        ? {
            n: e.n,
            kind: '사규',
            cited: cited.has(e.n),
            doc: e.chunk.docLabel,
            revised: e.chunk.revised,
            type: e.chunk.type,
            label: e.chunk.label,
            path: e.chunk.header.replace(/^\[|\]$/g, ''),
            score: Math.round(e.chunk.score * 1000) / 1000,
            text: e.chunk.text,
          }
        : {
            n: e.n,
            kind: e.kind,
            cited: cited.has(e.n),
            doc: e.kind === '법령' ? e.law.law : e.kind,
            revised: e.law.date,
            type: e.kind,
            label: e.kind === '법령' ? e.law.title.replace(e.law.law + ' ', '') : e.law.title,
            path: `국가법령정보센터 · ${e.kind}`,
            url: e.law.url || '',
            score: Math.round(e.law.score * 1000) / 1000,
            text: e.law.text,
          }
    )
    // 인용된 근거만 표시. 단, 답변이 사규 번호를 하나도 인용하지 않았으면(모델 편차) 가장 관련도 높은 사규 조문 2개는 남김
    .filter((s, i, all) => {
      if (!cited.size || s.cited) return true;
      const regCited = all.some((x) => x.kind === '사규' && x.cited);
      return !regCited && s.kind === '사규' && all.filter((x) => x.kind === '사규').indexOf(s) < 2;
    });

  const result = {
    answer: out.text,
    sources,
    ehr,
    visuals,
    visualsDropped: Math.max(0, vis.raw.length - visuals.length),
    followups,
    personal,
    anonymous,
    elapsed: (Date.now() - t0) / 1000,
    timing: { ...r.timing, law: lawRes.timing, ...prof },
    lawSources: [...lawRes.items, ...caseRes.items].map((x) => x.kind),
    model: out.model,
  };
  if (cacheKey && out.text) cachePut(cacheKey, result);
  return result;
}

// ── 답변 캐시: 대화 첫 질문(이전 대화 없음)만, 역할+질문 기준, 30분 유지, 최대 200개
const CACHE_TTL = Number(process.env.ANSWER_CACHE_MINUTES || 30) * 60 * 1000;
const answerCache = new Map();
const normQ = (q) => q.replace(/\s+/g, ' ').replace(/[?？!.~]+$/g, '').trim().toLowerCase();
function cacheGet(key) {
  const hit = answerCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) return answerCache.delete(key), null;
  return hit.value;
}
function cachePut(key, value) {
  if (answerCache.size >= 200) answerCache.delete(answerCache.keys().next().value);
  answerCache.set(key, { at: Date.now(), value });
}

function reset(sessionId) {
  sessions.delete(sessionId);
}

module.exports = { answer, reset, PERSONAL };
