/**
 * lib/services/v2/auth.service.ts
 * User auth for the v2 API — uses full_name, status, and the new User model.
 */
import 'server-only'
import { db } from '../../db'
import { hashPassword, verifyPassword } from '../../crypto/password'
import { issueTokens } from '../../auth/session'
import {
  BadRequestError,
  ConflictError,
  UnauthorizedError,
} from '../../errors'
import { auditServiceV2 } from './audit.service'
import type { AuthTokens } from '../../auth/session'

export interface UserDtoV2 {
  id:        string
  fullName:  string
  email:     string
  role:      string
  status:    string
  createdAt: Date
}

function toDto(u: {
  id: string; fullName: string; email: string
  role: string; status: string; createdAt: Date
}): UserDtoV2 {
  return { id: u.id, fullName: u.fullName, email: u.email, role: u.role, status: u.status, createdAt: u.createdAt }
}

export class AuthServiceV2 {
  async register(input: {
    fullName: string
    email:    string
    password: string
  }): Promise<{ user: UserDtoV2; tokens: AuthTokens }> {
    const existing = await db.user.findUnique({
      where: { email: input.email.toLowerCase() },
      select: { id: true },
    })
    if (existing) throw new ConflictError('Email already registered')

    const passwordHash = await hashPassword(input.password)
    const user = await db.user.create({
      data: {
        fullName:     input.fullName,
        email:        input.email.toLowerCase(),
        passwordHash,
      },
    })

    await auditServiceV2.log({ userId: user.id, action: 'USER_REGISTERED' })
    const tokens = await issueTokens(user.id, user.role)
    return { user: toDto(user), tokens }
  }

  async login(input: {
    email:    string
    password: string
  }): Promise<{ user: UserDtoV2; tokens: AuthTokens }> {
    const user = await db.user.findUnique({ where: { email: input.email.toLowerCase() } })
    if (!user || user.status === 'DELETED') {
      throw new UnauthorizedError('Invalid email or password')
    }
    if (user.status === 'SUSPENDED') {
      throw new UnauthorizedError('Account suspended')
    }
    const valid = await verifyPassword(user.passwordHash, input.password)
    if (!valid) throw new UnauthorizedError('Invalid email or password')

    await db.user.update({ where: { id: user.id }, data: { updatedAt: new Date() } })
    await auditServiceV2.log({ userId: user.id, action: 'USER_LOGIN' })
    const tokens = await issueTokens(user.id, user.role)
    return { user: toDto(user), tokens }
  }

  async getMe(userId: string): Promise<UserDtoV2> {
    const user = await db.user.findUnique({
      where:  { id: userId },
      select: { id: true, fullName: true, email: true, role: true, status: true, createdAt: true, deletedAt: true },
    })
    if (!user || user.deletedAt) throw new UnauthorizedError('User not found')
    return toDto(user)
  }
}

export const authServiceV2 = new AuthServiceV2()
