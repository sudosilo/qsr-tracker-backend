const express = require("express");
const { XMLParser } = require("fast-xml-parser");
const { cacheAside, accumulateSet } = require("../cache");

const router = express.Router();
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

async function refreshMagazine() {
  const { data: fresh } = await cacheAside("magazine:raw-pull", 60 * 60, async () => {
    const r = await fetch("https://www.qsrmagazine.com/feed/");
    if (!r.ok) throw new Error("QSR Magazine feed returned " + r.status);
    const xml = await r.text();
    const parsed = parser.parse(xml);
    const items = parsed?.rss?.channel?.item || [];
    const list = Array.isArray(items) ? items : [items];
    return list.map((item) => {
      const link = typeof item.link === "string" ? item.link : "";
      const title = typeof item.title === "string" ? item.title : (item.title?.["#text"] || "");
      const pubDate = item.pubDate || "";
      const description = typeof item.description === "string" ? item.description : "";
      return {
        id: link || (title + "|" + pubDate),
        title,
        link,
        pubDate,
        timestamp: Math.floor(new Date(pubDate).getTime() / 1000),
        snippet: description.replace(/<[^>]+>/g, "").trim().slice(0, 200)
      };
    }).filter((a) => !isNaN(a.timestamp));
  });

  return accumulateSet("magazine:archive", fresh, "id", 30 * 24 * 60 * 60);
}

router.get("/", async (req, res) => {
  try {
    const archive = await refreshMagazine();
    res.json({ articles: archive, source: "accumulated" });
  } catch (e) {
    res.status(502).json({ error: "QSR Magazine feed failed", detail: e.message });
  }
});

module.exports = { router, refreshMagazine };
