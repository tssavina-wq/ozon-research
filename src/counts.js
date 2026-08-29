/** Parse Ozon human counts: "20,6 K", "1,4 млн", "253 M", "187K заказов". */
export function parseHumanCount(text) {
  if (text == null) return null;
  const s = String(text)
    .replace(/\u00a0|\u202f/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*([KkКкMmМм]|тыс(?:яч)?|млн|million|млрд)?/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const u = (m[2] || "").toLowerCase();
  if (/^[kк]|тыс/.test(u)) n *= 1_000;
  else if (/^[mм]|млн|million/.test(u)) n *= 1_000_000;
  else if (/млрд/.test(u)) n *= 1_000_000_000;
  return Math.round(n);
}

/** Format currency_price the way Ozon's active filter expects: "1000;5000" (NOT "1000.000;5000.000"). */
export function formatCurrencyPrice(min, max) {
  const lo = min == null ? 0 : Math.max(0, Math.round(Number(min)));
  const hi = max == null ? 99_999_999 : Math.max(lo, Math.round(Number(max)));
  return `${lo};${hi}`;
}
