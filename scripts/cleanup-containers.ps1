# Stop all ozon-mcp-pro containers left running
docker ps -q --filter "label=ozon-mcp-pro=1" | ForEach-Object { docker stop $_ }

# Fallback: any container from this image
docker ps -q --filter "ancestor=ozon-mcp-pro:latest" | ForEach-Object { docker stop $_ }
