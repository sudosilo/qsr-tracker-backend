const express = require("express");
const { getClient } = require("../cache");

const router = express.Router();

// Namespaced away from every other consumer of this Redis instance so the tracker's keys
// and the engine's keys can never collide.
const SNAPSHOT_KEY = "engine:snapshot";
const LEDGER_KEY = "engine:ledger";
const HEARTBEAT_KEY = "engine:heartbeat";
const COMMAND_KEY = "engine:commands";

// The ledger is trimmed to this many most recent trades so a long running engine cannot
// grow the key without bound. The authoritative full history stays in the engine's own
// results output, this is the monitoring copy.
const LEDGER_MAX = 2000;

// A heartbeat older than this means the engine is not running, whatever the snapshot says.
const HEARTBEAT_STALE_SECONDS = 120;

// Commands older than this are refused rather than executed, so a flatten issued while the
// engine was offline does not fire at an arbitrary later moment against a different position.
const COMMAND_MAX_AGE_SECONDS = 300;

const VALID_COMMANDS = ["pause", "resume", "flatten"];

function requireRedis(res) {
  const redis = getClient();
  if (!redis) {
    res.status(500).json({ error: "REDIS_URL is not configured on this server, the engine routes cannot work without it" });
    return null;
  }
  return redis;
}

// Every write path and the command drain are gated on a shared secret, since these routes
// can affect a live trading process rather than only serving public data.
function requireSecret(req, res) {
  const expected = process.env.ENGINE_SECRET;
  if (!expected) {
    res.status(500).json({ error: "ENGINE_SECRET is not configured on this server, writes are refused rather than left open" });
    return false;
  }
  const provided = req.get("x-engine-secret");
  if (provided !== expected) {
    res.status(401).json({ error: "missing or incorrect x-engine-secret header" });
    return false;
  }
  return true;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// The engine overwrites this after every bar. Deliberately stored with no expiry, since a
// position snapshot silently vanishing is exactly the failure this whole layer exists to
// prevent.
router.put("/snapshot", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const redis = requireRedis(res);
  if (!redis) return;
  const body = req.body;
  if (!body || typeof body !== "object") return res.status(400).json({ error: "a json body is required" });
  const record = { storedAt: nowSeconds(), snapshot: body };
  try {
    await redis.set(SNAPSHOT_KEY, JSON.stringify(record));
    res.json({ stored: true, storedAt: record.storedAt });
  } catch (e) {
    res.status(502).json({ error: "could not store the snapshot", detail: e.message });
  }
});

// Read by the companion app, and by the engine itself on startup when recovering state.
// Reports heartbeat age alongside so a caller can tell a live position from a stale record
// left behind by a process that died.
router.get("/snapshot", async (req, res) => {
  const redis = requireRedis(res);
  if (!redis) return;
  try {
    const raw = await redis.get(SNAPSHOT_KEY);
    const beatRaw = await redis.get(HEARTBEAT_KEY);
    const beat = beatRaw !== null ? JSON.parse(beatRaw) : null;
    const beatAge = beat ? nowSeconds() - beat.at : null;
    if (raw === null) {
      return res.json({ snapshot: null, storedAt: null, engineLive: false, heartbeatAgeSeconds: beatAge });
    }
    const record = JSON.parse(raw);
    res.json({
      snapshot: record.snapshot,
      storedAt: record.storedAt,
      engineLive: beatAge !== null && beatAge <= HEARTBEAT_STALE_SECONDS,
      heartbeatAgeSeconds: beatAge,
    });
  } catch (e) {
    res.status(502).json({ error: "could not read the snapshot", detail: e.message });
  }
});

// Append only. The engine posts one completed trade at a time as it closes.
router.post("/ledger", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const redis = requireRedis(res);
  if (!redis) return;
  const body = req.body;
  if (!body || typeof body !== "object") return res.status(400).json({ error: "a json body is required" });
  const entry = { recordedAt: nowSeconds(), trade: body };
  try {
    await redis.lpush(LEDGER_KEY, JSON.stringify(entry));
    await redis.ltrim(LEDGER_KEY, 0, LEDGER_MAX - 1);
    const length = await redis.llen(LEDGER_KEY);
    res.json({ recorded: true, ledgerLength: length });
  } catch (e) {
    res.status(502).json({ error: "could not record the trade", detail: e.message });
  }
});

// Most recent first, newest trade at index zero.
router.get("/ledger", async (req, res) => {
  const redis = requireRedis(res);
  if (!redis) return;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, LEDGER_MAX);
  try {
    const rows = await redis.lrange(LEDGER_KEY, 0, limit - 1);
    const trades = rows.map((r) => JSON.parse(r));
    const total = await redis.llen(LEDGER_KEY);
    res.json({ trades, returned: trades.length, total });
  } catch (e) {
    res.status(502).json({ error: "could not read the ledger", detail: e.message });
  }
});

// Posted by the engine on every loop iteration. Carries whatever status detail the engine
// wants surfaced, so the companion app can distinguish connected and waiting for the entry
// window from connected and actively trading.
router.put("/heartbeat", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const redis = requireRedis(res);
  if (!redis) return;
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const record = { at: nowSeconds(), status: body.status || "unknown", detail: body.detail || null };
  try {
    await redis.set(HEARTBEAT_KEY, JSON.stringify(record));
    res.json({ stored: true, at: record.at });
  } catch (e) {
    res.status(502).json({ error: "could not store the heartbeat", detail: e.message });
  }
});

router.get("/heartbeat", async (req, res) => {
  const redis = requireRedis(res);
  if (!redis) return;
  try {
    const raw = await redis.get(HEARTBEAT_KEY);
    if (raw === null) return res.json({ heartbeat: null, engineLive: false, ageSeconds: null });
    const record = JSON.parse(raw);
    const age = nowSeconds() - record.at;
    res.json({ heartbeat: record, engineLive: age <= HEARTBEAT_STALE_SECONDS, ageSeconds: age });
  } catch (e) {
    res.status(502).json({ error: "could not read the heartbeat", detail: e.message });
  }
});

// Issued by the companion app. Queued rather than applied here, since this service has no
// broker connection, the engine is the only thing that can actually act.
router.post("/commands", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const redis = requireRedis(res);
  if (!redis) return;
  const command = req.body && req.body.command;
  if (!VALID_COMMANDS.includes(command)) {
    return res.status(400).json({ error: "command must be one of: " + VALID_COMMANDS.join(", ") });
  }
  const entry = { command, issuedAt: nowSeconds(), note: (req.body && req.body.note) || null };
  try {
    await redis.rpush(COMMAND_KEY, JSON.stringify(entry));
    const depth = await redis.llen(COMMAND_KEY);
    res.json({ queued: true, command, issuedAt: entry.issuedAt, queueDepth: depth });
  } catch (e) {
    res.status(502).json({ error: "could not queue the command", detail: e.message });
  }
});

// Read only view of what is waiting, so the companion app can show a pending command
// without consuming it.
router.get("/commands", async (req, res) => {
  const redis = requireRedis(res);
  if (!redis) return;
  try {
    const rows = await redis.lrange(COMMAND_KEY, 0, -1);
    res.json({ pending: rows.map((r) => JSON.parse(r)) });
  } catch (e) {
    res.status(502).json({ error: "could not read the command queue", detail: e.message });
  }
});

// Drained by the engine on each loop iteration. Destructive by design, a command executes
// once and is gone, so a restart cannot replay an old flatten against a new position.
// Commands older than COMMAND_MAX_AGE_SECONDS are returned separately as expired rather
// than as live instructions, so the engine never acts on a stale order it finds after
// having been offline.
router.post("/commands/drain", async (req, res) => {
  if (!requireSecret(req, res)) return;
  const redis = requireRedis(res);
  if (!redis) return;
  try {
    const rows = [];
    for (;;) {
      const row = await redis.lpop(COMMAND_KEY);
      if (row === null) break;
      rows.push(JSON.parse(row));
    }
    const cutoff = nowSeconds() - COMMAND_MAX_AGE_SECONDS;
    const commands = rows.filter((r) => r.issuedAt >= cutoff);
    const expired = rows.filter((r) => r.issuedAt < cutoff);
    res.json({ commands, expired });
  } catch (e) {
    res.status(502).json({ error: "could not drain the command queue", detail: e.message });
  }
});

module.exports = router;
