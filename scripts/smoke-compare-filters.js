#!/usr/bin/env node
/** Live smoke: filtered search + compare products. */
import { search, compareProducts, categoryBrowse } from "../src/ozon.js";
import { shutdown } from "../src/browser.js";

let failed = 0;
async function check(name, fn) {
  try {
    const r = await fn();
    console.log(`ok  ${name}:`, JSON.stringify(r).slice(0, 220));
    return r;
  } catch (e) {
    console.error(`FAIL ${name}:`, e.message);
    failed++;
    return null;
  }
}

const filtered = await check("search category+brand+price", () =>
  search({
    category: "besprovodnye-myshi-31940",
    priceMax: 3000,
    filters: { brand: "ATTACK SHARK" },
    limit: 6,
    sort: "popular",
  })
);
if (filtered && filtered.count < 1) {
  console.error("FAIL filtered search empty");
  failed++;
}
if (filtered?.filters?.brand && filtered.filters.brand !== "100867541" && filtered.filters.brand !== "ATTACK SHARK") {
  // after resolve should be key
  console.log("note brand filter value:", filtered.filters.brand);
}

const byKey = await check("search filters by key", () =>
  categoryBrowse({
    category: "besprovodnye-myshi-31940",
    priceMax: 3000,
    filters: { mouseconnection: "279146" },
    limit: 4,
  })
);
if (byKey && byKey.count < 1) {
  console.error("FAIL category filter empty");
  failed++;
}

const skus =
  filtered?.items?.slice(0, 2).map((i) => i.sku) ||
  ["1581519778", "1796874853"];
if (skus.length >= 2) {
  const cmp = await check("compare products", () => compareProducts({ products: skus }));
  if (cmp && (!cmp.matrix || cmp.count < 2)) {
    console.error("FAIL compare matrix");
    failed++;
  }
}

await shutdown();
process.exit(failed ? 1 : 0);
