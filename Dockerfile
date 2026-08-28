# Ozon MCP Pro — Node MCP + Python Camoufox (anti-detect browser).
FROM python:3.12-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libxshmfence1 libxt6 \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY python/requirements.txt ./python/
RUN pip install --no-cache-dir -r python/requirements.txt \
    && python -m camoufox fetch

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY src/ ./src/
COPY python/ ./python/

ENV NODE_ENV=production
ENV OZON_PYTHON=python3
ENV OZON_HEADLESS=true
ENV PYTHONUNBUFFERED=1

ENTRYPOINT ["node", "src/index.js"]
