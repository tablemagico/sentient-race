// api/submit-score.js
// Node.js Serverless Function (Vercel) — Submit Score (WRITE)
// Varsayılan namespace: "sentient-race" (ENV ile override edilebilir: LAMUMU_NS)

module.exports.config = { runtime: 'nodejs' };

const Redis = require('ioredis');

let client;
function getRedis() {
  if (client) return client;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not set');

  const opts = {};
  try {
    const u = new URL(url);
    if (u.protocol === 'rediss:') opts.tls = {};
  } catch (_) {}
  client = new Redis(url, opts);
  return client;
}

function getNs() {
  const def = 'sentient-race';
  const envNs = (process.env.LAMUMU_NS || '').trim();
  return envNs || def;
}

// Skor sıralaması: önce yüksek score, eşitlikte daha hızlı (timeMs küçük) üste
const composite = (score, timeMs) =>
  (Math.floor(score) * 1_000_000_000) - Math.floor(timeMs);

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function normHandle(h) {
  return String(h || '')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9_.-]/g, '')
    .trim()
    .slice(0, 32);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  try {
    const body = await readJson(req);
    let { handle, score, timeMs } = body;

    const NS = getNs();
    const BOARD_KEY = `${NS}:board`;               // ZSET
    const DETAIL_KEY = (h) => `${NS}:detail:${h}`; // HASH

    handle = normHandle(handle);
    score = Number.isFinite(Number(score)) ? Math.max(0, Math.floor(Number(score))) : NaN;
    timeMs = Number.isFinite(Number(timeMs)) ? Math.max(0, Math.floor(Number(timeMs))) : NaN;

    if (!handle || Number.isNaN(score) || Number.isNaN(timeMs)) {
      res.statusCode = 400;
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({ error: 'Invalid payload' }));
      return;
    }

    // (Opsiyonel üst limitler)
    // timeMs = Math.min(timeMs, 3_600_000); // 1 saat
    // score  = Math.min(score, 1_000_000);

    const r = getRedis();

    const cur = await r.zscore(BOARD_KEY, handle);
    const curNum = cur == null ? null : Number(cur);
    const nextScore = composite(score, timeMs);

    let updated = false;
    if (curNum == null || nextScore > curNum) {
      const multi = r.multi();
      multi.zadd(BOARD_KEY, nextScore, handle);
      multi.hset(
        DETAIL_KEY(handle),
        'score', String(score),
        'timeMs', String(timeMs),
        'updatedAt', String(Date.now())
      );
      await multi.exec();
      updated = true;
    }

    res.statusCode = 200;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({ updated }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({ error: String(e) }));
  }
};
