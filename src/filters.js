/** Build Ozon catalog query params from agent-facing filter objects. */

/**
 * filters shape:
 * {
 *   brand: "100867541" | "Brand Title" | ["100867541", "26303256"],
 *   is_promo: true,
 *   <facetKey>: optionKey | title | [keys],
 *   <rangeFacet>: { min, max },
 *   category: "slug-id" | category URL | title  // from ozon_list_categories / filters
 * }
 *
 * Ozon encoding:
 * - multi checkbox: comma-separated keys  brand=1,2
 * - boolean: key=t
 * - range: key=min;max  (currency_price uses min.000;max.000)
 * - category: switches path to /category/{slug}/
 */

function asList(raw) {
  if (raw == null || raw === "") return [];
  return Array.isArray(raw) ? raw : [raw];
}

export function looksResolvedFilterValue(v) {
  if (typeof v === "boolean") return true;
  if (typeof v === "number") return true;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v.min != null || v.max != null;
  }
  const s = String(v).trim();
  if (!s) return true;
  if (/^(t|true|1|yes|f|false|0|no)$/i.test(s)) return true;
  if (/^\d+$/.test(s)) return true;
  if (/^-?\d+(?:\.\d+)?;-?\d+(?:\.\d+)?$/.test(s)) return true;
  if (/^[a-z0-9-]+-\d+$/i.test(s)) return true; // category slug
  if (/^https?:\/\//i.test(s) || s.startsWith("/category/")) return true;
  return false;
}

export function filtersNeedResolve(filters) {
  if (!filters || typeof filters !== "object") return false;
  for (const [key, raw] of Object.entries(filters)) {
    if (key === "category") {
      const s = String(asList(raw)[0] ?? "").trim();
      if (s && !looksResolvedFilterValue(s)) return true;
      continue;
    }
    for (const v of asList(raw)) {
      if (!looksResolvedFilterValue(v)) return true;
    }
  }
  return false;
}

/** Extract category slug (or numeric id) from slug / path / URL. Titles → null. */
export function categorySlugFromValue(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    try {
      const m = new URL(s).pathname.match(/\/category\/([^/]+)/i);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }
  if (s.startsWith("/category/")) {
    const m = s.match(/\/category\/([^/?#]+)/i);
    return m ? m[1] : null;
  }
  if (/^[a-z0-9-]+-\d+$/i.test(s) || /^\d+$/.test(s)) return s;
  return null;
}

/** Numeric category id from slug-id / path / bare digits. */
export function categoryIdFromValue(raw) {
  const slug = categorySlugFromValue(raw) || String(raw ?? "").trim();
  if (!slug) return null;
  if (/^\d+$/.test(slug)) return slug;
  const m = slug.match(/-(\d+)$/);
  return m ? m[1] : null;
}

/**
 * Map human titles → option keys using a filters catalog from parseSearchFilters.
 * Returns a new filters object (does not mutate input).
 */
export function resolveFilterTitles(filters, catalog) {
  if (!filters || typeof filters !== "object") return {};
  const byKey = Object.fromEntries((catalog?.filters || []).map((f) => [f.key, f]));
  const out = {};

  for (const [key, raw] of Object.entries(filters)) {
    if (raw == null || raw === "") continue;

    if (key === "category") {
      const v = asList(raw)[0];
      const slug = categorySlugFromValue(v);
      if (slug) {
        out.category = slug;
        continue;
      }
      const cat = byKey.category;
      const title = String(v).trim().toLowerCase();
      const opt = (cat?.options || []).find((o) => String(o.title || "").trim().toLowerCase() === title);
      if (opt?.url) {
        const fromUrl = categorySlugFromValue(opt.url);
        if (fromUrl) out.category = fromUrl;
        else out.category = v;
      } else {
        out.category = v;
      }
      continue;
    }

    const meta = byKey[key];
    const values = asList(raw);
    if (!meta?.options?.length) {
      out[key] = Array.isArray(raw) ? values : values[0];
      continue;
    }

    const mapped = values.map((v) => {
      if (typeof v === "boolean" || typeof v === "number") return v;
      if (v && typeof v === "object") return v;
      const s = String(v).trim();
      if (meta.options.some((o) => String(o.key) === s)) return s;
      const byTitle = meta.options.find(
        (o) => String(o.title || "").trim().toLowerCase() === s.toLowerCase()
      );
      return byTitle?.key != null ? String(byTitle.key) : s;
    });
    out[key] = Array.isArray(raw) || mapped.length > 1 ? mapped : mapped[0];
  }

  return out;
}

/**
 * Serialize filters into URLSearchParams + optional category slug.
 * priceMin/priceMax are handled separately via appendCatalogParams.
 */
export function serializeFilters(filters) {
  const params = new URLSearchParams();
  let category = null;
  if (!filters || typeof filters !== "object") return { category, params };

  for (const [key, raw] of Object.entries(filters)) {
    if (raw == null || raw === "") continue;
    const k = String(key).trim();
    if (!k) continue;

    if (k === "category") {
      category = categorySlugFromValue(asList(raw)[0]);
      continue;
    }

    // skip price aliases — use priceMin/priceMax on the tool
    if (k === "currency_price" || k === "price") {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const min = raw.min ?? 0;
        const max = raw.max ?? 99999999;
        params.set("currency_price", `${min}.000;${max}.000`);
      } else {
        const s = String(asList(raw)[0] ?? "").trim();
        if (s) params.set("currency_price", s.includes(";") ? s : `${s};99999999`);
      }
      continue;
    }

    if (typeof raw === "boolean") {
      if (raw) params.set(k, "t");
      continue;
    }

    if (raw && typeof raw === "object" && !Array.isArray(raw) && (raw.min != null || raw.max != null)) {
      const min = raw.min ?? 0;
      const max = raw.max ?? 99999999;
      params.set(k, `${min};${max}`);
      continue;
    }

    const values = asList(raw)
      .map((v) => {
        if (typeof v === "boolean") return v ? "t" : null;
        return String(v).trim();
      })
      .filter(Boolean);

    if (!values.length) continue;

    if (values.length === 1 && /^(t|true|1|yes)$/i.test(values[0])) {
      params.set(k, "t");
      continue;
    }
    if (values.length === 1 && /^(f|false|0|no)$/i.test(values[0])) {
      continue; // unset
    }

    params.set(k, values.join(","));
  }

  return { category, params };
}

/** Merge filter params into an existing path (?query). */
export function mergeFilterParams(url, filterParams) {
  if (!filterParams || ![...filterParams.keys()].length) return url;
  const [base, qs = ""] = url.split("?");
  const params = new URLSearchParams(qs);
  for (const [k, v] of filterParams.entries()) {
    params.set(k, v);
  }
  const out = params.toString();
  return out ? `${base}?${out}` : base;
}
