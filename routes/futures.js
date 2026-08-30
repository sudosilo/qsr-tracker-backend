const express = require("express");
const { cacheAside } = require("../cache");

const router = express.Router();

// only commodities with a genuinely liquid, actively traded futures contract get a symbol here.
// chicken, eggs, potatoes, turkey, and cheese either never had a real futures market or the
// contract was delisted for lack of volume, mapping those anyway would just show noise dressed
// up as a real signal.
const FUTURES_SYMBOLS = {
  beef: "LE=F",
  pork: "HE=F",
  coffee: "KC=F",
  wheat: "ZW=F",
  dairy: "DC=F",
  sugar: "SB=F",
  rice: "ZR=F"
};

router.get("/", async (req, res) => {
  const keyword = (req.query.commodity || "").toLowerCase();
  const symbol = FUTURES_SYMBOLS[keyword];
  if (!symbol) {
    return res.status(400).json({
      error: "no liquid futures contract exists for this commodity",
      available: Object.keys(FUTURES_SYMBOLS)
    });
  }

  const cacheKey = "futures:" + keyword;
  try {
    const { data, source } = await cacheAside(cacheKey, 15 * 60, async () => {
      const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?interval=1d&range=5d";
      const r = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          "Referer": "https://finance.yahoo.com"
        }
      });
      if (!r.ok) throw new Error("Yahoo Finance returned " + r.status);
      const json = await r.json();
      const result = json.chart && json.chart.result && json.chart.result[0];
      if (!result || !result.meta) throw new Error("Yahoo Finance returned no usable chart data");
      const meta = result.meta;
      const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
      const closes = (quote && quote.close) || [];
      const timestamps = result.timestamp || [];
      const points = timestamps
        .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
        .filter((p) => typeof p.close === "number");
      return {
        symbol,
        price: meta.regularMarketPrice,
        previousClose: meta.chartPreviousClose || meta.previousClose || null,
        currency: meta.currency || "USD",
        exchangeName: meta.exchangeName || null,
        points
      };
    });
    res.json({ commodity: keyword, ...data, source, note: "delayed exchange quote, not real-time, personal use only" });
  } catch (e) {
    res.status(502).json({ error: "Yahoo Finance futures lookup failed", detail: e.message });
  }
});

module.exports = router;
