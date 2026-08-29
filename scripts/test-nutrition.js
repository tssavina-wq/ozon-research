#!/usr/bin/env node
import {
  extractNutrition,
  looksFoodRelated,
  thumbnailUrl,
  sanitizeMacroValue,
} from "../src/nutrition.js";

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
  "Вес товара, г": "907",
  Тип: "Протеин",
});
assert(iso.proteinG === 30 && iso.carbsG === 1 && iso.fatG === 0 && iso.kcal === 130, "isolate macros");
assert(iso.per === "1 порция", "per portion");
assert(iso.missing === false, "not missing");
assert(iso.source === "characteristics", "source chars");

// Package mass must not become protein
const massTrap = extractNutrition(
  { "Вес товара, г": "907", Тип: "Протеин" },
  ["Изолят сывороточного протеина Iso Sensation 93 907г Ваниль"]
);
assert(massTrap.proteinG == null, "no protein from package weight/name");
assert(massTrap.missing === true, "mass trap missing macros");

const huge = extractNutrition({ "Белок: грамм в 1 порции": "750" });
assert(huge.proteinG == null, "reject 750g protein");
assert(huge.warnings?.some((w) => /750/.test(w)), "warn on 750");

assert(sanitizeMacroValue("proteinG", 907, null).value == null, "sanitize 907");
assert(sanitizeMacroValue("proteinG", 30, "1 порция").value === 30, "sanitize 30 ok");

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
assert(!looksFoodRelated("Корм для кошек", { Тип: "Корм" }), "not pet food");
assert(
  thumbnailUrl("https://ir.ozone.ru/s3/multimedia-1-7/12912733555.jpg", 200).includes("/wc200/"),
  "thumbnail wc200"
);

process.exit(failed ? 1 : 0);
