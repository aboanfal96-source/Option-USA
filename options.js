export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { symbol = 'AAPL', date } = req.query;
  const sym = symbol.toUpperCase();
  const h = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://finance.yahoo.com/',
  };
  const qs = date ? `?date=${date}` : '';
  for (const host of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`${host}/v7/finance/options/${sym}${qs}`, { headers: h });
      if (!r.ok) continue;
      const d = await r.json();
      if (!d?.optionChain?.result?.[0]) continue;
      /* Options chains move slower than the underlying's live price, but
         still shouldn't be cached long — expirations near-term especially
         can see bid/ask and volume shift materially within the trading day. */
      res.setHeader('Cache-Control', 's-maxage=45,stale-while-revalidate=90');
      return res.status(200).json(d);
    } catch (e) { continue; }
  }
  return res.status(503).json({ error: 'unavailable' });
}
