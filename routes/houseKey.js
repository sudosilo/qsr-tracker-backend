const express = require("express");
const { cacheAside, peekCache, putCache } = require("../cache");

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

// batches many symbols into a single upstream call, since twelve data supports up to 120
// symbols per request. this is what actually fixes a 52-ticker cold start, one request
// instead of 52 spaced 7.6 seconds apart. cheap to serve from cache, individually, so a
// later request for a different mix of tickers can still reuse whichever ones are already
// fresh and only needs to batch-fetch the rest.
router.get("/quotes", async (req, res) => {
  if (!requireHouseKey(res)) return;
  const symbols = (req.query.symbols || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) return res.status(400).json({ error: "symbols is required, comma separated" });
  if (symbols.length > 120) return res.status(400).json({ error: "twelve data allows at most 120 symbols per batched request" });

  const results = {};
  const sources = {};
  const missing = [];

  for (const symbol of symbols) {
    const raw = await peekCache("house:quote:" + symbol);
    if (raw) {
      results[symbol] = raw;
      sources[symbol] = "cache";
    } else {
      missing.push(symbol);
    }
  }

  if (missing.length > 0) {
    try {
      const url = "https://api.twelvedata.com/quote?symbol=" + missing.join(",") + "&apikey=" + process.env.TWELVE_DATA_HOUSE_KEY;
      const r = await fetch(url);
      const json = await r.json();
      // a single symbol comes back as one flat object, more than one comes back keyed by symbol,
      // handle both shapes rather than assuming the multi-symbol form applies even when only
      // one symbol ended up actually needing a fetch this round.
      const bySymbol = missing.length === 1 && json.symbol ? { [missing[0]]: json } : json;
      for (const symbol of missing) {
        const entry = bySymbol[symbol];
        if (!entry || entry.status === "error" || entry.code) continue;
        const parsed = {
          price: parseFloat(entry.close),
          change: parseFloat(entry.change),
          percent: parseFloat(entry.percent_change)
        };
        results[symbol] = parsed;
        sources[symbol] = "live";
        await putCache("house:quote:" + symbol, parsed, 60);
      }
    } catch (e) {
      // whichever symbols we already had cached still get returned, only the missing
      // ones fail silently here, individually reported by their absence from results.
    }
  }

  res.json({ results, sources, requested: symbols.length, fromCache: symbols.length - missing.length });
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

// same batching idea as quotes, applied to history. opening one ticker's chart at a given
// range pre-warms every other tracked ticker at that same range in the same request, so by
// the time someone taps into a different one, its chart is already sitting in cache instead
// of starting from nothing.
router.get("/histories", async (req, res) => {
  if (!requireHouseKey(res)) return;
  const symbols = (req.query.symbols || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const apiRange = req.query.range;
  const cfg = API_RANGE_MAP[apiRange];
  if (symbols.length === 0 || !cfg) return res.status(400).json({ error: "symbols and a valid range (1D, 1W, or DAILY) are required" });
  if (symbols.length > 120) return res.status(400).json({ error: "twelve data allows at most 120 symbols per batched request" });

  const ttlSeconds = apiRange === "DAILY" ? 6 * 60 * 60 : 5 * 60;
  const results = {};
  const sources = {};
  const missing = [];

  for (const symbol of symbols) {
    const raw = await peekCache("house:history:" + symbol + ":" + apiRange);
    if (raw) {
      results[symbol] = raw;
      sources[symbol] = "cache";
    } else {
      missing.push(symbol);
    }
  }

  if (missing.length > 0) {
    try {
      const url = "https://api.twelvedata.com/time_series?symbol=" + missing.join(",") + "&interval=" + cfg.interval +
        "&outputsize=" + cfg.size + "&timezone=UTC&apikey=" + process.env.TWELVE_DATA_HOUSE_KEY;
      const r = await fetch(url);
      const json = await r.json();
      // a single symbol's time_series comes back flat with its own "values" array at the top
      // level, more than one comes back keyed by symbol, same shape split as the quotes batch.
      const bySymbol = missing.length === 1 && json.values ? { [missing[0]]: json } : json;
      for (const symbol of missing) {
        const entry = bySymbol[symbol];
        if (!entry || entry.status === "error" || !entry.values) continue;
        const points = entry.values.map((v) => ({ date: v.datetime, close: parseFloat(v.close) })).reverse();
        results[symbol] = points;
        sources[symbol] = "live";
        await putCache("house:history:" + symbol + ":" + apiRange, points, ttlSeconds);
      }
    } catch (e) {
      // symbols already served from cache above still return fine, only the missing
      // ones silently drop out of results here.
    }
  }

  res.json({ results, sources, apiRange, requested: symbols.length, fromCache: symbols.length - missing.length });
});

module.exports = router;
