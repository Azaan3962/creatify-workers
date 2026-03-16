# ── Base image ────────────────────────────────────────────────────────────────
# node:20-slim keeps the image small; we install Chromium from Debian packages
FROM node:20-slim

# ── System dependencies for Chromium ──────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ── Tell Puppeteer to use the system Chromium, not download its own ───────────
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# ── App setup ─────────────────────────────────────────────────────────────────
WORKDIR /usr/src/app

# Copy and install dependencies first (layer-caching: only reinstalls on package change)
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY server.js .

# Cloud Run injects $PORT at runtime; expose 3000 as the fallback default
EXPOSE 3000

# Run as non-root user for security
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && chown -R pptruser:pptruser /usr/src/app
USER pptruser

CMD ["node", "server.js"]
