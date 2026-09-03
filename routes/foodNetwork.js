const express = require("express");
const { XMLParser } = require("fast-xml-parser");
const { cacheAside, accumulateSet } = require("../cache");

const router = express.Router();
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", htmlEntities: true });

// this specific feed url came from two independent third-party listings agreeing on it,
// not from fetching food network's own site directly, since a crawler-facing fetch tool
// gets blocked by their robots.txt before it can confirm anything. that block says nothing
// about whether a real server-to-server request works, only that a polite crawler won't try.
// this needs a real check against the live backend once deployed, same as several other
// endpoints in this project turned out to need adjusting after the first real request.
const FOOD_NETWORK_FEED_URL = "https://blog.foodnetwork.com/fn-dish/feed/";

async function refreshFoodNetwork() {
  const { data: fresh } = await cacheAside("foodnetwork:raw-pull", 60 * 60, async () => {
    const r = await fetch(FOOD_NETWORK_FEED_URL);
    if (!r.ok) throw new Error("Food Network feed returned " + r.status);
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

  return accumulateSet("foodnetwork:archive", fresh, "id", 30 * 24 * 60 * 60);
}

router.get("/", async (req, res) => {
  try {
    const archive = await refreshFoodNetwork();
    res.json({ articles: archive, source: "accumulated" });
  } catch (e) {
    res.status(502).json({ error: "Food Network feed failed", detail: e.message });
  }
});

module.exports = { router, refreshFoodNetwork };
