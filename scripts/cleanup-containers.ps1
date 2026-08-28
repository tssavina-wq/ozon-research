# Stop ozon-customer-mcp containers (also cleans up legacy ozon-mcp-pro labels)
docker ps -q --filter "label=ozon-customer-mcp=1" | ForEach-Object { docker stop $_ }
docker ps -q --filter "label=ozon-mcp-pro=1" | ForEach-Object { docker stop $_ }

docker ps -q --filter "ancestor=ozon-customer-mcp:latest" | ForEach-Object { docker stop $_ }
docker ps -q --filter "ancestor=ozon-mcp-pro:latest" | ForEach-Object { docker stop $_ }
