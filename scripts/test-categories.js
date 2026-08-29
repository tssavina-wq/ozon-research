#!/usr/bin/env node
/** Unit checks for live category parsers (no browser). */
import { parseCatalogMenu, parseCategoryChild, parseSearchFilters } from "../src/parse.js";
import { categoryIdFromValue, categorySlugFromValue } from "../src/filters.js";
import { compactFilters } from "../src/compact.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL", msg);
    failed++;
  } else console.log("ok ", msg);
}

assert(categoryIdFromValue("elektronika-15500") === "15500", "id from slug");
assert(categoryIdFromValue("15500") === "15500", "id from digits");
assert(categorySlugFromValue("/category/noutbuki-15692/") === "noutbuki-15692", "slug from path");
assert(categorySlugFromValue("Ноутбуки") === null, "title is not a slug");

const menuPage = {
  widgetStates: {
    "catalogMenu-1-default-1": JSON.stringify({
      menuId: "185",
      categories: [
        { id: "15500", title: "Электроника", url: "/category/elektronika-15500/" },
        { id: "7500", title: "Одежда", url: "/category/odezhda-7500/" },
      ],
    }),
  },
};
const menu = parseCatalogMenu(menuPage);
assert(menu.menuId === "185", "menuId from homepage widget");
assert(menu.categories[0].slug === "elektronika-15500", "menu slug");
assert(menu.categories[0].title === "Электроника", "menu title");

const child = parseCategoryChild({
  data: {
    id: "15500",
    title: "Электроника",
    url: "/category/elektronika-15500/",
    columns: [
      {
        categories: [
          {
            title: "Ноутбуки",
            url: "/category/noutbuki-planshety-8730/",
            categories: [
              { title: "Ноутбуки", url: "/category/noutbuki-15692/" },
              { title: "Игровые", url: "/category/igrovye-noutbuki-15821/" },
            ],
          },
        ],
      },
    ],
  },
});
assert(child.parent.slug === "elektronika-15500", "child parent slug");
assert(child.categories[0].children[0].slug === "noutbuki-15692", "nested child slug");

const filtersPage = {
  widgetStates: {
    "filtersDesktop-1-default-1": JSON.stringify({
      sections: [
        {
          filters: [
            {
              key: "category",
              type: "category",
              categoryFilter: {
                title: "Категория",
                categories: [
                  {
                    title: "Ноутбуки",
                    urlValue: "https://www.ozon.ru/category/noutbuki-15692/",
                    isActive: true,
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
  },
};
const filt = parseSearchFilters(filtersPage, "ноутбук");
assert(filt.categories[0].slug === "noutbuki-15692", "filters categories[].slug");
assert(filt.categories[0].active === true, "filters categories active");

const compact = compactFilters(filt);
assert(compact.categories[0].slug === "noutbuki-15692", "compact keeps category slug");
assert(
  compact.filters.find((f) => f.key === "category")?.options?.[0]?.slug === "noutbuki-15692",
  "compact keeps facet slug"
);

process.exit(failed ? 1 : 0);
