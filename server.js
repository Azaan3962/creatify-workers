FROM node:20-slim

# Install Firefox instead of Chromium — uses ~400MB less RAM
RUN apt-get update && apt-get install -y \
    firefox-esr \
    ca-certificates \
    fonts-liberation \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    libdbus-glib-1-2 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxt6 \
    libasound2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/firefox-esr
ENV PUPPETEER_PRODUCT=firefox

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js .

EXPOSE 3000

RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && chown -R pptruser:pptruser /usr/src/app
USER pptruser

CMD ["node", "server.js"]
