// api/avatar.js
// Runtime: Vercel Node.js (Serverless Function)
module.exports.config = { runtime: 'nodejs' };

const https = require('https');
const crypto = require('crypto');

// ---------- helpers ----------
function normHandle(h) {
  return String(h || '')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9_.-]/g, '')
    .trim()
    .slice(0, 32);
}

function timeoutFetch(url, ms = 7000, init = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  const agent = new https.Agent({ keepAlive: true });

  return fetch(url, {
    redirect: 'follow',
    signal: ctrl.signal,
    headers: {
      'User-Agent': 'sentient-race-avatar/1.0',
      Accept: 'image/*,*/*',
      ...(init.headers || {})
    },
    agent,
    ...init
  }).finally(() => clearTimeout(id));
}

// pbs.twimg.com boyut seçimi: mini, normal, bigger, 400x400, original
function applySize(url, size = '400x400') {
  if (!url) return url;

  // 1) Sonek kullanan biçimler: ..._normal.jpg / ..._400x400.png
  const m = url.match(/^(https?:\/\/[^?]+?)(?:_(normal|bigger|mini|400x400))?(\.[a-z0-9]+)$/i);
  if (m) {
    const base = m[1] + m[3]; // soneksiz
    if (size === 'original') return base;
    return base.replace(/(\.[a-z0-9]+)$/i, `_${size}$1`);
  }

  // 2) Query-param kullanan biçimler: ?format=jpg&name=small/orig/400x400
  try {
    const u = new URL(url);
    const hasName = u.searchParams.has('name');
    if (hasName) {
      const map = { mini: 'mini', normal: 'normal', bigger: 'bigger', '400x400': '400x400', original: 'orig' };
      u.searchParams.set('name', map[size] || '400x400');
      return u.toString();
    }
  } catch (_) {
    // noop
  }

  // 3) Bilinmiyorsa olduğu gibi bırak
  return url;
}

function makeInitialsSvg(seed) {
  const initials = (seed || 'SR').slice(0, 2).toUpperCase();
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#2a3a5c"/><stop offset="100%" stop-color="#162235"/>
      </linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      <text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle"
        font-family="Montserrat,Arial,sans-serif" font-size="64" fill="#eaf2ff" font-weight="700">
        ${initials}
      </text>
    </svg>`
  );
}

function okImageResponse(buf, type = 'image/jpeg', cacheSeconds = 86400) {
  const etag = `"${crypto.createHash('sha1').update(buf).digest('hex')}"`;
  return { buf, type, etag, cacheSeconds };
}

// ---------- sources ----------

// 0) Snaplytics CDN JSON → pbs url (bulduğun kaynak)
async function getViaSnapCdn(handle, size = '400x400') {
  try {
    const api = `https://twittermedia.b-cdn.net/profile-pic/?username=${encodeURIComponent(handle)}`;
    const r = await timeoutFetch(api, 7000, {
      headers: { Referer: 'https://snaplytics.io', Accept: 'application/json' }
    });
    if (!r.ok) return null;

    const j = await r.json();
    let url = j?.profile_image_url;
    if (!url) return null;

    url = applySize(url, size);

    const img = await timeoutFetch(url, 7000);
    if (!img.ok) return null;

    const ab = await img.arrayBuffer();
    return okImageResponse(Buffer.from(ab), img.headers.get('content-type') || 'image/jpeg', 21600); // 6 saat
  } catch {
    return null;
  }
}

// 1) Resmî X API (Bearer gerekli)
async function getViaXApi(handle, size = '400x400') {
  const token = process.env.X_BEARER || process.env.TWITTER_BEARER_TOKEN;
  if (!token) return null;

  try {
    const u = `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=profile_image_url`;
    const r = await timeoutFetch(u, 7000, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;

    const data = await r.json();
    let url = data?.data?.profile_image_url;
    if (!url) return null;

    url = applySize(url, size);

    const img = await timeoutFetch(url, 7000);
    if (!img.ok) return null;

    const ab = await img.arrayBuffer();
    return okImageResponse(Buffer.from(ab), img.headers.get('content-type') || 'image/jpeg', 43200);
  } catch {
    return null;
  }
}

// 2) x.com redirect (profile_image)
async function getViaRedirect(handle) {
  try {
    const u = `https://x.com/${encodeURIComponent(handle)}/profile_image?size=original`;
    const r = await timeoutFetch(u, 7000);
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    return okImageResponse(Buffer.from(ab), r.headers.get('content-type') || 'image/jpeg', 3600);
  } catch {
    return null;
  }
}

// 3) Public aggregators (fallback)
async function getViaPublicAggregators(handle) {
  const candidates = [
    `https://unavatar.io/x/${encodeURIComponent(handle)}`,
    `https://unavatar.io/twitter/${encodeURIComponent(handle)}`,
    `https://avatar.vercel.sh/${encodeURIComponent(handle)}`,
    `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(handle)}&fontWeight=700`
  ];
  for (const c of candidates) {
    try {
      const r = await timeoutFetch(c, 7000);
      if (!r.ok) continue;
      const ct = r.headers.get('content-type') || '';
      if (!/^(image\/|application\/svg)/i.test(ct)) continue;
      const ab = await r.arrayBuffer();
      return okImageResponse(Buffer.from(ab), ct, 3600);
    } catch {
      // try next
    }
  }
  return null;
}

// ---------- handler ----------
module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const handle = normHandle(url.searchParams.get('handle') || '');
    const size = (url.searchParams.get('size') || '400x400').toLowerCase();

    // No handle → initials SVG
    if (!handle) {
      const svg = makeInitialsSvg('SR');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.end(svg);
    }

    // Resolution order:
    // 1) Snap CDN JSON (senin bulduğun)
    // 2) Resmî X API (varsa)
    // 3) x.com redirect
    // 4) Aggregators
    let out =
      (await getViaSnapCdn(handle, size)) ||
      (await getViaXApi(handle, size)) ||
      (await getViaRedirect(handle)) ||
      (await getViaPublicAggregators(handle));

    if (!out) {
      const svg = makeInitialsSvg(handle);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=604800');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.end(svg);
    }

    // ETag support
    if (req.headers['if-none-match'] === out.etag) {
      res.statusCode = 304;
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.end();
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', out.type);
    res.setHeader('ETag', out.etag);
    res.setHeader('Cache-Control', `public, s-maxage=${out.cacheSeconds}, stale-while-revalidate=604800`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(out.buf);
  } catch {
    const svg = makeInitialsSvg('SR');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=604800');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(svg);
  }
};
