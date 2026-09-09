import { describe, it, expect } from 'vitest';
import {
  slotToMinutes, minutesToSlot, nameMatches, slotsForPerson,
  blocksForPerson, blockAt, nextSwitch, hasSwitch, sideLabel,
} from './sideAssignments';

/**
 * The fixture is a REAL day copied out of Firestore
 * (centers/langley/schedulerInstructorAssignments/2026-09-09), because the
 * whole point of this feature is that the answer already exists in Neeru's
 * sheet — so the tests should be reading her actual sheet.
 *
 * In it: Jason Soo is Elementary 15:00–17:00 and then High School
 * 17:00–18:30. That transfer is precisely the thing instructors currently
 * have to ask about.
 */
const REAL_DAY = {
  'EM|15:00': ['Kaitlyn MacDonald', 'Dev Mistry', 'Jason Soo', 'Sarah Ghazi'],
  'EM|15:30': ['Kaitlyn MacDonald', 'Dev Mistry', 'Jason Soo', 'Sarah Ghazi', 'Arham Ahmed'],
  'EM|16:00': ['Kaitlyn MacDonald', 'Dev Mistry', 'Jason Soo', 'Sarah Ghazi', 'Arham Ahmed', 'Animesh Sharma', 'Shanvi Mundhra'],
  'EM|16:30': ['Kaitlyn MacDonald', 'Dev Mistry', 'Jason Soo', 'Sarah Ghazi', 'Arham Ahmed', 'Animesh Sharma', 'Shanvi Mundhra'],
  'EM|17:00': ['Kaitlyn MacDonald', 'Dev Mistry', 'Sarah Ghazi', 'Arham Ahmed', 'Animesh Sharma', 'Shanvi Mundhra'],
  'EM|17:30': ['Kaitlyn MacDonald', 'Dev Mistry', 'Sarah Ghazi', 'Arham Ahmed', 'Animesh Sharma', 'Shanvi Mundhra'],
  'EM|18:00': ['Kaitlyn MacDonald', 'Dev Mistry', 'Arham Ahmed', 'Animesh Sharma', 'Shanvi Mundhra'],
  'EM|18:30': ['Dev Mistry', 'Homer Ayuste', 'Arham Ahmed'],
  'HS|15:00': ['Luke Huang', 'Nathan Miller'],
  'HS|15:30': ['Luke Huang', 'Nathan Miller', 'Caleb Schelp', 'Homer Ayuste'],
  'HS|16:00': ['Luke Huang', 'Nathan Miller', 'Caleb Schelp', 'Homer Ayuste'],
  'HS|16:30': ['Luke Huang', 'Nathan Miller', 'Caleb Schelp', 'Homer Ayuste'],
  'HS|17:00': ['Luke Huang', 'Nathan Miller', 'Caleb Schelp', 'Homer Ayuste', 'Jason Soo'],
  'HS|17:30': ['Luke Huang', 'Nathan Miller', 'Caleb Schelp', 'Homer Ayuste', 'Jason Soo'],
  'HS|18:00': ['Luke Huang', 'Nathan Miller', 'Caleb Schelp', 'Homer Ayuste', 'Jason Soo', 'Sarah Ghazi'],
  'HS|18:30': ['Luke Huang', 'Nathan Miller', 'Caleb Schelp'],
};

const ROSTER = [
  'Kaitlyn MacDonald', 'Dev Mistry', 'Jason Soo', 'Sarah Ghazi', 'Arham Ahmed',
  'Animesh Sharma', 'Shanvi Mundhra', 'Luke Huang', 'Nathan Miller',
  'Caleb Schelp', 'Homer Ayuste',
];

const at = (h, m = 0) => h * 60 + m;

describe('slot arithmetic', () => {
  it('round-trips', () => {
    expect(slotToMinutes('15:30')).toBe(930);
    expect(minutesToSlot(930)).toBe('15:30');
    expect(minutesToSlot(600)).toBe('10:00');
  });
  it('refuses nonsense rather than guessing', () => {
    for (const bad of ['', null, 'lunch', '25:00', '15:99', '15']) {
      expect(slotToMinutes(bad)).toBeNull();
    }
  });
});

describe('the transfer case — Jason Soo, 9 Sept', () => {
  const blocks = blocksForPerson(REAL_DAY, 'Jason Soo', ROSTER);

  it('reads as two blocks, not eight half hours', () => {
    expect(blocks).toEqual([
      { side: 'EM', startMin: at(15), endMin: at(17), start: '15:00', end: '17:00' },
      { side: 'HS', startMin: at(17), endMin: at(18, 30), start: '17:00', end: '18:30' },
    ]);
  });

  it('knows which side he is on mid-shift', () => {
    expect(blockAt(blocks, at(15, 45)).side).toBe('EM');
    expect(blockAt(blocks, at(17, 45)).side).toBe('HS');
  });

  it('answers "when do I transfer"', () => {
    const nxt = nextSwitch(blocks, at(15, 45));
    expect(nxt.side).toBe('HS');
    expect(nxt.start).toBe('17:00');
  });

  it('says nothing more is coming once he is on the last side', () => {
    expect(nextSwitch(blocks, at(17, 45))).toBeNull();
  });

  it('promises no move before the shift has even started', () => {
    // At 9am he is at home. "You move to Elementary at 3:00" is wrong —
    // he is not moving anywhere, he is starting.
    expect(nextSwitch(blocks, at(9))).toBeNull();
  });

  it('does point somewhere when the day has begun but he is mid-gap', () => {
    const gapped = blocksForPerson({
      'EM|15:00': ['X Y'], 'HS|16:30': ['X Y'],
    }, 'X Y', ['X Y']);
    // 15:45 is unassigned, but the day has started — where next is useful.
    expect(nextSwitch(gapped, at(15, 45))?.side).toBe('HS');
    // ...and at 9am it still promises nothing.
    expect(nextSwitch(gapped, at(9))).toBeNull();
  });

  it('is flagged as a day with a switch in it', () => {
    expect(hasSwitch(blocks)).toBe(true);
  });
});

describe('a day with no switch — Luke Huang', () => {
  const blocks = blocksForPerson(REAL_DAY, 'Luke Huang', ROSTER);

  it('is one continuous block', () => {
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ side: 'HS', start: '15:00', end: '19:00' });
  });

  it('never promises a transfer', () => {
    expect(nextSwitch(blocks, at(16))).toBeNull();
    expect(hasSwitch(blocks)).toBe(false);
  });
});

describe('the awkward real shapes', () => {
  it('splits a genuine gap instead of merging across it', () => {
    // Homer is HS 15:30–18:30, then EM at 18:30 — a real switch at the end.
    const blocks = blocksForPerson(REAL_DAY, 'Homer Ayuste', ROSTER);
    expect(blocks.map(b => `${b.side} ${b.start}-${b.end}`))
      .toEqual(['HS 15:30-18:30', 'EM 18:30-19:00']);
  });

  it('handles someone who ends on the other side — Sarah Ghazi', () => {
    const blocks = blocksForPerson(REAL_DAY, 'Sarah Ghazi', ROSTER);
    expect(blocks.map(b => `${b.side} ${b.start}-${b.end}`))
      .toEqual(['EM 15:00-18:00', 'HS 18:00-18:30']);
    expect(nextSwitch(blocks, at(16)).side).toBe('HS');
  });

  it('does not treat a same-side gap as a transfer', () => {
    // Unassigned 16:00–16:30, but Elementary either side of it. Saying
    // "you move to Elementary at 16:30" would be nonsense — they never left.
    const day = { 'EM|15:00': ['A B'], 'EM|15:30': ['A B'], 'EM|16:30': ['A B'] };
    const blocks = blocksForPerson(day, 'A B', ['A B']);
    expect(blocks).toHaveLength(2);
    expect(hasSwitch(blocks)).toBe(false);
    expect(nextSwitch(blocks, at(15, 15))).toBeNull();
  });

  it('gives nothing for somebody not on the sheet', () => {
    expect(blocksForPerson(REAL_DAY, 'Nobody Here', ROSTER)).toEqual([]);
    expect(blockAt([], at(16))).toBeNull();
    expect(nextSwitch([], at(16))).toBeNull();
  });

  it('survives an empty or missing document', () => {
    expect(blocksForPerson({}, 'Jason Soo', ROSTER)).toEqual([]);
    expect(blocksForPerson(null, 'Jason Soo', ROSTER)).toEqual([]);
    expect(blocksForPerson(undefined, undefined, undefined)).toEqual([]);
  });

  it('ignores malformed keys and non-array values', () => {
    const junk = {
      'EM|15:00': ['A B'],
      'garbage': ['A B'],
      'EM|nope': ['A B'],
      'HS|16:00': 'not an array',
      '': ['A B'],
    };
    expect(blocksForPerson(junk, 'A B', ['A B'])).toEqual([
      { side: 'EM', startMin: at(15), endMin: at(15, 30), start: '15:00', end: '15:30' },
    ]);
  });

  it('counts a double-booked half hour once', () => {
    // Ticked on both sides for the same slot is a data error; producing two
    // overlapping blocks would render as being in two places at once.
    const day = { 'EM|15:00': ['A B'], 'HS|15:00': ['A B'] };
    expect(slotsForPerson(day, 'A B', ['A B'])).toHaveLength(1);
  });
});

describe('nameMatches — wrong is worse than nothing', () => {
  it('matches the exact display name, ignoring case and spacing', () => {
    expect(nameMatches('Jason Soo', 'Jason Soo', ROSTER)).toBe(true);
    expect(nameMatches('  jason   soo ', 'Jason Soo', ROSTER)).toBe(true);
  });

  it('accepts a bare first name when only one person has it', () => {
    // The sheet really does contain "Bri", "Sofie", "Sabrina".
    expect(nameMatches('Jason', 'Jason Soo', ROSTER)).toBe(true);
  });

  it('refuses a bare first name two people share', () => {
    const roster = ['Sarah Ghazi', 'Sarah Kim'];
    expect(nameMatches('Sarah', 'Sarah Ghazi', roster)).toBe(false);
    expect(nameMatches('Sarah', 'Sarah Kim', roster)).toBe(false);
  });

  it('never matches a different person', () => {
    expect(nameMatches('Jason Soo', 'Nathan Miller', ROSTER)).toBe(false);
    expect(nameMatches('Soo', 'Jason Soo', ROSTER)).toBe(false);   // surname alone
    expect(nameMatches('', 'Jason Soo', ROSTER)).toBe(false);
    expect(nameMatches('Jason Soo', '', ROSTER)).toBe(false);
  });
});

describe('sideLabel', () => {
  it('spells the sides out for people reading them on a phone', () => {
    expect(sideLabel('HS')).toBe('High School');
    expect(sideLabel('EM')).toBe('Elementary');
  });
  it('passes an unknown side through rather than blanking it', () => {
    expect(sideLabel('XX')).toBe('XX');
    expect(sideLabel(null)).toBe('');
  });
});
