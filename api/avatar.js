// api/avatar.js
module.exports.config = { runtime: 'nodejs' };

const https = require('https');
const crypto = require('crypto');

function normHandle(h) {
  return String(h || '')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9_.-]/g, '')
    .trim()
    .slice(0, 32);
}

function timeoutFetch(url, ms = 6000, init = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, {
    redirect: 'follow',
    signal: ctrl.signal,
    headers: { 'User-Agent': 'sentient-race-avatar/1.0', 'Accept': 'image/*,*/*' , ...(init.headers||{})},
    agent: new https.Agent({ keepAlive: true }),
    ...init
  }).finally(() => clearTimeout(id));
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

async function getViaXApi(handle) {
  const token = process.env.X_BEARER || process.env.TWITTER_BEARER_TOKEN;
  if (!token) return null;

  const u = `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=profile_image_url`;
  const r = await timeoutFetch(u, 7000, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;

  const data = await r.json();
  let url = data?.data?.profile_image_url;
  if (!url) return null;

  // "normal" → "400x400" (veya original). 400x400 genelde ideal.
  url = url.replace('_normal.', '_400x400.');
  const img = await timeoutFetch(url, 7000);
  if (!img.ok) return null;

  const ab = await img.arrayBuffer();
  return okImageResponse(Buffer.from(ab), img.headers.get('content-type') || 'image/jpeg');
}

async function getViaRedirect(handle) {
  const u = `https://x.com/${encodeURIComponent(handle)}/profile_image?size=original`;
  const r = await timeoutFetch(u, 7000);
  if (!r.ok) return null;
  const ab = await r.arrayBuffer();
  return okImageResponse(Buffer.from(ab), r.headers.get('content-type') || 'image/jpeg', 3600);
}

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
    } catch (_) {}
  }
  return null;
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const handle = normHandle(url.searchParams.get('handle') || '');

    // No handle → initials SVG
    if (!handle) {
      const svg = makeInitialsSvg('SR');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.end(svg);
    }

    let out =
      (await getViaXApi(handle)) ||
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

    // ETag/If-None-Match
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
  } catch (e) {
    const svg = makeInitialsSvg('SR');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=604800');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(svg);
  }
};
