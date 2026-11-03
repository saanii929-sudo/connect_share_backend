/**
 * lib/services/tunnel.service.ts
 * @deprecated — use lib/services/v2/tunnel-session.service.ts for the v2 API.
 * Tunnel coordination (provision, establish, terminate, status) now lives in
 * the tunnel-session service.
 */
export { tunnelSessionService as tunnelService } from './v2/tunnel-session.service'
export type { TunnelStatusDto as TunnelPeerDto } from './v2/tunnel-session.service'
