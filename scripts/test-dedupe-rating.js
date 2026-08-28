#!/usr/bin/env node
import {
  dedupeSearchItems,
  modelKey,
  baseModelKey,
  annotateReviewTrust,
  extractHardwareHints,
  parseSpecs,
  parseReviews,
  _internal,
} from "../src/parse.js";
import { inferCategoryFromQuery } from "../src/ozon.js";

const { parseProductScore } = _internal;
let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error("FAIL", msg);
    failed++;
  } else console.log("ok ", msg);
}

function scorePage(text) {
  return {
    widgetStates: {
      "webSingleProductScore-1": JSON.stringify({ text }),
    },
  };
}

ok(parseProductScore(scorePage("5 • 387 отзывов")).rating === 5, "integer rating 5");
ok(parseProductScore(scorePage("5 • 387 отзывов")).reviews === 387, "reviews 387");
ok(parseProductScore(scorePage("4.9 • 819 отзывов")).rating === 4.9, "decimal rating");

const cd26 = [
  {
    sku: "1",
    name: "Мышь беспроводная HUAWEI CD26, черная",
    brand: "HUAWEI",
    price: 1501,
    rating: 5,
    reviews: 387,
  },
  {
    sku: "2",
    name: "Мышь беспроводная HUAWEI CD26, белая",
    brand: "HUAWEI",
    price: 1496,
    rating: 5,
    reviews: 387,
  },
  {
    sku: "3",
    name: "Мышь беспроводная HUAWEI CD26, тёмно-серая",
    brand: "HUAWEI",
    price: 1527,
    rating: 5,
    reviews: 387,
  },
];

ok(modelKey(cd26[0]) === modelKey(cd26[1]), "CD26 colors share modelKey");
ok(baseModelKey(cd26[0]) === baseModelKey(cd26[2]), "CD26 share baseModelKey");

const annotated = annotateReviewTrust(cd26.map((x) => ({ ...x })));
ok(annotated.every((x) => x.variantReviewPool === true), "same card variants → variantReviewPool");
ok(annotated.every((x) => x.reviewsSharedAcrossModels !== true), "variants NOT cross-model");
ok(annotated.every((x) => x.reviewTrust !== "low"), "variants not low trust");

const cross = annotateReviewTrust([
  { sku: "a", name: "Neobihier Gaming 16", brand: "Neobihier", rating: 5, reviews: 1669 },
  { sku: "b", name: "ASUS TUF A15", brand: "ASUS", rating: 5, reviews: 1669 },
]);
ok(cross.every((x) => x.reviewsSharedAcrossModels === true), "different models same count → cross");
ok(cross.every((x) => x.reviewTrust === "low"), "cross-model → low trust");

const configs = [
  {
    sku: "10",
    name: "MSI Crosshair 16 16GB 512GB",
    brand: "MSI",
    price: 100000,
    rating: 4.8,
    reviews: 100,
  },
  {
    sku: "11",
    name: "MSI Crosshair 16 32GB 1TB",
    brand: "MSI",
    price: 120000,
    rating: 4.8,
    reviews: 100,
  },
  {
    sku: "20",
    name: "Logitech G305",
    brand: "Logitech",
    price: 4000,
    rating: 4.9,
    reviews: 500,
  },
];

const deduped = dedupeSearchItems([...cd26, configs[2]], { colors: true, configs: true });
ok(deduped.length === 2, "dedupe colors+other model → 2");
const cd = deduped.find((x) => /cd26/i.test(x.baseModelKey || x.modelKey || ""));
ok(cd?.variantCount === 3 || cd?.variants?.length === 3, "CD26 collapsed to one with 3 variants");

const cfgDeduped = dedupeSearchItems(configs, { colors: true, configs: true });
ok(cfgDeduped.length === 2, "config dedupe → Crosshair + G305");
const crosshair = cfgDeduped.find((x) => /crosshair/i.test(x.baseModelKey || ""));
ok((crosshair?.configCount || 0) >= 2, "Crosshair has configs[]");

// extracted GPU: never invent RTX from description when title has iGPU
const gpd = extractHardwareHints(
  "GPD WIN MAX 2 2024 Ryzen 7 8840U Radeon 780M 32GB 1TB",
  "Сравнение с RTX 3070 ноутбуками — наш Radeon 780M почти как RTX",
  {}
);
ok(/780m/i.test(gpd.gpu?.value || ""), "GPD GPU from title is 780M");
ok(!/rtx\s*3070/i.test(gpd.gpu?.value || ""), "GPD GPU not false RTX from description");

const charGpu = extractHardwareHints("Some laptop", "RTX 4090 everywhere", {
  Видеокарта: "Intel Arc Graphics",
});
ok(charGpu.gpu?.value === "Intel Arc Graphics", "characteristics GPU wins");
ok(charGpu.gpu?.source === "characteristics", "GPU source=characteristics");

// parseSpecs picks richest webCharacteristics widget
const sparseW = {
  totalCount: 5,
  characteristics: [
    {
      short: [
        { name: "A", values: [{ text: "1" }] },
        { name: "B", values: [{ text: "2" }] },
      ],
    },
  ],
};
const richW = {
  totalCount: 50,
  characteristics: [
    {
      short: Array.from({ length: 20 }, (_, i) => ({
        name: `S${i}`,
        values: [{ text: String(i) }],
      })),
      long: Array.from({ length: 30 }, (_, i) => ({
        name: `L${i}`,
        values: [{ text: String(i) }],
      })),
    },
  ],
};
const specsPage = {
  widgetStates: {
    "webCharacteristics-1-default-1": JSON.stringify(sparseW),
    "webCharacteristics-2-default-1": JSON.stringify(richW),
  },
};
const specs = parseSpecs(specsPage);
ok(specs.fieldCount >= 40, `parseSpecs picks rich widget (${specs.fieldCount})`);
ok(!specs.sparse, "rich specs not sparse");

ok(inferCategoryFromQuery("ультрабук dual screen") === "noutbuki-15692", "ultrabook → laptops");
ok(inferCategoryFromQuery("игровой ноутбук RTX") === "igrovye-noutbuki-15821", "gaming laptop category");
ok(inferCategoryFromQuery("iphone 15") == null, "phone query no laptop pin");

const reviewsPage = {
  widgetStates: {
    "webSingleProductScore-1": JSON.stringify({ text: "5 • 10 отзывов" }),
    "webListReviews-1": JSON.stringify({
      itemId: "111",
      products: {
        111: {
          itemId: "111",
          variants: [
            { name: "Цвет товара", value: "серый" },
            { name: "Оперативная память", value: "32 ГБ" },
          ],
        },
        222: {
          itemId: "222",
          variants: [{ name: "Цвет товара", value: "белый" }],
        },
      },
      reviews: [
        {
          itemId: "111",
          publishedAt: 1700000000,
          content: { comment: "Экран отличный, батарея держит", score: 5 },
          usefulness: { useful: 3 },
          isItemPurchased: true,
        },
        {
          itemId: "222",
          publishedAt: 1700000001,
          content: { comment: "Упаковка супер, продавец молодец", score: 5 },
          usefulness: { useful: 1 },
          isItemPurchased: true,
        },
      ],
    }),
  },
};

const allVariants = parseReviews(reviewsPage, 10, {
  productSku: "111",
  variantOnly: false,
  sort: "default",
});
ok(allVariants.count === 2, "all-variant reviews count 2");
ok(allVariants.reviews[1].isOtherVariant === true, "sibling SKU marked otherVariant");
ok(allVariants.reviews[1].reviewsScope === "otherVariant", "scope otherVariant");
ok(
  Array.isArray(allVariants.reviews[0].variant) &&
    allVariants.reviews[0].variant.some((x) => /серый/i.test(x)),
  "variant labels attached"
);

const emptyThis = parseReviews(
  {
    widgetStates: {
      "webSingleProductScore-1": JSON.stringify({ text: "5 • 10 отзывов" }),
      "webListReviews-1": JSON.stringify({ itemId: "999", products: {}, reviews: [] }),
    },
  },
  10,
  { productSku: "999", variantOnly: true }
);
ok(emptyThis.count === 0, "empty this-variant");
ok(/variantOnly=true|Этот вариант/i.test(emptyThis.note || ""), "empty note suggests pooled fallback");

process.exit(failed ? 1 : 0);
