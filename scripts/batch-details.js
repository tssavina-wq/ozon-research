#!/usr/bin/env node
/**
 * Batch product cards outside MCP context (for large canvases).
 * Run inside the Docker image with a mounted out dir:
 *
 *   docker run --rm --entrypoint node --init --shm-size=1g \
 *     -v "%CD%/out:/out" -v "%CD%/src:/app/src" -v "%CD%/python:/app/python" \
 *     ozon-customer-mcp:latest scripts/batch-details.js \
 *     --out /out/cards.json --imageDataUri -- skus.txt
 *
 * skus.txt = one SKU/URL per line. Or pass SKUs as CLI args after --.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { details } from "../src/ozon.js";
import { shutdown } from "../src/browser.js";

function parseArgs(argv) {
  const out = { outPath: null, imageDataUri: false, imageSize: 100, skus: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--out") out.outPath = argv[++i];
    else if (a === "--imageDataUri") out.imageDataUri = true;
    else if (a === "--imageSize") out.imageSize = Number(argv[++i]) || 100;
    else if (a === "--") {
      out.skus.push(...argv.slice(i + 1));
      break;
    } else if (a.endsWith(".txt") || a.endsWith(".json")) {
      const raw = readFileSync(a, "utf8");
      if (a.endsWith(".json")) {
        const j = JSON.parse(raw);
        out.skus.push(...(Array.isArray(j) ? j : j.products || j.skus || []));
      } else {
        out.skus.push(...raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
      }
    } else if (!a.startsWith("-")) out.skus.push(a);
    i++;
  }
  out.skus = [...new Set(out.skus.map(String))].slice(0, 40);
  return out;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.skus.length) {
  console.error("Usage: batch-details.js [--out file.json] [--imageDataUri] [--imageSize 100] sku…");
  process.exit(2);
}

try {
  const products = [];
  for (const product of opts.skus) {
    try {
      const d = await details({
        product,
        enrichNutrition: true,
        imageDataUri: opts.imageDataUri && opts.skus.length <= 24,
        imageSize: opts.imageSize,
        compact: false,
        rich: true,
      });
      products.push(d);
      console.error("ok", d.sku, d.nutrition?.proteinG, d.price);
    } catch (err) {
      products.push({ product, error: err?.message || String(err) });
      console.error("fail", product, err?.message);
    }
  }
  const payload = JSON.stringify({ count: products.length, products }, null, 2);
  if (opts.outPath) {
    writeFileSync(opts.outPath, payload);
    console.error("wrote", opts.outPath, payload.length, "bytes");
  } else {
    console.log(payload);
  }
} finally {
  await shutdown();
}
