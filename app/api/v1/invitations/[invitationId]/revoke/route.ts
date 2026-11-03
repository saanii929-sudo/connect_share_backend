/**
 * POST /api/v1/invitations/:invitationId/revoke
 */
import { type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { invitationServiceV2 } from '@/lib/services/v2/invitation.service'
import { noContent, apiError } from '@/lib/api-helpers'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ invitationId: string }> },
) {
  try {
    const payload          = await requireAuth(request)
    const { invitationId } = await params
    await invitationServiceV2.revoke(payload.sub!, invitationId)
    return noContent()
  } catch (err) {
    return apiError(err)
  }
}
