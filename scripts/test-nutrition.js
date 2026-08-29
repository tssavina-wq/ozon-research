#!/usr/bin/env node
import { extractNutrition, looksFoodRelated, thumbnailUrl } from "../src/nutrition.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL", msg);
    failed++;
  } else console.log("ok ", msg);
}

const iso = extractNutrition({
  "Белок: грамм в 1 порции": "30",
  "Углеводы: грамм в 1 порции": "1",
  "Жиры: грамм в 1 порции": "0",
  "Энергетическая ценность: ккал в 1 порции": "130",
  Тип: "Протеин",
});
assert(iso.proteinG === 30 && iso.carbsG === 1 && iso.fatG === 0 && iso.kcal === 130, "isolate macros");
assert(iso.per === "1 порция", "per portion");
assert(iso.missing === false, "not missing");
assert(iso.source === "characteristics", "source chars");

const cottage = extractNutrition({ Тип: "Творог", "Жирность, %": "0.5", "Вес товара, г": "200" });
assert(cottage.fatPercent === 0.5, "fat percent");
assert(cottage.missing === true, "cottage macros missing");
assert(looksFoodRelated("Творог 0.5%", cottage), "looks food");

const fromText = extractNutrition({}, ["Состав: белки 22 г, жиры 1.5 г, углеводы 0 г. 95 ккал на 100 г"]);
assert(fromText.proteinG === 22, "text protein");
assert(fromText.fatG === 1.5, "text fat");
assert(fromText.carbsG === 0, "text carbs");
assert(fromText.kcal === 95, "text kcal");
assert(fromText.per === "100 г", "text per 100g");
assert(fromText.source === "text", "source text");

assert(!looksFoodRelated("RTX 4070 laptop", { GPU: "4070" }), "not food laptop");
assert(
  thumbnailUrl("https://ir.ozone.ru/s3/multimedia-1-7/12912733555.jpg", 200).includes("/wc200/"),
  "thumbnail wc200"
);

process.exit(failed ? 1 : 0);
