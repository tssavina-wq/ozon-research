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
  location,
  searchCitiesTool,
  setLocation,
} from "./ozon.js";
import { shutdown, warmup } from "./browser.js";

const log = (...a) => console.error("[ozon-customer-mcp]", ...a);
const TOOL_TIMEOUT_MS = 55000;
const MAX_TEXT = 60000;
const EXIT_IDLE_MS = Number(process.env.OZON_EXIT_IDLE_MS || 30 * 60 * 1000);
const DO_WARMUP = process.env.OZON_WARMUP !== "0";

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
    'Facet filters from ozon_search_filters. Examples: {"brand":"100867541"}, ' +
      '{"brand":"ATTACK SHARK"}, {"brand":["100867541","26303256"]}, ' +
      '{"mouseconnection":279146,"is_promo":true}, ' +
      '{"maxamplificationmouse":{"min":18000,"max":50000}}, ' +
      '{"category":"besprovodnye-myshi-31940"}. Titles are resolved to keys when needed.'
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
      let text = JSON.stringify(result, null, 2);
      if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + "\n…(truncated)";
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

const server = new McpServer({ name: "ozon-customer-mcp", version: "1.5.3" });

server.registerTool(
  "ozon_search",
  {
    title: "Search Ozon products",
    description:
      "Entry point for product discovery on ozon.ru. Use when the user asks to find, look up, or compare products " +
      "by name or keywords. Returns sku, name, price, rating, reviews, brand, url, plus reviewTrust, " +
      "baseModelKey, configs[] / variants[]. Same review count on color/RAM variants of one card is normal " +
      "(variantReviewPool); reviewsSharedAcrossModels only flags collisions across different models. " +
      "Laptop/ultrabook queries auto-pin category noutbuki-15692 when category omitted (categoryInferred). " +
      "Use priceMin/priceMax, filters{} (from ozon_search_filters), excludeBrands, minReviews. " +
      "Color+RAM/SSD configs are deduped by default. If sort=popular is empty/ads-only → auto rating " +
      "(see note — not true popularity). page=2+ for next shelf. " +
      "Next: ozon_product_details / ozon_compare_products / ozon_product_offers.",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .optional()
        .describe('Keywords, e.g. "Steam Deck OLED", "iphone 15". Optional if category or filters.category set.'),
      category: z
        .string()
        .min(1)
        .optional()
        .describe("Category slug like igrovye-noutbuki-15821 — prefer over guessing inside filters"),
      sort: sortSchema.describe("popular | price | price_desc | rating | new | discount"),
      priceMin: z.number().int().nonnegative().optional().describe("Minimum price in rubles"),
      priceMax: z.number().int().nonnegative().optional().describe("Maximum price in rubles"),
      page: z.number().int().min(1).max(20).optional().describe("Results page (default 1); Ozon returns ~8 tiles/page"),
      filters: filtersSchema,
      excludeBrands: z
        .array(z.string())
        .optional()
        .describe('Drop brands/names containing these substrings, e.g. ["Neobihier"]'),
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
      limit: limitSchema(36, 12).describe("How many products to return after dedupe (1–36)"),
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
      "Full product card for one item. Use when you already have sku or product URL from ozon_search. " +
      "Returns: name, price/cardPrice/oldPrice, availability, seller name+rating, images, " +
      "short characteristics (5–10 fields), text description, location {city, region, pickupAddress}, " +
      "and delivery { summary, best, options[] } for the CURRENT listing (courier/PVZ dates for session city). " +
      "For ALL specs use ozon_product_specs. For reviews use ozon_product_reviews. For other sellers use ozon_product_offers.",
    inputSchema: {
      product: productId.optional().describe("SKU, URL, or slug"),
      sku: z.string().min(1).optional().describe("Alias for product (same meaning)"),
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
      limit: limitSchema(36, 12),
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
      "Products inside a category without text search. Use for 'show smartphones under 30k' via category + priceMax, " +
      "or browsing a department. Returns products, breadcrumbs, top brands in category. " +
      "IMPORTANT: Ozon matches the numeric id only — a hallucinated slug like myshi-15721 can silently open " +
      "videokarty-15721. Always copy the slug from ozon_search_filters (active category URL) or a real ozon.ru link. " +
      "Mismatch of text prefix vs real category → error. Supports filters{} like ozon_search.",
    inputSchema: {
      category: catalogId("Exact category slug from filters/URL, e.g. besprovodnye-myshi-31940 — not a guessed name-id"),
      sort: sortSchema,
      priceMin: z.number().int().nonnegative().optional(),
      priceMax: z.number().int().nonnegative().optional(),
      filters: filtersSchema,
      excludeBrands: z.array(z.string()).optional(),
      minReviews: z.number().int().nonnegative().optional(),
      page: z.number().int().min(1).max(20).optional(),
      dedupeVariants: z.boolean().optional().describe("Collapse color variants (default true)"),
      dedupeConfigs: z.boolean().optional().describe("Collapse RAM/SSD configs (default true)"),
      limit: limitSchema(36, 12),
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
      "Official brand storefront on Ozon (Apple, Samsung, Baseus, etc.). " +
      "Accepts brand name (\"Baseus\"), slug-id (\"apple-26303000\"), or /brand/... URL. " +
      "Plain names are resolved via Ozon search. Returns brand products (ads filtered out). Supports filters{}.",
    inputSchema: {
      brand: catalogId('Brand name "Baseus", slug-id "apple-26303000", or https://www.ozon.ru/brand/... URL'),
      sort: sortSchema,
      priceMin: z.number().int().nonnegative().optional(),
      priceMax: z.number().int().nonnegative().optional(),
      filters: filtersSchema,
      limit: limitSchema(36, 12),
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
      limit: limitSchema(36, 12),
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
      "Fetch details+fullest specs widget for 2–8 products and build a characteristic matrix " +
      "(same parser as ozon_product_specs; retries if sparse). " +
      "extracted{} GPU/RAM hints come from characteristics or title only — never from description. " +
      "missingKeysByProduct[sku] = fields present in the matrix but missing on that SKU.",
    inputSchema: {
      products: z
        .array(productId)
        .min(2)
        .max(8)
        .describe("2–8 product SKUs, URLs, or slugs to compare"),
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
      "Available filters and sort options BEFORE / alongside searching. Use to discover brand keys, " +
      "delivery options, attribute facets, then pass those keys into ozon_search filters{}. " +
      "Returns: filters[] (key, type, options with key+title), activeFilters, sortOptions. " +
      "Does not return products.",
    inputSchema: {
      query: z.string().min(1).optional().describe('Search text, e.g. "iphone 15" (optional if category set)'),
      category: z
        .string()
        .min(1)
        .optional()
        .describe("Category slug to list facets for, e.g. besprovodnye-myshi-31940"),
    },
    annotations: readOnly,
  },
  tool("ozon_search_filters", searchFilters)
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
