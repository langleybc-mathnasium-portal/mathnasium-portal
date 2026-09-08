/**
 * radiusTimesheet.js — turning a Radius "Employee Timesheet" export into rows.
 *
 * Extracted out of Admin.jsx so it can be run against real export files in
 * tests. It used to live inline in the import handler, which meant the only
 * way to find out whether it handled a given file was to click Upload and
 * squint — and the bug that motivated this (missed sign-outs being silently
 * dropped) survived exactly that long.
 *
 * WHAT THE FILE ACTUALLY LOOKS LIKE (verified against a live export):
 *
 *   ''                | Employee Attendance Id | Employee Name | ... | Time Out | Duration (Minutes)
 *   'Aarav Agarkar (I)'|                       |               |     |          |                     <- section header
 *   ''                | 14387040 | Aarav Agarkar | 26/08/2026 | 1:59 PM | 7:07 PM | 309
 *   ''                |          |               |            |         |         | 'Total: 1354'      <- subtotal
 *
 * So: a leading blank column, a per-person section header row, one row per
 * punch, and a subtotal row. Only the punch rows carry a numeric
 * Employee Attendance Id, which is what separates them from the other two.
 *
 * Dates are DD/MM/YYYY. Times are 12-hour with AM/PM.
 *
 * OPEN PUNCHES: a shift someone clocked into and never out of comes through
 * with Time Out as an EMPTY STRING and both Duration columns empty — but it
 * still has an attendance id, so it is a real row and must be kept. See
 * src/lib/signOut.js.
 */

import { toMinutes, hoursBetween, isOpenPunch } from './signOut';

export const PARSE_ERRORS = {
  NO_COLUMNS: 'Could not find the expected columns in this file. Make sure it is the '
    + 'Radius Employee Timesheet export with columns: Employee Name, Date, Time In, '
    + 'Time Out, Duration.',
  NO_ROWS: 'No valid entries found. Make sure this is the Radius Employee Timesheet export.',
};

/**
 * Normalise Radius's Duration column to decimal hours.
 *
 * Radius exports duration in MINUTES (a 4-hour shift comes through as 242 —
 * 4h 2min — not 242 hours). Treating it as hours produced totals like
 * "2,095h" for a pay period. Three observed shapes:
 *   minutes as a plain number (242)  -> /60
 *   decimal hours (4.03)             -> as-is
 *   "HH:MM" ("04:02")                -> parsed
 * Anything above 24 is minutes: nobody works a 24-hour shift, and the
 * largest legitimate hours value is ~16.
 */
export function normaliseDuration(raw) {
  if (raw == null || raw === '') return NaN;
  const s = String(raw).trim();
  if (s.includes(':')) {
    const [h, m] = s.split(':').map(Number);
    if (Number.isFinite(h) && Number.isFinite(m)) return h + (m / 60);
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return NaN;
  return n > 24 ? n / 60 : n;
}

/**
 * Find the header row and map the columns we need.
 *
 * Matched by keyword rather than fixed index, so a cosmetic header change
 * ("Date" -> "Shift Date") doesn't break the import. Radius also sometimes
 * puts a title row above the headers, hence the scan.
 */
export function findColumns(rows, scanLimit = 10) {
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const limit = Math.min(rows.length, scanLimit);
  for (let i = 0; i < limit; i++) {
    const r = (rows[i] || []).map(norm);
    const find = (p) => r.findIndex(p);
    const candidate = {
      name:         find(c => c.includes('employee') && c.includes('name')),
      attendanceId: find(c => c.includes('attendance') && c.includes('id')),
      date:         find(c => c === 'date' || c.includes('shift date') || c.includes('work date')),
      timeIn:       find(c => c.replace(/[^a-z]/g, '') === 'timein' || (c.includes('time') && c.includes('in') && !c.includes('out'))),
      timeOut:      find(c => c.replace(/[^a-z]/g, '') === 'timeout' || (c.includes('time') && c.includes('out'))),
      duration:     find(c => c.includes('duration') || c.includes('hours')),
    };
    if (candidate.name >= 0 && candidate.date >= 0
      && candidate.timeIn >= 0 && candidate.timeOut >= 0 && candidate.duration >= 0) {
      return { headerIndex: i, colMap: candidate };
    }
  }
  return { headerIndex: -1, colMap: null };
}

/** "26/08/2026" -> "2026-08-26". Null when it isn't a DD/MM/YYYY date. */
export function toISODate(raw) {
  const s = String(raw ?? '').trim();
  if (!s.includes('/')) return null;
  const parts = s.split('/');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts.map(x => x.trim());
  if (!/^\d{4}$/.test(y) || !/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(d)) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * Parse a sheet (array-of-arrays, as SheetJS `header: 1` gives it) into
 * timesheet entries.
 *
 * @returns {{ entries: Array, error: string|null }}
 */
export function parseRadiusRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { entries: [], error: PARSE_ERRORS.NO_COLUMNS };
  }
  const { headerIndex, colMap } = findColumns(rows);
  if (!colMap) return { entries: [], error: PARSE_ERRORS.NO_COLUMNS };

  const entries = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const name    = String(row[colMap.name] ?? '').trim();
    const dateRaw = String(row[colMap.date] ?? '').trim();
    const timeIn  = String(row[colMap.timeIn] ?? '').trim();
    const timeOut = String(row[colMap.timeOut] ?? '').trim();

    // Only real punch rows carry a numeric attendance id. Section headers
    // ("Aarav Agarkar (I)") and subtotals ("Total: 1354") don't, which is
    // how all three are told apart. Open punches DO have one.
    if (colMap.attendanceId >= 0) {
      const aid = row[colMap.attendanceId];
      if (typeof aid !== 'number' || Number.isNaN(aid)) continue;
    }
    if (!name) continue;

    const dateStr = toISODate(dateRaw);
    if (!dateStr) continue;

    // Signed in, never signed out. Kept with ZERO hours, not a guess: a
    // duration without a tap-out isn't evidence, and inventing hours here
    // would push a fabricated number into payroll. Before this, the row was
    // dropped and the shift read as "Not in Radius" — i.e. never came in.
    const openPunch = isOpenPunch({ timeIn, timeOut });

    // Prefer computing from the punch times (most accurate); the Duration
    // column has been unreliable across export versions.
    const fromTimes = hoursBetween(timeIn, timeOut);
    const fromCol   = normaliseDuration(row[colMap.duration]);
    const derived   = fromTimes != null ? fromTimes
                    : Number.isFinite(fromCol) ? fromCol
                    : NaN;
    const actualHours = openPunch ? 0 : derived;
    if (!openPunch && !Number.isFinite(actualHours)) continue;

    entries.push({ name, date: dateStr, timeIn, timeOut, actualHours, openPunch });
  }

  if (entries.length === 0) return { entries: [], error: PARSE_ERRORS.NO_ROWS };
  return { entries, error: null };
}

/** Re-exported so callers don't need two imports to read a punch time. */
export { toMinutes };
