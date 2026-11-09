# 인사해삐 (HR Happy AI) 웹

Stitch 화면을 실제 동작하는 웹으로 옮긴 프로젝트입니다. 한국무역보험공사 인사 제규정을 근거로 답하는 **RAG 챗봇**과 국가법령정보센터 API 기반 **법령-사규 정합성 분석**을 제공합니다. (Copilot Studio 에이전트 연동은 제거되었습니다.)

## 실행

```bash
npm install
cp .env.example .env     # OPENROUTER_API_KEY, LAW_OC 채우기
npm run ingest           # 규정 문서 색인 (처음 한 번, 문서가 바뀔 때마다)
npm start                # http://localhost:3000
```

- 처음 실행 시 BGE-M3·리랭커 ONNX 모델(각 약 570MB)을 Hugging Face에서 `models/`로 내려받습니다.
- Qdrant는 `bin/qdrant/qdrant.exe`(v1.19.2, Windows)를 서버가 자동으로 띄웁니다. 데이터는 `qdrant_storage/`.
- Python·Docker·GPU 없이 Node만으로 CPU에서 동작합니다.

## .env 설정

| 키 | 내용 |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API 키 (OpenAI 호환 API) |
| `LLM_MODEL` | 답변 생성 모델. 기본 `openai/gpt-4.1-mini` |
| `RAG_DOCS_DIR` | 규정 문서 폴더(.hwp/.hwpx). 기본 `docs/regulations` |
| `RAG_CANDIDATES` / `RAG_TOP_K` / `RAG_MIN_SCORE` / `RAG_RERANK` | 1차 검색 후보 수(20) / LLM에 넘길 청크 수(5) / 리랭커 점수 하한(0.05) / 리랭커 사용(on) |
| `LAW_OC` | 법령정보센터 API 인증키(OC). **등록한 IP의 PC에서 서버를 실행**해야 합니다. |

`.env`는 절대 공유 저장소에 올리지 마세요.

## RAG 구성

```
docs/regulations/*.hwp|hwpx
  → rag/parse.js   HWP 바이너리·HWPX 직접 파싱 (표 구조 복원, HWPX 변경 추적은 '수락' 상태로 반영)
  → rag/chunk.js   조문 단위 구조 청킹
  → rag/ingest.js  BGE-M3 dense(1024) + BM25 sparse → Qdrant 컬렉션 hr_regulations
질문
  → rag/retrieve.js 메타데이터 필터 → 하이브리드 검색(RRF) 후보 20 → bge-reranker-v2-m3 → 상위 5
  → rag/answer.js   근거 번호 인용 답변 (OpenRouter) + 출처 목록
```

| 항목 | 적용 내용 |
|---|---|
| 문서 전처리 | HWP/HWPX 텍스트·표 추출, 개정 이력·삭제 조문 제외, "제 1 조" 표기 정규화, HWPX 변경 추적(삭제 58건/삽입 208건) 수락 처리 |
| 청킹 | 1조 = 1청크. 1,000자 초과 시 ①②항 → 호 → 문장 경계로 약 800자 이하 분할. 모든 청크 앞에 `[규정명 > 장 > 절 > 제N조(제목)]` 머리글(오버랩 역할) |
| 문서 유형별 | 본문 / 별표(마크다운 표, 1,500자 초과 시 머리행 반복 분할) / 부칙 / 별지(서식) 분리 |
| 임베딩 | BGE-M3 (ONNX int8, CLS 풀링, 정규화) |
| 하이브리드 | Qdrant dense + sparse(BM25, 단어+한글 2-gram, IDF는 Qdrant 계산) → RRF |
| 리랭커 | bge-reranker-v2-m3 (ONNX int8) |
| 메타데이터 필터 | 질문에 규정명이 있으면 해당 규정(+시행요강)으로 제한. 부칙은 시행일·경과조치 질문에만, 별지는 서식 질문에만 검색 |
| 국가법령정보센터 근거 | 직원용: **법령** / 인사담당자용: **법령·판례·행정규칙·고용노동부 행정해석·노동위원회 결정례** (`rag/lawsources.js`, 키 LAW_OC). 법령은 주요 노동 법령 16개(1,247개 조문)를 조문 단위로 색인(`npm run ingest:laws`, 컬렉션 labor_laws, 서버 시작 시 없으면 자동 생성). 판례 등은 질문마다 키워드 추출 → 실시간 검색·상세 조회 → 리랭커로 관련도 판정 후 유형별 최대 2건 |
| 출처 | 답변의 [1] 배지 → 규정명·조문·개정일·원문 펼쳐보기 |
| RAG / DB 구분 | "내 잔여 연차" 같은 개인별 수치는 규정으로 답하지 않고 eHR 조회 메뉴 안내 |
| eHR 경로 안내 | 신청·조회·출력 방법을 물으면 `rag/ehr-menu.json`(**해커톤 시연용** 메뉴 카탈로그, 사내 eHR 개인용 메뉴 캡처 기반)에서 경로를 골라 단계별 안내 + "eHR에서 바로 처리하기" 카드 표시. 실제 경로로 바꿀 땐 이 파일만 수정 |
| 답변 시각화 | 본 답변과 병렬로 JSON 모드 호출(`rag/visuals.js`) → 핵심 수치 카드·절차 흐름·기간 타임라인·그래프(Chart.js 4.5.1, 로컬 제공). 근거 원문에 없는 숫자는 계산식(formula) 없이는 버림, 시작·끝 기준일이 다른 타임라인도 버림 |
| 후속 질문 | 같은 보조 호출에서 이어서 물어볼 질문 0~3개 생성 → 추천 키워드 자리에 표시 |
| 답변 평가 | 답변마다 별점(1~5) + 항목 태그 + 개선 의견 → `data/feedback.json` (`GET /api/feedback`로 조회) |
| 익명 질문 | 입력 중 민감 질문 감지(키워드 + BGE-M3 의미 유사도, `rag/sensitive.js`) → 입력창 위에 "익명으로 질문하기" 자동 표시. 익명이면 이름 없이 답변, 이전 대화와 미연결, 대화 이력·의견 미저장(평가는 점수·태그만) |
| 평가 | `eval/qa.json` (38문항) — `npm run eval -- retrieval`, `npm run eval -- answer` |

문서 수: 7건 / 청크 688개 (본문 346, 별표 23, 부칙 299, 별지 20).

## 화면

| 경로 | 화면 | 대상 |
|---|---|---|
| `/` | 로그인 (직원용 / 인사담당자용 선택) | 공통 |
| `/mypage.html` | 마이페이지 (개인정보 수집·이용 동의) | 공통 |
| `/chat.html` | 인사해삐 / 인사해삐M RAG 챗봇 (역할에 따라 답변 톤만 다름) | 공통 |
| `/faq.html` | FAQ 조회 (게시된 항목만) | 직원 |
| `/faq-admin.html` | FAQ 관리 (AI 초안 → 대기 → 게시/반려), 인기 검색어 | 담당자 |
| `/risk.html` | 고위험 질문 비식별 통계, 리스크 브리프, 알림 관리 | 담당자 |
| `/compliance.html` | 법령 조회 → 정합성 분석 실행 → 리포트 히스토리·조치 상태 | 담당자 |

## 정합성 분석 흐름

1. 컴플라이언스 화면에서 법령 조회 → `분석 실행`
2. 서버가 법령 상세(공포일·시행일·제개정이유·개정문·부칙)를 받음
3. 제개정이유·개정문으로 관련 사규 조문을 RAG 검색(상위 8개)
4. LLM이 조문별로 위반/미반영/보완권고/정합 판정 → 리포트 + 요약 JSON → `data/reports.json`

Teams 알림은 에이전트 제거와 함께 없어졌습니다.

## 데이터

- `seed/` 초기 샘플(화면에 "샘플" 표시) → 첫 실행 시 `data/`로 복사
- `data/rag-chunks.json`, `data/rag-docs.json`: 색인된 청크·문서 목록 (검수용)
- 질문 통계는 **질문 원문·사용자 정보 없이 주제별 건수만** 저장. 대화 이력은 서버 메모리에만 최근 6턴 보관
- 초기화하려면 `data/` 폴더 삭제 후 `npm run ingest`

## 이미지

- `public/img/mascot.svg`, `mascot-m.svg`: 새로 그린 토끼 마스코트 (Stitch 이미지 대체)
- `public/img/wave.svg`: 배경 웨이브
- 회사 공식 로고는 `public/img/logo.png`로 넣으면 자동으로 표시됩니다 (없으면 "KT IS" 텍스트).

## 응답 속도

`node rag/bench.js <라벨>` (스트리밍 측정은 `BENCH_STREAM=1`) → `eval/bench-*.json`

| 단계 | 직원용 첫 글자 / 전체 | 인사담당자용 첫 글자 / 전체 |
|---|---|---|
| 0. 기준 (스트리밍 없음) | 10.0s / 10.0s | 16.2s / 16.2s |
| 1. 질문 임베딩 1회 공유 + 사규 리랭크 후보 20→12 | 8.0s | 13.5s |
| 2. 판례 검색어 추출 LLM → 규칙 사전 (없을 때만 LLM) | 8.0s | 12.5s |
| 3. 답변 스트리밍 (SSE `/api/chat/stream`) | 5.4s / 7.4s | 7.0s / 11.8s |
| 4. 법령 조문 리랭커 → 유사도 + 스레드 10 | 3.7s / 7.7s | 6.8s / 13.7s |
| 5. 판례·해석 섹션을 본 답변과 분리 | 3.7s / 6.2s | 4.0s / 11.7s |
| 6. 판례 섹션을 판례 조회 직후 병렬 작성 | **3.7s / 6.4s** | **3.9s / 9.0s** |
| 7. 같은 첫 질문은 30분 캐시 | 즉시 | 즉시 |

전체 시간은 OpenRouter LLM 응답 편차(같은 길이에도 2.5~7.5초)가 큽니다. 리랭커 입력 길이 축소(512→320)는 정확도가 떨어져(Hit@1 91.7%→88.9%) 적용하지 않았습니다.
