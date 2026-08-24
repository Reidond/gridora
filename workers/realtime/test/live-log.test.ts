import { describe, expect, it } from 'vitest'
import {
  LIVE_LOG_LIMITS,
  boundedLiveLogBacklog,
  isValidLiveLogCursor,
  liveLogBackpressureDecision,
} from '../src/live-log-invariants.js'

describe('live log bounded stream invariants', () => {
  it('closes a client before a frame can exceed the bounded send window', () => {
    expect(liveLogBackpressureDecision(0, LIVE_LOG_LIMITS.maximumFrameBytes)).toBe('send')
    expect(liveLogBackpressureDecision(LIVE_LOG_LIMITS.maximumBufferedBytes, 1)).toBe('close')
    expect(liveLogBackpressureDecision(LIVE_LOG_LIMITS.maximumBufferedBytes - 10, 11)).toBe('close')
    expect(liveLogBackpressureDecision(0, LIVE_LOG_LIMITS.maximumFrameBytes + 1)).toBe('close')
  })

  it('keeps reconnect replay bounded and signals truncation', () => {
    const rows = Array.from(
      { length: LIVE_LOG_LIMITS.maximumBacklogEvents + 5 },
      (_, index) => index + 1,
    )
    expect(boundedLiveLogBacklog(rows)).toEqual({
      items: rows.slice(-LIVE_LOG_LIMITS.maximumBacklogEvents),
      truncated: true,
    })
    expect(boundedLiveLogBacklog(rows.slice(0, 2))).toEqual({ items: [1, 2], truncated: false })
  })

  it('accepts only bounded positive replay cursors', () => {
    expect(isValidLiveLogCursor('1')).toBe(true)
    expect(isValidLiveLogCursor('0001')).toBe(false)
    expect(isValidLiveLogCursor('0')).toBe(false)
    expect(isValidLiveLogCursor('1.5')).toBe(false)
    expect(isValidLiveLogCursor('9'.repeat(17))).toBe(false)
  })
})
