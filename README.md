# ozon-mcp-pro

MCP-сервер для маркетплейса [Ozon](https://www.ozon.ru): поиск, карточки товаров, отзывы, Q&A, сравнение продавцов, каталоги и **город доставки** через [Model Context Protocol](https://modelcontextprotocol.io).

Работает в Cursor, Claude Desktop, VS Code и других MCP-клиентах.

## Зачем

У Ozon нет публичного consumer API. Сайт защищён антиботом — обычный headless Chromium в Docker часто получает капчу.

Этот сервер держит сессию anti-detect браузера [Camoufox](https://github.com/daijro/camoufox), один раз проходит JS-челлендж и дальше читает внутренний `composer-api` как JSON. HTML не парсится.

## Инструменты

| Tool | Назначение |
|---|---|
| `ozon_search` | Поиск товаров |
| `ozon_product_details` | Карточка товара (+ `location`) |
| `ozon_product_reviews` | Отзывы покупателей |
| `ozon_product_questions` | Вопросы и ответы на карточке |
| `ozon_product_offers` | Тот же товар у других продавцов (+ даты доставки, `location`) |
| `ozon_product_variants` | Варианты (память, цвет, …) |
| `ozon_product_specs` | Полные характеристики |
| `ozon_seller_info` | Профиль продавца |
| `ozon_seller_catalog` | Каталог магазина |
| `ozon_category_browse` | Товары в категории |
| `ozon_brand_catalog` | Витрина бренда |
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

## Быстрый старт

```bash
git clone <this-repo>
cd ozon-mcp-pro
docker build -t ozon-mcp-pro:latest .
```

### MCP-конфиг (Docker)

Скопируйте [docs/mcp.example.json](docs/mcp.example.json) в конфиг клиента (например `~/.cursor/mcp.json`) или используйте [.cursor/mcp.json](.cursor/mcp.json) в проекте:

```json
{
  "mcpServers": {
    "ozon": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm", "--init", "--stop-timeout=10", "--shm-size=1g",
        "--label", "ozon-mcp-pro=1",
        "ozon-mcp-pro:latest"
      ]
    }
  }
}
```

После сборки перезагрузите MCP-сервер в клиенте. Должно быть **16 tools**.

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
| Мало tools в клиенте | Reload MCP / пересоберите `ozon-mcp-pro:latest` |
| Город не тот | `ozon_search_cities` → `ozon_set_city` |

## Лицензия

MIT — см. [LICENSE](LICENSE).
