#!/usr/bin/env node
/** Verify feedback fixes: empty search, bad category slug, brand resolve. */
import { search, categoryBrowse, brandCatalog } from "../src/ozon.js";
import { shutdown } from "../src/browser.js";

let failed = 0;

async function check(name, fn) {
  try {
    const r = await fn();
    console.log(`ok  ${name}:`, typeof r === "string" ? r : JSON.stringify(r).slice(0, 180));
    return r;
  } catch (e) {
    console.error(`FAIL ${name}:`, e.message);
    failed++;
    return null;
  }
}

const s = await check("search wireless mouse", () =>
  search({ query: "беспроводная мышь", limit: 8, sort: "popular" })
);
if (s && s.count < 1) {
  console.error("FAIL search still empty");
  failed++;
}

const bad = await check("bad category should error", async () => {
  try {
    await categoryBrowse({ category: "myshi-15721", limit: 4 });
    throw new Error("expected slug mismatch error");
  } catch (e) {
    if (/slug mismatch/i.test(e.message)) return e.message;
    throw e;
  }
});

const good = await check("good category mice", () =>
  categoryBrowse({ category: "besprovodnye-myshi-31940", limit: 4, sort: "popular" })
);
if (good && good.count < 1) {
  console.error("FAIL good category empty");
  failed++;
}

const brand = await check("brand ATTACK SHARK", () =>
  brandCatalog({ brand: "ATTACK SHARK", limit: 6, sort: "popular" })
);
if (brand && brand.count < 1) {
  console.error("FAIL brand empty");
  failed++;
}

await shutdown();
process.exit(failed ? 1 : 0);
