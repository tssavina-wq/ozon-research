#!/usr/bin/env node
// Ozon MCP server (stdio). Marketplace tools over composer-api.
// CRITICAL: stdout is the JSON-RPC wire — never write to it. All logs go to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  search,
  details,
  reviews,
  questions,
  offers,
  variants,
  specs,
  sellerInfo,
  sellerCatalog,
  categoryBrowse,
  brandCatalog,
  relatedProducts,
  compareProducts,
  searchFilters,
  listCategories,
  location,
  searchCitiesTool,
  setLocation,
} from "./ozon.js";
import { shutdown, warmup } from "./browser.js";

const log = (...a) => console.error("[ozon-customer-mcp]", ...a);
const TOOL_TIMEOUT_MS = 55000;
const MAX_TEXT = 60000;
const MAX_TEXT_COMPACT = 24000;
const EXIT_IDLE_MS = Number(process.env.OZON_EXIT_IDLE_MS || 30 * 60 * 1000);
const DO_WARMUP = process.env.OZON_WARMUP !== "0";

/** Default compact=true. Pass compact:false or rich:true for full payloads. */
const compactSchema = z
  .boolean()
  .optional()
  .describe(
    "Default true: slim fields (saves context). false or rich:true returns full nested variants/images/filters."
  );
const richSchema = z
  .boolean()
  .optional()
  .describe("Alias for compact:false — return full payload");

const productId = z
  .string()
  .min(1)
  .describe(
    'Product identifier: numeric SKU ("1850364818"), full https://www.ozon.ru/product/... URL, or slug path'
  );

/** Accept product or sku (agents often pass sku= by mistake). */
function withProductAlias(fn) {
  return (args) => {
    const a = { ...args };
    if (!a.product && a.sku) a.product = a.sku;
    if (!a.product) throw new Error("product or sku is required");
    return fn(a);
  };
}

const catalogId = (hint) => z.string().min(1).describe(hint);

const sortSchema = z
  .enum(["popular", "price", "price_desc", "rating", "new", "discount"])
  .default("popular");

const limitSchema = (max, def) => z.number().int().min(1).max(max).default(def);

/** Arbitrary Ozon facet filters — keys from ozon_search_filters. */
const filtersSchema = z
  .record(
    z.string(),
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.union([z.string(), z.number()])),
      z.object({
        min: z.number().optional(),
        max: z.number().optional(),
      }),
    ])
  )
  .optional()
  .describe(
    'Facet filters from ozon_search_filters. Examples: {"brand":"<id>"}, ' +
      '{"brand":"Brand Title"}, {"brand":["<id1>","<id2>"]}, ' +
      '{"is_promo":true}, {"<rangeFacet>":{"min":0,"max":10000}}, ' +
      '{"category":"<slug-id from ozon_list_categories>"}. Titles resolve to keys when needed.'
  );

const readOnly = { readOnlyHint: true, openWorldHint: true, idempotentHint: true };

let exitIdleTimer = null;

function resetExitIdle() {
  clearTimeout(exitIdleTimer);
  exitIdleTimer = setTimeout(() => {
    log(`idle for ${EXIT_IDLE_MS}ms — exiting so Docker --rm can remove the container`);
    cleanup();
  }, EXIT_IDLE_MS);
  exitIdleTimer.unref();
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

function tool(label, fn, timeoutMs = TOOL_TIMEOUT_MS) {
  return async (args) => {
    resetExitIdle();
    try {
      const result = await withTimeout(fn(args), timeoutMs, label);
      const isCompact = result && typeof result === "object" && result.compact === true;
      let text = isCompact ? JSON.stringify(result) : JSON.stringify(result, null, 2);
      const max = isCompact ? MAX_TEXT_COMPACT : MAX_TEXT;
      if (text.length > max) text = text.slice(0, max) + "\n…(truncated)";
      return { content: [{ type: "text", text }] };
    } catch (err) {
      log(`${label} error:`, err?.message);
      let msg = err?.message || String(err);
      if (/exited|EPIPE|closed|not writable|Connection closed/i.test(msg)) {
        msg += " — temporary session drop; retry the same tool call.";
      }
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  };
}

const server = new McpServer({ name: "ozon-customer-mcp", version: "1.7.0" });

server.registerTool(
  "ozon_search",
  {
    title: "Search Ozon products",
    description:
      "Entry point for product discovery on ozon.ru. Default compact=true: sku, name, price, rating, reviews, brand, url " +
      "(+ reviewTrust / variantCount|configCount when >1). Pass compact:false or rich:true for full nested variants/configs/images. " +
      "Do NOT guess category slugs — call ozon_list_categories (or copy from ozon_search_filters / a real ozon.ru URL); " +
      "omit category for plain text search. " +
      "Use priceMin/priceMax, filters{} (from ozon_search_filters), excludeBrands, minReviews. Prefer limit 5–8 for shortlists. " +
      "Next: ozon_product_details / ozon_compare_products / ozon_product_offers.",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .optional()
        .describe("Keywords for product search. Optional if category or filters.category set."),
      category: z
        .string()
        .min(1)
        .optional()
        .describe("Exact category slug from ozon_list_categories / filters — never invent the stem"),
      sort: sortSchema.describe("popular | price | price_desc | rating | new | discount"),
      priceMin: z.number().int().nonnegative().optional().describe("Minimum price in rubles"),
      priceMax: z.number().int().nonnegative().optional().describe("Maximum price in rubles"),
      page: z.number().int().min(1).max(20).optional().describe("Results page (default 1); Ozon returns ~8 tiles/page"),
      filters: filtersSchema,
      excludeBrands: z
        .array(z.string())
        .optional()
        .describe('Drop brands/names containing these substrings, e.g. ["NoBrand"]'),
      minReviews: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Drop items with fewer reviews than this"),
      dedupeVariants: z
        .boolean()
        .optional()
        .describe("Collapse color variants (default true)"),
      dedupeConfigs: z
        .boolean()
        .optional()
        .describe("Collapse RAM/SSD configs of same series into configs[] (default true)"),
      compact: compactSchema,
      rich: richSchema,
      limit: limitSchema(36, 8).describe("How many products to return after dedupe (1–36, default 8)"),
    },
    annotations: readOnly,
  },
  tool("ozon_search", search)
);

server.registerTool(
  "ozon_product_details",
  {
    title: "Get Ozon product details",
    description:
      "Product card. Default compact=true: price, seller, location, delivery summary, short characteristics " +
      "(no image gallery / full description). compact:false or rich:true for images + full description. " +
      "For ALL specs use ozon_product_specs. For reviews use ozon_product_reviews.",
    inputSchema: {
      product: productId.optional().describe("SKU, URL, or slug"),
      sku: z.string().min(1).optional().describe("Alias for product (same meaning)"),
      compact: compactSchema,
      rich: richSchema,
    },
    annotations: readOnly,
  },
  tool("ozon_product_details", withProductAlias(details))
);

server.registerTool(
  "ozon_product_reviews",
  {
    title: "Get Ozon product reviews",
    description:
      "Buyer reviews for a product SKU. Default variantOnly=true matches Ozon UI «Этот вариант» " +
      "(only reviews left on this exact color/config SKU — may be empty while the card shows pooled totals). " +
      "Pass variantOnly=false for all sibling variants on the same card. " +
      "sort=helpful|date|product|default. hasPhotos=true keeps photo reviews. " +
      "Each review: aboutProduct, likelySellerGeneric, matchedSku, isOtherVariant, variant[] labels, " +
      "reviewsScope (product|otherVariant|seller|crossListing|unclear). " +
      "If count=0 with variantOnly, retry variantOnly=false and label quotes as other-variant.",
    inputSchema: {
      product: productId.optional(),
      sku: z.string().min(1).optional().describe("Alias for product"),
      variantOnly: z
        .boolean()
        .optional()
        .describe(
          "true (default): only this SKU («Этот вариант»). false: all color/config variants on the card"
        ),
      sort: z
        .enum(["helpful", "date", "product", "default"])
        .optional()
        .describe("Client-side sort (Ozon composer ignores most URL sort params)"),
      hasPhotos: z.boolean().optional().describe("Only reviews with photos"),
      compact: compactSchema,
      rich: richSchema,
      limit: limitSchema(30, 10).describe("Number of reviews to return"),
    },
    annotations: readOnly,
  },
  tool("ozon_product_reviews", withProductAlias(reviews))
);

server.registerTool(
  "ozon_product_questions",
  {
    title: "Get Ozon product Q&A",
    description:
      "Questions and answers on the product page (not reviews). Use for compatibility, package contents, " +
      "warranty, regional versions, setup tips — things buyers ask before purchase. " +
      "Returns question text, author, date, and answers (seller or buyers). Requires product sku or URL.",
    inputSchema: {
      product: productId.optional(),
      sku: z.string().min(1).optional(),
      limit: limitSchema(30, 10).describe("Number of questions to fetch"),
    },
    annotations: readOnly,
  },
  tool("ozon_product_questions", withProductAlias(questions))
);

server.registerTool(
  "ozon_product_offers",
  {
    title: "Compare Ozon seller offers",
    description:
      "Lists sellers for the product cluster. includeCurrent=true (default) prepends THIS card's seller " +
      "with isCurrentListing=true and delivery from the product page (not only /otherOffers). " +
      "Each row: price, rating, delivery text, advantages[] (all badges, not only first), productUrl, sellerUrl. " +
      "Delivery dates follow location.city / pickupAddress — call ozon_search_cities then ozon_set_city " +
      "(optionally with address for a specific PVZ area) first. Requires product sku.",
    inputSchema: {
      product: productId.optional(),
      sku: z.string().min(1).optional(),
      sort: z.enum(["price", "rating", "delivery"]).default("price").describe("Sort offers by price, rating, or delivery"),
      includeCurrent: z
        .boolean()
        .optional()
        .describe("Prepend current product-card seller with delivery (default true)"),
      compact: compactSchema,
      rich: richSchema,
      limit: limitSchema(36, 12).describe("Max offers to return"),
    },
    annotations: readOnly,
  },
  tool("ozon_product_offers", withProductAlias(offers))
);

server.registerTool(
  "ozon_product_variants",
  {
    title: "Get Ozon product variants",
    description:
      "Product configuration options: memory size, color, storage, etc. Each variant has its own sku and price. " +
      "Use when user asks '512GB or 1TB?', 'what colors available?', or needs sku for a specific configuration. " +
      "Returns aspects[] with variants[]: sku, label, price, oldPrice, available, url.",
    inputSchema: {
      product: productId.optional(),
      sku: z.string().min(1).optional(),
    },
    annotations: readOnly,
  },
  tool("ozon_product_variants", withProductAlias(variants))
);

server.registerTool(
  "ozon_product_specs",
  {
    title: "Get full Ozon product specifications",
    description:
      "Technical characteristics from the listing (fieldCount varies — many cards are sparse with <8 fields). " +
      "When sparse/specsIncomplete=true, do not invent hardware numbers; use ozon_product_questions or another SKU of the same model. " +
      "More complete than ozon_product_details.characteristics when the seller filled the table.",
    inputSchema: {
      product: productId.optional(),
      sku: z.string().min(1).optional(),
    },
    annotations: readOnly,
  },
  tool("ozon_product_specs", withProductAlias(specs))
);

server.registerTool(
  "ozon_seller_info",
  {
    title: "Get Ozon seller profile",
    description:
      "Shop profile for a seller. Use when user asks 'is this seller trustworthy?' or before buying from unknown shop. " +
      "Returns: shop name, logo, subtitle, rating (when present), badges with human labels (not only modal URLs), " +
      "infoUrl, isExpress/isOfficial hints. Product-card seller.rating is often richer than this page.",
    inputSchema: {
      seller: catalogId('Seller slug "dubaidutyfree", numeric id, or https://www.ozon.ru/seller/... URL'),
    },
    annotations: readOnly,
  },
  tool("ozon_seller_info", sellerInfo)
);

server.registerTool(
  "ozon_seller_catalog",
  {
    title: "Browse Ozon seller catalog",
    description:
      "Product listing from a seller's shop page. Use when user wants to see what else this shop sells. " +
      "Returns same fields as ozon_search items plus seller info. Supports sort and price filters.",
    inputSchema: {
      seller: catalogId("Seller slug, id, or URL"),
      sort: sortSchema,
      priceMin: z.number().int().nonnegative().optional(),
      priceMax: z.number().int().nonnegative().optional(),
      compact: compactSchema,
      rich: richSchema,
      limit: limitSchema(36, 8),
    },
    annotations: readOnly,
  },
  tool("ozon_seller_catalog", sellerCatalog)
);

server.registerTool(
  "ozon_category_browse",
  {
    title: "Browse Ozon category",
    description:
      "Products inside a category without text search. Use for browsing a department with priceMax/filters. " +
      "Returns products, breadcrumbs, top brands. " +
      "IMPORTANT: Ozon matches the numeric id only — a guessed stem+id can open a different category. " +
      "Always copy slug from ozon_list_categories (or ozon_search_filters / real ozon.ru link). " +
      "Mismatch of text prefix vs real category → error. Supports filters{} like ozon_search.",
    inputSchema: {
      category: catalogId("Exact category slug from ozon_list_categories — not a guessed name-id"),
      sort: sortSchema,
      priceMin: z.number().int().nonnegative().optional(),
      priceMax: z.number().int().nonnegative().optional(),
      filters: filtersSchema,
      excludeBrands: z.array(z.string()).optional(),
      minReviews: z.number().int().nonnegative().optional(),
      page: z.number().int().min(1).max(20).optional(),
      dedupeVariants: z.boolean().optional().describe("Collapse color variants (default true)"),
      dedupeConfigs: z.boolean().optional().describe("Collapse RAM/SSD configs (default true)"),
      compact: compactSchema,
      rich: richSchema,
      limit: limitSchema(36, 8),
    },
    annotations: readOnly,
  },
  tool("ozon_category_browse", categoryBrowse)
);

server.registerTool(
  "ozon_brand_catalog",
  {
    title: "Browse Ozon brand store",
    description:
      "Official brand storefront on Ozon. " +
      "Accepts brand name, slug-id (\"name-123\"), or /brand/... URL. " +
      "Plain names are resolved via Ozon search. Returns brand products (ads filtered out). Supports filters{}.",
    inputSchema: {
      brand: catalogId('Brand name, slug-id "name-123", or https://www.ozon.ru/brand/... URL'),
      sort: sortSchema,
      priceMin: z.number().int().nonnegative().optional(),
      priceMax: z.number().int().nonnegative().optional(),
      filters: filtersSchema,
      compact: compactSchema,
      rich: richSchema,
      limit: limitSchema(36, 8),
    },
    annotations: readOnly,
  },
  tool("ozon_brand_catalog", brandCatalog)
);

server.registerTool(
  "ozon_related_products",
  {
    title: "Get related Ozon products",
    description:
      "Cross-sell block from product page ('Покупают вместе', accessories, similar items). " +
      "Use when user asks what to buy with this product or wants alternatives. " +
      "Returns product list same format as ozon_search.",
    inputSchema: {
      product: productId.optional(),
      sku: z.string().min(1).optional(),
      compact: compactSchema,
      rich: richSchema,
      limit: limitSchema(36, 8),
    },
    annotations: readOnly,
  },
  tool("ozon_related_products", withProductAlias(relatedProducts))
);

server.registerTool(
  "ozon_compare_products",
  {
    title: "Compare Ozon products side-by-side",
    description:
      "Compare 2–8 products. Default compact=true: matrix + slim product rows (no per-SKU characteristics dump / missingKeys). " +
      "compact:false keeps full characteristics + missingKeysByProduct. " +
      "extracted{} from characteristics/title only.",
    inputSchema: {
      products: z
        .array(productId)
        .min(2)
        .max(8)
        .describe("2–8 product SKUs, URLs, or slugs to compare"),
      compact: compactSchema,
      rich: richSchema,
    },
    annotations: readOnly,
  },
  tool("ozon_compare_products", compareProducts, 150000)
);

server.registerTool(
  "ozon_search_filters",
  {
    title: "Get Ozon search filters",
    description:
      "Available filters and sort options BEFORE / alongside searching. Default compact=true truncates long facet option lists " +
      "(keeps brand/category/price fuller; category options include slug+url). Pass compact:false for complete options. " +
      "For browsing the category tree use ozon_list_categories. Does not return products.",
    inputSchema: {
      query: z.string().min(1).optional().describe("Search text (optional if category set)"),
      category: z
        .string()
        .min(1)
        .optional()
        .describe("Category slug from ozon_list_categories to list facets for"),
      compact: compactSchema,
      rich: richSchema,
    },
    annotations: readOnly,
  },
  tool("ozon_search_filters", searchFilters)
);

server.registerTool(
  "ozon_list_categories",
  {
    title: "List Ozon categories",
    description:
      "Live category directory from Ozon (not a hardcoded map). Returns title + slug + url. " +
      "No args → top departments. parent=slug|id|title → children. query=text → category facet for that search. " +
      "Copy slug into ozon_category_browse / ozon_search.category — never invent stems.",
    inputSchema: {
      parent: z
        .string()
        .min(1)
        .optional()
        .describe("Parent category slug, numeric id, URL, or top-level title to list children"),
      query: z
        .string()
        .min(1)
        .optional()
        .describe("Search text — return categories Ozon associates with this query"),
      limit: limitSchema(120, 60),
      compact: compactSchema,
      rich: richSchema,
    },
    annotations: readOnly,
  },
  tool("ozon_list_categories", listCategories)
);

server.registerTool(
  "ozon_search_cities",
  {
    title: "Search Ozon delivery cities",
    description:
      "Live city lookup via Ozon maps API (not a static list). Use when user asks about delivery to a city " +
      "or you need options to choose from. Pass first letters or full name: \"Каз\", \"Санкт\", \"Екатеринбург\". " +
      "Returns cities[]: label, city, region, lat, lng, uid. Show options to user, then ozon_set_city(city).",
    inputSchema: {
      query: z.string().min(1).describe('City name or prefix, e.g. "Казань", "Санкт", "Новос"'),
      limit: limitSchema(20, 10).describe("Max unique cities to return"),
    },
    annotations: readOnly,
  },
  tool("ozon_search_cities", searchCitiesTool)
);

server.registerTool(
  "ozon_get_location",
  {
    title: "Get Ozon delivery location",
    description:
      "Current delivery city/region for this browser session. Anonymous sessions default to Москва. " +
      "Use before quoting delivery dates. Returns { city, region, pickupAddress }.",
    inputSchema: {},
    annotations: readOnly,
  },
  tool("ozon_get_location", async () => location())
);

server.registerTool(
  "ozon_set_city",
  {
    title: "Set Ozon delivery city",
    description:
      "Change delivery city for the session (picks a pickup point via Ozon map). " +
      "Call ozon_search_cities first to show the user valid options from Ozon. " +
      "Pass address to bias PVZ toward a street/district (e.g. city=Зеленоград, address=\"Заводская 14к2\"). " +
      "Returns requestedCity and location { city, region, pickupAddress }. " +
      "Affects delivery in ozon_product_details / ozon_product_offers. Takes ~20–40s.",
    inputSchema: {
      city: z.string().min(1).describe('City name from ozon_search_cities results, e.g. "Казань"'),
      address: z
        .string()
        .min(1)
        .optional()
        .describe('Optional street/district to bias PVZ, e.g. "Заводская улица 14к2" or "8 микрорайон"'),
      lat: z.number().optional().describe("Optional lat from ozon_search_cities (exact match)"),
      lng: z.number().optional().describe("Optional lng from ozon_search_cities (exact match)"),
    },
    annotations: { openWorldHint: true },
  },
  tool("ozon_set_city", setLocation, 90000)
);

// ── lifecycle ───────────────────────────────────────────────────────────────────
let cleaning = false;
async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  clearTimeout(exitIdleTimer);
  log("shutting down…");
  await Promise.race([
    shutdown().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]);
  setImmediate(() => process.exit(0));
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("SIGHUP", cleanup);
process.on("uncaughtException", (e) => {
  log("uncaughtException:", e);
  cleanup();
});
process.on("unhandledRejection", (r) => log("unhandledRejection:", r));

process.stdin.on("end", () => {
  log("stdin ended");
  cleanup();
});
process.stdin.on("close", () => {
  log("stdin closed");
  cleanup();
});
if (!process.stdin.isTTY) process.stdin.resume();

const transport = new StdioServerTransport();
transport.onclose = cleanup;
await server.connect(transport);
resetExitIdle();
log("ready on stdio");

// Background browser warmup so first tool isn't blocked on Camoufox cold start.
// Does not block MCP discovery (tools/list already registered above).
if (DO_WARMUP) {
  warmup()
    .then(() => log("browser warmup ok"))
    .catch((err) => log("browser warmup failed:", err?.message || err));
}
