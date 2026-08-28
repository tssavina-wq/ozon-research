#!/usr/bin/env node
import { search, details } from "../src/ozon.js";
import { shutdown } from "../src/browser.js";

let failed = 0;
async function check(name, fn) {
  try {
    const r = await fn();
    console.log(`ok  ${name}:`, JSON.stringify(r).slice(0, 240));
    return r;
  } catch (e) {
    console.error(`FAIL ${name}:`, e.message);
    failed++;
    return null;
  }
}

const s = await check("popular+priceMax", () =>
  search({ query: "беспроводная мышь", priceMax: 3000, sort: "popular", limit: 12 })
);
if (!s || s.count < 1) {
  console.error("FAIL still empty popular+priceMax");
  failed++;
} else if (s.sort === "popular" && s.sponsoredOnly) {
  console.log("note: popular stayed sponsored-only");
} else if (s.requestedSort === "popular" && s.sort === "rating") {
  console.log("note: fallback popular→rating ok");
}

const cd26 = s?.items?.find((i) => /CD26/i.test(i.name || "")) || s?.items?.[0];
const d = await check("details rating", () => details({ product: "4181292725" }));
if (d && (d.rating == null || d.rating < 1)) {
  console.error("FAIL details rating still null", d.rating, d.reviews);
  failed++;
}

if (s?.items) {
  const keys = s.items.map((i) => i.modelKey).filter(Boolean);
  const uniq = new Set(keys);
  if (keys.length && uniq.size < keys.length) {
    console.error("FAIL duplicate modelKeys after dedupe");
    failed++;
  }
  const withVariants = s.items.find((i) => (i.variantCount || 0) > 1);
  console.log("dedupe sample", withVariants?.name, "variants", withVariants?.variantCount);
}

await shutdown();
process.exit(failed ? 1 : 0);
