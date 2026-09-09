import { describe, it, expect } from 'vitest';
import { ratioOf, ratioHealth, unitDots, RATIO_AIM, RATIO_FLOOR } from './ratioShape';

describe('ratioOf', () => {
  it('is students per instructor', () => {
    expect(ratioOf(4, 14)).toBe(3.5);
    expect(ratioOf(5, 16)).toBe(3.2);
  });
  it('is zero when nobody has arrived yet', () => {
    expect(ratioOf(3, 0)).toBe(0);
  });
  it('is Infinity when students are in with no instructor — the emergency', () => {
    expect(ratioOf(0, 6)).toBe(Infinity);
  });
  it('is null when the question does not apply', () => {
    expect(ratioOf(0, 0)).toBeNull();
    expect(ratioOf(null, 5)).toBeNull();
    expect(ratioOf(4, undefined)).toBeNull();
  });
});

describe('ratioHealth — the centre’s settled policy, not new invention', () => {
  it('is fine at or under the 1:3.5 aim', () => {
    expect(ratioHealth(3.2)).toBe('ok');
    expect(ratioHealth(RATIO_AIM)).toBe('ok');
    expect(ratioHealth(0)).toBe('ok');
  });
  it('warns between the aim and the 1:4 floor', () => {
    expect(ratioHealth(3.6)).toBe('warn');
    expect(ratioHealth(RATIO_FLOOR)).toBe('warn');
  });
  it('is over once past the floor', () => {
    expect(ratioHealth(4.1)).toBe('over');
    expect(ratioHealth(Infinity)).toBe('over');
  });
  it('says nothing when there is nothing to say', () => {
    expect(ratioHealth(null)).toBeNull();
  });
});

describe('unitDots — one instructor’s share, not the whole room', () => {
  it('draws 1:3.5 as three covered students', () => {
    expect(unitDots(4, 14)).toEqual({ covered: 3, uncovered: 0 });
  });
  it('adds a dashed dot only once past the floor', () => {
    expect(unitDots(4, 16)).toEqual({ covered: 4, uncovered: 0 });   // exactly 1:4
    expect(unitDots(3, 14).uncovered).toBeGreaterThan(0);            // 1:4.7
  });
  it('caps so a bad hour cannot blow out a phone layout', () => {
    const { covered, uncovered } = unitDots(1, 40);
    expect(covered + uncovered).toBeLessThanOrEqual(8);
  });
  it('draws students with nobody on them as all-uncovered', () => {
    expect(unitDots(0, 3)).toEqual({ covered: 0, uncovered: 3 });
  });
  it('draws nothing when there is nothing to draw', () => {
    expect(unitDots(0, 0)).toEqual({ covered: 0, uncovered: 0 });
  });
  it('never returns a negative count', () => {
    for (const [i, s] of [[4,14],[1,1],[0,0],[9,2],[2,30],[1,4],[1,5]]) {
      const d = unitDots(i, s);
      expect(d.covered).toBeGreaterThanOrEqual(0);
      expect(d.uncovered).toBeGreaterThanOrEqual(0);
    }
  });
});
