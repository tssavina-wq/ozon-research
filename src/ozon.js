// High-level Ozon operations: build composer-api paths, fetch via the browser, parse to plain data.
import { fetchJson, getLocation, searchCities, setCity } from "./browser.js";
import {
  parseSearch,
  parseDetails,
  parseReviews,
  parseQuestions,
  parseOffers,
  parseVariants,
  parseSpecs,
  parseSellerInfo,
  parseSellerCatalog,
  parseCategoryBrowse,
  parseBrandCatalog,
  parseRelatedProducts,
  parseSearchFilters,
} from "./parse.js";
import { _internal } from "./parse.js";

const { skuFromUrl } = _internal;

const SORT_MAP = {
  popular: "",
  price: "price",
  price_desc: "price_desc",
  rating: "rating",
  new: "new",
  discount: "discount",
};

// Ozon UI: "Быстрее доставка" → sort=date (not "delivery")
const OFFERS_SORT_MAP = {
  price: "price",
  rating: "rating",
  delivery: "date",
};

/** Accept a product as sku ("1185261285"), full url, or slug; return the site path "/product/.../". */
function productPath(product) {
  const p = String(product || "").trim();
  if (!p) throw new Error("product is required (sku, url, or slug)");
  if (/^https?:\/\//.test(p)) return new URL(p).pathname.replace(/\/?$/, "/");
  if (p.startsWith("/product/")) return p.replace(/\/?$/, "/");
  if (/^\d+$/.test(p)) return `/product/${p}/`;
  return `/product/${p.replace(/^\/+|\/+$/g, "")}/`;
}

function productSku(product) {
  const p = String(product || "").trim();
  if (/^\d+$/.test(p)) return p;
  return skuFromUrl(productPath(product));
}

function catalogPath(value, kind) {
  const p = String(value || "").trim();
  if (!p) throw new Error(`${kind} is required (slug, id, or url)`);
  if (/^https?:\/\//.test(p)) return new URL(p).pathname.replace(/\/?$/, "/");
  const prefix = `/${kind}/`;
  if (p.startsWith(prefix)) return p.replace(/\/?$/, "/");
  if (/^\d+$/.test(p)) return `${prefix}${p}/`;
  return `${prefix}${p.replace(/^\/+|\/+$/g, "")}/`;
}

/** Brand pages need slug-id (apple-26303000). Plain "baseus" hits an A–Z index. */
function looksLikeBrandId(value) {
  return /-\d+\/?$/.test(String(value || "").trim()) || /\/brand\/[^/]+-\d+/i.test(String(value || ""));
}

function extractBrandSlugFromSearch(page, query) {
  const q = String(query || "")
    .trim()
    .toLowerCase()
    .replace(/-\d+$/, "")
    .replace(/[^a-z0-9а-яё_-]+/gi, "");
  if (!q) return null;
  const blob = JSON.stringify(page?.widgetStates || {});
  // /brand/baseus-168785571/ or /category/.../baseus-168785571/
  const re = new RegExp(`(?:/brand/|/category/[^/]+/)(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\w-]*-\\d+)`, "i");
  const m = blob.match(re);
  if (m) return m[1];
  const loose = blob.match(/\/brand\/([a-z0-9-]+-\d+)\//i);
  return loose ? loose[1] : null;
}

async function resolveBrandPath(brand) {
  const raw = String(brand || "").trim();
  if (!raw) throw new Error("brand is required");
  if (/^https?:\/\//.test(raw) || looksLikeBrandId(raw) || raw.startsWith("/brand/")) {
    return catalogPath(raw, "brand");
  }
  const probe = await fetchJson(catalogPath(raw, "brand"));
  const pageType = probe?.pageInfo?.pageTypeTracking || "";
  const organic = parseSearch(probe, 3).count;
  if ((pageType === "brand/landing" || pageType === "brand_customized") && organic > 0) {
    return catalogPath(raw, "brand");
  }
  const searchPage = await fetchJson(`/search/?text=${encodeURIComponent(raw)}&from_global=true`);
  const slug = extractBrandSlugFromSearch(searchPage, raw);
  if (!slug) {
    throw new Error(
      `could not resolve brand "${raw}"; pass slug with id like "apple-26303000" or a /brand/... URL`
    );
  }
  return `/brand/${slug}/`;
}

function appendCatalogParams(url, { sort = "popular", priceMin, priceMax } = {}) {
  let out = url.includes("?") ? url : `${url}${url.endsWith("/") ? "" : "/"}`;
  const sorting = SORT_MAP[sort];
  const params = new URLSearchParams(out.includes("?") ? out.split("?")[1] : "");
  if (sorting) params.set("sorting", sorting);
  if (priceMin != null || priceMax != null) {
    const min = priceMin ?? 0;
    const max = priceMax ?? 99999999;
    params.set("currency_price", `${min}.000;${max}.000`);
  }
  const base = out.split("?")[0];
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export async function search({ query, sort = "popular", priceMin, priceMax, limit = 12 }) {
  if (!query || !String(query).trim()) throw new Error("query is required");
  let url = `/search/?text=${encodeURIComponent(query)}&from_global=true`;
  url = appendCatalogParams(url, { sort, priceMin, priceMax });
  const page = await fetchJson(url);
  const { items } = parseSearch(page, limit);
  return { query, sort, count: items.length, items };
}

export async function details({ product }) {
  const path = productPath(product);
  const [basePage, page2] = await Promise.all([
    fetchJson(path),
    fetchJson(`${path}?layout_container=pdpPage2column&layout_page_index=2`),
  ]);
  return parseDetails(basePage, page2);
}

export async function reviews({ product, limit = 10 }) {
  const path = productPath(product);
  const page = await fetchJson(`${path}reviews/`);
  return parseReviews(page, limit);
}

export async function questions({ product, limit = 10 }) {
  const path = productPath(product);
  const page = await fetchJson(`${path}questions/`);
  return parseQuestions(page, limit);
}

export async function offers({ product, sort = "price", limit = 12 }) {
  const sku = productSku(product);
  if (!sku) throw new Error("could not resolve product sku");
  const offerSort = OFFERS_SORT_MAP[sort] || "price";
  const page = await fetchJson(`/modal/otherOffersFromSellers?product_id=${sku}&sort=${offerSort}`);
  return { product: sku, ...parseOffers(page, limit) };
}

export async function variants({ product }) {
  const path = productPath(product);
  const page = await fetchJson(path);
  return { product: productSku(product), ...parseVariants(page) };
}

export async function specs({ product }) {
  const path = productPath(product);
  const page = await fetchJson(`${path}features/`);
  return { product: productSku(product), ...parseSpecs(page) };
}

export async function sellerInfo({ seller }) {
  const path = catalogPath(seller, "seller");
  const page = await fetchJson(path);
  return parseSellerInfo(page);
}

export async function sellerCatalog({ seller, sort = "popular", priceMin, priceMax, limit = 12 }) {
  const path = appendCatalogParams(catalogPath(seller, "seller"), { sort, priceMin, priceMax });
  const page = await fetchJson(path);
  return parseSellerCatalog(page, limit);
}

export async function categoryBrowse({ category, sort = "popular", priceMin, priceMax, limit = 12 }) {
  const path = appendCatalogParams(catalogPath(category, "category"), { sort, priceMin, priceMax });
  const page = await fetchJson(path);
  return parseCategoryBrowse(page, limit);
}

export async function brandCatalog({ brand, sort = "popular", priceMin, priceMax, limit = 12 }) {
  const path = appendCatalogParams(await resolveBrandPath(brand), { sort, priceMin, priceMax });
  const page = await fetchJson(path);
  return parseBrandCatalog(page, limit);
}

export async function relatedProducts({ product, limit = 12 }) {
  const path = productPath(product);
  const page = await fetchJson(`${path}?layout_container=pdpPage2column&layout_page_index=2`);
  return { product: productSku(product), ...parseRelatedProducts(page, limit) };
}

export async function searchFilters({ query }) {
  if (!query || !String(query).trim()) throw new Error("query is required");
  const page = await fetchJson(`/search/?text=${encodeURIComponent(query)}&from_global=true`);
  return parseSearchFilters(page, query);
}

export async function location() {
  return getLocation();
}

export async function searchCitiesTool({ query, limit = 10 }) {
  if (!query || !String(query).trim()) throw new Error("query is required (min 1 character)");
  return searchCities(String(query).trim(), limit);
}

export async function setLocation({ city, lat, lng }) {
  if (!city || !String(city).trim()) throw new Error("city is required");
  return setCity(String(city).trim(), { lat, lng });
}

export const _paths = { productPath, productSku, catalogPath };
