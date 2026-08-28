#!/usr/bin/env node
/** Smoke-test key MCP operations via ozon.js (requires Camoufox). */
import {
  questions,
  offers,
  variants,
  specs,
  sellerInfo,
  relatedProducts,
  searchFilters,
} from "../src/ozon.js";
import { shutdown } from "../src/browser.js";

const PRODUCT = "1850364818";

const tests = [
  ["questions", () => questions({ product: PRODUCT, limit: 2 })],
  ["offers", () => offers({ product: PRODUCT, limit: 3 })],
  ["variants", () => variants({ product: PRODUCT })],
  ["specs", () => specs({ product: PRODUCT })],
  ["sellerInfo", () => sellerInfo({ seller: "dubaidutyfree" })],
  ["related", () => relatedProducts({ product: PRODUCT, limit: 3 })],
  ["filters", () => searchFilters({ query: "steam deck" })],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    const r = await fn();
    const summary = JSON.stringify(r).slice(0, 120);
    console.log(`ok  ${name}: ${summary}…`);
  } catch (e) {
    console.error(`FAIL ${name}:`, e.message);
    failed++;
  }
}

await shutdown();
process.exit(failed ? 1 : 0);
