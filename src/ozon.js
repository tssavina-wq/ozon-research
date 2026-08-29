// High-level Ozon operations: build composer-api paths, fetch via the browser, parse to plain data.
import { fetchJson, fetchUrl, getLocation, searchCities, setCity } from "./browser.js";
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
  parseCatalogMenu,
  parseCategoryChild,
  dedupeSearchItems,
  annotateReviewTrust,
  modelKey,
  baseModelKey,
  extractHardwareHints,
  findLayoutWidget,
  parseDelivery,
} from "./parse.js";
import { wantCompact, applyCompact } from "./compact.js";
import {
  filtersNeedResolve,
  resolveFilterTitles,
  serializeFilters,
  mergeFilterParams,
  looksResolvedFilterValue,
  categoryIdFromValue,
} from "./filters.js";
import { _internal } from "./parse.js";

const { skuFromUrl } = _internal;

function maybeCompact(kind, result, args) {
  if (!wantCompact(args)) {
    if (result && typeof result === "object") return { ...result, compact: false };
    return result;
  }
  return applyCompact(kind, result);
}

const WIDGET_JSON_V2 = "https://www.ozon.ru/api/composer-api.bx/widget/json/v2";

/** Resolve async onPageLoad widgets (webDelivery lives here, not in initial page JSON). */
export async function fetchAsyncWidget(page, component) {
  const node = findLayoutWidget(page, component);
  if (!node?.asyncData) return null;
  let url = "/";
  try {
    const decoded = JSON.parse(Buffer.from(node.asyncData, "base64").toString("utf8"));
    if (decoded?.url) url = decoded.url;
  } catch {
    /* keep default */
  }
  return fetchUrl(WIDGET_JSON_V2, {
    method: "POST",
    body: { asyncData: node.asyncData, url },
  });
}

const SORT_MAP = {
  // IMPORTANT: Ozon `sorting=popular` returns an EMPTY tile grid for many queries.
  // Default popularity is "no sorting param".
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

function brandTokens(query) {
  return String(query || "")
    .trim()
    .toLowerCase()
    .replace(/-\d+$/, "")
    .split(/[^a-z0-9а-яё]+/i)
    .filter(Boolean);
}

function stemMatchesBrand(stem, tokens) {
  if (!stem || !tokens.length) return false;
  const flat = stem.replace(/-/g, "").toLowerCase();
  const joined = tokens.join("");
  const dashed = tokens.join("-");
  return (
    stem.toLowerCase() === dashed ||
    flat === joined ||
    (tokens.length > 1 && tokens.every((t) => stem.toLowerCase().includes(t)))
  );
}

function extractBrandSlugFromSearch(page, query) {
  const tokens = brandTokens(query);
  if (!tokens.length) return null;
  const blob = JSON.stringify(page?.widgetStates || {});
  const brandPaths = [...blob.matchAll(/\/brand\/([a-z0-9-]+-\d+)\//gi)].map((m) => m[1]);
  const categoryBrandPaths = [...blob.matchAll(/\/category\/[^"'\\\s]+\/([a-z0-9-]+-\d+)\//gi)].map(
    (m) => m[1]
  );
  const candidates = [...new Set([...brandPaths, ...categoryBrandPaths])];
  for (const c of candidates) {
    const stem = c.replace(/-\d+$/, "");
    if (stemMatchesBrand(stem, tokens) && brandPaths.includes(c)) return c;
  }
  for (const c of candidates) {
    const stem = c.replace(/-\d+$/, "");
    if (stemMatchesBrand(stem, tokens)) return c;
  }
  // Brand filter id → guess slug-id (attack-shark-100867541)
  const filters = parseSearchFilters(page, query);
  const brandFilter = filters.filters?.find((f) => f.key === "brand");
  const opt = (brandFilter?.options || []).find((o) => {
    const t = brandTokens(o.title);
    return t.join("") === tokens.join("") || stemMatchesBrand(t.join("-"), tokens);
  });
  if (opt?.key && /^\d+$/.test(String(opt.key))) {
    return `${tokens.join("-")}-${opt.key}`;
  }
  return brandPaths[0] || null;
}

async function resolveBrandPath(brand) {
  const raw = String(brand || "").trim();
  if (!raw) throw new Error("brand is required");
  if (/^https?:\/\//.test(raw) || looksLikeBrandId(raw) || raw.startsWith("/brand/")) {
    return catalogPath(raw, "brand");
  }

  const hyphenated = brandTokens(raw).join("-");
  for (const candidate of [...new Set([raw, hyphenated].filter(Boolean))]) {
    try {
      const probe = await fetchJson(catalogPath(candidate, "brand"));
      const pageType = probe?.pageInfo?.pageTypeTracking || "";
      const organic = parseSearch(probe, 3).count;
      if ((pageType === "brand/landing" || pageType === "brand_customized") && organic > 0) {
        return catalogPath(candidate, "brand");
      }
    } catch (err) {
      if (!/HTTP 404/i.test(err?.message || "")) throw err;
    }
  }

  const searchPage = await fetchJson(`/search/?text=${encodeURIComponent(raw)}&from_global=true`);
  const slug = extractBrandSlugFromSearch(searchPage, raw);
  if (!slug) {
    throw new Error(
      `could not resolve brand "${raw}"; pass slug with id like "apple-26303000" or a /brand/... URL`
    );
  }
  // Verify guessed slug-id actually exists (filter-based guesses can 404)
  try {
    await fetchJson(`/brand/${slug}/`);
    return `/brand/${slug}/`;
  } catch (err) {
    if (!/HTTP 404/i.test(err?.message || "")) throw err;
    throw new Error(
      `could not resolve brand "${raw}" (tried /brand/${slug}/); pass slug with id like "apple-26303000"`
    );
  }
}

/** Ozon resolves /category/wrongstem-15721/ by numeric id only — validate stem vs page. */
function categoryStemId(value) {
  const m = String(value || "").match(/([a-z0-9-]+)-(\d+)\/?$/i);
  if (!m) return null;
  return { stem: m[1].toLowerCase(), id: m[2] };
}

function canonicalCategorySlug(page) {
  const brandsW = page?.widgetStates
    ? Object.entries(page.widgetStates).find(([k]) => k.startsWith("categoryBrandList"))
    : null;
  if (brandsW) {
    try {
      const data = typeof brandsW[1] === "string" ? JSON.parse(brandsW[1]) : brandsW[1];
      for (const b of data?.brands || []) {
        const m = String(b.action?.link || "").match(/\/category\/([a-z0-9-]+-\d+)\//i);
        if (m) return m[1];
      }
    } catch {
      /* ignore */
    }
  }
  const blob = JSON.stringify(page?.widgetStates || {});
  const m = blob.match(/\/category\/([a-z0-9-]+-\d+)\//i);
  return m ? m[1] : null;
}

function assertCategorySlug(categoryInput, page) {
  const requested = categoryStemId(catalogPath(categoryInput, "category"));
  if (!requested) return;
  const canonical = canonicalCategorySlug(page);
  const got = categoryStemId(canonical);
  if (!got || got.id !== requested.id || got.stem === requested.stem) return;
  const title = String(page?.seo?.title || "")
    .split(/[-–|]/)[0]
    .trim();
  throw new Error(
    `category slug mismatch: "${requested.stem}-${requested.id}" is not a real category — ` +
      `Ozon id ${requested.id} is "${got.stem}-${got.id}"` +
      `${title ? ` ("${title}")` : ""}. ` +
      `Ozon ignores the text prefix and uses the numeric id. ` +
      `Get the real slug from ozon_search_filters (active category URL), e.g. "${got.stem}-${got.id}".`
  );
}

function appendCatalogParams(url, { sort = "popular", priceMin, priceMax, page } = {}) {
  let out = url.includes("?") ? url : `${url}${url.endsWith("/") ? "" : "/"}`;
  const sorting = SORT_MAP[sort];
  const params = new URLSearchParams(out.includes("?") ? out.split("?")[1] : "");
  if (sorting) params.set("sorting", sorting);
  if (priceMin != null || priceMax != null) {
    const min = priceMin ?? 0;
    const max = priceMax ?? 99999999;
    params.set("currency_price", `${min}.000;${max}.000`);
  }
  if (page != null && page > 1) params.set("page", String(page));
  const base = out.split("?")[0];
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Build catalog URL with sort/price + arbitrary Ozon filters. */
async function buildCatalogUrl({
  query,
  category,
  sort = "popular",
  priceMin,
  priceMax,
  page,
  filters,
}) {
  let applied = filters && typeof filters === "object" ? { ...filters } : {};
  let base;
  if (category) {
    base = catalogPath(category, "category");
  } else if (query) {
    base = `/search/?text=${encodeURIComponent(query)}&from_global=true`;
  } else if (applied.category) {
    base = null; // filled after resolve
  } else {
    throw new Error("query or category is required");
  }

  if (filtersNeedResolve(applied) || (!category && applied.category && !/^[a-z0-9-]+-\d+$/i.test(String(applied.category)))) {
    let probeBase = base;
    if (!probeBase) {
      if (query) {
        probeBase = `/search/?text=${encodeURIComponent(query)}&from_global=true`;
      } else if (looksResolvedFilterValue(applied.category)) {
        probeBase = catalogPath(String(applied.category), "category");
      } else {
        probeBase = `/search/?text=${encodeURIComponent(String(applied.category))}&from_global=true`;
      }
    }
    const probe = await fetchJson(appendCatalogParams(probeBase, { sort, priceMin, priceMax }));
    const catalog = parseSearchFilters(probe, query || "");
    applied = resolveFilterTitles(applied, catalog);
  }

  const { category: catFromFilters, params: filterParams } = serializeFilters(applied);
  const cat = category || catFromFilters;
  if (cat) {
    base = catalogPath(cat, "category");
  } else if (!base) {
    if (!query) throw new Error("query or category is required");
    base = `/search/?text=${encodeURIComponent(query)}&from_global=true`;
  }

  let url = appendCatalogParams(base, { sort, priceMin, priceMax, page });
  url = mergeFilterParams(url, filterParams);
  return { url, category: cat || null, appliedFilters: applied };
}

function finalizeItems(
  parsed,
  {
    limit = 12,
    dedupeVariants = true,
    dedupeConfigs = true,
    excludeBrands = [],
    minReviews,
  } = {}
) {
  let items = parsed.items || [];
  const exclude = (excludeBrands || []).map((b) => String(b).toLowerCase().trim()).filter(Boolean);
  if (exclude.length) {
    items = items.filter((it) => {
      const brand = String(it.brand || "").toLowerCase();
      const name = String(it.name || "").toLowerCase();
      return !exclude.some((b) => brand.includes(b) || name.includes(b));
    });
  }
  if (minReviews != null) {
    items = items.filter((it) => (it.reviews || 0) >= minReviews);
  }
  if (dedupeVariants || dedupeConfigs) {
    items = dedupeSearchItems(items, { colors: dedupeVariants, configs: dedupeConfigs });
  } else {
    items = annotateReviewTrust(
      items.map((it) => ({
        ...it,
        modelKey: it.modelKey || modelKey(it),
        baseModelKey: it.baseModelKey || baseModelKey(it),
      }))
    );
  }
  items = items.slice(0, limit);
  const cross = items.filter((i) => i.reviewsSharedAcrossModels).length;
  const warnings = [];
  if (cross >= 2) {
    warnings.push(
      `${cross} items share the same rating/review count across different baseModelKey values ` +
        `(reviewsSharedAcrossModels) — unusual; verify they are not unrelated listings. ` +
        `Same count on color/RAM variants of one model is normal (variantReviewPool).`
    );
  }
  return {
    items,
    count: items.length,
    sponsoredOnly: parsed.sponsoredOnly || false,
    dedupeVariants: Boolean(dedupeVariants),
    dedupeConfigs: Boolean(dedupeConfigs),
    warnings,
  };
}

export async function search({
  query,
  category,
  sort = "popular",
  priceMin,
  priceMax,
  page = 1,
  filters,
  limit = 8,
  dedupeVariants = true,
  dedupeConfigs = true,
  excludeBrands,
  minReviews,
  compact,
  rich,
} = {}) {
  if ((!query || !String(query).trim()) && !category && !(filters && filters.category)) {
    throw new Error("query or category is required");
  }
  const q = query ? String(query).trim() : undefined;
  const fetchLimit = dedupeVariants || dedupeConfigs ? Math.min(36, Math.max(limit * 3, limit)) : limit;

  const built = await buildCatalogUrl({
    query: q,
    category,
    sort,
    priceMin,
    priceMax,
    page,
    filters,
  });
  let pageData = await fetchJson(built.url);
  if (built.category) assertCategorySlug(built.category, pageData);

  let sortUsed = sort;
  let parsed = parseSearch(pageData, fetchLimit);
  let note = null;

  // Ozon "popular" (no sorting / ads shelf) is often empty or ads-only with price filters.
  // Prefer organic rating results instead of making the agent guess.
  if (sort === "popular" && (parsed.count === 0 || parsed.sponsoredOnly)) {
    const alt = await buildCatalogUrl({
      query: q,
      category: built.category || category,
      sort: "rating",
      priceMin,
      priceMax,
      page,
      filters: built.appliedFilters,
    });
    const altPage = await fetchJson(alt.url);
    const altParsed = parseSearch(altPage, fetchLimit);
    if (altParsed.count > 0 && (parsed.count === 0 || !altParsed.sponsoredOnly)) {
      pageData = altPage;
      parsed = altParsed;
      sortUsed = "rating";
      note =
        "sort=popular returned empty or ads-only results with these filters; automatically used sort=rating (not a true popularity signal)";
    }
  }

  const finalized = finalizeItems(parsed, {
    limit,
    dedupeVariants,
    dedupeConfigs,
    excludeBrands,
    minReviews,
  });
  const out = {
    query: q || null,
    category: built.category,
    sort: sortUsed,
    page: page || 1,
    filters:
      built.appliedFilters && Object.keys(built.appliedFilters).length
        ? built.appliedFilters
        : undefined,
    count: finalized.count,
    items: finalized.items,
    dedupeVariants: finalized.dedupeVariants,
    dedupeConfigs: finalized.dedupeConfigs,
  };
  if (sortUsed !== sort) out.requestedSort = sort;
  if (finalized.sponsoredOnly) out.sponsoredOnly = true;
  if (note) out.note = note;
  if (finalized.warnings?.length) out.warnings = finalized.warnings;

  if (finalized.count === 0) {
    const filt = parseSearchFilters(pageData, q || "");
    const cat = filt.filters?.find((f) => f.key === "category");
    const active = (cat?.options || []).find((o) => o.active && /\/category\//.test(o.url || ""));
    const slug = active?.url?.match(/\/category\/([^/?#]+)/)?.[1];
    if (slug) {
      out.hint =
        `No products parsed for this query; Ozon maps it to category "${slug}". ` +
        `Try ozon_category_browse({ category: "${slug}" }) or ozon_search_filters.`;
      out.suggestedCategory = slug;
    } else {
      out.hint =
        "No products found. Try ozon_search_filters for filter keys, loosen filters, excludeBrands, or page=2.";
    }
  }
  return maybeCompact("search", out, { compact, rich });
}

export async function details({ product, compact, rich } = {}) {
  const path = productPath(product);
  const [basePage, page2] = await Promise.all([
    fetchJson(path),
    fetchJson(`${path}?layout_container=pdpPage2column&layout_page_index=2`),
  ]);
  const d = parseDetails(basePage, page2);
  try {
    const raw = await fetchAsyncWidget(basePage, "webDelivery");
    const delivery = parseDelivery(raw);
    if (delivery.options.length || delivery.summary) d.delivery = delivery;
  } catch (err) {
    d.delivery = {
      title: null,
      options: [],
      addressHint: null,
      best: null,
      summary: null,
      error: err?.message || String(err),
    };
  }
  return maybeCompact("details", d, { compact, rich });
}

export async function reviews({
  product,
  sku,
  limit = 10,
  sort = "helpful",
  hasPhotos = false,
  variantOnly = true,
  compact,
  rich,
} = {}) {
  const id = product || sku;
  const path = productPath(id);
  // reviewsVariantMode=1 → Ozon UI «Этот вариант»; =2 → all sibling variants on the card.
  const mode = variantOnly ? 1 : 2;
  const page = await fetchJson(`${path}reviews/?reviewsVariantMode=${mode}`);
  const parsed = parseReviews(page, limit, {
    sort,
    hasPhotos,
    productSku: productSku(id),
    variantOnly: Boolean(variantOnly),
  });
  return maybeCompact("reviews", parsed, { compact, rich });
}

export async function questions({ product, limit = 10 }) {
  const path = productPath(product);
  const page = await fetchJson(`${path}questions/`);
  return parseQuestions(page, limit);
}

export async function offers({
  product,
  sort = "price",
  limit = 12,
  includeCurrent = true,
  compact,
  rich,
} = {}) {
  const sku = productSku(product);
  if (!sku) throw new Error("could not resolve product sku");
  const offerSort = OFFERS_SORT_MAP[sort] || "price";
  const page = await fetchJson(`/modal/otherOffersFromSellers?product_id=${sku}&sort=${offerSort}`);
  const parsed = parseOffers(page, includeCurrent ? Math.max(0, limit - 1) : limit);

  if (includeCurrent) {
    try {
      // Always load full details for current row; outer compact applied below.
      const current = await details({ product: sku, compact: false });
      const currentRow = {
        sellerId: null,
        sku: current.sku || sku,
        name: current.seller?.name || null,
        rating: current.seller?.rating ?? null,
        reviews: null,
        price: current.price ?? null,
        delivery: current.delivery?.summary || current.delivery?.best?.text || null,
        advantages: (current.delivery?.options || []).map((o) => ({
          key: o.kind,
          text: o.text,
          icon: null,
        })),
        isCurrentListing: true,
        sellerUrl: current.seller?.url || null,
        productUrl: current.url || null,
        image: current.images?.[0] || null,
      };
      const rest = parsed.sellers.filter(
        (s) =>
          !(
            s.sku === currentRow.sku &&
            s.price === currentRow.price &&
            String(s.name || "").toLowerCase() === String(currentRow.name || "").toLowerCase()
          )
      );
      parsed.sellers = [currentRow, ...rest].slice(0, limit);
      parsed.count = parsed.sellers.length;
      parsed.location = current.location || parsed.location;
      parsed.currentDelivery = current.delivery || null;
    } catch (err) {
      parsed.currentListingError = err?.message || String(err);
    }
  }

  return maybeCompact("offers", { product: sku, includeCurrent: Boolean(includeCurrent), ...parsed }, {
    compact,
    rich,
  });
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

export async function sellerCatalog({
  seller,
  sort = "popular",
  priceMin,
  priceMax,
  limit = 12,
  compact,
  rich,
}) {
  const path = appendCatalogParams(catalogPath(seller, "seller"), { sort, priceMin, priceMax });
  const page = await fetchJson(path);
  return maybeCompact("sellerCatalog", parseSellerCatalog(page, limit), { compact, rich });
}

export async function categoryBrowse({
  category,
  sort = "popular",
  priceMin,
  priceMax,
  page = 1,
  filters,
  limit = 12,
  dedupeVariants = true,
  dedupeConfigs = true,
  excludeBrands,
  minReviews,
  compact,
  rich,
} = {}) {
  const fetchLimit = dedupeVariants || dedupeConfigs ? Math.min(36, Math.max(limit * 3, limit)) : limit;
  const { url, category: resolvedCategory, appliedFilters } = await buildCatalogUrl({
    category,
    sort,
    priceMin,
    priceMax,
    page,
    filters,
  });
  let pageData = await fetchJson(url);
  assertCategorySlug(resolvedCategory || category, pageData);
  let sortUsed = sort;
  let parsed = parseSearch(pageData, fetchLimit);
  let note = null;

  if (sort === "popular" && (parsed.count === 0 || parsed.sponsoredOnly)) {
    const alt = await buildCatalogUrl({
      category: resolvedCategory || category,
      sort: "rating",
      priceMin,
      priceMax,
      page,
      filters: appliedFilters,
    });
    const altPage = await fetchJson(alt.url);
    const altParsed = parseSearch(altPage, fetchLimit);
    if (altParsed.count > 0 && (parsed.count === 0 || !altParsed.sponsoredOnly)) {
      pageData = altPage;
      parsed = altParsed;
      sortUsed = "rating";
      note =
        "sort=popular returned empty or ads-only results; automatically used sort=rating (not a true popularity signal)";
    }
  }

  const finalized = finalizeItems(parsed, {
    limit,
    dedupeVariants,
    dedupeConfigs,
    excludeBrands,
    minReviews,
  });
  const meta = parseCategoryBrowse(pageData, fetchLimit);
  const out = {
    ...meta,
    sort: sortUsed,
    page: page || 1,
    requestedSort: sortUsed !== sort ? sort : undefined,
    note: note || undefined,
    warnings: finalized.warnings?.length ? finalized.warnings : undefined,
    filters: appliedFilters && Object.keys(appliedFilters).length ? appliedFilters : undefined,
    count: finalized.count,
    items: finalized.items,
    dedupeVariants: finalized.dedupeVariants,
    dedupeConfigs: finalized.dedupeConfigs,
    sponsoredOnly: finalized.sponsoredOnly || undefined,
  };
  return maybeCompact("browse", out, { compact, rich });
}

export async function brandCatalog({
  brand,
  sort = "popular",
  priceMin,
  priceMax,
  filters,
  limit = 12,
  compact,
  rich,
}) {
  const brandPath = await resolveBrandPath(brand);
  let applied = filters && typeof filters === "object" ? { ...filters } : {};
  if (filtersNeedResolve(applied)) {
    const probe = await fetchJson(appendCatalogParams(brandPath, { sort, priceMin, priceMax }));
    applied = resolveFilterTitles(applied, parseSearchFilters(probe, brand));
  }
  const { params: filterParams } = serializeFilters(applied);
  let url = appendCatalogParams(brandPath, { sort, priceMin, priceMax });
  url = mergeFilterParams(url, filterParams);
  const page = await fetchJson(url);
  const result = parseBrandCatalog(page, limit);
  if (Object.keys(applied).length) result.filters = applied;
  return maybeCompact("brand", result, { compact, rich });
}

export async function relatedProducts({ product, limit = 12, compact, rich }) {
  const path = productPath(product);
  const page = await fetchJson(`${path}?layout_container=pdpPage2column&layout_page_index=2`);
  return maybeCompact(
    "related",
    { product: productSku(product), ...parseRelatedProducts(page, limit) },
    { compact, rich }
  );
}

/** Compare 2–8 products: details + fullest specs widget in one matrix. */
export async function compareProducts({ products, compact, rich }) {
  const list = [
    ...new Set((products || []).map((p) => String(p || "").trim()).filter(Boolean)),
  ];
  if (list.length < 2) throw new Error("products requires at least 2 items (sku, url, or slug)");
  if (list.length > 8) throw new Error("products supports at most 8 items");

  async function loadOne(product) {
    const path = productPath(product);
    const skuHint = productSku(product);
    const [basePage, page2, featuresPage] = await Promise.all([
      fetchJson(path),
      fetchJson(`${path}?layout_container=pdpPage2column&layout_page_index=2`),
      fetchJson(`${path}features/`),
    ]);
    const d = parseDetails(basePage, page2);
    let s = parseSpecs(featuresPage);
    // If we accidentally hit the short characteristics widget / empty features, retry once.
    if ((s.fieldCount || 0) < 8) {
      const retry = await fetchJson(`${path}features/`);
      const s2 = parseSpecs(retry);
      if ((s2.fieldCount || 0) > (s.fieldCount || 0)) s = s2;
    }
    const short = d.characteristics || {};
    const full = s.characteristics || {};
    const characteristics = { ...short, ...full };
    const extracted =
      extractHardwareHints(d.name, "", characteristics) || d.extracted;
    return {
      sku: d.sku || skuHint,
      name: d.name,
      price: d.price,
      oldPrice: d.oldPrice,
      rating: d.rating,
      reviews: d.reviews,
      available: d.available,
      url: d.url,
      seller: d.seller,
      location: d.location,
      fieldCount: Object.keys(characteristics).length,
      sparse: Object.keys(characteristics).length > 0 && Object.keys(characteristics).length < 8,
      specsIncomplete:
        Object.keys(characteristics).length === 0 || Object.keys(characteristics).length < 8,
      characteristics,
      extracted: Object.keys(extracted || {}).length ? extracted : undefined,
      error: null,
    };
  }

  const rows = [];
  for (const product of list) {
    try {
      rows.push(await loadOne(product));
    } catch (err) {
      rows.push({
        sku: productSku(product) || product,
        name: null,
        price: null,
        characteristics: {},
        fieldCount: 0,
        sparse: true,
        specsIncomplete: true,
        error: err?.message || String(err),
      });
    }
  }

  const keys = new Set();
  for (const r of rows) {
    for (const k of Object.keys(r.characteristics || {})) keys.add(k);
  }
  const allKeys = [...keys].sort((a, b) => a.localeCompare(b, "ru"));
  const matrix = {};
  for (const key of allKeys) {
    matrix[key] = {};
    for (const r of rows) {
      matrix[key][r.sku] = r.characteristics?.[key] ?? null;
    }
  }

  const missingKeysByProduct = {};
  for (const r of rows) {
    missingKeysByProduct[r.sku] = allKeys.filter((k) => r.characteristics?.[k] == null);
  }

  const out = {
    count: rows.length,
    products: rows,
    matrix,
    missingKeysByProduct,
    note: rows.some((r) => r.sparse || r.specsIncomplete)
      ? "Some listings have sparse specs — check extracted{} (title/characteristics only; GPU never from description) and prefer another SKU of the same model."
      : null,
  };
  return maybeCompact("compare", out, { compact, rich });
}

const CATEGORY_CHILD_V3 =
  "https://www.ozon.ru/api/composer-api.bx/_action/v2/categoryChildV3";

async function loadCatalogMenu() {
  const page = await fetchJson("/");
  const menu = parseCatalogMenu(page);
  if (!menu.menuId || !menu.categories.length) {
    throw new Error("catalog menu not available from Ozon homepage");
  }
  return menu;
}

/**
 * Live category directory (no hardcoded slugs).
 * - no args → top departments from homepage catalogMenu
 * - parent → children via categoryChildV3 (parent = slug, id, URL, or title)
 * - query → category facet from search (title + slug for that query)
 */
export async function listCategories({ parent, query, limit = 60, compact, rich } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 60, 1), 120);

  if (query && String(query).trim()) {
    const url = `/search/?text=${encodeURIComponent(String(query).trim())}&from_global=true`;
    const page = await fetchJson(url);
    const parsed = parseSearchFilters(page, String(query).trim());
    const categories = (parsed.categories || []).filter((c) => c.slug).slice(0, lim);
    return maybeCompact(
      "categories",
      {
        query: String(query).trim(),
        count: categories.length,
        categories,
        note:
          categories.length === 0
            ? "No category facet for this query — try ozon_list_categories without args, then drill with parent."
            : "Copy slug into ozon_category_browse / ozon_search.category — do not invent stems.",
      },
      { compact, rich }
    );
  }

  const menu = await loadCatalogMenu();

  if (!parent || !String(parent).trim()) {
    return maybeCompact(
      "categories",
      {
        level: "root",
        menuId: menu.menuId,
        count: menu.categories.length,
        categories: menu.categories.slice(0, lim),
        note: "Top departments. Pass parent=slug (or title/id) to list children.",
      },
      { compact, rich }
    );
  }

  const raw = String(parent).trim();
  let categoryId = categoryIdFromValue(raw);
  let matched = null;

  if (!categoryId) {
    matched = menu.categories.find(
      (c) =>
        c.title &&
        (c.title.toLowerCase() === raw.toLowerCase() ||
          c.slug?.toLowerCase() === raw.toLowerCase())
    );
    if (matched) categoryId = matched.id || categoryIdFromValue(matched.slug);
  } else {
    matched = menu.categories.find((c) => c.id === categoryId || categoryIdFromValue(c.slug) === categoryId);
  }

  if (!categoryId) {
    throw new Error(
      `unknown category parent "${raw}" — use a slug/id from ozon_list_categories() or a title of a top department`
    );
  }

  const childUrl = `${CATEGORY_CHILD_V3}?menuId=${encodeURIComponent(menu.menuId)}&categoryId=${encodeURIComponent(categoryId)}`;
  const payload = await fetchUrl(childUrl);
  const parsed = parseCategoryChild(payload, { limit: lim });
  if (matched && !parsed.parent.title) {
    parsed.parent = { ...parsed.parent, ...matched, id: categoryId };
  } else if (!parsed.parent.id) {
    parsed.parent = { ...parsed.parent, id: categoryId };
  }

  return maybeCompact(
    "categories",
    {
      level: "child",
      menuId: menu.menuId,
      parent: parsed.parent,
      count: parsed.count,
      categories: parsed.categories,
      note: "Copy slug into ozon_category_browse / ozon_search.category — do not invent stems.",
    },
    { compact, rich }
  );
}

export async function searchFilters({ query, category, compact, rich } = {}) {
  if ((!query || !String(query).trim()) && !category) {
    throw new Error("query or category is required");
  }
  let url;
  if (category) {
    url = catalogPath(category, "category");
  } else {
    url = `/search/?text=${encodeURIComponent(query)}&from_global=true`;
  }
  const page = await fetchJson(url);
  if (category) assertCategorySlug(category, page);
  return maybeCompact("filters", parseSearchFilters(page, query || category), { compact, rich });
}

export async function location() {
  return getLocation();
}

export async function searchCitiesTool({ query, limit = 10 }) {
  if (!query || !String(query).trim()) throw new Error("query is required (min 1 character)");
  return searchCities(String(query).trim(), limit);
}

export async function setLocation({ city, lat, lng, address } = {}) {
  if (!city || !String(city).trim()) throw new Error("city is required");
  const query = address && String(address).trim()
    ? `${String(city).trim()}, ${String(address).trim()}`
    : String(city).trim();
  // Pass fuller query as city so suggest resolves near the street/PVZ area.
  return setCity(query, { lat, lng });
}

export const _paths = { productPath, productSku, catalogPath };
