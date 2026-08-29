const express = require("express");
const { cacheAside } = require("../cache");

const router = express.Router();

router.get("/", async (req, res) => {
  const cacheKey = "tariffs:watch";
  try {
    const { data, source } = await cacheAside(cacheKey, 6 * 60 * 60, async () => {
      const url = "https://www.federalregister.gov/api/v1/documents.json" +
        "?conditions%5Bterm%5D=tariff&order=newest&per_page=40" +
        "&fields%5B%5D=title&fields%5B%5D=abstract&fields%5B%5D=publication_date" +
        "&fields%5B%5D=agencies&fields%5B%5D=document_number&fields%5B%5D=type";
      const r = await fetch(url);
      if (!r.ok) throw new Error("Federal Register returned " + r.status);
      const json = await r.json();
      return (json.results || []).map((d) => ({
        title: d.title,
        abstract: d.abstract || "",
        agencies: (d.agencies || []).map((a) => a.name).join(", "),
        documentNumber: d.document_number,
        docType: d.type,
        timestamp: Math.floor(new Date(d.publication_date).getTime() / 1000)
      })).filter((d) => !isNaN(d.timestamp));
    });
    res.json({ docs: data, source });
  } catch (e) {
    res.status(502).json({ error: "Federal Register lookup failed", detail: e.message });
  }
});

module.exports = router;
