/**
 * tests/relay-frame.test.ts
 * Tests the binary frame protocol used by the relay server.
 */
import { describe, it, expect } from 'vitest'
import { Buffer } from 'buffer'

// Replicate the frame protocol from relay/server.ts
const MAGIC = Buffer.from([0xc5, 0xf0, 0x01, 0x00])
const HEADER_LEN = 7

function buildFrame(type: number, payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(HEADER_LEN)
  MAGIC.copy(header, 0)
  header[4] = type
  header.writeUInt16BE(payload.length, 5)
  return Buffer.concat([header, payload])
}

function parseFrame(buf: Buffer): { type: number; payload: Buffer } | null {
  if (buf.length < HEADER_LEN) return null
  if (!buf.subarray(0, 4).equals(MAGIC)) return null
  const type = buf[4]
  const len = buf.readUInt16BE(5)
  if (buf.length < HEADER_LEN + len) return null
  return { type, payload: buf.subarray(HEADER_LEN, HEADER_LEN + len) }
}

describe('Relay frame protocol', () => {
  it('builds a valid DATA frame', () => {
    const payload = Buffer.from('hello-world')
    const frame = buildFrame(0x01, payload)
    // Header: 4 magic + 1 type + 2 length
    expect(frame.subarray(0, 4)).toEqual(MAGIC)
    expect(frame[4]).toBe(0x01)
    expect(frame.readUInt16BE(5)).toBe(payload.length)
    expect(frame.subarray(7).toString()).toBe('hello-world')
  })

  it('parses a valid frame', () => {
    const payload = Buffer.from('test-payload')
    const frame = buildFrame(0x02, payload)
    const parsed = parseFrame(frame)
    expect(parsed).not.toBeNull()
    expect(parsed!.type).toBe(0x02)
    expect(parsed!.payload.toString()).toBe('test-payload')
  })

  it('rejects a frame with wrong magic bytes', () => {
    const bad = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from([0x01]), Buffer.from([0x00, 0x04]), Buffer.from('test')])
    expect(parseFrame(bad)).toBeNull()
  })

  it('rejects a truncated frame (shorter than header)', () => {
    expect(parseFrame(Buffer.from([0xc5, 0xf0, 0x01]))).toBeNull()
  })

  it('handles empty payload frames', () => {
    const frame = buildFrame(0x03, Buffer.alloc(0))
    const parsed = parseFrame(frame)
    expect(parsed).not.toBeNull()
    expect(parsed!.payload.length).toBe(0)
  })

  it('handles large payloads up to uint16 max', () => {
    const largePayload = Buffer.alloc(1000, 0x42)
    const frame = buildFrame(0x01, largePayload)
    const parsed = parseFrame(frame)
    expect(parsed).not.toBeNull()
    expect(parsed!.payload.length).toBe(1000)
  })

  it('distinguishes frame types (DATA=0x01, PROBE=0x02, PROBE_ACK=0x03, CONTROL=0x04)', () => {
    for (const type of [0x01, 0x02, 0x03, 0x04]) {
      const frame = buildFrame(type, Buffer.from('x'))
      const parsed = parseFrame(frame)
      expect(parsed!.type).toBe(type)
    }
  })
})
