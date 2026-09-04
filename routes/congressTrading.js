const express = require("express");
const { XMLParser } = require("fast-xml-parser");
const AdmZip = require("adm-zip");
const { cacheAside } = require("../cache");

const router = express.Router();
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

// the house clerk publishes no documented developer api for this, only a search page and
// pdf downloads, but they do publish this real annual zip archive of every filing as
// structured xml, republished daily. this url pattern is confirmed against a real, working
// script that uses it, not just a marketing page, but the exact xml field names inside
// still need confirming against a real response, so this parses defensively and tries a
// couple of likely field name shapes rather than assuming one is right.
function houseDisclosureZipUrl(year) {
  return "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/" + year + "FD.ZIP";
}
function houseFieldingPdfUrl(year, docId) {
  return "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/" + year + "/" + docId + ".pdf";
}

async function fetchHouseFilingIndex(year) {
  const r = await fetch(houseDisclosureZipUrl(year));
  if (!r.ok) throw new Error("House Clerk ZIP returned " + r.status);
  const buffer = Buffer.from(await r.arrayBuffer());
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const xmlEntry = entries.find((e) => e.entryName.toLowerCase().endsWith(".xml"));
  if (!xmlEntry) throw new Error("no xml file found inside the House Clerk ZIP");
  const xml = zip.readAsText(xmlEntry);
  const parsed = parser.parse(xml);
  const root = parsed?.FinancialDisclosure || parsed?.Members || parsed;
  const rawMembers = root?.Member || root?.member || [];
  const members = Array.isArray(rawMembers) ? rawMembers : [rawMembers];

  return members.map((m) => {
    const last = m.Last || m.LastName || "";
    const first = m.First || m.FirstName || "";
    const prefix = m.Prefix || "";
    const suffix = m.Suffix || "";
    const filingType = m.FilingType || m.Filing || "";
    const stateDst = m.StateDst || m.StateDistrict || "";
    const filingDate = m.FilingDate || m.Date || "";
    const docId = m.DocID || m.DocId || m.FilingId || "";
    return {
      name: [prefix, first, last, suffix].filter(Boolean).join(" ").trim(),
      lastName: last,
      stateDistrict: stateDst,
      filingType,
      filingDate,
      documentUrl: docId ? houseFieldingPdfUrl(year, docId) : null
    };
  }).filter((m) => m.name);
}

router.get("/", async (req, res) => {
  const lastName = (req.query.lastname || "").toLowerCase();
  const year = req.query.year || new Date().getFullYear();
  const cacheKey = "congress:house:" + year;

  try {
    const { data: allFilings, source } = await cacheAside(cacheKey, 24 * 60 * 60, () => fetchHouseFilingIndex(year));
    // "P" is the House Clerk's own filing type code for a Periodic Transaction Report,
    // the actual disclosed trade filings, as opposed to annual summaries or candidate forms.
    let filings = allFilings.filter((f) => f.filingType === "P" || f.filingType === "PTR");
    if (lastName) filings = filings.filter((f) => f.lastName.toLowerCase().includes(lastName));
    filings.sort((a, b) => (b.filingDate || "").localeCompare(a.filingDate || ""));
    res.json({ year, filings: filings.slice(0, 100), totalMatched: filings.length, source });
  } catch (e) {
    res.status(502).json({ error: "House Clerk disclosure index failed", detail: e.message });
  }
});

module.exports = router;
