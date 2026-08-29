require("dotenv").config();
const express = require("express");
const cors = require("cors");

const secFilingsRouter = require("./routes/secFilings");
const fredRouter = require("./routes/fred");
const tariffsRouter = require("./routes/tariffs");
const magazineRouter = require("./routes/magazine");
const tiingoRouter = require("./routes/tiingo");
const { getClient } = require("./cache");

const app = express();
app.use(cors());

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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("qsr-tracker-backend listening on " + port);
});
