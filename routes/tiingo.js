const express = require("express");
const { cacheAside } = require("../cache");

const router = express.Router();

router.get("/history", async (req, res) => {
  const symbol = (req.query.symbol || "").toLowerCase();
  const key = req.query.key || "";
  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  if (!key) return res.status(400).json({ error: "key is required, this relay forwards your own tiingo key, it does not hold one for you" });

  // don't cache by raw key, different people's keys shouldn't collide or leak into
  // each other's cached responses, cache by symbol only, key is just used to make the call
  const cacheKey = "tiingo:daily:" + symbol;
  try {
    const { data, source } = await cacheAside(cacheKey, 24 * 60 * 60, async () => {
      const start = new Date();
      start.setDate(start.getDate() - 400);
      const startDate = start.toISOString().slice(0, 10);
      const url = "https://api.tiingo.com/tiingo/daily/" + symbol + "/prices?token=" + key + "&startDate=" + startDate;
      const r = await fetch(url);
      if (!r.ok) throw new Error("Tiingo returned " + r.status);
      const json = await r.json();
      if (!Array.isArray(json)) throw new Error("Tiingo returned an unexpected shape, possibly an invalid key");
      return json.map((d) => ({ date: d.date.slice(0, 10), close: parseFloat(d.close) })).slice(-260);
    });
    res.json({ symbol, points: data, source });
  } catch (e) {
    res.status(502).json({ error: "Tiingo lookup failed", detail: e.message });
  }
});

module.exports = router;
