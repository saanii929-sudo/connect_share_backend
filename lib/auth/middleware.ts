/**
 * lib/auth/middleware.ts
 * Route handler auth helpers — extract and verify bearer tokens,
 * return typed payloads or throw UnauthorizedError.
 */
import 'server-only'
import { type NextRequest } from 'next/server'
import { verifyAccessToken, type AccessTokenPayload } from '../crypto/tokens'
import { UnauthorizedError, ForbiddenError } from '../errors'

export async function requireAuth(request: NextRequest): Promise<AccessTokenPayload> {
  const header = request.headers.get('authorization') ?? ''
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) throw new UnauthorizedError('Missing Authorization header')
  return verifyAccessToken(token)
}

export async function requireRole(
  request: NextRequest,
  allowedRoles: string[],
): Promise<AccessTokenPayload> {
  const payload = await requireAuth(request)
  if (!allowedRoles.includes(payload.role)) {
    throw new ForbiddenError(`Role '${payload.role}' is not permitted`)
  }
  return payload
}

export function requireOwnerOrAdmin(
  payload: AccessTokenPayload,
  resourceUserId: string,
): void {
  if (payload.role === 'ADMIN') return
  if (payload.sub !== resourceUserId) throw new ForbiddenError()
}
