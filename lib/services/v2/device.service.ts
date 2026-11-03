/**
 * lib/services/v2/device.service.ts
 * Device registration for v2 — adds platform and appVersion fields.
 *
 * Security: A device is NEVER trusted based solely on its submitted ID.
 * Every request that claims to come from a device is re-verified:
 *   1. Device ID exists in DB.
 *   2. Device belongs to the authenticated user (JWT sub).
 *   3. Device status is ACTIVE.
 */
import 'server-only'
import { createHash } from 'crypto'
import { db } from '../../db'
import { generateDeviceToken } from '../../crypto/tokens'
import { redis, REDIS_KEYS } from '../../redis'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../errors'
import { auditServiceV2 } from './audit.service'
import type { DevicePlatform, DeviceStatus } from '../../../generated/prisma/client'

const DEVICE_TOKEN_TTL = 3600   // 1 hour

export interface DeviceDto {
  id:           string
  userId:       string
  deviceName:   string
  platform:     DevicePlatform
  appVersion:   string | null
  fingerprint:  string
  deviceStatus: DeviceStatus
  lastSeenAt:   Date | null
  createdAt:    Date
}

function toDto(d: {
  id: string; userId: string; deviceName: string; platform: DevicePlatform
  appVersion: string | null; fingerprint: string; deviceStatus: DeviceStatus
  lastSeenAt: Date | null; createdAt: Date
}): DeviceDto {
  return {
    id:           d.id,
    userId:       d.userId,
    deviceName:   d.deviceName,
    platform:     d.platform,
    appVersion:   d.appVersion,
    fingerprint:  d.fingerprint,
    deviceStatus: d.deviceStatus,
    lastSeenAt:   d.lastSeenAt,
    createdAt:    d.createdAt,
  }
}

export class DeviceServiceV2 {
  async register(userId: string, input: {
    deviceName:  string
    platform:    DevicePlatform
    appVersion?: string
    publicKey:   string     // Ed25519 base64 public key
    userAgent?:  string
  }): Promise<{ device: DeviceDto; deviceToken: string }> {
    const fingerprint = createHash('sha256')
      .update(Buffer.from(input.publicKey, 'base64'))
      .digest('hex')

    const existing = await db.device.findUnique({ where: { fingerprint } })

    if (existing) {
      if (existing.userId !== userId) {
        throw new ConflictError('Device already registered to another account')
      }
      // Re-issue token for same user
      const token = generateDeviceToken(userId, fingerprint)
      await redis.setex(REDIS_KEYS.deviceToken(fingerprint), DEVICE_TOKEN_TTL, userId)
      // Update metadata
      await db.device.update({
        where: { id: existing.id },
        data: {
          deviceName: input.deviceName,
          platform:   input.platform,
          appVersion: input.appVersion,
          lastSeenAt: new Date(),
        },
      })
      return { device: toDto({ ...existing, deviceName: input.deviceName, platform: input.platform, appVersion: input.appVersion ?? null, lastSeenAt: new Date() }), deviceToken: token }
    }

    const device = await db.device.create({
      data: {
        userId,
        deviceName:   input.deviceName,
        platform:     input.platform,
        appVersion:   input.appVersion,
        fingerprint,
        publicKey:    input.publicKey,
        userAgent:    input.userAgent,
        lastSeenAt:   new Date(),
      },
    })

    const token = generateDeviceToken(userId, fingerprint)
    await redis.setex(REDIS_KEYS.deviceToken(fingerprint), DEVICE_TOKEN_TTL, userId)

    await auditServiceV2.log({ userId, action: 'DEVICE_REGISTERED', resourceId: device.id })

    return { device: toDto(device), deviceToken: token }
  }

  async listByUser(userId: string): Promise<DeviceDto[]> {
    const devices = await db.device.findMany({
      where:   { userId },
      orderBy: { createdAt: 'desc' },
    })
    return devices.map(toDto)
  }

  async revoke(userId: string, deviceId: string): Promise<void> {
    const device = await db.device.findUnique({ where: { id: deviceId } })
    if (!device) throw new NotFoundError('Device')
    if (device.userId !== userId) throw new ForbiddenError()
    if (device.deviceStatus === 'REVOKED') throw new BadRequestError('Device already revoked')

    await db.device.update({
      where: { id: deviceId },
      data:  { deviceStatus: 'REVOKED' },
    })
    await redis.del(REDIS_KEYS.deviceToken(device.fingerprint))
    await auditServiceV2.log({ userId, action: 'DEVICE_REVOKED', resourceId: deviceId })
  }

  /**
   * Verify that the given deviceId actually belongs to userId and is ACTIVE.
   * Throws ForbiddenError if not — must be called before trusting any device claim.
   */
  async assertOwned(userId: string, deviceId: string): Promise<DeviceDto> {
    const device = await db.device.findUnique({ where: { id: deviceId } })
    if (!device) throw new NotFoundError('Device')
    if (device.userId !== userId) throw new ForbiddenError()
    if (device.deviceStatus === 'REVOKED') throw new BadRequestError('Device is revoked')
    return toDto(device)
  }

  async touch(deviceId: string): Promise<void> {
    await db.device.update({
      where: { id: deviceId },
      data:  { lastSeenAt: new Date() },
    }).catch(() => { /* non-critical */ })
  }
}

export const deviceServiceV2 = new DeviceServiceV2()
