#!/usr/bin/env node
/** Unit checks for filter serialization (no browser). */
import {
  serializeFilters,
  resolveFilterTitles,
  filtersNeedResolve,
  mergeFilterParams,
} from "../src/filters.js";

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
  mouseconnection: 279146,
  maxamplificationmouse: { min: 18000, max: 50000 },
  category: "besprovodnye-myshi-31940",
});
assert(category === "besprovodnye-myshi-31940", "category extracted");
assert(params.get("brand") === "100867541,26303256", "multi brand comma");
assert(params.get("is_promo") === "t", "bool t");
assert(params.get("mouseconnection") === "279146", "checkbox key");
assert(params.get("maxamplificationmouse") === "18000;50000", "range semicolon");

assert(filtersNeedResolve({ brand: "ATTACK SHARK" }), "title needs resolve");
assert(!filtersNeedResolve({ brand: "100867541", is_promo: true }), "keys resolved");

const resolved = resolveFilterTitles(
  { brand: "ATTACK SHARK", category: "Компьютерные мыши" },
  {
    filters: [
      {
        key: "brand",
        options: [
          { key: "100867541", title: "ATTACK SHARK" },
          { key: "1", title: "Other" },
        ],
      },
      {
        key: "category",
        options: [
          {
            title: "Компьютерные мыши",
            url: "https://www.ozon.ru/category/besprovodnye-myshi-31940/",
          },
        ],
      },
    ],
  }
);
assert(resolved.brand === "100867541", "brand title→key");
assert(resolved.category === "besprovodnye-myshi-31940", "category title→slug");

const merged = mergeFilterParams("/category/x-1/", params);
assert(merged.includes("brand=100867541"), "merge params");

process.exit(failed ? 1 : 0);
