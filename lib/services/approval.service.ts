/**
 * lib/services/approval.service.ts
 * @deprecated — use lib/services/v2/participant.service.ts for the v2 API.
 * Approval decisions are now handled via the participant service's
 * approve/reject/revoke methods.
 */
export { participantService as approvalService } from './v2/participant.service'
export type { ParticipantDto as ApprovalDto } from './v2/participant.service'
