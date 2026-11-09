/**
 * Qdrant REST 클라이언트 + 로컬 실행 관리
 * bin/qdrant/qdrant.exe 가 있고 서버가 꺼져 있으면 자동으로 띄웁니다 (저장소: qdrant_storage/).
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const URL_ = (process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/$/, '');
const COLLECTION = process.env.QDRANT_COLLECTION || 'hr_regulations';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function q(method, p, body) {
  const r = await fetch(URL_ + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Qdrant ${method} ${p} 실패 (${r.status}): ${JSON.stringify(j.status || j).slice(0, 300)}`);
  return j.result;
}

async function alive() {
  try {
    const r = await fetch(URL_ + '/healthz');
    return r.ok;
  } catch {
    return false;
  }
}

let child = null;
async function ensureRunning() {
  if (await alive()) return true;
  const exe = path.join(ROOT, 'bin', 'qdrant', process.platform === 'win32' ? 'qdrant.exe' : 'qdrant');
  if (!fs.existsSync(exe)) throw new Error('Qdrant가 실행 중이 아니고 bin/qdrant 실행 파일도 없습니다.');
  const storage = path.join(ROOT, 'qdrant_storage');
  fs.mkdirSync(storage, { recursive: true });
  child = spawn(exe, [], {
    cwd: path.dirname(exe),
    env: { ...process.env, QDRANT__STORAGE__STORAGE_PATH: storage, QDRANT__SERVICE__HOST: '127.0.0.1', QDRANT__TELEMETRY_DISABLED: 'true' },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('exit', () => (child = null));
  process.on('exit', () => child && child.kill());
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await alive()) return true;
  }
  throw new Error('Qdrant를 시작하지 못했습니다.');
}

async function recreateCollection(dim, collection = COLLECTION) {
  await q('DELETE', `/collections/${collection}`).catch(() => {});
  await q('PUT', `/collections/${collection}`, {
    vectors: { dense: { size: dim, distance: 'Cosine' } },
    sparse_vectors: { sparse: { modifier: 'idf' } },
  });
  for (const field of ['doc', 'parent', 'kind', 'type'])
    await q('PUT', `/collections/${collection}/index`, { field_name: field, field_schema: 'keyword' });
}

async function upsert(points, collection = COLLECTION) {
  for (let i = 0; i < points.length; i += 64)
    await q('PUT', `/collections/${collection}/points?wait=true`, { points: points.slice(i, i + 64) });
}

/** 하이브리드 검색: dense + sparse 를 각각 prefetch 후 RRF 융합 */
async function hybrid({ dense, sparse, filter, limit = 30, prefetch = 40, collection = COLLECTION }) {
  const res = await q('POST', `/collections/${collection}/points/query`, {
    prefetch: [
      { query: dense, using: 'dense', limit: prefetch, filter },
      { query: sparse, using: 'sparse', limit: prefetch, filter },
    ],
    query: { fusion: 'rrf' },
    limit,
    with_payload: true,
  });
  return res.points;
}

async function denseOnly({ dense, filter, limit = 30, collection = COLLECTION, scoreThreshold }) {
  return (await q('POST', `/collections/${collection}/points/query`, { query: dense, using: 'dense', filter, limit, with_payload: true, ...(scoreThreshold != null ? { score_threshold: scoreThreshold } : {}) })).points;
}
async function sparseOnly({ sparse, filter, limit = 30 }) {
  return (await q('POST', `/collections/${COLLECTION}/points/query`, { query: sparse, using: 'sparse', filter, limit, with_payload: true })).points;
}

async function info(collection = COLLECTION) {
  try {
    const r = await q('GET', `/collections/${collection}`);
    return { points: r.points_count, status: r.status };
  } catch {
    return null;
  }
}

module.exports = { ensureRunning, alive, recreateCollection, upsert, hybrid, denseOnly, sparseOnly, info, COLLECTION };
