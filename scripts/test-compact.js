#!/usr/bin/env node
import {
  wantCompact,
  compactSearchItem,
  compactItemList,
  compactDetails,
  compactCompare,
  compactFilters,
} from "../src/compact.js";

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error("FAIL", msg);
    failed++;
  } else console.log("ok ", msg);
}

ok(wantCompact({}) === true, "default compact");
ok(wantCompact({ compact: false }) === false, "compact:false → full");
ok(wantCompact({ rich: true }) === false, "rich:true → full");
ok(wantCompact({ compact: true, rich: true }) === false, "rich wins over compact:true");

const fat = {
  sku: "1",
  name: "A".repeat(200),
  price: 100,
  brand: "HP",
  url: "https://www.ozon.ru/product/1/",
  image: "https://cdn/x.jpg",
  modelKey: "long key",
  baseModelKey: "base",
  reviewTrust: "ok",
  variantCount: 1,
  variants: [{ sku: "1", name: "A".repeat(200), price: 100 }],
  configCount: 3,
  configs: [
    { sku: "1", name: "16GB", price: 100, label: "16GB" },
    { sku: "2", name: "32GB", price: 120, label: "32GB" },
    { sku: "3", name: "64GB", price: 140, label: "64GB" },
  ],
};
const slim = compactSearchItem(fat);
ok(slim.name.length <= 141, "name clipped");
ok(!slim.image && !slim.modelKey && !slim.variants, "no image/modelKey/singleton variants");
ok(slim.configCount === 3 && slim.configs.length === 3, "multi configs kept slim");
ok(!slim.configs[0].name || slim.configs[0].label, "config uses label");

const list = compactItemList({ count: 1, items: [fat] });
ok(list.compact === true, "list marked compact");
ok(JSON.stringify(list).length < JSON.stringify({ count: 1, items: [fat] }).length, "list smaller");

const details = compactDetails({
  sku: "1",
  name: "Laptop",
  price: 1,
  images: ["a", "b", "c"],
  description: { text: "x".repeat(500), images: [] },
  seller: { name: "Shop", rating: 4.9, logo: "L", url: "U" },
  delivery: {
    summary: "Завтра",
    best: { title: "PVZ", dateText: "Завтра", kind: "pickup", text: "PVZ — Завтра" },
    options: [{ title: "PVZ", dateText: "Завтра", kind: "pickup", text: "PVZ — Завтра" }],
  },
  characteristics: { CPU: "i5" },
});
ok(!details.images, "details drops images");
ok(details.descriptionPreview && details.descriptionPreview.length <= 241, "desc preview");
ok(details.delivery.summary === "Завтра", "delivery kept");

const cmp = compactCompare({
  count: 2,
  products: [
    { sku: "a", name: "A", price: 1, characteristics: { X: "1", Y: "2" }, fieldCount: 2 },
    { sku: "b", name: "B", price: 2, characteristics: { X: "1" }, fieldCount: 1 },
  ],
  matrix: { X: { a: "1", b: "1" }, Y: { a: "2", b: null } },
  missingKeysByProduct: { a: [], b: ["Y"] },
});
ok(!cmp.missingKeysByProduct, "compare drops missingKeys");
ok(!cmp.products[0].characteristics, "compare drops per-product characteristics");
ok(cmp.matrix.X.a === "1", "matrix kept");

const filters = compactFilters({
  query: "q",
  categories: [
    {
      title: "Cat",
      slug: "cat-1",
      url: "https://www.ozon.ru/category/cat-1/",
      children: [{ title: "Sub", slug: "sub-2", url: "/category/sub-2/" }],
    },
  ],
  filters: [
    {
      key: "brand",
      type: "checkbox",
      title: "Бренд",
      options: Array.from({ length: 40 }, (_, i) => ({ key: String(i), title: `B${i}` })),
    },
    {
      key: "category",
      type: "category",
      title: "Категория",
      options: [
        {
          title: "Laptops",
          slug: "noutbuki-15692",
          url: "https://www.ozon.ru/category/noutbuki-15692/",
          active: true,
        },
      ],
    },
    {
      key: "obscure",
      type: "checkbox",
      title: "X",
      options: Array.from({ length: 20 }, (_, i) => ({ key: String(i), title: `O${i}` })),
    },
  ],
});
ok(filters.filters[0].optionsTruncated === true, "brand options truncated");
ok(filters.filters[0].optionCount === 40, "optionCount preserved");
ok(filters.filters[0].options.length <= 16, "brand options capped");
const catFacet = filters.filters.find((f) => f.key === "category");
ok(catFacet?.options?.[0]?.slug === "noutbuki-15692", "category slug kept in compact");
ok(catFacet?.options?.[0]?.url?.includes("noutbuki-15692"), "category url kept in compact");
ok(filters.categories?.[0]?.slug === "cat-1", "top-level categories kept");
ok(filters.categories?.[0]?.children?.[0]?.slug === "sub-2", "category children slugs kept");

process.exit(failed ? 1 : 0);
