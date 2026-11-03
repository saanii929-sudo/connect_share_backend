/**
 * prisma.config.ts — Prisma 7 configuration file.
 * The Prisma CLI reads database connection details from here.
 * For `prisma generate` (no DB needed) DATABASE_URL is optional.
 * For `prisma migrate dev/deploy` DATABASE_URL must be set.
 */
import 'dotenv/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  ...(process.env['DATABASE_URL']
    ? {
        datasource: {
          url: process.env['DATABASE_URL'],
        },
      }
    : {}),
})
