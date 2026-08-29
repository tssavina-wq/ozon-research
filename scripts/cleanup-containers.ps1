# Stop ozon-customer-mcp containers
docker ps -q --filter "label=ozon-customer-mcp=1" | ForEach-Object { docker stop $_ }
docker ps -q --filter "ancestor=ozon-customer-mcp:latest" | ForEach-Object { docker stop $_ }
