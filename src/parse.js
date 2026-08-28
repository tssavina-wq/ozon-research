// Pure parsers over Ozon's composer-api JSON. No browser, no network —
// each function takes a composer-api response and returns plain data.

/**
 * widgetStates keys look like "webPrice-3121879-default-1". Match by the exact widget NAME
 * (the part before the first "-"), so "webPrice" doesn't also match "webPriceDecreasedCompact".
 */
function widgetName(key) {
  return String(key).split("-")[0];
}

function widget(page, name) {
  const ws = page?.widgetStates || {};
  const key = Object.keys(ws).find((k) => widgetName(k) === name);
  if (!key) return null;
  try {
    return JSON.parse(ws[key]);
  } catch {
    return null;
  }
}

/** All widgets with the given exact widget name, parsed. */
function widgets(page, name) {
  const ws = page?.widgetStates || {};
  return Object.keys(ws)
    .filter((k) => widgetName(k) === name)
    .map((k) => {
      try {
        return JSON.parse(ws[k]);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** "53 022 ₽" -> 53022 ; null/garbage -> null */
function priceToNumber(text) {
  if (typeof text === "number" && Number.isFinite(text)) return Math.round(text);
  if (typeof text !== "string") return null;
  const digits = text.replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : null;
}

/** Composer page.location.current → { city, region } for delivery context. */
export function parseLocation(page) {
  const cur = page?.location?.current;
  if (!cur) return null;
  const city = cur.city || cur.name || null;
  let region = null;
  const full = cur.fullName || "";
  if (full.startsWith("{{")) {
    const inner = full.split("|")[0].replace(/^\{+/, "").trim();
    const parts = inner.split(",").map((s) => s.trim());
    if (parts.length >= 2) region = parts[1];
  } else if (full.includes(",")) {
    const parts = full.split(",").map((s) => s.trim());
    if (parts[0] === "Россия" && parts.length >= 2) region = parts[1];
    else if (parts.length >= 2) region = parts[0] === city ? parts[1] : parts[0];
  }
  return { city, region };
}

/** strip ?at=... tracking and make absolute */
function cleanUrl(link) {
  if (!link) return null;
  const path = String(link).split("?")[0];
  return path.startsWith("http") ? path : `https://www.ozon.ru${path}`;
}

/** pull the numeric sku out of a product url/slug: ...-1185261285/ -> "1185261285" */
function skuFromUrl(url) {
  const m = String(url || "").match(/-(\d+)\/?(?:\?|$)/) || String(url || "").match(/(\d{6,})/);
  return m ? m[1] : null;
}

// ── search ─────────────────────────────────────────────────────────────────────
// Products live in the `tileGridDesktop-*` widget as `items[]`. Each item carries a
// `mainState[]` array of typed blocks (priceV2 / textDS name / labelListV2 rating).

function parseSearchItem(it) {
  if (!it) return null;
  const ms = Array.isArray(it.mainState) ? it.mainState : [];

  // price block
  const priceBlock = ms.find((s) => s.type === "priceV2")?.priceV2;
  const prices = priceBlock?.price || [];
  const price = priceToNumber(prices.find((p) => p.textStyle === "PRICE")?.text);
  const oldPrice = priceToNumber(prices.find((p) => p.textStyle === "ORIGINAL_PRICE")?.text);

  // name block (id === "name")
  const name = ms.find((s) => s.id === "name")?.textDS?.text || null;

  // rating block: a labelListV2 that contains a star icon
  let rating = null;
  let reviews = null;
  const ratingList = ms.find(
    (s) => s.labelListV2 && JSON.stringify(s.labelListV2).includes("ic_s_star")
  )?.labelListV2?.items;
  if (Array.isArray(ratingList)) {
    const texts = ratingList.filter((x) => x.type === "text").map((x) => x.text?.text);
    // first text after the star = rating, the one after the dialog icon = review count
    if (texts[0]) rating = parseFloat(String(texts[0]).replace(",", "."));
    if (texts[1]) reviews = priceToNumber(texts[1]);
  }

  // brand: a labelListV2 that is not the rating block; take its first text item, but skip
  // marketing badges ("Стало дешевле", "Оригинал", "Хит", price-drop labels, etc.)
  const BADGE = /^(стало дешевле|оригинал|хит|новинка|акция|распродажа|выбор|бестселлер|ozon|premium|самовывоз|скидка)/i;
  let brand = null;
  const labelLists = ms
    .filter((s) => s.labelListV2 && !JSON.stringify(s.labelListV2).includes("ic_s_star"))
    .map((s) => s.labelListV2);
  for (const ll of labelLists) {
    const cand = (ll.items || []).find((x) => x.type === "text")?.text?.text?.trim();
    if (cand && !BADGE.test(cand)) {
      brand = cand;
      break;
    }
  }

  const url = cleanUrl(it.action?.link);
  const sku = String(it.sku || it.id || skuFromUrl(url) || "") || null;

  // first image
  const image =
    it.tileImage?.items?.find((x) => x.image?.link)?.image?.link ||
    it.tileImage?.coverImage ||
    null;

  if (!sku || !price) return null; // a real product always has both
  return {
    sku,
    name,
    price,
    oldPrice: oldPrice && oldPrice > price ? oldPrice : null,
    discount: priceBlock?.discount || null,
    rating,
    reviews,
    brand,
    url,
    image,
  };
}

/** True if tile looks like paid placement (Ozon puts advertLite in tracking). */
function isAdTile(it) {
  const customs = [];
  const c1 = it?.trackingInfo?.click?.custom;
  if (c1) customs.push(c1);
  for (const btn of it?.topRightButtons || []) {
    const c = btn?.favoriteProductMoleculeV2?.trackingInfo?.click?.custom;
    if (c) customs.push(c);
  }
  return customs.some((c) => c.advertLite || c.advId || c.advert);
}

/** Pick the best product grid: catalog page grids over ad carousels. */
function pickTileGrid(page) {
  const grids = widgets(page, "tileGridDesktop");
  if (!grids.length) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const g of grids) {
    const items = g.items || [];
    if (!items.length) continue;
    const ads = items.filter(isAdTile).length;
    const organic = items.length - ads;
    // Real catalog grids often expose `page`; ad shelves are almost all advertLite
    const score = (g.page != null ? 1000 : 0) + organic * 10 - ads * 20;
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best || grids[0];
}

export function parseSearch(page, limit = 12) {
  const grid = pickTileGrid(page);
  const all = grid?.items || [];
  const organic = all.filter((it) => !isAdTile(it));
  // Popular queries often land on a category shelf where every tile is advertLite —
  // filtering them all would return an empty list while the page is full of products.
  const raw = organic.length ? organic : all;
  const items = raw.map(parseSearchItem).filter(Boolean).slice(0, limit);
  return {
    count: items.length,
    items,
    sponsoredOnly: Boolean(organic.length === 0 && items.length > 0),
  };
}

/** Extract plain text from Ozon DS text nodes. */
function textField(obj) {
  if (!obj) return null;
  if (typeof obj === "string") return obj;
  return obj.text ?? null;
}

function parseBreadcrumbs(page) {
  const w = widget(page, "breadCrumbs");
  return (w?.breadcrumbs || []).map((b) => ({
    title: b.text,
    url: cleanUrl(b.link),
  }));
}

function parseCatalogMeta(page, limit, extra = {}) {
  const { items, count } = parseSearch(page, limit);
  const header = widget(page, "resultsHeader");
  return {
    ...extra,
    title: header?.title || extra.title || null,
    breadcrumbs: parseBreadcrumbs(page),
    count,
    items,
  };
}

// ── product details ─────────────────────────────────────────────────────────────
// Base PDP page carries webPrice / webProductHeading / webGallery / webReviewProductScore /
// webShortCharacteristics / webCurrentSeller. The description (webDescription) lives on
// the `pdpPage2column` page (page index 2), so details merges two pages.

/** join an array of rich-text nodes ({text}|{content}) into a plain string */
function rsText(arr) {
  return (arr || [])
    .map((v) => v.text || v.content)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseShortCharacteristics(page) {
  const w = widget(page, "webShortCharacteristics");
  const out = {};
  // characteristics[] is a flat list; title.textRs[] = name, values[] = value(s)
  for (const c of w?.characteristics || []) {
    const title = rsText(c.title?.textRs) || (typeof c.title === "string" ? c.title : null);
    const value = rsText(c.values || c.contentRS || c.valueRs);
    if (title && value) out[title] = value;
  }
  return out;
}

/** product's own rating + review count, from webSingleProductScore: "4.9 • 819 отзывов" */
function parseProductScore(page) {
  const w = widget(page, "webSingleProductScore") || widget(page, "webReviewProductScore");
  const text = w?.text || JSON.stringify(w || {});
  let rating = null;
  let reviews = null;
  const rm = text.match(/(\d[.,]\d)/);
  if (rm) rating = parseFloat(rm[1].replace(",", "."));
  const cm = text.match(/(\d[\d\s]*)\s*отзыв/);
  if (cm) reviews = priceToNumber(cm[1]);
  return { rating, reviews };
}

function parseSeller(page) {
  const w = widget(page, "webCurrentSeller");
  if (!w) return null;
  const name = w.sellerCell?.centerBlock?.title?.text || w.title?.text || null;
  const rating = parseFloat(String(w.rating?.title?.text || "").replace(",", ".")) || null;
  const url = cleanUrl(w.sellerCell?.common?.action?.link);
  if (!name) return null;
  return { name, rating, url };
}

/** webDescription.richAnnotationJson holds rich content blocks: text items and images. */
export function parseDescription(page2) {
  const w = widgets(page2, "webDescription").find((x) => x.richAnnotationJson);
  if (!w) return { text: "", images: [] };
  let ra = w.richAnnotationJson;
  if (typeof ra === "string") {
    try {
      ra = JSON.parse(ra);
    } catch {
      return { text: "", images: [] };
    }
  }
  const texts = [];
  const images = [];
  const walk = (n) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n !== "object") return;
    if (n.type === "text" && typeof n.content === "string") texts.push(n.content);
    if (n.img?.src) images.push(n.img.src);
    if (Array.isArray(n.items))
      n.items.forEach((it) => {
        if (it?.type === "text" && typeof it.content === "string") texts.push(it.content);
      });
    for (const k in n) if (n[k] && typeof n[k] === "object") walk(n[k]);
  };
  walk(ra.content || ra);
  return {
    text: texts.join(" ").replace(/\s+/g, " ").trim(),
    images: [...new Set(images)],
  };
}

export function parseDetails(basePage, page2) {
  const heading = widget(basePage, "webProductHeading");
  const price = widget(basePage, "webPrice");
  const gallery = widget(basePage, "webGallery");

  const sku =
    String(gallery?.sku || basePage?.layoutTrackingInfo && JSON.parse(basePage.layoutTrackingInfo || "{}").sku || "") ||
    skuFromUrl(basePage?.seo?.link?.[0]?.href) ||
    null;

  const url =
    cleanUrl(basePage?.seo?.link?.[0]?.href) ||
    (sku ? `https://www.ozon.ru/product/${sku}/` : null);

  const { rating, reviews } = parseProductScore(basePage);

  const images = [];
  if (gallery?.coverImage) images.push(gallery.coverImage);
  for (const im of gallery?.images || []) {
    const src = im?.src || im?.image || im;
    if (typeof src === "string") images.push(src);
  }

  return {
    sku,
    name: heading?.title || basePage?.seo?.title || null,
    url,
    price: priceToNumber(price?.cardPrice) ?? priceToNumber(price?.price),
    priceRegular: priceToNumber(price?.price),
    oldPrice: priceToNumber(price?.originalPrice),
    available: price?.isAvailable ?? null,
    rating,
    reviews,
    seller: parseSeller(basePage),
    images: [...new Set(images)].slice(0, 10),
    characteristics: parseShortCharacteristics(basePage),
    description: parseDescription(page2),
    location: parseLocation(basePage),
  };
}

// ── reviews ─────────────────────────────────────────────────────────────────────
// webListReviews holds reviews[]; each has content.{comment,positive,negative,score},
// author, publishedAt (unix), usefulness, isItemPurchased.

function unixToDate(ts) {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function parseReviews(page, limit = 10) {
  const w = widget(page, "webListReviews");
  const raw = w?.reviews || w?.items || [];
  const { rating, reviews: total } = parseProductScore(page);

  const reviews = raw.slice(0, limit).map((r) => {
    const c = r.content || {};
    const author =
      r.author?.title ||
      [r.author?.firstName, r.author?.lastName].filter(Boolean).join(" ") ||
      (r.isAnonymous ? "Аноним" : null);
    return {
      author: author || null,
      score: typeof c.score === "number" ? c.score : null,
      comment: c.comment || "",
      pros: c.positive || "",
      cons: c.negative || "",
      date: unixToDate(r.publishedAt || r.createdAt),
      useful: r.usefulness?.useful ?? null,
      purchased: r.isItemPurchased ?? null,
      hasPhotos: Array.isArray(c.photos) && c.photos.length > 0,
    };
  });

  return { rating, totalReviews: total, count: reviews.length, reviews };
}

// ── questions ───────────────────────────────────────────────────────────────────

export function parseQuestions(page, limit = 10) {
  const w = widget(page, "webPDPListQuestions");
  const raw = w?.questions || [];
  const questions = raw.slice(0, limit).map((q) => ({
    id: q.questionUuid || null,
    author: textField(q.author?.name),
    date: textField(q.createdAt),
    text: textField(q.text),
    sku: q.itemId || null,
    answers: (q.answers || []).map((a) => ({
      id: a.answerUuid || null,
      author: textField(a.author?.name),
      date: textField(a.createdAt),
      text: textField(a.text),
      official: Boolean(a.author?.avatarUrl),
    })),
  }));
  return { count: questions.length, questions };
}

// ── offers from other sellers ───────────────────────────────────────────────────

function offersActiveSort(sortW) {
  const tab = (sortW?.tabs || []).find((t) => t.isActive || t.isSelected);
  if (!tab) return null;
  const deeplink = tab.deeplink || tab.link || "";
  const m = String(deeplink).match(/[?&]sort=([^&]+)/);
  if (m) return m[1];
  return tab.value || tab.title || null;
}

export function parseOffers(page, limit = 12) {
  const w = widget(page, "webSellerList");
  const sortW = widget(page, "webSellersSortSwitcher");
  const sellers = (w?.sellers || []).slice(0, limit).map((s) => ({
    sellerId: s.id || null,
    sku: String(s.sku || "") || null,
    name: s.name || null,
    rating: s.rating?.totalScore ?? null,
    reviews: s.rating?.reviewsCount ?? null,
    price:
      priceToNumber(s.price?.cardPrice?.price) ??
      priceToNumber(s.price?.price) ??
      priceToNumber(s.price?.originalPrice) ??
      null,
    delivery: rsText(s.advantages?.[0]?.contentRs?.headRs) || null,
    sellerUrl: cleanUrl(s.link),
    productUrl: cleanUrl(s.productLink),
    image: s.coverImage || null,
  }));
  return {
    sort: offersActiveSort(sortW),
    count: sellers.length,
    sellers,
    location: parseLocation(page),
  };
}

// ── variants (aspects) ──────────────────────────────────────────────────────────

export function parseVariants(page) {
  const w = widget(page, "webAspects");
  const brand = widget(page, "webBrand");
  const aspects = (w?.aspects || []).map((a) => ({
    name: a.aspectName || null,
    key: a.aspectKey || null,
    variants: (a.variants || []).map((v) => ({
      sku: String(v.sku || "") || null,
      label: rsText(v.data?.textRs) || v.data?.searchableText || null,
      price: typeof v.price === "number" ? v.price : priceToNumber(v.data?.price),
      oldPrice: priceToNumber(v.data?.originalPrice),
      available: v.availability === "inStock",
      active: Boolean(v.active),
      url: cleanUrl(v.link),
      image: v.data?.coverImage || v.data?.picture || null,
    })),
  }));
  return {
    brand: brand?.params?.title || textField(brand?.content?.description?.content?.text) || null,
    aspects,
  };
}

// ── full specs ──────────────────────────────────────────────────────────────────

export function parseSpecs(page) {
  const w = widget(page, "webCharacteristics");
  const characteristics = {};
  for (const block of w?.characteristics || []) {
    for (const item of block.short || []) {
      const name = item.name;
      const values = (item.values || []).map((v) => v.text).filter(Boolean);
      if (name && values.length) characteristics[name] = values.join(", ");
    }
  }
  const keys = Object.keys(characteristics);
  const totalCount = Number(w?.totalCount) || keys.length;
  return {
    totalCount,
    fieldCount: keys.length,
    sparse: keys.length > 0 && keys.length < 8,
    productTitle: w?.productTitle || null,
    characteristics,
    note:
      keys.length < 8
        ? "Seller left few specs on this listing; cross-check ozon_product_questions / title / other SKUs of the same model."
        : null,
  };
}

// ── seller ──────────────────────────────────────────────────────────────────────

export function parseSellerInfo(page) {
  const w = widget(page, "sellerTransparency");
  if (!w) return { name: null, logo: null, badges: [], infoUrl: null };
  return {
    name: w.title?.text || null,
    logo: w.logoImage?.backgroundImage || null,
    badges: (w.badges || []).map((b) => ({
      icon: b.leftIcon || null,
      label: b.common?.action?.link || null,
    })),
    infoUrl: cleanUrl(w.action?.link),
  };
}

export function parseSellerCatalog(page, limit = 12) {
  const seller = parseSellerInfo(page);
  const catalog = parseCatalogMeta(page, limit);
  return { seller, ...catalog };
}

// ── category / brand catalog ────────────────────────────────────────────────────

export function parseCategoryBrowse(page, limit = 12) {
  const brandsW = widget(page, "categoryBrandList");
  const catalog = parseCatalogMeta(page, limit);
  return {
    ...catalog,
    brands: (brandsW?.brands || []).slice(0, 24).map((b) => ({
      name: b.text,
      url: cleanUrl(b.action?.link),
      logo: b.logo || null,
    })),
  };
}

export function parseBrandCatalog(page, limit = 12) {
  const brandW = widget(page, "sellerTransparency");
  const seoTitle = page?.seo?.title || null;
  const brandName =
    brandW?.title?.text ||
    (typeof seoTitle === "string" ? seoTitle.split(/купить|–|-/)[0].trim() : null) ||
    null;
  const catalog = parseCatalogMeta(page, limit, { brand: brandName });
  return catalog;
}

// ── related products ────────────────────────────────────────────────────────────

export function parseRelatedProducts(page, limit = 12) {
  const w = widget(page, "tileScrollDesktop");
  const title = w?.header?.title?.text || "Покупают вместе";
  const items = (w?.items || []).map(parseSearchItem).filter(Boolean).slice(0, limit);
  return { title, count: items.length, items };
}

// ── search filters ──────────────────────────────────────────────────────────────

function parseFilterOption(item) {
  return {
    key: item.key || item.value || null,
    title: textField(item.title) || item.title || null,
    image: item.image || null,
  };
}

function parseFilterEntry(f) {
  const entry = { key: f.key, type: f.type };
  if (f.categoryFilter) {
    entry.title = f.categoryFilter.title;
    entry.options = (f.categoryFilter.categories || []).map((c) => ({
      title: c.title,
      url: cleanUrl(c.urlValue),
      active: Boolean(c.isActive),
    }));
  } else if (f.boolFilter) {
    entry.title = f.boolFilter.title;
    entry.type = "boolean";
  } else if (f.checkboxesFilter) {
    entry.title = f.checkboxesFilter.title;
    entry.options = [];
    for (const sec of f.checkboxesFilter.sections || []) {
      for (const item of sec.items || []) entry.options.push(parseFilterOption(item));
    }
  } else if (f.rangeFilter) {
    entry.title = f.rangeFilter.title;
    entry.type = "range";
    entry.min = f.rangeFilter.minValue ?? null;
    entry.max = f.rangeFilter.maxValue ?? null;
  } else if (f.multipleRangesFilter) {
    const mr = f.multipleRangesFilter;
    entry.title = mr.title || (f.key === "currency_price" ? "Цена" : f.key);
    entry.type = "range";
    entry.min = mr.minValue ?? mr.min ?? null;
    entry.max = mr.maxValue ?? mr.max ?? null;
  } else if (f.radioFilter) {
    entry.title = f.radioFilter.title;
    entry.options = (f.radioFilter.sections?.[0]?.items || f.radioFilter.items || []).map(parseFilterOption);
  } else if (f.colorFilter) {
    entry.title = f.colorFilter.title || "Цвет";
    entry.options = (f.colorFilter.colors || f.colorFilter.items || []).map((c) => ({
      key: c.key || c.value || null,
      title: textField(c.title) || c.name || c.text || null,
      image: c.image || null,
    }));
  }
  return entry;
}

export function parseSearchFilters(page, query) {
  const w = widget(page, "filtersDesktop");
  const active = widget(page, "searchResultsFiltersActive");
  const sort = widget(page, "searchResultsSort");

  const filters = [];
  for (const sec of w?.sections || []) {
    for (const f of sec.filters || []) {
      const entry = parseFilterEntry(f);
      if (entry.title || entry.options?.length) filters.push(entry);
    }
  }

  const activeFilters = (active?.activeFilters || []).map((af) => ({
    key: af.key,
    name: af.name,
    values: (af.activeValues || []).map((v) => v.name || v.value || v.key),
  }));

  const sortOptions = (sort?.sortButton?.options || []).map((o) => ({
    name: o.name,
    selected: o.isSelected === "True" || o.isSelected === true,
  }));

  return { query, filters, activeFilters, sortOptions };
}

export const _internal = { priceToNumber, cleanUrl, skuFromUrl, widget, parseSearchItem };
