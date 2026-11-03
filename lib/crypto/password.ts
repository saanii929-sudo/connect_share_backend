/**
 * lib/crypto/password.ts
 * Argon2id password hashing — server-only.
 */
import 'server-only'
import { hash, verify } from '@node-rs/argon2'

// Argon2id parameters (OWASP recommended minimums for interactive login)
const ARGON2_OPTIONS = {
  memoryCost:  65536, // 64 MiB
  timeCost:    3,
  parallelism: 4,
  outputLen:   32,
} as const

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS)
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await verify(hash, password)
  } catch {
    return false
  }
}
