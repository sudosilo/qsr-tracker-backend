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
  const formType = ["20-F", "4"].includes(req.query.form) ? req.query.form : "10-K";
  if (!symbol) return res.status(400).json({ error: "symbol is required" });

  // form 4 (insider transactions) happens far more often than an annual report, so it
  // gets a longer window returned, 8 would only cover a couple of weeks for an active insider.
  const resultLimit = formType === "4" ? 20 : 8;
  const cacheKey = "sec:" + symbol + ":" + formType;

  try {
    const { data, source } = await cacheAside(cacheKey, 24 * 60 * 60, async () => {
      const url = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=" + symbol +
        "&type=" + formType + "&dateb=&owner=include&count=40&output=atom";
      const r = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT } });
      if (!r.ok) throw new Error("SEC EDGAR returned " + r.status);
      const xml = await r.text();
      return parseFilingsAtom(xml, formType, resultLimit);
    });
    res.json({ symbol, formType, filings: data, source });
  } catch (e) {
    res.status(502).json({ error: "SEC EDGAR lookup failed", detail: e.message });
  }
});

function parseFilingsAtom(xml, defaultForm, limit) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    const updated = (block.match(/<updated>([\s\S]*?)<\/updated>/) || [])[1] || "";
    const summary = (block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1] || "";
    const idField = (block.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || "";
    // the entry's own <link href> already points at the real, ready to open filing index
    // page on sec.gov, CIK and all, no need to build that url ourselves or guess at one.
    const linkMatch = block.match(/<link[^>]*href="([^"]+)"/i);
    // the entry's own <id> uses a strict, standardized format, accession-number=NNNNNNNNNN-NN-NNNNNN,
    // that's a far more reliable source than the free-text summary, which is what "unknown" came from.
    const idMatch = idField.match(/accession-number=([0-9-]+)/i);
    const accMatch = idMatch || summary.match(/Acc-no:\s*([0-9-]+)/i);
    const formMatch = title.match(/(10-K\/A|10-K|20-F\/A|20-F|4\/A|\b4\b)/i);
    // form 4 titles typically carry the reporting insider's name after the form number,
    // something like "4 - SMITH JOHN". this hasn't been confirmed against a real response
    // the way 10-K's title format was, so it's read defensively, if the shape doesn't
    // match cleanly the filing still shows up, it just shows up without a name attached
    // rather than displaying something wrong.
    const reportingPersonMatch = title.match(/^4(?:\/A)?\s*-\s*(.+)$/i);
    const filingDate = updated.slice(0, 10);
    const timestamp = Math.floor(new Date(updated).getTime() / 1000);
    if (!filingDate || isNaN(timestamp)) continue;
    entries.push({
      form: formMatch ? formMatch[1].toUpperCase() : defaultForm,
      filingDate,
      accessionNumber: accMatch ? accMatch[1] : "unknown",
      filingUrl: linkMatch ? linkMatch[1] : null,
      reportingPerson: reportingPersonMatch ? reportingPersonMatch[1].trim() : null,
      timestamp
    });
  }
  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries.slice(0, limit);
}

module.exports = router;
