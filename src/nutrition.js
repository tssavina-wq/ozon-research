/** Normalize Ozon food macros from characteristics / free text into nutrition{}. */

function parseNum(raw) {
  if (raw == null) return null;
  const m = String(raw).replace(/\u00a0/g, " ").match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function perFromKey(key) {
  const k = String(key || "").toLowerCase();
  if (/100\s*г|на\s*100|\/\s*100/.test(k)) return "100 г";
  if (/1\s*порц|в\s*порц|на\s*порц/.test(k)) return "1 порция";
  if (/100\s*мл/.test(k)) return "100 мл";
  return null;
}

/** Package mass / count keys must never become macros. */
function isNonMacroKey(key) {
  const kl = String(key || "").toLowerCase();
  if (/белок|белки|углевод|жир|ккал|калор|энерг|жирност|protein|carb|fat|calor/i.test(kl)) {
    // still reject "вид/тип протеина"
    return /вид\s*протеин|тип\s*протеин|линейк/i.test(kl);
  }
  return /вес|масса|нетто|упаковк|объ[её]м|количеств|размер|штук|порций(?!\s*:)|срок|артикул|бренд|страна|состав(?!\s*бжу)/i.test(
    kl
  );
}

function isMacroProteinKey(key) {
  const kl = String(key || "").toLowerCase();
  if (!/белок|белки|протеин|protein/i.test(kl)) return false;
  if (/вид|тип|линейк/i.test(kl)) return false;
  return true;
}

function isMacroCarbsKey(key) {
  const kl = String(key || "").toLowerCase();
  return /углевод/i.test(kl);
}

function isMacroFatKey(key) {
  const kl = String(key || "").toLowerCase();
  if (/жирност/i.test(kl)) return false;
  return /^жир|жиры|жир,|жиры\s*:|жир.*грамм|fat\b/i.test(kl);
}

function isMacroKcalKey(key) {
  const kl = String(key || "").toLowerCase();
  return /ккал|калор|энерг/i.test(kl);
}

/**
 * Reject values that look like package mass (e.g. 907g tub read as protein).
 * Typical max: ~100g macro / 100g food; servings rarely > 60g protein.
 */
export function sanitizeMacroValue(kind, value, per) {
  if (value == null || !Number.isFinite(value)) return { value: null };
  const v = value;
  const per100 = per === "100 г" || per === "100 мл";
  const perServing = /порц/i.test(String(per || ""));

  if (kind === "kcal") {
    if (v > 2000) return { value: null, rejected: `${v} kcal looks like package energy` };
    if (perServing && v > 900) return { value: null, rejected: `${v} kcal/serving implausible` };
    if (per100 && v > 900) return { value: null, rejected: `${v} kcal/100g implausible` };
    return { value: v };
  }

  // protein / carbs / fat grams
  if (v > 100) {
    return { value: null, rejected: `${kind}=${v}g looks like package mass, not a macro` };
  }
  if (perServing && kind === "proteinG" && v > 70) {
    return { value: null, rejected: `${kind}=${v}g/serving implausible` };
  }
  if (!per && v > 80) {
    // No portion context + huge number → almost always package weight
    return { value: null, rejected: `${kind}=${v}g without portion looks like package mass` };
  }
  if (per100 && v > 100) {
    return { value: null, rejected: `${kind}=${v}g/100g impossible` };
  }
  return { value: v };
}

/**
 * @returns {{
 *   proteinG: number|null,
 *   carbsG: number|null,
 *   fatG: number|null,
 *   kcal: number|null,
 *   fatPercent: number|null,
 *   per: string|null,
 *   source: string|null,
 *   missing: boolean,
 *   raw?: Record<string,string>,
 *   warnings?: string[]
 * }}
 */
export function extractNutrition(characteristics = {}, textSources = []) {
  const chars = Object.entries(characteristics || {});
  const raw = {};
  const warnings = [];
  let proteinG = null;
  let carbsG = null;
  let fatG = null;
  let kcal = null;
  let fatPercent = null;
  let per = null;
  let source = null;

  const setPer = (key) => {
    const p = perFromKey(key);
    if (p && !per) per = p;
  };

  const accept = (kind, n, key, val) => {
    const { value, rejected } = sanitizeMacroValue(kind, n, per || perFromKey(key));
    if (rejected) {
      warnings.push(rejected);
      return null;
    }
    raw[key] = val;
    setPer(key);
    source = "characteristics";
    return value;
  };

  for (const [key, val] of chars) {
    const k = String(key);
    const kl = k.toLowerCase();
    const v = String(val ?? "").trim();
    if (!v) continue;
    if (isNonMacroKey(k) && !isMacroProteinKey(k) && !isMacroCarbsKey(k) && !isMacroFatKey(k) && !isMacroKcalKey(k) && !/жирност/i.test(kl)) {
      continue;
    }

    if (/жирност/i.test(kl)) {
      const n = parseNum(v);
      if (n != null && n <= 100) {
        fatPercent = n;
        raw[k] = v;
        if (!source) source = "characteristics";
      }
      continue;
    }

    if (isMacroProteinKey(k)) {
      const n = parseNum(v);
      if (n != null) {
        const a = accept("proteinG", n, k, v);
        if (a != null) proteinG = a;
      }
      continue;
    }
    if (isMacroCarbsKey(k)) {
      const n = parseNum(v);
      if (n != null) {
        const a = accept("carbsG", n, k, v);
        if (a != null) carbsG = a;
      }
      continue;
    }
    if (isMacroFatKey(k)) {
      const n = parseNum(v);
      if (n != null) {
        const a = accept("fatG", n, k, v);
        if (a != null) fatG = a;
      }
      continue;
    }
    if (isMacroKcalKey(k)) {
      const n = parseNum(v);
      if (n != null) {
        const a = accept("kcal", n, k, v);
        if (a != null) kcal = a;
      }
    }
  }

  // Free-text fallback — only fill gaps; require explicit nutrient labels (never bare "907г")
  if (proteinG == null || carbsG == null || fatG == null || kcal == null) {
    const blob = (Array.isArray(textSources) ? textSources : [textSources])
      .map((t) => String(t || ""))
      .join("\n")
      .replace(/\u00a0/g, " ");

    const pick = (m) => (m ? parseNum(m[1] || m[2]) : null);
    // Stricter: label then number+г, or number+г then белк
    const proteinM = blob.match(
      /белк[аи]\s*[:=\-]?\s*(\d+(?:[.,]\d+)?)\s*г|(?:^|[^\d])(\d+(?:[.,]\d+)?)\s*г\.?\s*белк/i
    );
    const carbsM = blob.match(/углевод(?:ы|ов)?\s*[:=\-]?\s*(\d+(?:[.,]\d+)?)\s*г/i);
    const fatM = blob.match(/жир(?:ы|ов)?\s*[:=\-]?\s*(\d+(?:[.,]\d+)?)\s*г/i);
    const kcalM = blob.match(/(\d+(?:[.,]\d+)?)\s*ккал|ккал\s*[:=\-]?\s*(\d+(?:[.,]\d+)?)/i);

    const tryText = (kind, m, cur) => {
      if (cur != null) return cur;
      const n = pick(m);
      if (n == null) return cur;
      const { value, rejected } = sanitizeMacroValue(kind, n, per);
      if (rejected) {
        warnings.push(rejected);
        return cur;
      }
      source = source || "text";
      return value;
    };

    proteinG = tryText("proteinG", proteinM, proteinG);
    carbsG = tryText("carbsG", carbsM, carbsG);
    fatG = tryText("fatG", fatM, fatG);
    kcal = tryText("kcal", kcalM, kcal);
    if (!per && /100\s*г/i.test(blob)) per = "100 г";
    if (!per && /порц/i.test(blob) && (proteinG != null || kcal != null)) per = "1 порция";
  }

  // Final pass with known per
  const fin = (kind, cur) => {
    const { value, rejected } = sanitizeMacroValue(kind, cur, per);
    if (rejected) warnings.push(rejected);
    return value;
  };
  proteinG = fin("proteinG", proteinG);
  carbsG = fin("carbsG", carbsG);
  fatG = fin("fatG", fatG);
  kcal = fin("kcal", kcal);

  const missing = proteinG == null && carbsG == null && fatG == null && kcal == null;
  const out = {
    proteinG,
    carbsG,
    fatG,
    kcal,
    fatPercent,
    per,
    source,
    missing,
  };
  if (Object.keys(raw).length) out.raw = raw;
  if (warnings.length) out.warnings = [...new Set(warnings)];
  return out;
}

/** Substrings that pollute grocery search (pet food, dishes, baby, chem). */
export const FOOD_SEARCH_NOISE = [
  "корм",
  "для кошек",
  "для котят",
  "для собак",
  "для щенков",
  "зоотовар",
  "наполнитель",
  "тарелка",
  "миска",
  "соска",
  "подгуз",
  "детское питание",
  "пюре дет",
  "антисептик",
  "средство для мытья",
  "бытовая химия",
  "пакетик для",
];

/** Heuristic: listing looks like food / sports nutrition / groceries. */
export function looksFoodRelated(name = "", characteristics = {}, breadcrumbs = []) {
  const blob = [
    name,
    ...Object.keys(characteristics || {}),
    ...Object.values(characteristics || {}),
    ...(breadcrumbs || []).map((b) => b.title || b),
  ]
    .join(" ")
    .toLowerCase();
  if (/зоотовар|корм для|для кошек|для собак/.test(blob)) return false;
  return /продукт|пищев|ед[аы]|бакале|молоч|мяс|рыб|протеин|творог|йогурт|курин|индейк|говяд|тунец|кревет|яйц|белок|сушк|кбжу|калор|ккал|жирност|спортивн\w*\s*питан|батончик|изолят|казеин|суперфуд|орех|семечки|консерв|овощ|зелень|напиток/.test(
    blob
  );
}

/** Ozon CDN thumbnail: insert /wc{size}/ before filename. */
export function thumbnailUrl(url, size = 200) {
  const u = String(url || "").trim();
  if (!u) return null;
  if (/\/wc\d+\//i.test(u)) return u.replace(/\/wc\d+\//i, `/wc${size}/`);
  return u.replace(/(\/multimedia[^/]*\/)([^/?#]+\.(?:jpe?g|png|webp))/i, `$1wc${size}/$2`);
}
