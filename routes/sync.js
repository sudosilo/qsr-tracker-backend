const express = require("express");
const { getClient } = require("../cache");

const router = express.Router();

const SYNC_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days of inactivity before a sync code expires

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous characters
  let code = "";
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function requireRedis(res) {
  const redis = getClient();
  if (!redis) {
    res.status(500).json({ error: "REDIS_URL is not configured on this server, sync cannot work without it" });
    return null;
  }
  return redis;
}

// create a brand new sync code holding whatever blob the client sends
router.post("/", async (req, res) => {
  const redis = requireRedis(res);
  if (!redis) return;
  const body = req.body;
  if (!body || typeof body !== "object") return res.status(400).json({ error: "a json body is required" });

  let code;
  try {
    do {
      code = randomCode();
    } while (await redis.get("sync:" + code));
    await redis.set("sync:" + code, JSON.stringify(body), "EX", SYNC_TTL_SECONDS);
    res.json({ code });
  } catch (e) {
    res.status(502).json({ error: "could not create a sync code", detail: e.message });
  }
});

// fetch whatever is stored under a code
router.get("/:code", async (req, res) => {
  const redis = requireRedis(res);
  if (!redis) return;
  const code = (req.params.code || "").toUpperCase();
  try {
    const raw = await redis.get("sync:" + code);
    if (raw === null) return res.status(404).json({ error: "no data found for this code, it may have expired or never existed" });
    res.json({ code, data: JSON.parse(raw) });
  } catch (e) {
    res.status(502).json({ error: "could not read this sync code", detail: e.message });
  }
});

// overwrite the blob under an existing code, refreshing its expiry
router.put("/:code", async (req, res) => {
  const redis = requireRedis(res);
  if (!redis) return;
  const code = (req.params.code || "").toUpperCase();
  const body = req.body;
  if (!body || typeof body !== "object") return res.status(400).json({ error: "a json body is required" });
  try {
    const exists = await redis.get("sync:" + code);
    if (exists === null) return res.status(404).json({ error: "no existing sync code to update, create one first" });
    await redis.set("sync:" + code, JSON.stringify(body), "EX", SYNC_TTL_SECONDS);
    res.json({ code, updated: true });
  } catch (e) {
    res.status(502).json({ error: "could not update this sync code", detail: e.message });
  }
});

module.exports = router;
