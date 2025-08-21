
// api/avatar.js
// Same-origin avatar proxy: tries external sources for X handle, returns image with good CORS & cache.

module.exports.config = { runtime: 'nodejs' };

const { AbortController } = require('abort-controller'); // Vercel Node 18'de global fetch var; AbortController yoksa bu paketi eklemen gerekmezse çıkar.
const https = require('https');

// küçük yardımcılar
function normHandle(h) {
  return String(h || '')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9_.-]/g, '')
    .trim()
    .slice(0, 32); // 32 char (ilk karakteri kesme!)
}

function timeoutFetch(url, ms = 5000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, {
    redirect: 'follow',
    signal: ctrl.signal,
    // bazı CDN'ler referer'e takılmasın
    headers: { 'User-Agent': 'sentient-race-avatar/1.0', 'Accept': 'image/*' },
    // vercel fetch keep-alive default iyi; Node agent eklemek istersen:
    agent: new https.Agent({ keepAlive: true })
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

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const raw = url.searchParams.get('handle') || '';
    const handle = normHandle(raw);

    // hiç handle yoksa direkt SVG initials
    if (!handle) {
      const svg = makeInitialsSvg('SR');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(svg);
      return;
    }

    // 1) Unavatar (X/Twitter) – gerçek X avatarı için en iyi şans.
    // Not: Unavatar genel aggregator’dır. X tarafı bazen sınırlı olabilir ama çoğunlukla çalışır. :contentReference[oaicite:1]{index=1}
    const candidates = [
      `https://unavatar.io/x/${encodeURIComponent(handle)}`,
      `https://unavatar.io/twitter/${encodeURIComponent(handle)}`,
      `https://unavatar.io/https://x.com/${encodeURIComponent(handle)}`,
      // 2) Placeholder (gerçek X yerine gradient) – servis ayakta ve hızlı. :contentReference[oaicite:2]{index=2}
      `https://avatar.vercel.sh/${encodeURIComponent(handle)}`,
      // 3) DiceBear SVG (placeholder) – son çare. :contentReference[oaicite:3]{index=3}
      `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(handle)}&fontWeight=700`
    ];

    for (const c of candidates) {
      try {
        const up = await timeoutFetch(c, 6000);
        if (!up.ok) continue;

        const ct = up.headers.get('content-type') || '';
        // image veya svg ise kabul
        if (!/^(image\/|application\/svg)/i.test(ct)) continue;

        const ab = await up.arrayBuffer();
        const buf = Buffer.from(ab);
        res.statusCode = 200;
        res.setHeader('Content-Type', ct.includes('svg') ? 'image/svg+xml' : ct);
        res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(buf);
        return;
      } catch (_) {
        // sıradaki kaynağı dene
      }
    }

    // hepsi düşerse initials svg
    const svg = makeInitialsSvg(handle);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=604800');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(svg);
  } catch (e) {
    // en kötü durumda yine svg ver
    const svg = makeInitialsSvg('SR');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=604800');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(svg);
  }
};
