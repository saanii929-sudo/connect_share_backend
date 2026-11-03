/**
 * lib/api-helpers.ts
 * Shared utilities for route handlers: response factories,
 * zod body validation, error wrapping.
 */
import { NextResponse } from 'next/server'
import { ZodSchema, ZodError } from 'zod'
import { toErrorResponse } from './errors'

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ data }, { status })
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 })
}

export function apiError(err: unknown): NextResponse {
  const { status, body } = toErrorResponse(err)
  return NextResponse.json(body, { status })
}

/** Parse + validate request JSON body against a Zod schema. */
export async function parseBody<T>(request: Request, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400, code: 'BAD_REQUEST' })
  }

  const result = schema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map(i => ({
      field:   i.path.join('.'),
      message: i.message,
    }))
    const err = new Error('Validation failed') as Error & { statusCode: number; code: string; details: unknown }
    err.statusCode = 400
    err.code = 'VALIDATION_ERROR'
    err.details = issues
    // Make toErrorResponse handle it
    throw Object.assign(err, { statusCode: 400, code: 'VALIDATION_ERROR', details: issues })
  }
  return result.data
}

/** BigInt-safe JSON serialiser for Response.json with BigInt values. */
export function serializeBigInt(data: unknown): string {
  return JSON.stringify(data, (_key, val) =>
    typeof val === 'bigint' ? val.toString() : val,
  )
}

export function bigIntResponse(data: unknown, status = 200): NextResponse {
  return new NextResponse(serializeBigInt({ data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
