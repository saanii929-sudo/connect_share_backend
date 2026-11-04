# ConnectShare Dockerfile
# Single image for: app (Next.js), realtime, relay, migrate.
# Command is overridden per-service in docker-compose.yml.
#
# Strategy: full build output + full node_modules (no standalone).
# Standalone was removed because it conflicts with the full node_modules
# copy needed by realtime/relay, causing the app healthcheck to fail.

# ─── Stage 1: Install production dependencies ─────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# Build tools for native addons (argon2)
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ─── Stage 2: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Need dev deps for the build (prisma CLI, tsx, typescript, etc.)
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Generate Prisma 7 client (output: ./generated/prisma)
RUN npx prisma generate

# Next.js production build (no standalone — we serve with next start)
RUN npm run build

# ─── Stage 3: Runner ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# Next.js built output
COPY --from=builder --chown=nextjs:nodejs /app/.next       ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public      ./public
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts

# Prisma schema + config (for migrate service)
COPY --from=builder --chown=nextjs:nodejs /app/prisma          ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts

# Prisma 7 generated client
COPY --from=builder --chown=nextjs:nodejs /app/generated   ./generated

# Source files for realtime + relay (run by tsx at runtime)
COPY --from=builder --chown=nextjs:nodejs /app/realtime    ./realtime
COPY --from=builder --chown=nextjs:nodejs /app/relay       ./relay
COPY --from=builder --chown=nextjs:nodejs /app/lib         ./lib
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json

# package.json needed by Next.js + Prisma CLI
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json

# Production node_modules (no dev deps — smaller image)
COPY --from=deps --chown=nextjs:nodejs /app/node_modules   ./node_modules

USER nextjs

EXPOSE 3000 3001 3002

# Default: start the Next.js production server
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
