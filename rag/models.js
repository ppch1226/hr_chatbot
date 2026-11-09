/**
 * 로컬 ONNX 모델 (CPU)
 * - 임베딩: BGE-M3 dense (1024차원, CLS 풀링 + L2 정규화)
 * - 리랭커: bge-reranker-v2-m3 (cross-encoder, 질문-청크 관련도 점수)
 * 처음 실행 시 Hugging Face에서 내려받아 models/ 에 캐시합니다.
 */
const path = require('path');

const EMBED_MODEL = process.env.EMBED_MODEL || 'Xenova/bge-m3';
const RERANK_MODEL = process.env.RERANK_MODEL || 'onnx-community/bge-reranker-v2-m3-ONNX';
const DTYPE = process.env.MODEL_DTYPE || 'q8'; // q8 = model_quantized.onnx (약 570MB)
const SESSION = { intraOpNumThreads: Number(process.env.MODEL_THREADS || 6), interOpNumThreads: 1 };

let tf = null;
async function lib() {
  if (!tf) {
    tf = await import('@huggingface/transformers');
    tf.env.cacheDir = path.join(__dirname, '..', 'models');
    tf.env.allowRemoteModels = true;
  }
  return tf;
}

let embedderP = null;
function embedder() {
  if (!embedderP) embedderP = lib().then((t) => t.pipeline('feature-extraction', EMBED_MODEL, { dtype: DTYPE, session_options: SESSION }));
  return embedderP;
}

/** 텍스트 배열 → 1024차원 벡터 배열 */
async function embed(texts, { batch = 8, onProgress } = {}) {
  const ex = await embedder();
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const t = await ex(texts.slice(i, i + batch), { pooling: 'cls', normalize: true });
    out.push(...t.tolist());
    onProgress && onProgress(Math.min(i + batch, texts.length), texts.length);
  }
  return out;
}

let rerankerP = null;
function reranker() {
  if (!rerankerP)
    rerankerP = lib().then(async (t) => ({
      tok: await t.AutoTokenizer.from_pretrained(RERANK_MODEL),
      model: await t.AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: DTYPE, session_options: SESSION }),
    }));
  return rerankerP;
}

/** 질문과 후보 문서들의 관련도 점수(0~1). 길이순으로 묶어 패딩 낭비를 줄임 */
async function rerank(query, docs, { batch = 5 } = {}) {
  const { tok, model } = await reranker();
  const maxLength = Number(process.env.RERANK_MAX_TOKENS || 512);
  const order = docs.map((d, i) => i).sort((a, b) => docs[a].length - docs[b].length);
  const scores = new Array(docs.length);
  for (let i = 0; i < order.length; i += batch) {
    const idx = order.slice(i, i + batch);
    const inputs = tok(new Array(idx.length).fill(query), { text_pair: idx.map((k) => docs[k]), padding: true, truncation: true, max_length: maxLength });
    const { logits } = await model(inputs);
    logits.tolist().forEach((v, j) => (scores[idx[j]] = 1 / (1 + Math.exp(-v[0]))));
  }
  return scores;
}

module.exports = { embed, rerank, EMBED_MODEL, RERANK_MODEL, warmup: () => Promise.all([embedder(), reranker()]) };
