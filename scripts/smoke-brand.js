#!/usr/bin/env node
import { brandCatalog } from "../src/ozon.js";
import { shutdown } from "../src/browser.js";

let failed = 0;
for (const brand of ["apple-26303000", "Baseus", "baseus"]) {
  try {
    const r = await brandCatalog({ brand, limit: 6 });
    const names = (r.items || []).map((i) => i.name).join(" | ");
    const junk = /батар|тетрад|наполнител|морокен|порошок|подушка|тарак|кофе в зерн/i.test(names);
    console.log(`${junk ? "FAIL" : "ok "} ${brand}: brand=${r.brand} count=${r.count}`);
    console.log("  ", names.slice(0, 200));
    if (junk || !r.count) failed++;
  } catch (e) {
    console.error("FAIL", brand, e.message);
    failed++;
  }
}
await shutdown();
process.exit(failed ? 1 : 0);
