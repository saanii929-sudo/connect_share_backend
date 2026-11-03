/**
 * lib/errors.ts
 * Centralised application error hierarchy.
 * Route handlers catch AppError and map it to the correct HTTP status.
 */

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) {
    super(400, 'BAD_REQUEST', message, details)
    this.name = 'BadRequestError'
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, 'FORBIDDEN', message)
    this.name = 'ForbiddenError'
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, 'NOT_FOUND', `${resource} not found`)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(409, 'CONFLICT', message)
    this.name = 'ConflictError'
  }
}

export class TooManyRequestsError extends AppError {
  constructor(retryAfterMs?: number) {
    super(429, 'TOO_MANY_REQUESTS', 'Rate limit exceeded', { retryAfterMs })
    this.name = 'TooManyRequestsError'
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal server error') {
    super(500, 'INTERNAL_ERROR', message)
    this.name = 'InternalError'
  }
}

// ─── Central error response mapper ───────────────────────────────────────────

export function toErrorResponse(err: unknown): { status: number; body: object } {
  if (err instanceof AppError) {
    return {
      status: err.statusCode,
      body: {
        error: {
          code:    err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      },
    }
  }

  // Unexpected error — don't leak internals
  console.error('[ConnectShare] Unexpected error:', err)
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
  }
}
