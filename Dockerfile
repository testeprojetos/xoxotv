FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8000

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
       -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY public ./public

EXPOSE 8000

CMD ["node", "server.js"]
