const express = require("express");
const { cacheAside } = require("../cache");

const router = express.Router();

// SEC's documented required format is "Company Name AdminContact@example.com",
// a plain name and email separated by a space, no parentheses. Their automated
// blocking checks the header shape, not just whether something is present.
const SEC_USER_AGENT = process.env.SEC_CONTACT
  ? `qsr-tracker-backend ${process.env.SEC_CONTACT}`
  : "qsr-tracker-backend set-SEC_CONTACT-env-var@example.com";

router.get("/", async (req, res) => {
  const symbol = (req.query.symbol || "").toUpperCase();
  const formType = req.query.form === "20-F" ? "20-F" : "10-K";
  if (!symbol) return res.status(400).json({ error: "symbol is required" });

  const cacheKey = "sec:" + symbol + ":" + formType;

  try {
    const { data, source } = await cacheAside(cacheKey, 24 * 60 * 60, async () => {
      const url = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=" + symbol +
        "&type=" + formType + "&dateb=&owner=include&count=20&output=atom";
      const r = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT } });
      if (!r.ok) throw new Error("SEC EDGAR returned " + r.status);
      const xml = await r.text();
      return parseFilingsAtom(xml, formType);
    });
    res.json({ symbol, formType, filings: data, source });
  } catch (e) {
    res.status(502).json({ error: "SEC EDGAR lookup failed", detail: e.message });
  }
});

function parseFilingsAtom(xml, defaultForm) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    const updated = (block.match(/<updated>([\s\S]*?)<\/updated>/) || [])[1] || "";
    const summary = (block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1] || "";
    const accMatch = summary.match(/Acc-no:\s*([0-9-]+)/i);
    const formMatch = title.match(/(10-K\/A|10-K|20-F\/A|20-F)/i);
    const filingDate = updated.slice(0, 10);
    const timestamp = Math.floor(new Date(updated).getTime() / 1000);
    if (!filingDate || isNaN(timestamp)) continue;
    entries.push({
      form: formMatch ? formMatch[1].toUpperCase() : defaultForm,
      filingDate,
      accessionNumber: accMatch ? accMatch[1] : "unknown",
      timestamp
    });
  }
  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries.slice(0, 8);
}

module.exports = router;
