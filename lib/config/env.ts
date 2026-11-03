/**
 * lib/config/env.ts
 * Centralised, validated environment configuration.
 * All process.env reads happen here — nowhere else.
 */
import 'server-only'
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Database
  DATABASE_URL: z.string().min(1),

  // Redis
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  // Auth secrets (generate with: openssl rand -base64 32)
  JWT_ACCESS_SECRET:        z.string().min(32),
  JWT_REFRESH_SECRET:       z.string().min(32),
  INVITE_HMAC_SECRET:       z.string().min(32),
  DEVICE_TOKEN_SECRET:      z.string().min(32),
  WG_KEY_ENCRYPTION_SECRET: z.string().min(32),

  // Relay session key encryption (for relaySessionKey field)
  RELAY_SESSION_KEY_SECRET: z.string().min(32),

  // JWT expiry
  JWT_ACCESS_EXPIRES_IN:  z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // Server ports
  PORT:          z.coerce.number().int().min(1).default(3000),
  REALTIME_PORT: z.coerce.number().int().min(1).default(3001),
  RELAY_PORT:    z.coerce.number().int().min(1).default(3002),
  APP_URL:       z.string().url().default('http://localhost:3000'),

  // WireGuard defaults
  WG_SERVER_LISTEN_PORT: z.coerce.number().int().min(1024).max(65535).default(51820),
  WG_BASE_SUBNET:        z.string().default('10.8.0.0/24'),
  WG_OUTBOUND_IFACE:     z.string().default('eth0'),

  // Relay
  RELAY_URL:               z.string().default('ws://localhost:3002'),
  RELAY_AUTH_SECRET:       z.string().min(32).optional(),   // shared secret for relay→api calls
  // How long (ms) to wait for a gateway heartbeat before declaring it failed
  GATEWAY_HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().default(30_000),
  // Verification: how many successful relay test-pings confirm a gateway is ready
  GATEWAY_VERIFY_ATTEMPTS: z.coerce.number().int().default(3),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().default(60_000),
  RATE_LIMIT_MAX:       z.coerce.number().int().default(60),

  // Metrics
  METRICS_BEARER_TOKEN: z.string().optional(),
})

function parseEnv() {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`❌  Invalid environment variables:\n${issues}`)
  }
  return result.data
}

let _config: z.infer<typeof envSchema> | undefined

export function getConfig(): z.infer<typeof envSchema> {
  if (!_config) _config = parseEnv()
  return _config
}

export const config = new Proxy({} as z.infer<typeof envSchema>, {
  get(_target, prop) {
    return getConfig()[prop as keyof z.infer<typeof envSchema>]
  },
})

export type AppConfig = z.infer<typeof envSchema>
