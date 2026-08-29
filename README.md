# ozon-customer-mcp

MCP-сервер для маркетплейса [Ozon](https://www.ozon.ru) (сторона покупателя): поиск, карточки товаров, отзывы, Q&A, сравнение продавцов, каталоги и **город доставки** через [Model Context Protocol](https://modelcontextprotocol.io).

Репозиторий: `ozon-customer-mcp`. Имя MCP-сервера и Docker-образа совпадает.

Работает в Cursor, Claude Desktop, VS Code и других MCP-клиентах.

## Зачем

У Ozon нет публичного consumer API. Сайт защищён антиботом — обычный headless Chromium в Docker часто получает капчу.

Этот сервер держит сессию anti-detect браузера [Camoufox](https://github.com/daijro/camoufox), один раз проходит JS-челлендж и дальше читает внутренний `composer-api` как JSON. HTML не парсится.

## Инструменты

| Tool | Назначение |
|---|---|
| `ozon_search` | Поиск (+ filters, dedupe, reviewTrust, page) |
| `ozon_product_details` | Карточка (+ `extracted`, seller.isExpress) |
| `ozon_product_reviews` | Отзывы (sort helpful/date/product, aboutProduct) |
| `ozon_product_questions` | Вопросы и ответы на карточке |
| `ozon_product_offers` | Тот же товар у других продавцов (+ даты доставки, `location`) |
| `ozon_product_variants` | Варианты (память, цвет, …) |
| `ozon_product_specs` | Полные характеристики |
| `ozon_compare_products` | Сравнение 2–8 товаров (матрица + extracted) |
| `ozon_seller_info` | Профиль продавца |
| `ozon_seller_catalog` | Каталог магазина |
| `ozon_category_browse` | Товары в категории (+ filters, dedupe) |
| `ozon_list_categories` | Живое дерево категорий (title + slug, без хардкода) |
| `ozon_brand_catalog` | Витрина бренда (+ `filters`) |
| `ozon_related_products` | «Покупают вместе» / похожие |
| `ozon_search_filters` | Доступные фильтры поиска |
| `ozon_get_location` | Текущий город доставки сессии |
| `ozon_search_cities` | Живой поиск городов (Ozon Maps suggest) |
| `ozon_set_city` | Сменить город доставки (через выбор ПВЗ) |

### Доставка и город

По умолчанию анонимная сессия — **Москва**. Даты в `ozon_product_offers` относятся к `location.city`.

Типичный сценарий:

```
ozon_get_location
ozon_search_cities({ query: "Каз" })   → показать варианты пользователю
ozon_set_city({ city: "Казань" })      → ~20–40 с
ozon_product_offers({ product: sku })  → даты для выбранного региона
```

`ozon_search_cities` ходит в живой API Ozon (не хардкод). Список городов всегда актуальный.

### Идентификаторы

- **Товар:** SKU, URL `https://www.ozon.ru/product/...` или slug  
- **Продавец / категория / бренд:** slug, numeric id или полный URL  
- **Категория:** только реальный slug из `ozon_list_categories` / `ozon_search_filters` или ozon.ru — Ozon смотрит на numeric id, угаданный префикс может открыть чужую категорию

```
ozon_list_categories()                    → топ-отделы
ozon_list_categories({ parent: "…" })     → дети
ozon_list_categories({ query: "…" })      → категории по поисковому запросу
ozon_category_browse({ category: slug })  → товары
```

## Быстрый старт

```bash
git clone https://github.com/Raleose/ozon-customer-mcp.git
cd ozon-customer-mcp
docker build -t ozon-customer-mcp:latest .
```

### MCP-конфиг (Docker)

Скопируйте [docs/mcp.example.json](docs/mcp.example.json) в конфиг клиента (например `~/.cursor/mcp.json`) или используйте [.cursor/mcp.json](.cursor/mcp.json) в проекте:

```json
{
  "mcpServers": {
    "ozon-customer": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm", "--init", "--stop-timeout=10", "--shm-size=1g",
        "--label", "ozon-customer-mcp=1",
        "ozon-customer-mcp:latest"
      ]
    }
  }
}
```

После сборки перезагрузите MCP-сервер в клиенте. Должно быть **17 tools**.

Подробнее: [docs/install.md](docs/install.md).

## Архитектура

```
MCP-клиент
    ↓ stdio
  src/index.js              — MCP tools
  src/ozon.js               — пути composer-api
  src/parse.js              — парсеры widgetStates
  src/browser.js            — мост Node ↔ Python
    ↓
  python/browser_service.py — Camoufox + location
  python/locations.py       — парсинг suggest / location
    ↓
  www.ozon.ru composer-api
```

## Локальная разработка

```bash
npm install
pip install -r python/requirements.txt
python -m camoufox fetch

node src/index.js                 # MCP по stdio
python test/locations.test.py     # unit-тесты location/suggest
node scripts/smoke-test.js        # live smoke (нужен Camoufox)
node scripts/smoke-location.js    # live: search_cities + set_city
```

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `OZON_HEADLESS` | `true` | Headless Camoufox |
| `OZON_GEOIP` | `false` | Геолокация браузера по IP (не прокси) |
| `OZON_CHALLENGE_WAIT_MS` | `15000` | Ожидание антибота |
| `OZON_EXIT_IDLE_MS` | `600000` | Exit после простоя (Docker `--rm` убирает контейнер) |
| `OZON_PYTHON` | `python3` | Интерпретатор для browser service |
| `HTTP_PROXY` / `HTTPS_PROXY` | — | HTTP(S)-прокси при необходимости |

## Docker-контейнеры

Контейнер живёт, пока открыта MCP-сессия. После отключения клиента или idle-таймаута процесс завершается, `--rm` удаляет контейнер.

Зависшие:

```powershell
.\scripts\cleanup-containers.ps1
```

## Troubleshooting

| Симптом | Что сделать |
|---|---|
| Antibot / Captcha | Другой IP или RU-прокси |
| HTTP 403 | Сессия перезапустится сама |
| Контейнеры не удаляются | Пересоберите образ, проверьте `--stop-timeout=10` |
| Мало tools в клиенте | Reload MCP / пересоберите `ozon-customer-mcp:latest` |
| Город не тот | `ozon_search_cities` → `ozon_set_city` |
| Пустой search | Смотри `hint` / `suggestedCategory` или `ozon_search_filters` |

## Лицензия

MIT — см. [LICENSE](LICENSE).
