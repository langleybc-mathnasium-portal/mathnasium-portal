import { describe, it, expect, afterEach, vi } from 'vitest';
import { centreYMD, centreToday, centreOffsetYMD } from './centreDate.js';

/**
 * The bug these pin down: Vercel runs UTC, the centre runs Pacific, and
 * from ~5pm local the two disagree about what day it is. Everything below
 * asserts the CENTRE's answer, because that is what shift.date holds.
 */

afterEach(() => { vi.useRealTimers(); });

describe('centreYMD', () => {
  it('is still today at 6pm Pacific, when UTC has already rolled over', () => {
    const evening = new Date('2026-09-08T18:00:00-07:00');   // Tue 6pm Vancouver
    expect(evening.toISOString().slice(0, 10)).toBe('2026-09-09');  // what was wrong
    expect(centreYMD(evening)).toBe('2026-09-08');                  // what is right
  });

  it('rolls over only at centre midnight', () => {
    expect(centreYMD(new Date('2026-09-08T23:59:00-07:00'))).toBe('2026-09-08');
    expect(centreYMD(new Date('2026-09-09T00:01:00-07:00'))).toBe('2026-09-09');
  });

  it('handles PST (winter, UTC−8) as well as PDT', () => {
    // 5pm in January is already the next day in UTC — one hour earlier than
    // the summer boundary, which is exactly the DST case a fixed −7 offset
    // would get wrong.
    const winterEvening = new Date('2026-01-14T17:30:00-08:00');
    expect(winterEvening.toISOString().slice(0, 10)).toBe('2026-01-15');
    expect(centreYMD(winterEvening)).toBe('2026-01-14');
  });

  it('agrees with UTC during centre working hours', () => {
    const midday = new Date('2026-09-08T11:00:00-07:00');
    expect(centreYMD(midday)).toBe(midday.toISOString().slice(0, 10));
  });

  it('honours an explicit timezone', () => {
    const t = new Date('2026-09-08T18:00:00-07:00');
    expect(centreYMD(t, 'America/Toronto')).toBe('2026-09-08');
    expect(centreYMD(t, 'Australia/Sydney')).toBe('2026-09-09');   // genuinely tomorrow there
  });
});

describe('centreToday', () => {
  it('reads the centre date, not the process date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T02:00:00Z'));   // 7pm Sept 8 in Vancouver
    expect(centreToday()).toBe('2026-09-08');
  });
});

describe('centreOffsetYMD', () => {
  it('steps whole days from the centre date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T02:00:00Z'));   // 7pm Sept 8 locally
    expect(centreOffsetYMD(0)).toBe('2026-09-08');
    expect(centreOffsetYMD(1)).toBe('2026-09-09');
    expect(centreOffsetYMD(-1)).toBe('2026-09-07');
    expect(centreOffsetYMD(-30)).toBe('2026-08-09');
  });

  it('crosses a month boundary correctly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T15:00:00Z'));   // 8am Oct 1 locally
    expect(centreOffsetYMD(0)).toBe('2026-10-01');
    expect(centreOffsetYMD(-1)).toBe('2026-09-30');
  });
});
