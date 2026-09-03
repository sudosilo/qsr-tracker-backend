// QSR Tracker Backend — Orange phone code
// Built and maintained on Orange's phone, sudosilo on GitHub, paired with the frontend
// at github.com/sudosilo/shitty-ass-trading-app.
//
// What this is: a small Express service on Railway with Redis, relaying the providers the
// static frontend can't reach directly, SEC EDGAR, the Federal Register, the QSR Magazine
// feed, Tiingo, FRED (both commodity spot prices and futures via a Yahoo Finance relay), a
// shared "house key" for Twelve Data so new users see data with zero setup, and a
// cross-device sync code system with no accounts or login.
//
// Handoff note: Twelve Data bills one credit per symbol in a batch request, not one credit
// per HTTP call, so batching reduces request count but never reduces credits spent. Both
// the house key routes here and the frontend's personal-key path cap batches to 8 symbols
// per call to respect the free tier's per-minute limit, and the frontend separately paces
// its own refresh interval to respect the 800-per-day limit. See houseKey.js for the
// per-request cap and tickertracker.html's startPolling for the daily pacing.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");

const secFilingsRouter = require("./routes/secFilings");
const fredRouter = require("./routes/fred");
const tariffsRouter = require("./routes/tariffs");
const { router: magazineRouter, refreshMagazine } = require("./routes/magazine");
const { router: foodNetworkRouter, refreshFoodNetwork } = require("./routes/foodNetwork");
const tiingoRouter = require("./routes/tiingo");
const syncRouter = require("./routes/sync");
const futuresRouter = require("./routes/futures");
const houseKeyRouter = require("./routes/houseKey");
const { getClient } = require("./cache");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "qsr-tracker-backend" });
});

app.get("/health", async (req, res) => {
  const redis = getClient();
  let redisOk = false;
  if (redis) {
    try {
      await redis.ping();
      redisOk = true;
    } catch (e) {
      redisOk = false;
    }
  }
  res.json({ status: "ok", redisConfigured: !!process.env.REDIS_URL, redisOk });
});

app.use("/sec-filings", secFilingsRouter);
app.use("/fred", fredRouter);
app.use("/tariffs", tariffsRouter);
app.use("/magazine", magazineRouter);
app.use("/tiingo", tiingoRouter);
app.use("/sync", syncRouter);
app.use("/futures", futuresRouter);
app.use("/house", houseKeyRouter);
app.use("/foodnetwork", foodNetworkRouter);

// this is what makes the magazine archive genuinely scheduled rather than only
// updating when a request happens to land after its cache expires. runs every
// hour on its own, independent of any user visiting the app.
cron.schedule("0 * * * *", async () => {
  try {
    await refreshMagazine();
    console.log("scheduled magazine refresh completed");
  } catch (e) {
    console.error("scheduled magazine refresh failed:", e.message);
  }
  try {
    await refreshFoodNetwork();
    console.log("scheduled food network refresh completed");
  } catch (e) {
    console.error("scheduled food network refresh failed:", e.message);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("qsr-tracker-backend listening on " + port);
});
