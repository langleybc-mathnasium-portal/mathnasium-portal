import { describe, it, expect } from 'vitest';
import {
  parseRadiusRows, findColumns, normaliseDuration, toISODate, PARSE_ERRORS,
} from './radiusTimesheet';
import { signOutState, isShiftOver } from './signOut';
import REAL_EXPORT from './__fixtures__/radius-export-2026-09-08.json';

/**
 * These run against a REAL Radius export (8 Sept 2026, Langley), not a
 * hand-written approximation. The bug this feature exists for survived
 * because nobody could test the importer without clicking Upload.
 */

describe('a real Radius export', () => {
  const { entries, error } = parseRadiusRows(REAL_EXPORT);

  it('parses without error', () => {
    expect(error).toBeNull();
    expect(entries.length).toBeGreaterThan(100);
  });

  it('finds the columns despite the leading blank column', () => {
    const { headerIndex, colMap } = findColumns(REAL_EXPORT);
    expect(headerIndex).toBe(0);
    expect(colMap).toMatchObject({
      attendanceId: 1, name: 2, date: 4, timeIn: 5, timeOut: 6,
    });
  });

  it('skips section headers and subtotal rows', () => {
    // "Aarav Agarkar (I)" is a section header, "Total: 1354" a subtotal, and
    // neither carries a numeric attendance id — that is what separates them
    // from real punches.
    //
    // NB: parentheses are NOT the test. Two actual employees have them
    // ("Jieun (Joanne) Lee", "Darshveer (Diya) Brar"), and an earlier version
    // of this assertion failed on exactly that. The real property is that no
    // parsed name carries the section-header role suffix, and no date is a
    // subtotal string.
    expect(entries.some(e => /\((I|A|M)\)$/.test(e.name))).toBe(false);
    expect(entries.some(e => String(e.date).includes('Total'))).toBe(false);
    expect(new Set(entries.map(e => e.name)).size).toBe(33);
  });

  it('converts DD/MM/YYYY to ISO', () => {
    expect(entries.every(e => /^\d{4}-\d{2}-\d{2}$/.test(e.date))).toBe(true);
  });

  it('KEEPS the open punches that used to be dropped', () => {
    const open = entries.filter(e => e.openPunch);
    expect(open).toHaveLength(17);
    // Every one has a clock-in and no clock-out, and carries zero hours
    // rather than a guessed duration.
    for (const e of open) {
      expect(e.timeIn).not.toBe('');
      expect(e.timeOut).toBe('');
      expect(e.actualHours).toBe(0);
    }
  });

  it('still computes hours for complete punches', () => {
    const aarav = entries.find(e => e.name === 'Aarav Agarkar' && e.date === '2026-08-26');
    expect(aarav).toMatchObject({ timeIn: '1:59 PM', timeOut: '7:07 PM', openPunch: false });
    expect(aarav.actualHours).toBeCloseTo(5.13, 2);   // 309 min = 5.15; times give 5.133
  });

  it('the old rule would have thrown all 17 away', () => {
    // Reproduces the pre-fix condition: no Time Out -> no duration -> NaN
    // -> `continue`. This is the line the whole feature exists to undo.
    const wouldHaveBeenDropped = entries.filter(e => e.openPunch);
    expect(wouldHaveBeenDropped.length).toBeGreaterThan(0);
  });
});

describe('who is actually still at work', () => {
  const { entries } = parseRadiusRows(REAL_EXPORT);
  const open = entries.filter(e => e.openPunch);

  // The export was taken mid-afternoon on 8 Sept 2026.
  const EXPORTED_AT = new Date(2026, 8, 8, 16, 30);   // 4:30pm local

  it('most open punches on the export date are people mid-shift, not missed sign-outs', () => {
    const today = open.filter(e => e.date === '2026-09-08');
    expect(today).toHaveLength(14);

    // A 3pm–7pm shift at 4:30pm has not finished.
    const state = signOutState({
      match: today[0],
      shift: { date: '2026-09-08', endTime: '19:00' },
      now: EXPORTED_AT,
    });
    expect(state).toBe('in-progress');
  });

  it('older open punches ARE missed sign-outs', () => {
    const stale = open.filter(e => e.date < '2026-09-08');
    expect(stale).toHaveLength(3);
    const state = signOutState({
      match: stale[0],
      shift: { date: stale[0].date, endTime: '19:00' },
      now: EXPORTED_AT,
    });
    expect(state).toBe('open');
  });

  it('so only 3 of 17 would be emailed, not all 17', () => {
    const shiftFor = (e) => ({ date: e.date, endTime: '19:00' });
    const actionable = open.filter(e =>
      signOutState({ match: e, shift: shiftFor(e), now: EXPORTED_AT }) === 'open');
    expect(actionable).toHaveLength(3);
  });
});

describe('isShiftOver', () => {
  const shift = { date: '2026-09-08', endTime: '19:00' };

  it('is false while the shift is running', () => {
    expect(isShiftOver(shift, { now: new Date(2026, 8, 8, 16, 30) })).toBe(false);
  });

  it('is false in the grace window just after the end', () => {
    expect(isShiftOver(shift, { now: new Date(2026, 8, 8, 19, 10) })).toBe(false);
  });

  it('is true once the grace has passed', () => {
    expect(isShiftOver(shift, { now: new Date(2026, 8, 8, 19, 45) })).toBe(true);
  });

  it('is true for any earlier day', () => {
    expect(isShiftOver({ date: '2026-09-02', endTime: '19:00' },
      { now: new Date(2026, 8, 8, 9, 0) })).toBe(true);
  });

  it('does not fall a day short through UTC parsing', () => {
    // `new Date('2026-09-08')` is UTC midnight = 5pm Sept 7 in Vancouver.
    // If that were used, a Sept 8 shift would read as already over on the 7th.
    expect(isShiftOver(shift, { now: new Date(2026, 8, 7, 23, 0) })).toBe(false);
  });

  it('falls back to end-of-day when the end time is unreadable', () => {
    const odd = { date: '2026-09-08', endTime: '' };
    expect(isShiftOver(odd, { now: new Date(2026, 8, 8, 12, 0) })).toBe(false);
    expect(isShiftOver(odd, { now: new Date(2026, 8, 9, 12, 0) })).toBe(true);
  });
});

describe('normaliseDuration', () => {
  it('treats anything over 24 as minutes', () => {
    expect(normaliseDuration(309)).toBeCloseTo(5.15, 2);
    expect(normaliseDuration(242)).toBeCloseTo(4.03, 2);
  });
  it('leaves plausible decimal hours alone', () => {
    expect(normaliseDuration(5.15)).toBe(5.15);
  });
  it('parses HH:MM', () => {
    expect(normaliseDuration('04:02')).toBeCloseTo(4.033, 2);
  });
  it('is NaN for the empty duration an open punch carries', () => {
    expect(Number.isNaN(normaliseDuration(''))).toBe(true);
    expect(Number.isNaN(normaliseDuration(null))).toBe(true);
  });
});

describe('toISODate', () => {
  it('reads Radius DD/MM/YYYY', () => {
    expect(toISODate('26/08/2026')).toBe('2026-08-26');
    expect(toISODate('4/09/2026')).toBe('2026-09-04');
  });
  it('rejects anything else rather than guessing', () => {
    for (const bad of ['', 'Total: 1354', '2026-08-26', '26-08-2026', null]) {
      expect(toISODate(bad)).toBeNull();
    }
  });
});

describe('a file that is not a Radius export', () => {
  it('reports the column error', () => {
    const { entries, error } = parseRadiusRows([['Name', 'Something', 'Else']]);
    expect(entries).toEqual([]);
    expect(error).toBe(PARSE_ERRORS.NO_COLUMNS);
  });
  it('reports the empty error when headers match but nothing follows', () => {
    const { error } = parseRadiusRows([
      ['', 'Employee Attendance Id', 'Employee Name', 'Employee ID', 'Date',
       'Time In', 'Time Out', 'Duration (Minutes)', 'Duration (Hours)', 'Centre'],
    ]);
    expect(error).toBe(PARSE_ERRORS.NO_ROWS);
  });
});
