const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* Yahoo's options-chain endpoint (v7/finance/options) — unlike the plain
   chart/price endpoint — rejects most server-side requests unless they carry
   a valid session cookie + "crumb" token. Without this, it silently returns
   an empty/error body, which is why contract suggestions were never
   showing up even though the price data worked fine. This cookie+crumb
   pair is cached in module scope so a warm serverless instance reuses it
   instead of re-negotiating on every request. */
let cached = { cookie: null, crumb: null, ts: 0 };
const CRUMB_TTL_MS = 25 * 60 * 1000; // refresh well before Yahoo's own session expiry

async function getCookieAndCrumb() {
  const now = Date.now();
  if (cached.cookie && cached.crumb && (now - cached.ts) < CRUMB_TTL_MS) return cached;

  // Step 1: hit a Yahoo domain that hands out a session cookie.
  const cookieRes = await fetch('https://fc.yahoo.com', {
    headers: { 'User-Agent': UA },
    redirect: 'manual',
  });
  const setCookieHeader = cookieRes.headers.get('set-cookie') || cookieRes.headers.raw?.()['set-cookie']?.join('; ');
  if (!setCookieHeader) throw new Error('no set-cookie from fc.yahoo.com');
  const cookie = setCookieHeader.split(';')[0];

  // Step 2: use that cookie to fetch a crumb token.
  const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': cookie },
  });
  if (!crumbRes.ok) throw new Error(`getcrumb failed: HTTP ${crumbRes.status}`);
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.includes('<')) throw new Error('crumb response looked invalid');

  cached = { cookie, crumb, ts: now };
  return cached;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol = 'AAPL', date } = req.query;
  const sym = symbol.toUpperCase();
  const attempts = [];

  // Attempt 1: plain unauthenticated request — cheap, occasionally still
  // works depending on Yahoo's mood, so try it first before paying the
  // cost of the cookie/crumb dance.
  try {
    const qs = date ? `?date=${date}` : '';
    const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/options/${sym}${qs}`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' },
    });
    const bodyText = await r.text();
    if (r.ok) {
      const d = JSON.parse(bodyText);
      if (d?.optionChain?.result?.[0] && !d.optionChain.error) {
        res.setHeader('Cache-Control', 's-maxage=45,stale-while-revalidate=90');
        return res.status(200).json(d);
      }
      attempts.push(`plain: HTTP ${r.status} but empty/error result`);
    } else {
      attempts.push(`plain: HTTP ${r.status}`);
    }
  } catch (e) {
    attempts.push(`plain: ${e.message}`);
  }

  // Attempt 2: cookie + crumb authenticated request.
  try {
    const { cookie, crumb } = await getCookieAndCrumb();
    const params = new URLSearchParams({ crumb });
    if (date) params.set('date', date);
    const r = await fetch(`https://query2.finance.yahoo.com/v7/finance/options/${sym}?${params.toString()}`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Cookie': cookie, 'Referer': 'https://finance.yahoo.com/' },
    });
    const bodyText = await r.text();
    if (r.ok) {
      const d = JSON.parse(bodyText);
      if (d?.optionChain?.result?.[0] && !d.optionChain.error) {
        res.setHeader('Cache-Control', 's-maxage=45,stale-while-revalidate=90');
        return res.status(200).json(d);
      }
      attempts.push(`authed: HTTP ${r.status} but empty/error result`);
    } else {
      // crumb may have gone stale — drop the cache so the next request renegotiates
      cached = { cookie: null, crumb: null, ts: 0 };
      attempts.push(`authed: HTTP ${r.status}`);
    }
  } catch (e) {
    attempts.push(`authed: ${e.message}`);
  }

  /* Surface exactly what was tried and why it failed, instead of a bare
     503 — this is what let the "no contracts suggested" symptom go
     undiagnosed: the client only ever saw a generic empty result with no
     way to tell whether the symbol has no options, Yahoo rate-limited us,
     or the auth flow itself broke. */
  return res.status(502).json({ error: 'yahoo_options_unavailable', symbol: sym, attempts });
}
