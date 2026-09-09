import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isNewLookOn, setNewLook, newLookKey, doorsFor, resolveDoor,
  readPreferredDoor, setPreferredDoor, DOORS,
} from './newLook';

/**
 * The load-bearing property here is that this GRANTS NOTHING. Door
 * entitlement has to track the permissions the app already enforces — a
 * front door that shows an instructor the owner's numbers would be a
 * permission bug wearing a redesign.
 */

const store = new Map();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the opt-in switch', () => {
  it('is off until someone turns it on', () => {
    expect(isNewLookOn('u1')).toBe(false);
  });

  it('remembers per person, so switching accounts does not carry it over', () => {
    setNewLook('u1', true);
    expect(isNewLookOn('u1')).toBe(true);
    expect(isNewLookOn('u2')).toBe(false);      // the next login starts classic
  });

  it('turns back off', () => {
    setNewLook('u1', true);
    setNewLook('u1', false);
    expect(isNewLookOn('u1')).toBe(false);
  });

  it('survives storage being unavailable rather than crashing the app', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(() => isNewLookOn('u1')).not.toThrow();
    expect(isNewLookOn('u1')).toBe(false);       // fails closed, to classic
    expect(() => setNewLook('u1', true)).not.toThrow();
  });

  it('keys anonymous separately from a real uid', () => {
    expect(newLookKey(null)).not.toBe(newLookKey('u1'));
  });
});

describe('doorsFor — entitlement, not decoration', () => {
  it('an instructor gets exactly one door', () => {
    expect(doorsFor({ isInstructor: true })).toEqual(['instructor']);
  });

  it('a volunteer or trainee gets the same single door', () => {
    expect(doorsFor({ isVolunteer: true })).toEqual(['instructor']);
    expect(doorsFor({ isTraining: true })).toEqual(['instructor']);
  });

  it('a host gets the desk and their own shifts', () => {
    expect(doorsFor({ isHost: true })).toEqual(['host', 'instructor']);
  });

  it('a director gets the week, and can still see their own shifts', () => {
    expect(doorsFor({ isDirector: true })).toEqual(['director', 'instructor']);
  });

  it('an owner gets everything except the desk they do not staff', () => {
    expect(doorsFor({ isOwner: true })).toEqual(['owner', 'instructor']);
  });

  it('an owner who is also host-capable gets the desk too', () => {
    expect(doorsFor({ isOwner: true, isHost: true }))
      .toEqual(['owner', 'host', 'instructor']);
  });

  it('a custom centre role with admin.panel earns the director door', () => {
    // This is the point: a role invented in Manage Roles reaches the right
    // door without anyone editing newLook.js.
    expect(doorsFor({ canSeeAdminPanel: true })).toEqual(['director', 'instructor']);
  });

  it('never hands out a door twice', () => {
    const doors = doorsFor({ isOwner: true, isDirector: true, canSeeAdminPanel: true, isHost: true });
    expect(new Set(doors).size).toBe(doors.length);
  });

  it('every door it can return is a known door', () => {
    const combos = [
      { isSuperAdmin: true }, { isOwner: true }, { isDirector: true },
      { isAdminAssistant: true }, { isHost: true }, { canSeeAdminPanel: true },
      {}, { isVolunteer: true },
    ];
    for (const c of combos) {
      for (const d of doorsFor(c)) expect(DOORS).toContain(d);
    }
  });

  it('gives an instructor door to absolutely everyone', () => {
    for (const c of [{ isSuperAdmin: true }, { isOwner: true }, { isDirector: true }, {}]) {
      expect(doorsFor(c)).toContain('instructor');
    }
  });
});

describe('resolveDoor', () => {
  it('lands on the most senior door held', () => {
    expect(resolveDoor({ isOwner: true })).toBe('owner');
    expect(resolveDoor({ isDirector: true })).toBe('director');
    expect(resolveDoor({ isHost: true })).toBe('host');
    expect(resolveDoor({})).toBe('instructor');
  });

  it('honours a saved preference — Rahul can make the desk his home', () => {
    expect(resolveDoor({ isHost: true }, 'instructor')).toBe('instructor');
    expect(resolveDoor({ isOwner: true, isHost: true }, 'host')).toBe('host');
  });

  it('ignores a preference the person is not entitled to', () => {
    // The real guard: a saved string cannot promote anybody.
    expect(resolveDoor({ isInstructor: true }, 'owner')).toBe('instructor');
    expect(resolveDoor({ isHost: true }, 'director')).toBe('host');
  });

  it('ignores a junk preference', () => {
    expect(resolveDoor({ isOwner: true }, 'nonsense')).toBe('owner');
    expect(resolveDoor({ isOwner: true }, null)).toBe('owner');
  });
});

describe('the saved door preference', () => {
  it('round-trips', () => {
    setPreferredDoor('u1', 'host');
    expect(readPreferredDoor('u1')).toBe('host');
  });
  it('refuses to store a door that does not exist', () => {
    expect(setPreferredDoor('u1', 'payroll')).toBeNull();
    expect(readPreferredDoor('u1')).toBeNull();
  });
  it('reads null when nothing is saved', () => {
    expect(readPreferredDoor('nobody')).toBeNull();
  });
});
