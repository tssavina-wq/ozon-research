# Установка MCP-сервера

## 1. Собрать образ

```bash
docker build -t ozon-customer-mcp:latest .
```

## 2. Конфиг клиента

Пример: [mcp.example.json](mcp.example.json).

| Клиент | Куда положить |
|---|---|
| Cursor | `~/.cursor/mcp.json` или `.cursor/mcp.json` в проекте |
| Claude Desktop | `claude_desktop_config.json` (секция `mcpServers`) |
| Другой MCP-клиент | По документации клиента: `command` + `args` как в примере |

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

## 3. Активация

1. Перезапустите MCP-сервер `ozon-customer` в клиенте (Reload / restart).
2. Должно быть **16 tools**.

## 4. Проверка

В чате: «Найди Steam Deck на Ozon и сравни продавцов» — ожидаются `ozon_search` → `ozon_product_offers`.

Для доставки: «Поставь город Казань и покажи сроки» — `ozon_search_cities` → `ozon_set_city` → `ozon_product_offers`.

## 5. Зависшие контейнеры

```powershell
.\scripts\cleanup-containers.ps1
```
