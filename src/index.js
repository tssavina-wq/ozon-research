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
  searchFilters,
  location,
  searchCitiesTool,
  setLocation,
} from "./ozon.js";
import { shutdown } from "./browser.js";

const log = (...a) => console.error("[ozon-mcp]", ...a);
const TOOL_TIMEOUT_MS = 55000;
const MAX_TEXT = 60000;
const EXIT_IDLE_MS = Number(process.env.OZON_EXIT_IDLE_MS || 10 * 60 * 1000);

const productId = z
  .string()
  .min(1)
  .describe(
    'Product identifier: numeric SKU ("1850364818"), full https://www.ozon.ru/product/... URL, or slug path'
  );

const catalogId = (hint) =>
  z.string().min(1).describe(`${hint}. Examples: slug "dubaidutyfree", id "1463603", or full ozon.ru URL`);

const sortSchema = z
  .enum(["popular", "price", "price_desc", "rating", "new", "discount"])
  .default("popular");

const limitSchema = (max, def) => z.number().int().min(1).max(max).default(def);

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
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
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
      return {
        content: [{ type: "text", text: `Error: ${err?.message || String(err)}` }],
        isError: true,
      };
    }
  };
}

const server = new McpServer({ name: "ozon-mcp-pro", version: "1.2.0" });

server.registerTool(
  "ozon_search",
  {
    title: "Search Ozon products",
    description:
      "Entry point for product discovery on ozon.ru. Use when the user asks to find, look up, or compare products " +
      "by name or keywords. Returns sku, name, price (RUB number), oldPrice, discount, rating, review count, brand, " +
      "image URL and clean product link. Use priceMin/priceMax for budget filters. " +
      "Next step: ozon_product_details(sku) for full card, or ozon_product_offers(sku) to compare sellers.",
    inputSchema: {
      query: z.string().min(1).describe('Keywords, e.g. "Steam Deck OLED", "iphone 15", "наушники sony"'),
      sort: sortSchema.describe("popular | price (cheap first) | price_desc | rating | new | discount"),
      priceMin: z.number().int().nonnegative().optional().describe("Minimum price in rubles"),
      priceMax: z.number().int().nonnegative().optional().describe("Maximum price in rubles"),
      limit: limitSchema(36, 12).describe("How many products to return (1–36)"),
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
      "short characteristics (5–10 fields), text description, and location {city, region} " +
      "(delivery dates elsewhere refer to this city). " +
      "For ALL specs use ozon_product_specs. For reviews use ozon_product_reviews. For Q&A use ozon_product_questions.",
    inputSchema: { product: productId },
    annotations: readOnly,
  },
  tool("ozon_product_details", details)
);

server.registerTool(
  "ozon_product_reviews",
  {
    title: "Get Ozon product reviews",
    description:
      "Real buyer reviews for a product. Use when the user asks about quality, reliability, pros/cons, or real experience. " +
      "Returns: author, score 1–5, comment, pros, cons, date, useful votes, purchased flag, hasPhotos. " +
      "Requires product sku or URL.",
    inputSchema: {
      product: productId,
      limit: limitSchema(30, 10).describe("Number of reviews to fetch"),
    },
    annotations: readOnly,
  },
  tool("ozon_product_reviews", reviews)
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
      product: productId,
      limit: limitSchema(30, 10).describe("Number of questions to fetch"),
    },
    annotations: readOnly,
  },
  tool("ozon_product_questions", questions)
);

server.registerTool(
  "ozon_product_offers",
  {
    title: "Compare Ozon seller offers",
    description:
      "Lists all sellers offering the SAME product (different listings/prices). " +
      "Use when user wants the cheapest option or asks 'who sells it cheaper'. " +
      "Returns location {city, region}, per seller: price, rating, reviews count, delivery hint, productUrl, sellerUrl. " +
      "Delivery dates are for location.city — call ozon_search_cities then ozon_set_city if user asked about another city. " +
      "Requires product sku (from ozon_search or ozon_product_details).",
    inputSchema: {
      product: productId,
      sort: z.enum(["price", "rating", "delivery"]).default("price").describe("Sort offers by price, rating, or delivery"),
      limit: limitSchema(36, 12).describe("Max offers to return"),
    },
    annotations: readOnly,
  },
  tool("ozon_product_offers", offers)
);

server.registerTool(
  "ozon_product_variants",
  {
    title: "Get Ozon product variants",
    description:
      "Product configuration options: memory size, color, storage, etc. Each variant has its own sku and price. " +
      "Use when user asks '512GB or 1TB?', 'what colors available?', or needs sku for a specific configuration. " +
      "Returns aspects[] with variants[]: sku, label, price, oldPrice, available, url.",
    inputSchema: { product: productId },
    annotations: readOnly,
  },
  tool("ozon_product_variants", variants)
);

server.registerTool(
  "ozon_product_specs",
  {
    title: "Get full Ozon product specifications",
    description:
      "Complete technical characteristics table (~15–30 fields). Use for detailed comparison between models " +
      "or when user asks about specific specs (CPU, RAM, screen, interfaces). " +
      "More complete than ozon_product_details.characteristics. Requires product sku or URL.",
    inputSchema: { product: productId },
    annotations: readOnly,
  },
  tool("ozon_product_specs", specs)
);

server.registerTool(
  "ozon_seller_info",
  {
    title: "Get Ozon seller profile",
    description:
      "Shop profile for a seller. Use when user asks 'is this seller trustworthy?' or before buying from unknown shop. " +
      "Returns: shop name, logo, badges (Premium etc.), info modal link. " +
      "Seller id examples: slug 'dubaidutyfree', numeric id, or seller URL from product card.",
    inputSchema: {
      seller: catalogId("Seller slug, numeric id, or https://www.ozon.ru/seller/... URL"),
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
      "Category example: 'smartfony-15502' or full /category/... URL from ozon.ru.",
    inputSchema: {
      category: catalogId("Category slug like smartfony-15502, or full category URL"),
      sort: sortSchema,
      priceMin: z.number().int().nonnegative().optional(),
      priceMax: z.number().int().nonnegative().optional(),
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
      "Official brand storefront on Ozon (Apple, Samsung, Valve, etc.). Use when user asks for all products of a brand. " +
      "Brand example: 'apple-26303000' or /brand/... URL.",
    inputSchema: {
      brand: catalogId("Brand slug like apple-26303000, or full brand URL"),
      sort: sortSchema,
      priceMin: z.number().int().nonnegative().optional(),
      priceMax: z.number().int().nonnegative().optional(),
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
      product: productId,
      limit: limitSchema(36, 12),
    },
    annotations: readOnly,
  },
  tool("ozon_related_products", relatedProducts)
);

server.registerTool(
  "ozon_search_filters",
  {
    title: "Get Ozon search filters",
    description:
      "Available filters and sort options for a search query BEFORE searching. Use to discover brands, " +
      "delivery options, price ranges, or explain to user what filters exist. " +
      "Returns: filters[] (brand, delivery, promo, etc.), activeFilters, sortOptions. " +
      "Does not return products — pair with ozon_search or ozon_category_browse.",
    inputSchema: {
      query: z.string().min(1).describe('Same query you plan to search, e.g. "iphone 15"'),
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
      "Use before quoting delivery dates from ozon_product_offers. Returns { city, region }.",
    inputSchema: {},
    annotations: readOnly,
  },
  tool("ozon_get_location", location)
);

server.registerTool(
  "ozon_set_city",
  {
    title: "Set Ozon delivery city",
    description:
      "Change delivery city for the session (picks a pickup point via Ozon map). " +
      "Call ozon_search_cities first to show the user valid options from Ozon. " +
      "Returns requestedCity (what you asked for) and location (actual Ozon session, city may be a suburb). " +
      "Affects delivery dates in ozon_product_offers. Takes ~20–40s.",
    inputSchema: {
      city: z.string().min(1).describe('City name from ozon_search_cities results, e.g. "Казань"'),
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
