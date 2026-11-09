#!/usr/bin/env node
/**
 * 규정 문서 색인: docs/regulations/*.hwp|hwpx → 파싱 → 청킹 → BGE-M3 임베딩 + BM25 희소 벡터 → Qdrant
 *   npm run ingest
 * 결과 청크는 data/rag-chunks.json, 문서 목록은 data/rag-docs.json 에도 저장 (검수용)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { parseFile } = require('./parse');
const { chunkDocument } = require('./chunk');
const { embed, EMBED_MODEL } = require('./models');
const sparse = require('./sparse');
const qdrant = require('./qdrant');

const ROOT = path.join(__dirname, '..');
const DOCS_DIR = path.resolve(ROOT, process.env.RAG_DOCS_DIR || 'docs/regulations');
const DATA_DIR = path.join(ROOT, 'data');

(async () => {
  const files = fs.readdirSync(DOCS_DIR).filter((f) => /\.hwpx?$/i.test(f));
  if (!files.length) throw new Error(`${DOCS_DIR} 에 HWP/HWPX 문서가 없습니다.`);

  const all = [];
  const docs = [];
  for (const f of files) {
    const blocks = await parseFile(path.join(DOCS_DIR, f));
    const { meta, chunks } = chunkDocument(blocks, f);
    if (!chunks.some((c) => c.type === '본문')) console.warn(`  ⚠ ${f}: 조문을 찾지 못했습니다. (텍스트 추출 실패 또는 OCR 필요 문서인지 확인)`);
    docs.push({ ...meta, chunks: chunks.length, articles: new Set(chunks.filter((c) => c.type === '본문').map((c) => c.articleNo)).size });
    all.push(...chunks);
    console.log(`  ${meta.docLabel.padEnd(14)} ${meta.revised}  청크 ${chunks.length}`);
  }
  all.forEach((c, i) => (c.id = i + 1));

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'rag-chunks.json'), JSON.stringify(all, null, 1));
  fs.writeFileSync(path.join(DATA_DIR, 'rag-docs.json'), JSON.stringify({ indexedAt: new Date().toISOString(), embedModel: EMBED_MODEL, docs }, null, 2));

  console.log(`\n  임베딩 ${all.length}개 (${EMBED_MODEL}, CPU) …`);
  const t0 = Date.now();
  const vectors = await embed(all.map((c) => c.content), {
    onProgress: (n, total) => process.stdout.write(`\r  ${n}/${total}`),
  });
  console.log(`\n  완료 ${((Date.now() - t0) / 1000).toFixed(0)}초`);

  const avgLen = all.reduce((s, c) => s + sparse.tokenize(c.content).length, 0) / all.length;
  await qdrant.ensureRunning();
  await qdrant.recreateCollection(vectors[0].length);
  await qdrant.upsert(
    all.map((c, i) => {
      const { content, ...payload } = c;
      return { id: c.id, vector: { dense: vectors[i], sparse: sparse.docVector(content, avgLen) }, payload: { ...payload, content } };
    })
  );
  console.log(`  Qdrant 컬렉션 "${qdrant.COLLECTION}" 저장 완료: ${(await qdrant.info()).points}개\n`);
  process.exit(0);
})().catch((e) => {
  console.error('\n색인 실패:', e.message);
  process.exit(1);
});
