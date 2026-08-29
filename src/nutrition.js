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
 *   raw?: Record<string,string>
 * }}
 */
export function extractNutrition(characteristics = {}, textSources = []) {
  const chars = Object.entries(characteristics || {});
  const raw = {};
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

  for (const [key, val] of chars) {
    const k = String(key);
    const kl = k.toLowerCase();
    const v = String(val ?? "").trim();
    if (!v) continue;

    // Fat % is not grams — keep separate
    if (/жирност/i.test(kl)) {
      const n = parseNum(v);
      if (n != null) {
        fatPercent = n;
        raw[k] = v;
        if (!source) source = "characteristics";
      }
      continue;
    }

    if (/белок|белки|протеин|protein/i.test(kl) && !/вид\s*протеин|тип/i.test(kl)) {
      const n = parseNum(v);
      if (n != null) {
        proteinG = n;
        raw[k] = v;
        setPer(k);
        source = "characteristics";
      }
      continue;
    }
    if (/углевод/i.test(kl)) {
      const n = parseNum(v);
      if (n != null) {
        carbsG = n;
        raw[k] = v;
        setPer(k);
        source = "characteristics";
      }
      continue;
    }
    if (/^жир|жиры|жир,/i.test(kl) || /жиры\s*:/i.test(kl) || /жир.*грамм/i.test(kl)) {
      const n = parseNum(v);
      if (n != null) {
        fatG = n;
        raw[k] = v;
        setPer(k);
        source = "characteristics";
      }
      continue;
    }
    if (/ккал|калор|энерг/i.test(kl)) {
      const n = parseNum(v);
      if (n != null) {
        kcal = n;
        raw[k] = v;
        setPer(k);
        source = "characteristics";
      }
    }
  }

  // Free-text fallback (description / title) — only fill gaps
  if (proteinG == null || carbsG == null || fatG == null || kcal == null) {
    const blob = (Array.isArray(textSources) ? textSources : [textSources])
      .map((t) => String(t || ""))
      .join("\n")
      .replace(/\u00a0/g, " ");

    const pick = (m) => (m ? parseNum(m[1] || m[2] || m[3]) : null);
    const proteinM = blob.match(
      /белк[аиуе]?\s*[:=\-]?\s*(\d+(?:[.,]\d+)?)\s*г|(?:^|[^\d])(\d+(?:[.,]\d+)?)\s*г\.?\s*белк|protein[^0-9]{0,8}(\d+(?:[.,]\d+)?)/i
    );
    const carbsM = blob.match(
      /углевод(?:ы|ов)?\s*[:=\-]?\s*(\d+(?:[.,]\d+)?)\s*г|carbs?[^0-9]{0,8}(\d+(?:[.,]\d+)?)/i
    );
    const fatM = blob.match(
      /жир(?:ы|ов)?\s*[:=\-]?\s*(\d+(?:[.,]\d+)?)\s*г|(?:^|[^\d])(\d+(?:[.,]\d+)?)\s*г\.?\s*жир|fat[^0-9]{0,8}(\d+(?:[.,]\d+)?)/i
    );
    const kcalM = blob.match(
      /(\d+(?:[.,]\d+)?)\s*ккал|ккал\s*[:=\-]?\s*(\d+(?:[.,]\d+)?)|kalorij[^0-9]{0,8}(\d+(?:[.,]\d+)?)/i
    );

    if (proteinG == null && pick(proteinM) != null) {
      proteinG = pick(proteinM);
      source = source || "text";
    }
    if (carbsG == null && pick(carbsM) != null) {
      carbsG = pick(carbsM);
      source = source || "text";
    }
    if (fatG == null && pick(fatM) != null) {
      fatG = pick(fatM);
      source = source || "text";
    }
    if (kcal == null && pick(kcalM) != null) {
      kcal = pick(kcalM);
      source = source || "text";
    }
    if (!per && /100\s*г/i.test(blob)) per = "100 г";
    if (!per && /порц/i.test(blob) && (proteinG != null || kcal != null)) per = "1 порция";
  }

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
  return out;
}

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
  return /продукт|пищев|ед[аы]|бакале|молоч|мяс|рыб|протеин|творог|йогурт|курин|индейк|говяд|тунец|кревет|яйц|белок|сушк|кбжу|калор|ккал|жирност|спортивн\w*\s*питан|батончик|изолят|казеин|суперфуд|орех|семечки|консерв/.test(
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
