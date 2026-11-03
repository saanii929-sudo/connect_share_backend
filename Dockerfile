# ConnectShare Dockerfile
# Produces one image used by app, realtime, relay, and migrate services.
# The command is overridden per-service in docker-compose.coolify.yml.

# ─── Stage 1: Install dependencies ───────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# Install OS-level build tools needed by native modules (argon2, etc.)
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
# --ignore-scripts prevents postinstall from running argon2 build during install;
# the build step runs it explicitly.
RUN npm ci

# ─── Stage 2: Build the Next.js app ──────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma 7: generate the client into ./generated/prisma
# DATABASE_URL is not needed at generate time — prisma.config.ts handles it
RUN npx prisma generate

# Next.js production build
RUN npm run build

# ─── Stage 3: Production runner ───────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# ── Next.js app files ──────────────────────────────────────────────────────────
# Use standalone output for the web server
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public         ./public

# ── Prisma ────────────────────────────────────────────────────────────────────
# Schema (needed by prisma migrate deploy in the migrate service)
COPY --from=builder --chown=nextjs:nodejs /app/prisma           ./prisma
# prisma.config.ts (needed by Prisma CLI)
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts
# Prisma 7 generated client lives in generated/prisma, NOT node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/generated        ./generated

# ── Source files for realtime + relay servers ─────────────────────────────────
# These are TypeScript files run by tsx at runtime
COPY --from=builder --chown=nextjs:nodejs /app/realtime ./realtime
COPY --from=builder --chown=nextjs:nodejs /app/relay    ./relay
COPY --from=builder --chown=nextjs:nodejs /app/lib      ./lib

# tsconfig needed by tsx
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json

# ── Runtime node_modules ──────────────────────────────────────────────────────
# Copy the full node_modules — realtime and relay need all deps at runtime.
# This is larger than copying selectively but avoids "module not found" errors.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules

USER nextjs

EXPOSE 3000 3001 3002

# Default: run the Next.js app.
# Override per-service in docker-compose:
#   realtime: ["node", "node_modules/tsx/dist/cli.mjs", "realtime/server.ts"]
#   relay:    ["node", "node_modules/tsx/dist/cli.mjs", "relay/server.ts"]
#   migrate:  ["npx", "prisma", "migrate", "deploy"]
CMD ["node", "server.js"]
