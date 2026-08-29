/** Shrink MCP payloads for agent context. Default ON; pass compact:false or rich:true for full. */

export function wantCompact(args = {}) {
  if (args?.rich === true) return false;
  if (args?.compact === false) return false;
  return true;
}

const NAME_MAX = 140;
const FILTER_OPTIONS_MAX = 16;
/** Facets agents usually need first — brand/category/price only (no domain-specific hardcodes). */
const FILTER_PRIORITY = new Set(["brand", "category", "currency_price", "is_promo", "delivery"]);

export function clipName(name, max = NAME_MAX) {
  const s = String(name || "");
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function dropUndef(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** Compact one search/browse tile. */
export function compactSearchItem(it) {
  if (!it) return it;
  const out = {
    sku: it.sku,
    name: clipName(it.name),
    price: it.price,
    oldPrice: it.oldPrice ?? undefined,
    discount: it.discount ?? undefined,
    rating: it.rating ?? undefined,
    reviews: it.reviews ?? undefined,
    brand: it.brand ?? undefined,
    url: it.url ?? undefined,
  };
  if (it.reviewTrust && it.reviewTrust !== "unknown") out.reviewTrust = it.reviewTrust;
  if (it.reviewsSharedAcrossModels) out.reviewsSharedAcrossModels = true;
  if (it.variantReviewPool) out.variantReviewPool = true;
  // Only expose variant/config payloads when there are real siblings
  if ((it.variantCount || it.variants?.length || 0) > 1) {
    out.variantCount = it.variantCount || it.variants.length;
    out.variantSkus = (it.variantSkus || it.variants?.map((v) => v.sku) || []).filter(Boolean);
  }
  if ((it.configCount || it.configs?.length || 0) > 1) {
    out.configCount = it.configCount || it.configs.length;
    out.configs = (it.configs || []).map((c) =>
      dropUndef({
        sku: c.sku,
        label: c.label || clipName(c.name, 80),
        price: c.price,
      })
    );
  }
  return dropUndef(out);
}

export function compactItemList(result) {
  if (!result || typeof result !== "object") return result;
  const out = { ...result, compact: true };
  if (Array.isArray(out.items)) out.items = out.items.map(compactSearchItem);
  if (Array.isArray(out.brands) && out.brands.length > 12) {
    out.brands = out.brands.slice(0, 12);
    out.brandsTruncated = true;
  }
  // Drop heavy browse extras that agents rarely need in shortlists
  return out;
}

export function compactDetails(d) {
  if (!d || typeof d !== "object") return d;
  const seller = d.seller
    ? dropUndef({
        name: d.seller.name,
        rating: d.seller.rating,
        url: d.seller.url,
        isExpress: d.seller.isExpress || undefined,
        isOfficial: d.seller.isOfficial || undefined,
      })
    : null;
  const delivery = d.delivery
    ? dropUndef({
        summary: d.delivery.summary,
        best: d.delivery.best
          ? dropUndef({
              title: d.delivery.best.title,
              dateText: d.delivery.best.dateText,
              kind: d.delivery.best.kind,
              text: d.delivery.best.text,
            })
          : undefined,
        options: (d.delivery.options || []).map((o) =>
          dropUndef({ title: o.title, dateText: o.dateText, kind: o.kind, text: o.text })
        ),
        addressHint: d.delivery.addressHint,
        error: d.delivery.error,
      })
    : undefined;
  return dropUndef({
    compact: true,
    sku: d.sku,
    name: clipName(d.name, 180),
    url: d.url,
    price: d.price,
    priceRegular: d.priceRegular,
    oldPrice: d.oldPrice,
    available: d.available,
    rating: d.rating,
    reviews: d.reviews,
    seller,
    location: d.location,
    delivery,
    characteristics: d.characteristics,
    extracted: d.extracted,
    // omit images + full description in compact
    descriptionPreview: d.description?.text
      ? clipName(d.description.text.replace(/\s+/g, " "), 240)
      : undefined,
  });
}

export function compactCompare(result) {
  if (!result || typeof result !== "object") return result;
  const products = (result.products || []).map((p) =>
    dropUndef({
      sku: p.sku,
      name: clipName(p.name, 160),
      price: p.price,
      oldPrice: p.oldPrice,
      rating: p.rating,
      reviews: p.reviews,
      available: p.available,
      url: p.url,
      seller: p.seller?.name || p.seller || undefined,
      fieldCount: p.fieldCount,
      sparse: p.sparse || undefined,
      specsIncomplete: p.specsIncomplete || undefined,
      extracted: p.extracted,
      error: p.error,
      // characteristics omitted — use matrix
    })
  );
  return dropUndef({
    compact: true,
    count: result.count,
    products,
    matrix: result.matrix,
    // omit missingKeysByProduct (duplicates matrix holes)
    note: result.note,
  });
}

export function compactFilters(result) {
  if (!result || typeof result !== "object") return result;
  const filters = (result.filters || []).map((f) => {
    const opts = Array.isArray(f.options) ? f.options : [];
    const priority = FILTER_PRIORITY.has(f.key);
    const max = priority ? FILTER_OPTIONS_MAX : Math.min(8, FILTER_OPTIONS_MAX);
    const truncated = opts.length > max;
    const slimOpts = opts.slice(0, max).map((o) =>
      dropUndef({
        key: o.key,
        title: o.title,
        // Category facets need slug/url — without them agents invent wrong stems
        slug: o.slug,
        url: o.url,
        active: o.active || undefined,
        count: o.count,
      })
    );
    return dropUndef({
      key: f.key,
      type: f.type,
      title: f.title,
      optionCount: opts.length,
      optionsTruncated: truncated || undefined,
      options: slimOpts,
    });
  });
  // Prefer priority filters first, then others
  filters.sort((a, b) => Number(FILTER_PRIORITY.has(b.key)) - Number(FILTER_PRIORITY.has(a.key)));
  const categories = Array.isArray(result.categories)
    ? result.categories.slice(0, FILTER_OPTIONS_MAX).map((c) =>
        dropUndef({
          title: c.title,
          slug: c.slug,
          url: c.url,
          active: c.active || undefined,
          children: Array.isArray(c.children)
            ? c.children.slice(0, 12).map((ch) =>
                dropUndef({ title: ch.title, slug: ch.slug, url: ch.url })
              )
            : undefined,
        })
      )
    : undefined;
  return dropUndef({
    compact: true,
    query: result.query,
    parent: result.parent,
    menuId: result.menuId,
    level: result.level,
    count: result.count,
    categories,
    filters,
    activeFilters: result.activeFilters,
    sortOptions: result.sortOptions,
    note: truncatedNote(filters, categories, result),
  });
}

function truncatedNote(filters, categories, result) {
  const parts = [];
  if (filters.some((f) => f.optionsTruncated)) {
    parts.push("Facet options truncated (compact). Pass compact:false for full filter lists.");
  }
  if (Array.isArray(result.categories) && categories && result.categories.length > categories.length) {
    parts.push("Category list truncated (compact). Pass compact:false for full tree.");
  }
  return parts.length ? parts.join(" ") : undefined;
}

export function compactOffers(result) {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    compact: true,
    sellers: (result.sellers || []).map((s) =>
      dropUndef({
        sellerId: s.sellerId,
        sku: s.sku,
        name: s.name,
        rating: s.rating,
        reviews: s.reviews,
        price: s.price,
        delivery: s.delivery,
        isCurrentListing: s.isCurrentListing || undefined,
        sellerUrl: s.sellerUrl,
        productUrl: s.productUrl,
        // omit image + full advantages list unless useful
        advantages: s.advantages?.length
          ? s.advantages.map((a) => a.text).filter(Boolean)
          : undefined,
      })
    ),
    currentDelivery: result.currentDelivery
      ? dropUndef({
          summary: result.currentDelivery.summary,
          best: result.currentDelivery.best,
        })
      : undefined,
  };
}

export function compactReviews(result) {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    compact: true,
    reviews: (result.reviews || []).map((r) =>
      dropUndef({
        author: r.author,
        score: r.score,
        comment: r.comment ? clipName(r.comment, 400) : undefined,
        pros: r.pros ? clipName(r.pros, 200) : undefined,
        cons: r.cons ? clipName(r.cons, 200) : undefined,
        date: r.date,
        useful: r.useful,
        purchased: r.purchased,
        hasPhotos: r.hasPhotos || undefined,
        aboutProduct: r.aboutProduct,
        reviewsScope: r.reviewsScope,
        matchedSku: r.matchedSku,
        isOtherVariant: r.isOtherVariant || undefined,
        variant: r.variant,
      })
    ),
  };
}

/** Apply the right compressor for a tool result envelope. */
export function applyCompact(kind, result) {
  switch (kind) {
    case "search":
    case "browse":
    case "brand":
    case "sellerCatalog":
    case "related":
      return compactItemList(result);
    case "details":
      return compactDetails(result);
    case "compare":
      return compactCompare(result);
    case "filters":
    case "categories":
      return compactFilters(result);
    case "offers":
      return compactOffers(result);
    case "reviews":
      return compactReviews(result);
    default:
      return result && typeof result === "object" ? { ...result, compact: true } : result;
  }
}
