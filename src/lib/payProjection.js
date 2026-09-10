/**
 * payProjection.js — an instructor's own pay period, as far as Ratio knows it.
 *
 * WHAT THIS IS FOR
 *   Staff currently have no way to see their own hours without asking. This
 *   answers "how many hours am I on for this period, roughly what does that
 *   come to, and where do I stand on sick days and stat pay" — from data
 *   they are already allowed to see.
 *
 * WHAT IT IS NOT
 *   It is not payroll. QuickBooks is the source of truth, and the figures
 *   here carry no deductions — no income tax, no CPP, no EI, no union or
 *   benefit lines. It is gross, before everything.
 *
 * IT MIRRORS THE REAL SHEET RATHER THAN RECOMPUTING IT
 *   Every rule below is copied from the payroll summary in Admin.jsx on
 *   purpose, so the two cannot drift:
 *
 *     pay hours = 0 if no-show, else payHoursOverride ?? scheduled hours
 *
 *   In particular there is NO OVERTIME here, because Ratio's payroll does
 *   not compute overtime either. Inventing time-and-a-half would produce a
 *   number that disagrees with what the person is actually paid, which is
 *   worse than showing them nothing — they would budget against it.
 */

import { statPayForHoliday, isPaidStatHoliday, STAT_MIN_QUALIFYING_DAYS } from './statPay';

// Re-exported so the page has one place to import pay rules from.
export { STAT_MIN_QUALIFYING_DAYS };

export const SICK_DAYS_PER_YEAR = 5;   // BC ESA minimum
export const PROBATION_DAYS = 90;      // before paid sick leave is available

// ─── Pay periods ────────────────────────────────────────────────────────
// The centre runs 11th–25th and 26th–10th. Same cycle the Manage Payroll
// tab defaults to; keep them in step.

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** Local-noon parse. A bare YYYY-MM-DD is UTC midnight, i.e. the day before. */
function parse(dateISO) {
  const [y, m, d] = String(dateISO).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0);
}

/**
 * The pay period containing a date.
 * @returns {{ start: string, end: string }}
 */
export function periodFor(dateISO) {
  const d = parse(dateISO);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();

  if (day >= 11 && day <= 25) return { start: iso(y, m, 11), end: iso(y, m, 25) };

  if (day > 25) {
    // 26th → the 10th of next month.
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return { start: iso(y, m, 26), end: iso(ny, nm, 10) };
  }

  // 1st–10th → started on the 26th of last month.
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return { start: iso(py, pm, 26), end: iso(y, m, 10) };
}

/** The period before or after this one. `delta` of -1 or +1. */
export function stepPeriod(period, delta) {
  const anchor = parse(delta < 0 ? period.start : period.end);
  anchor.setDate(anchor.getDate() + (delta < 0 ? -1 : 1));
  return periodFor(iso(anchor.getFullYear(), anchor.getMonth() + 1, anchor.getDate()));
}

/** "11–25 September" / "26 September – 10 October". */
export function periodLabel(period) {
  const a = parse(period.start);
  const b = parse(period.end);
  const month = (d) => d.toLocaleDateString('en-CA', { month: 'long' });
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) {
    return `${a.getDate()}–${b.getDate()} ${month(a)}`;
  }
  return `${a.getDate()} ${month(a)} – ${b.getDate()} ${month(b)}`;
}

export function isInPeriod(dateISO, period) {
  return !!dateISO && dateISO >= period.start && dateISO <= period.end;
}

// ─── Hours ──────────────────────────────────────────────────────────────

/** Scheduled length of a shift, in decimal hours. */
export function scheduledHours(shift) {
  const [h1, m1] = String(shift?.startTime || '').split(':').map(Number);
  const [h2, m2] = String(shift?.endTime || '').split(':').map(Number);
  if (![h1, m1, h2, m2].every(Number.isFinite)) return 0;
  return Math.max(0, ((h2 * 60 + m2) - (h1 * 60 + m1)) / 60);
}

/**
 * What payroll will actually pay for this shift.
 *
 * Identical to Admin.jsx: a no-show pays nothing whatever the override
 * says, and an admin's manual Pay-h figure beats the clock.
 */
export function payHours(shift) {
  if (shift?.noShow === true) return 0;
  const override = shift?.payHoursOverride;
  if (typeof override === 'number' && Number.isFinite(override)) return override;
  return scheduledHours(shift);
}

/** Is this row settled enough to be worth showing as adjusted? */
export function isAdjusted(shift) {
  const override = shift?.payHoursOverride;
  return typeof override === 'number' && Number.isFinite(override)
    && Math.abs(override - scheduledHours(shift)) > 0.01;
}

/**
 * One person's period: their rows, their hours, and how settled it is.
 *
 * Draft shifts are excluded — they were never published, so they are a plan
 * rather than a commitment, and counting them would inflate the number
 * somebody is budgeting against.
 */
export function summarisePeriod(shifts, period, asOf) {
  const rows = (shifts || [])
    .filter(s => isInPeriod(s?.date, period))
    .filter(s => s.status !== 'draft' && s.status !== 'cancelled')
    .sort((a, b) => String(a.date).localeCompare(String(b.date))
      || String(a.startTime).localeCompare(String(b.startTime)))
    .map(s => ({
      id: s.id,
      date: s.date,
      startTime: s.startTime,
      endTime: s.endTime,
      subRole: s.subRole || null,
      scheduled: round2(scheduledHours(s)),
      pay: round2(payHours(s)),
      noShow: s.noShow === true,
      sick: s.sickPay === true,
      adjusted: isAdjusted(s),
      resolved: s.payrollResolved === true,
    }));

  const scheduled = round2(rows.reduce((n, r) => n + r.scheduled, 0));
  const pay = round2(rows.reduce((n, r) => n + r.pay, 0));

  // Split at today, because mid-period "what am I on track for" is the
  // question people actually have — a single total can't tell them whether
  // the money is already earned or still to be worked for. Today's own
  // shifts count as still to come: the day isn't over.
  const today = asOf || todayISO();
  const done = round2(rows.filter(r => r.date < today).reduce((n, r) => n + r.pay, 0));
  const upcoming = round2(rows.filter(r => r.date >= today).reduce((n, r) => n + r.pay, 0));

  return {
    rows,
    shiftCount: rows.length,
    scheduled,
    pay,
    done,
    upcoming,
    // How much of the period an admin has already signed off. Not a
    // guarantee — just a signal that the number is settling.
    reviewed: rows.filter(r => r.resolved).length,
    adjusted: rows.filter(r => r.adjusted).length,
    noShows: rows.filter(r => r.noShow).length,
    sickDays: new Set(rows.filter(r => r.sick).map(r => r.date)).size,
  };
}

// ─── Sick leave (BC ESA minimum) ────────────────────────────────────────

/**
 * Where someone stands on paid sick leave for a calendar year.
 *
 * Mirrors Admin.jsx: five days a year, available once ninety days are
 * served, entitlement consumed chronologically across the whole year.
 *
 * A MISSING HIRE DATE COUNTS AS ELIGIBLE, exactly as the payroll page
 * treats it — withholding somebody's leave because nobody filled in a form
 * is the worse failure. The UI says the date is missing rather than hiding
 * the assumption.
 */
export function sickStatus({ hireDate, sickDates = [], externalSickDates = [], asOf } = {}) {
  const today = asOf || todayISO();
  const year = String(today).slice(0, 4);
  const inYear = (d) => typeof d === 'string' && d.slice(0, 4) === year;

  const used = new Set([...sickDates, ...externalSickDates].filter(inYear));

  let daysIn = null;
  let onProbation = false;
  let eligibleFrom = null;
  if (hireDate) {
    daysIn = Math.floor((parse(today) - parse(hireDate)) / 86400000);
    onProbation = daysIn < PROBATION_DAYS;
    const d = parse(hireDate);
    d.setDate(d.getDate() + PROBATION_DAYS);
    eligibleFrom = iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  return {
    year,
    hireDate: hireDate || null,
    hireDateMissing: !hireDate,
    daysIn,
    onProbation,
    eligibleFrom,
    used: used.size,
    entitlement: SICK_DAYS_PER_YEAR,
    remaining: onProbation ? 0 : Math.max(0, SICK_DAYS_PER_YEAR - used.size),
    dates: [...used].sort(),
  };
}

// ─── Statutory holidays ─────────────────────────────────────────────────

/**
 * Stat holidays falling in this period, with the person's entitlement
 * against each — using the same engine the payroll page uses.
 *
 * @param holidays  the centre's configured holidays
 * @param allShifts every shift of theirs (the 30-day window reaches back
 *                  BEFORE the period, so passing only period rows would
 *                  under-count qualifying days and wrongly say "no")
 */
export function statsInPeriod(holidays, period, allShifts) {
  return (holidays || [])
    .filter(h => h?.date && isInPeriod(h.date, period) && isPaidStatHoliday(h))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(h => ({
      date: h.date,
      name: h.name || 'Statutory holiday',
      ...statPayForHoliday(allShifts || [], h.date, scheduledHours),
    }));
}

// ─── Money ──────────────────────────────────────────────────────────────

/**
 * Gross pay, before every deduction.
 *
 * Returns null rather than 0 when there is no usable rate, so the UI can
 * ask for one instead of showing somebody "$0.00" and letting them think
 * that is the answer.
 */
export function grossPay(hours, rate) {
  // `Number(null)` is 0, not NaN — so an UNKNOWN number of hours would
  // quietly come out as "$0.00", which reads as an answer rather than a
  // gap. Zero hours legitimately pays zero; absent hours must not.
  if (hours == null || rate == null || hours === '' || rate === '') return null;
  const h = Number(hours);
  const r = Number(rate);
  if (!Number.isFinite(h) || !Number.isFinite(r) || r <= 0 || h < 0) return null;
  return Math.round(h * r * 100) / 100;
}

/** A rate a person could plausibly have typed. Guards against fat fingers. */
export function isPlausibleRate(rate) {
  const r = Number(rate);
  return Number.isFinite(r) && r > 0 && r <= 500;
}

export function money(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-CA', {
    style: 'currency', currency: 'CAD', minimumFractionDigits: 2,
  });
}

function round2(n) { return Math.round(n * 100) / 100; }

export function todayISO(d = new Date()) {
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/**
 * Is this person paid by the hour, and so has a projection worth showing?
 *
 * Two exclusions, both mirroring how Manage Payroll builds its sheet:
 *
 *   - VOLUNTEERS are unpaid. A pay page for somebody who is not paid is
 *     not a neutral empty state, it is a wrong one.
 *   - SALARIED staff (`centerConfig.salaryStaff`) are paid outside the
 *     hourly sheet entirely, so hours × rate is not what they receive and
 *     showing it would actively mislead.
 *
 * Everyone else — instructors, leads, managers, hosts, trainees — is paid
 * for the hours they work, which is exactly what this projects.
 */
export function isHourlyPaid({ displayName, isVolunteer } = {}, centerConfig = null) {
  if (isVolunteer) return false;
  const salaried = Array.isArray(centerConfig?.salaryStaff) ? centerConfig.salaryStaff : [];
  const norm = (n) => String(n || '').trim().toLowerCase();
  if (displayName && salaried.some(n => norm(n) === norm(displayName))) return false;
  return true;
}
