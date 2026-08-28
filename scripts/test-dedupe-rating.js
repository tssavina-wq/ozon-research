#!/usr/bin/env node
import { dedupeSearchItems, modelKey, _internal } from "../src/parse.js";

const { parseProductScore } = _internal;
let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error("FAIL", msg);
    failed++;
  } else console.log("ok ", msg);
}

// Fake page widget for score
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
ok(parseProductScore(scorePage("4,8 • 12 отзывов")).rating === 4.8, "comma rating");

const items = [
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
  {
    sku: "4",
    name: "Logitech G305 Lightspeed",
    brand: "Logitech G",
    price: 2058,
    rating: 4.9,
    reviews: 15000,
  },
];

ok(modelKey(items[0]) === modelKey(items[1]), "CD26 colors share modelKey");
ok(modelKey(items[0]) === modelKey(items[2]), "CD26 grey shares modelKey");
ok(modelKey(items[0]) !== modelKey(items[3]), "different models differ");

const deduped = dedupeSearchItems(items);
ok(deduped.length === 2, "dedupe to 2 models");
const cd = deduped.find((x) => /cd26/i.test(x.modelKey));
ok(cd?.variantCount === 3, "CD26 variantCount 3");
ok(cd?.variantSkus?.length === 3, "CD26 variantSkus");

process.exit(failed ? 1 : 0);
