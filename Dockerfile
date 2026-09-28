FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8000

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY public ./public

EXPOSE 8000

CMD ["node", "server.js"]
