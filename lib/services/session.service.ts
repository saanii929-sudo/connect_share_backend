/**
 * lib/services/session.service.ts
 * @deprecated — use lib/services/v2/connection.service.ts for the v2 API.
 */
export { connectionService as sessionService } from './v2/connection.service'
export type { ConnectionDto as SessionDto } from './v2/connection.service'
