/**
 * lib/db.ts
 * Prisma 7 client singleton — uses @prisma/adapter-pg (node-postgres adapter).
 * Import path is from the generated output directory defined in prisma/schema.prisma.
 * Lazy instantiation prevents build-time failures when DATABASE_URL is absent.
 */
import 'server-only'
import { PrismaClient } from '../generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is not set')
  }

  const adapter = new PrismaPg({ connectionString })
  return new PrismaClient({ adapter })
}

// Lazy getter — the client is only created on first use, not at import time.
// This prevents build-time failures when DATABASE_URL is not set.
let _dbInstance: PrismaClient | undefined

export function getDb(): PrismaClient {
  if (globalThis.__prisma) return globalThis.__prisma
  if (!_dbInstance) {
    _dbInstance = createPrismaClient()
    if (process.env.NODE_ENV !== 'production') {
      globalThis.__prisma = _dbInstance
    }
  }
  return _dbInstance
}

// Proxy so callers can still write `db.user.findMany(...)` without calling getDb()
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop]
  },
})
