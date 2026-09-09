import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isNewLookOn, setNewLook, newLookKey, canUseNewLook, newLookActive,
} from './newLook';

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

describe('canUseNewLook — floor staff only', () => {
  it('includes the people it is built for', () => {
    expect(canUseNewLook({ isInstructor: true })).toBe(true);
    expect(canUseNewLook({ isTraining: true })).toBe(true);
    expect(canUseNewLook({ isVolunteer: true })).toBe(true);
    expect(canUseNewLook({ isLead: true })).toBe(true);
    expect(canUseNewLook({ isManager: true })).toBe(true);
    expect(canUseNewLook({ isHost: true })).toBe(true);   // a host is an instructor
  });

  it('excludes everyone who opens the portal to run the centre', () => {
    // Their figures need data this app cannot yet read quickly or fully,
    // so they keep the pages whose numbers are known-good.
    expect(canUseNewLook({ isOwner: true })).toBe(false);
    expect(canUseNewLook({ isSuperAdmin: true })).toBe(false);
    expect(canUseNewLook({ isDirector: true })).toBe(false);
    expect(canUseNewLook({ isAdminAssistant: true })).toBe(false);
    expect(canUseNewLook({ isAdmin: true })).toBe(false);
    expect(canUseNewLook({ isOwnerLike: true })).toBe(false);
  });

  it('excludes an instructor-flagged account that is also leadership', () => {
    // Belt and braces: the leadership flag wins, whatever else is set.
    expect(canUseNewLook({ isInstructor: true, isDirector: true })).toBe(false);
    expect(canUseNewLook({ isLead: true, isOwnerLike: true })).toBe(false);
  });

  it('treats an empty auth object as floor staff, not leadership', () => {
    // Fails toward the safer of the two: a plain instructor view.
    expect(canUseNewLook({})).toBe(true);
  });
});

describe('newLookActive — eligible AND opted in', () => {
  const instructor = { profile: { uid: 'u1' }, isInstructor: true };
  const director = { profile: { uid: 'u2' }, isDirector: true };

  it('is false for an instructor who has not opted in', () => {
    expect(newLookActive(instructor)).toBe(false);
  });

  it('is true once they opt in', () => {
    setNewLook('u1', true);
    expect(newLookActive(instructor)).toBe(true);
  });

  it('stays false for a director even with the flag set', () => {
    // The important one: a leftover localStorage value from before the
    // owner/director/host boards were removed must not resurrect anything.
    setNewLook('u2', true);
    expect(newLookActive(director)).toBe(false);
  });

  it('survives a missing profile', () => {
    expect(() => newLookActive({ isInstructor: true })).not.toThrow();
    expect(newLookActive({ isInstructor: true })).toBe(false);
  });
});
