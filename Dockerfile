# ── Rakhsha Backend Dockerfile ──────────────────────────────
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 py3-pip gcc musl-dev

# ── Dependencies ─────────────────────────────────────────────
FROM base AS deps
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# ── Production image ─────────────────────────────────────────
FROM base AS production
ENV NODE_ENV=production

RUN addgroup -g 1001 -S nodejs && adduser -S rakhsha -u 1001

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=rakhsha:nodejs . .

RUN mkdir -p logs && chown rakhsha:nodejs logs

USER rakhsha
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:5000/health || exit 1

CMD ["node", "src/server.js"]
