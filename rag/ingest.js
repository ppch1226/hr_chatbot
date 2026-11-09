#!/usr/bin/env node
/**
 * 규정 문서 색인: docs/regulations/*.hwp|hwpx → 파싱 → 청킹 → BGE-M3 임베딩 + BM25 희소 벡터 → Qdrant
 *   npm run ingest            (CLI)
 *   require('./ingest').ingestAll()  (서버의 사규 개정 확인에서 사용)
 * - 결과 청크는 data/rag-chunks.json, 문서 목록은 data/rag-docs.json 에도 저장 (검수용)
 * - 임베딩은 본문 해시 기준으로 data/embed-cache.json 에 캐시 → 바뀐 문서의 청크만 새로 임베딩
 * - 같은 규정의 파일이 여러 개면(새 개정본 업로드) 개정일이 가장 최근인 것만 색인하고 나머지는 _archive/ 로 옮김
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseFile } = require('./parse');
const { chunkDocument, docMeta } = require('./chunk');
const { embed, EMBED_MODEL } = require('./models');
const sparse = require('./sparse');
const qdrant = require('./qdrant');

const ROOT = path.join(__dirname, '..');
const DOCS_DIR = path.resolve(ROOT, process.env.RAG_DOCS_DIR || 'docs/regulations');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'embed-cache.json');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const toB64 = (v) => Buffer.from(new Float32Array(v).buffer).toString('base64');
const fromB64 = (b) => Array.from(new Float32Array(Buffer.from(b, 'base64').buffer.slice(0)));

/** 규정 파일 목록 (같은 규정은 최신 개정본만). 오래된 개정본은 _archive 로 이동 */
function listDocFiles({ archive = true } = {}) {
  const files = fs.readdirSync(DOCS_DIR).filter((f) => /\.hwpx?$/i.test(f));
  const byDoc = new Map();
  for (const f of files) {
    const m = docMeta(f);
    const prev = byDoc.get(m.doc);
    if (!prev || m.revised > prev.meta.revised) byDoc.set(m.doc, { file: f, meta: m, older: prev ? [...prev.older, prev.file] : [] });
    else prev.older.push(f);
  }
  if (archive)
    for (const v of byDoc.values())
      for (const old of v.older) {
        const dir = path.join(DOCS_DIR, '_archive');
        fs.mkdirSync(dir, { recursive: true });
        fs.renameSync(path.join(DOCS_DIR, old), path.join(dir, old));
      }
  return [...byDoc.values()].map((v) => v.file);
}

async function ingestAll({ log = console.log } = {}) {
  const files = listDocFiles();
  if (!files.length) throw new Error(`${DOCS_DIR} 에 HWP/HWPX 문서가 없습니다.`);

  const all = [];
  const docs = [];
  for (const f of files) {
    const blocks = await parseFile(path.join(DOCS_DIR, f));
    const { meta, chunks } = chunkDocument(blocks, f);
    if (!chunks.some((c) => c.type === '본문')) log(`  ⚠ ${f}: 조문을 찾지 못했습니다. (텍스트 추출 실패 또는 OCR 필요 문서인지 확인)`);
    const hash = sha1(fs.readFileSync(path.join(DOCS_DIR, f)));
    docs.push({ ...meta, hash, chunks: chunks.length, articles: new Set(chunks.filter((c) => c.type === '본문').map((c) => c.articleNo)).size });
    all.push(...chunks);
    log(`  ${meta.docLabel.padEnd(14)} ${meta.revised}  청크 ${chunks.length}`);
  }
  all.forEach((c, i) => (c.id = i + 1));

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'rag-chunks.json'), JSON.stringify(all, null, 1));
  fs.writeFileSync(path.join(DATA_DIR, 'rag-docs.json'), JSON.stringify({ indexedAt: new Date().toISOString(), embedModel: EMBED_MODEL, docs }, null, 2));

  // 임베딩 캐시: 내용이 같은 청크는 다시 계산하지 않음
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (cache._model !== EMBED_MODEL) cache = {};
  } catch {}
  const keys = all.map((c) => sha1(c.content));
  const todo = all.map((c, i) => i).filter((i) => !cache[keys[i]]);
  log(`\n  임베딩 ${todo.length}개 새로 계산 (캐시 ${all.length - todo.length}개 재사용, ${EMBED_MODEL})`);
  const t0 = Date.now();
  if (todo.length) {
    const vecs = await embed(todo.map((i) => all[i].content), { onProgress: (n, total) => process.stdout.isTTY && process.stdout.write(`\r  ${n}/${total}`) });
    todo.forEach((i, k) => (cache[keys[i]] = toB64(vecs[k])));
  }
  const fresh = { _model: EMBED_MODEL };
  for (const k of keys) fresh[k] = cache[k]; // 지금 쓰는 청크만 남김
  fs.writeFileSync(CACHE_FILE, JSON.stringify(fresh));
  const vectors = keys.map((k) => fromB64(fresh[k]));
  log(`  임베딩 완료 ${((Date.now() - t0) / 1000).toFixed(0)}초`);

  const avgLen = all.reduce((s, c) => s + sparse.tokenize(c.content).length, 0) / all.length;
  await qdrant.ensureRunning();
  await qdrant.recreateCollection(vectors[0].length);
  await qdrant.upsert(
    all.map((c, i) => {
      const { content, ...payload } = c;
      return { id: c.id, vector: { dense: vectors[i], sparse: sparse.docVector(content, avgLen) }, payload: { ...payload, content } };
    })
  );
  log(`  Qdrant 컬렉션 "${qdrant.COLLECTION}" 저장 완료: ${(await qdrant.info()).points}개`);
  return { docs, chunks: all };
}

module.exports = { ingestAll, listDocFiles, DOCS_DIR };

if (require.main === module) {
  ingestAll()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('\n색인 실패:', e.message);
      process.exit(1);
    });
}
