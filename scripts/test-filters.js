#!/usr/bin/env node
/** Unit checks for filter serialization (no browser). */
import {
  serializeFilters,
  resolveFilterTitles,
  filtersNeedResolve,
  mergeFilterParams,
} from "../src/filters.js";
import { formatCurrencyPrice, parseHumanCount } from "../src/counts.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL", msg);
    failed++;
  } else console.log("ok ", msg);
}

const { params, category } = serializeFilters({
  brand: ["100867541", "26303256"],
  is_promo: true,
  facet_a: 279146,
  facet_range: { min: 18000, max: 50000 },
  category: "example-category-31940",
  currency_price: { min: 1000, max: 5000 },
});
assert(category === "example-category-31940", "category extracted");
assert(params.get("brand") === "100867541,26303256", "multi brand comma");
assert(params.get("is_promo") === "t", "bool t");
assert(params.get("facet_a") === "279146", "checkbox key");
assert(params.get("facet_range") === "18000;50000", "range semicolon");
assert(params.get("currency_price") === "1000;5000", "currency_price without .000");

assert(formatCurrencyPrice(1000, 5000) === "1000;5000", "currency_price format");
assert(parseHumanCount("20,6 K заказов") === 20600, "K orders");
assert(parseHumanCount("1,4 млн") === 1400000, "mln");
assert(parseHumanCount("253 M") === 253000000, "M");

assert(filtersNeedResolve({ brand: "ATTACK SHARK" }), "title needs resolve");
assert(!filtersNeedResolve({ brand: "100867541", is_promo: true }), "keys resolved");

const resolved = resolveFilterTitles(
  { brand: "Example Brand", category: "Example Category" },
  {
    filters: [
      {
        key: "brand",
        options: [
          { key: "100867541", title: "Example Brand" },
          { key: "1", title: "Other" },
        ],
      },
      {
        key: "category",
        options: [
          {
            title: "Example Category",
            url: "https://www.ozon.ru/category/example-category-31940/",
          },
        ],
      },
    ],
  }
);
assert(resolved.brand === "100867541", "brand title→key");
assert(resolved.category === "example-category-31940", "category title→slug");

const merged = mergeFilterParams("/category/x-1/", params);
assert(merged.includes("brand=100867541"), "merge params");

process.exit(failed ? 1 : 0);
