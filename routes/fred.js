const express = require("express");
const { cacheAside } = require("../cache");

const router = express.Router();

function requireFredKey(res) {
  if (!process.env.FRED_API_KEY) {
    res.status(500).json({ error: "FRED_API_KEY is not configured on this server" });
    return false;
  }
  return true;
}

// find the best matching series id for a plain-language commodity name, cached long
// since this mapping almost never changes.
router.get("/search", async (req, res) => {
  if (!requireFredKey(res)) return;
  const text = (req.query.text || "").trim();
  if (!text) return res.status(400).json({ error: "text is required" });

  const cacheKey = "fred:search:" + text.toLowerCase();
  try {
    const { data, source } = await cacheAside(cacheKey, 30 * 24 * 60 * 60, async () => {
      const url = "https://api.stlouisfed.org/fred/series/search?search_text=" +
        encodeURIComponent(text) + "&api_key=" + process.env.FRED_API_KEY + "&file_type=json&limit=5";
      const r = await fetch(url);
      if (!r.ok) throw new Error("FRED search returned " + r.status);
      const json = await r.json();
      return (json.seriess || []).map((s) => ({ id: s.id, title: s.title, units: s.units }));
    });
    res.json({ text, results: data, source });
  } catch (e) {
    res.status(502).json({ error: "FRED search failed", detail: e.message });
  }
});

// pull recent observations for a known series id.
router.get("/observations", async (req, res) => {
  if (!requireFredKey(res)) return;
  const seriesId = (req.query.series || "").trim();
  if (!seriesId) return res.status(400).json({ error: "series is required" });

  const cacheKey = "fred:obs:" + seriesId;
  try {
    const { data, source } = await cacheAside(cacheKey, 24 * 60 * 60, async () => {
      const url = "https://api.stlouisfed.org/fred/series/observations?series_id=" +
        encodeURIComponent(seriesId) + "&api_key=" + process.env.FRED_API_KEY +
        "&file_type=json&sort_order=desc&limit=24";
      const r = await fetch(url);
      if (!r.ok) throw new Error("FRED observations returned " + r.status);
      const json = await r.json();
      return (json.observations || [])
        .filter((o) => o.value !== ".")
        .map((o) => ({ date: o.date, value: parseFloat(o.value) }));
    });
    res.json({ series: seriesId, observations: data, source });
  } catch (e) {
    res.status(502).json({ error: "FRED observations failed", detail: e.message });
  }
});

module.exports = router;
