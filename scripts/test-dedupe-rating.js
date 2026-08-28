#!/usr/bin/env node
import {
  dedupeSearchItems,
  modelKey,
  baseModelKey,
  annotateReviewTrust,
  _internal,
} from "../src/parse.js";

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
    name: "MSI Crosshair 16 32GB 1024GB",
    brand: "MSI",
    price: 120000,
    rating: 4.8,
    reviews: 100,
  },
  {
    sku: "12",
    name: "Logitech G305",
    brand: "Logitech G",
    price: 2000,
    rating: 4.9,
    reviews: 15000,
  },
];
ok(baseModelKey(configs[0]) === baseModelKey(configs[1]), "RAM/SSD configs share baseModelKey");

const deduped = dedupeSearchItems([...cd26, configs[2]], { colors: true, configs: true });
ok(deduped.length === 2, "dedupe colors+other model → 2");
const cd = deduped.find((x) => /cd26/i.test(x.baseModelKey || x.modelKey || ""));
ok(cd?.variantCount === 3 || cd?.variants?.length === 3, "CD26 collapsed to one with 3 variants");

const cfgDeduped = dedupeSearchItems(configs, { colors: true, configs: true });
ok(cfgDeduped.length === 2, "config dedupe → Crosshair + G305");
const crosshair = cfgDeduped.find((x) => /crosshair/i.test(x.baseModelKey || ""));
ok((crosshair?.configCount || 0) >= 2, "Crosshair has configs[]");

process.exit(failed ? 1 : 0);
