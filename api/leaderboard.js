// api/leaderboard.js
// Node.js Serverless Function (Vercel) — Leaderboard (READ)
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

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  try {
    const r = getRedis();
    const NS = getNs();
    const BOARD_KEY = `${NS}:board`;                 // ZSET (rank)
    const DETAIL_KEY = (h) => `${NS}:detail:${h}`;   // HASH (score, timeMs, updatedAt)

    // ?start=0&count=50&rankFor=handle
    const url = new URL(req.url, 'http://localhost');
    const start = Math.max(0, parseInt(url.searchParams.get('start') ?? '0', 10));
    const count = Math.max(1, Math.min(200, parseInt(url.searchParams.get('count') ?? '50', 10)));
    const rankForRaw = url.searchParams.get('rankFor');
    const rankFor = rankForRaw ? String(rankForRaw).toLowerCase().replace(/^@/, '').trim() : null;

    const totalPromise = r.zcard(BOARD_KEY);
    const handles = await r.zrevrange(BOARD_KEY, start, start + count - 1);
    const total = await totalPromise;

    let rank = null;
    if (rankFor) {
      const rv = await r.zrevrank(BOARD_KEY, rankFor);
      if (rv !== null && rv !== undefined) rank = rv + 1; // 1-based
    }

    let items = [];
    if (handles.length) {
      const pipe = r.pipeline();
      for (const h of handles) pipe.hmget(DETAIL_KEY(h), 'score', 'timeMs', 'updatedAt');
      const rows = await pipe.exec();
      items = handles.map((h, i) => {
        const arr = rows[i]?.[1] || [];
        return {
          handle: h,
          score: parseInt(arr?.[0] ?? '0', 10),
          timeMs: parseInt(arr?.[1] ?? '0', 10),
          updatedAt: parseInt(arr?.[2] ?? '0', 10),
        };
      });
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ items, start, count, total, rank }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: String(e) }));
  }
};
