
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/middleware'
import { invitationServiceV2 } from '@/lib/services/v2/invitation.service'
import { ok, apiError, parseBody } from '@/lib/api-helpers'

const createSchema = z.object({
  maxUses:   z.number().int().min(1).max(100).optional(),
  expiresIn: z.number().int().min(60).max(604800),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  try {
    const payload          = await requireAuth(request)
    const { connectionId } = await params
    const body             = await parseBody(request, createSchema)
    const invitation       = await invitationServiceV2.create({
      creatorId: payload.sub!,
      connectionId,
      ...body,
    })
    return ok(invitation, 201)
  } catch (err) {
    return apiError(err)
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  try {
    const payload          = await requireAuth(request)
    const { connectionId } = await params
    const list             = await invitationServiceV2.listByConnection(payload.sub!, connectionId)
    return ok(list)
  } catch (err) {
    return apiError(err)
  }
}
