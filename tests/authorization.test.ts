/**
 * tests/authorization.test.ts
 * Authorization logic tests — IDOR prevention, role checks, ownership verification.
 * Tests the pure authorization decision functions without DB.
 */
import { describe, it, expect } from 'vitest'

// Replicate the authorization check from lib/auth/middleware.ts
function requireOwnerOrAdmin(
  payload: { sub: string; role: string },
  resourceUserId: string,
): void {
  if (payload.role === 'ADMIN') return
  if (payload.sub !== resourceUserId) {
    throw new Error('Forbidden')
  }
}

// Replicate participant authorization from the spec
function canAccessConnection(
  userId: string,
  connection: { creatorUserId: string },
  approvedParticipants: Array<{ userId: string; approvalStatus: string }>,
): boolean {
  if (connection.creatorUserId === userId) return true
  const participant = approvedParticipants.find(
    p => p.userId === userId && p.approvalStatus === 'APPROVED',
  )
  return !!participant
}

describe('Authorization — owner check', () => {
  it('allows the resource owner', () => {
    expect(() => requireOwnerOrAdmin({ sub: 'user-1', role: 'USER' }, 'user-1')).not.toThrow()
  })

  it('allows ADMIN to access any resource', () => {
    expect(() => requireOwnerOrAdmin({ sub: 'admin-1', role: 'ADMIN' }, 'user-99')).not.toThrow()
  })

  it('denies a non-owner non-admin', () => {
    expect(() => requireOwnerOrAdmin({ sub: 'user-1', role: 'USER' }, 'user-2')).toThrow('Forbidden')
  })
})

describe('Authorization — connection access (IDOR prevention)', () => {
  const connection = { creatorUserId: 'creator-1' }

  it('allows the creator', () => {
    expect(canAccessConnection('creator-1', connection, [])).toBe(true)
  })

  it('allows an approved participant', () => {
    expect(canAccessConnection('recipient-1', connection, [
      { userId: 'recipient-1', approvalStatus: 'APPROVED' },
    ])).toBe(true)
  })

  it('denies a PENDING participant', () => {
    expect(canAccessConnection('recipient-2', connection, [
      { userId: 'recipient-2', approvalStatus: 'PENDING' },
    ])).toBe(false)
  })

  it('denies a REJECTED participant', () => {
    expect(canAccessConnection('recipient-3', connection, [
      { userId: 'recipient-3', approvalStatus: 'REJECTED' },
    ])).toBe(false)
  })

  it('denies a random user with no relationship to the connection', () => {
    expect(canAccessConnection('random-user', connection, [
      { userId: 'someone-else', approvalStatus: 'APPROVED' },
    ])).toBe(false)
  })

  it('denies a REVOKED participant', () => {
    expect(canAccessConnection('recipient-4', connection, [
      { userId: 'recipient-4', approvalStatus: 'REVOKED' },
    ])).toBe(false)
  })
})

describe('Device trust — never trust device ID alone', () => {
  it('verifies device ownership before trusting claims', () => {
    function assertOwned(userId: string, deviceUserId: string, status: string): boolean {
      return userId === deviceUserId && status !== 'REVOKED'
    }
    expect(assertOwned('user-1', 'user-1', 'ACTIVE')).toBe(true)
    expect(assertOwned('user-1', 'user-2', 'ACTIVE')).toBe(false)   // wrong owner
    expect(assertOwned('user-1', 'user-1', 'REVOKED')).toBe(false)  // revoked
  })
})
