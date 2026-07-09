export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { symbol = 'AAPL', range = '3mo', interval = '1d' } = req.query;
  const sym = symbol.toUpperCase();
  const h = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://finance.yahoo.com/',
  };
  for (const host of ['https://query1.finance.yahoo.com','https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(
        `${host}/v8/finance/chart/${sym}?range=${range}&interval=${interval}&includePrePost=false`,
        { headers: h }
      );
      if (!r.ok) continue;
      const d = await r.json();
      if (!d?.chart?.result?.[0]) continue;
      /* Short cache window — this endpoint backs a near-live price scanner.
         The previous 15-minute cache (30-minute stale-while-revalidate) meant
         re-scanning inside that window silently returned old prices with no
         indication anything was stale; a full page reload was the only way
         to force a fresh fetch. 30s is enough to absorb duplicate requests
         from a fast scan burst without serving badly outdated prices. */
      res.setHeader('Cache-Control', 's-maxage=30,stale-while-revalidate=60');
      return res.status(200).json(d);
    } catch(e) { continue; }
  }
  return res.status(503).json({ error: 'unavailable' });
}
