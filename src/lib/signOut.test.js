import { describe, it, expect } from 'vitest';
import {
  toMinutes, toHHMM, hoursBetween, isOpenPunch, effectiveSignOut,
  signOutState, needsSignOutRequest, resolvedActualHours,
  buildSignOutRequest, isRequestRedeemable, newSignOutToken,
  SIGNOUT_TTL_DAYS, CONFIRMED_BY_INSTRUCTOR,
} from './signOut';

describe('toMinutes', () => {
  it('reads both formats Radius has been seen to export', () => {
    expect(toMinutes('9:02 AM')).toBe(9 * 60 + 2);
    expect(toMinutes('09:02')).toBe(9 * 60 + 2);
    expect(toMinutes('5:30 PM')).toBe(17 * 60 + 30);
    expect(toMinutes('17:30')).toBe(17 * 60 + 30);
    expect(toMinutes('17:30:00')).toBe(17 * 60 + 30);
  });

  it('handles the two midnight/noon traps', () => {
    expect(toMinutes('12:00 AM')).toBe(0);
    expect(toMinutes('12:00 PM')).toBe(12 * 60);
  });

  it('returns null rather than guessing', () => {
    for (const bad of ['', null, undefined, '  ', 'n/a', '—', '25:00', '9:99', 'lunch']) {
      expect(toMinutes(bad)).toBeNull();
    }
  });
});

describe('toHHMM', () => {
  it('normalises to 24-hour', () => {
    expect(toHHMM('9:02 AM')).toBe('09:02');
    expect(toHHMM('5:30 PM')).toBe('17:30');
    expect(toHHMM('12:00 AM')).toBe('00:00');
  });
  it('is null for unreadable input, never a fake time', () => {
    expect(toHHMM('')).toBeNull();
    expect(toHHMM(undefined)).toBeNull();
  });
});

describe('hoursBetween', () => {
  it('computes a normal shift', () => {
    expect(hoursBetween('9:00 AM', '2:00 PM')).toBe(5);
    expect(hoursBetween('09:02', '17:30')).toBe(8.47);
  });
  it('wraps past midnight', () => {
    expect(hoursBetween('22:00', '01:00')).toBe(3);
  });
  it('is null when either end is missing — the open-punch case', () => {
    expect(hoursBetween('9:00 AM', '')).toBeNull();
    expect(hoursBetween('', '5:00 PM')).toBeNull();
  });
});

describe('isOpenPunch', () => {
  it('is exactly "tapped in, never tapped out"', () => {
    expect(isOpenPunch({ timeIn: '9:02 AM', timeOut: '' })).toBe(true);
    expect(isOpenPunch({ timeIn: '9:02 AM', timeOut: null })).toBe(true);
    expect(isOpenPunch({ timeIn: '9:02 AM', timeOut: '—' })).toBe(true);
  });
  it('a complete punch is not an open punch', () => {
    expect(isOpenPunch({ timeIn: '9:02 AM', timeOut: '2:00 PM' })).toBe(false);
  });
  it('a row with no clock-in at all is not an open punch', () => {
    expect(isOpenPunch({ timeIn: '', timeOut: '' })).toBe(false);
    expect(isOpenPunch(null)).toBe(false);
  });
});

describe('effectiveSignOut', () => {
  it('a real tap-out always wins over a confirmation', () => {
    const got = effectiveSignOut(
      { timeIn: '09:00', timeOut: '2:05 PM' },
      { signOutConfirmedTime: '18:00', signOutConfirmedBy: 'instructor' },
    );
    expect(got).toEqual({ time: '14:05', source: 'radius' });
  });

  it('falls back to a confirmed time and says who gave it', () => {
    const got = effectiveSignOut(
      { timeIn: '09:00', timeOut: '' },
      { signOutConfirmedTime: '18:00', signOutConfirmedBy: 'instructor', signOutConfirmedAt: '2026-09-08T20:00:00Z' },
    );
    expect(got.time).toBe('18:00');
    expect(got.source).toBe('confirmed');
    expect(got.by).toBe('instructor');
  });

  it('reports nothing rather than inventing a time', () => {
    expect(effectiveSignOut({ timeIn: '09:00', timeOut: '' }, {})).toEqual({ time: null, source: 'none' });
  });
});

describe('signOutState', () => {
  const open = { timeIn: '09:00', timeOut: '' };
  const full = { timeIn: '09:00', timeOut: '17:00' };

  it('separates "never clocked in" from "never clocked out" — the whole bug', () => {
    expect(signOutState({ match: null, shift: {} })).toBe('absent');
    expect(signOutState({ match: open, shift: {} })).toBe('open');
  });

  it('a future shift with no punch is upcoming, not absent', () => {
    expect(signOutState({ match: null, shift: {}, isFuture: true })).toBe('upcoming');
  });

  it('becomes self-confirmed once the instructor supplies a time', () => {
    expect(signOutState({ match: open, shift: { signOutConfirmedTime: '17:00' } })).toBe('self-confirmed');
  });

  it('a complete punch stays complete even if a confirmation exists', () => {
    expect(signOutState({ match: full, shift: { signOutConfirmedTime: '18:00' } })).toBe('complete');
  });

  it('only open rows are worth emailing about', () => {
    expect(needsSignOutRequest('open')).toBe(true);
    for (const s of ['absent', 'upcoming', 'complete', 'self-confirmed']) {
      expect(needsSignOutRequest(s)).toBe(false);
    }
  });
});

describe('resolvedActualHours', () => {
  it('fills in the missing half once confirmed', () => {
    expect(resolvedActualHours({ timeIn: '09:00', timeOut: '' }, { signOutConfirmedTime: '17:00' })).toBe(8);
  });
  it('stays null while still open, so no invented number reaches payroll', () => {
    expect(resolvedActualHours({ timeIn: '09:00', timeOut: '' }, {})).toBeNull();
  });
  it('uses the real punch when there is one', () => {
    expect(resolvedActualHours({ timeIn: '09:00', timeOut: '14:30' }, { signOutConfirmedTime: '23:00' })).toBe(5.5);
  });
});

describe('buildSignOutRequest', () => {
  const now = new Date('2026-09-08T12:00:00Z');
  const base = {
    shift: { shiftId: 'sh1', date: '2026-09-06', endTime: '18:00' },
    row: { timeIn: '9:02 AM' },
    user: { id: 'u1', displayName: 'Kaitlyn MacDonald' },
    centerId: 'langley',
    requestedBy: 'vin@example.com',
    now,
  };

  it('proposes the scheduled end time', () => {
    expect(buildSignOutRequest(base).proposedSignOut).toBe('18:00');
  });

  it('records the clock-in it is asking about', () => {
    expect(buildSignOutRequest(base).clockIn).toBe('09:02');
  });

  it('expires after the stated window', () => {
    const r = buildSignOutRequest(base);
    const days = (new Date(r.expiresAt) - now) / 86400000;
    expect(days).toBe(SIGNOUT_TTL_DAYS);
  });

  it('starts pending and unused', () => {
    const r = buildSignOutRequest(base);
    expect(r.status).toBe('pending');
    expect(r.usedAt).toBeNull();
  });
});

describe('isRequestRedeemable', () => {
  const now = new Date('2026-09-08T12:00:00Z');
  const good = { status: 'pending', usedAt: null, expiresAt: '2026-09-20T12:00:00Z' };

  it('accepts a fresh, unused request', () => {
    expect(isRequestRedeemable(good, now)).toBe(true);
  });

  it('refuses a used one — single use is the point', () => {
    expect(isRequestRedeemable({ ...good, usedAt: '2026-09-08T13:00:00Z' }, now)).toBe(false);
  });

  it('refuses an expired one', () => {
    expect(isRequestRedeemable({ ...good, expiresAt: '2026-09-01T12:00:00Z' }, now)).toBe(false);
  });

  it('refuses anything already confirmed or cancelled', () => {
    expect(isRequestRedeemable({ ...good, status: 'confirmed' }, now)).toBe(false);
    expect(isRequestRedeemable({ ...good, status: 'cancelled' }, now)).toBe(false);
  });

  it('refuses a missing or expiry-less doc rather than defaulting open', () => {
    expect(isRequestRedeemable(null, now)).toBe(false);
    expect(isRequestRedeemable({ status: 'pending', usedAt: null }, now)).toBe(false);
  });
});

describe('newSignOutToken', () => {
  it('is 256 bits of hex', () => {
    const t = newSignOutToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });
  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newSignOutToken()));
    expect(seen.size).toBe(200);
  });
  it('uses the crypto source it is given', () => {
    const fake = { getRandomValues: (a) => { a.fill(0xab); return a; } };
    expect(newSignOutToken(fake)).toBe('ab'.repeat(32));
  });
});

describe('the regression this feature exists for', () => {
  it('an open punch no longer reads as "never showed up"', () => {
    const row = { name: 'Kaitlyn', date: '2026-09-06', timeIn: '9:02 AM', timeOut: '' };
    // Before: the row was dropped at parse time, so match was null...
    expect(signOutState({ match: null, shift: {} })).toBe('absent');
    // ...and now it survives, and says what actually happened.
    expect(isOpenPunch(row)).toBe(true);
    expect(signOutState({ match: row, shift: {} })).toBe('open');
    // Once she confirms 6pm, the shift has real hours again.
    expect(resolvedActualHours(row, {
      signOutConfirmedTime: '18:00', signOutConfirmedBy: CONFIRMED_BY_INSTRUCTOR,
    })).toBe(8.97);
  });
});
