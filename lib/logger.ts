/**
 * lib/logger.ts
 * Structured pino logger — server-only.
 * Pretty-prints in development, ndjson in production for log aggregators.
 */
import 'server-only'
import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'

export const logger = pino({
  name: 'connectshare',
  level: isDev ? 'debug' : 'info',
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      }
    : {
        // Production: JSON with timestamp
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: {
          level: (label) => ({ level: label }),
        },
        redact: {
          paths: [
            // HTTP auth material
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers.x-api-key',
            // Passwords / secrets
            'passwordHash',
            'password',
            '*.password',
            '*.passwordHash',
            // WireGuard private keys
            'wgPrivKey',
            'wgServerPrivKey',
            '*.wgPrivKey',
            '*.wgServerPrivKey',
            '*.wgPeerPrivKey',
            // Relay session keys
            'relaySessionKey',
            '*.relaySessionKey',
            // Tokens
            'token',
            'refreshToken',
            'accessToken',
            'gatewayToken',
            'deviceToken',
            '*.token',
            // Encrypted-at-rest ciphertext
            'peerConfig',
            '*.peerConfig',
          ],
          censor: '[REDACTED]',
        },
      }),
})

// Child logger factory — attach context fields without polluting the root logger
export function childLogger(context: Record<string, unknown>) {
  return logger.child(context)
}
