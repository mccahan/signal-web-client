# syntax=docker/dockerfile:1

# Node 24 ships SQLite in core (node:sqlite), so the image needs no build
# toolchain and no native modules — it stays small and cross-builds cleanly
# for arm64 (Raspberry Pi, Apple silicon) and amd64 alike.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app

# Install dependencies first so layer caching survives source edits.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public
COPY scripts ./scripts

# The database and cached media live on a volume so they survive upgrades.
RUN mkdir -p /data && chown -R node:node /data /app

USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
