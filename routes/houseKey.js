const express = require("express");
const { cacheAside } = require("../cache");

const router = express.Router();

// same interval/size mapping the client itself uses when calling twelve data directly with
// a personal key, kept identical so the house path behaves exactly the same to the rest of
// the app, just fetched and cached server side instead.
const API_RANGE_MAP = { "1D": { interval: "5min", size: 780 }, "1W": { interval: "1h", size: 320 }, DAILY: { interval: "1day", size: 260 } };

function requireHouseKey(res) {
  if (!process.env.TWELVE_DATA_HOUSE_KEY) {
    res.status(500).json({ error: "TWELVE_DATA_HOUSE_KEY is not configured on this server" });
    return false;
  }
  return true;
}

// the whole point of a single shared key is that redis caching does almost all of the work,
// many visitors asking about the same ticker inside the cache window share one real call
// upstream, the house key itself only ever supplies the very first request for a given
// symbol in each window, not one call per person.
router.get("/quote", async (req, res) => {
  if (!requireHouseKey(res)) return;
  const symbol = (req.query.symbol || "").toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol is required" });

  const cacheKey = "house:quote:" + symbol;
  try {
    const { data, source } = await cacheAside(cacheKey, 60, async () => {
      const url = "https://api.twelvedata.com/quote?symbol=" + symbol + "&apikey=" + process.env.TWELVE_DATA_HOUSE_KEY;
      const r = await fetch(url);
      const json = await r.json();
      if (json.status === "error" || json.code) throw new Error(json.message || "twelve data returned an error");
      return {
        price: parseFloat(json.close),
        change: parseFloat(json.change),
        percent: parseFloat(json.percent_change)
      };
    });
    res.json({ symbol, ...data, source });
  } catch (e) {
    res.status(502).json({ error: "house key quote failed", detail: e.message });
  }
});

router.get("/history", async (req, res) => {
  if (!requireHouseKey(res)) return;
  const symbol = (req.query.symbol || "").toUpperCase();
  const apiRange = req.query.range;
  const cfg = API_RANGE_MAP[apiRange];
  if (!symbol || !cfg) return res.status(400).json({ error: "symbol and a valid range (1D, 1W, or DAILY) are required" });

  const cacheKey = "house:history:" + symbol + ":" + apiRange;
  const ttlSeconds = apiRange === "DAILY" ? 6 * 60 * 60 : 5 * 60;
  try {
    const { data, source } = await cacheAside(cacheKey, ttlSeconds, async () => {
      const url = "https://api.twelvedata.com/time_series?symbol=" + symbol + "&interval=" + cfg.interval +
        "&outputsize=" + cfg.size + "&timezone=UTC&apikey=" + process.env.TWELVE_DATA_HOUSE_KEY;
      const r = await fetch(url);
      const json = await r.json();
      if (json.status === "error" || !json.values) throw new Error(json.message || "twelve data returned an error");
      return json.values.map((v) => ({ date: v.datetime, close: parseFloat(v.close) })).reverse();
    });
    res.json({ symbol, apiRange, points: data, source });
  } catch (e) {
    res.status(502).json({ error: "house key history failed", detail: e.message });
  }
});

module.exports = router;
