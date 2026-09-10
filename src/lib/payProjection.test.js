import { describe, it, expect } from 'vitest';
import {
  periodFor, stepPeriod, periodLabel, isInPeriod,
  scheduledHours, payHours, isAdjusted, summarisePeriod,
  sickStatus, statsInPeriod, grossPay, isPlausibleRate, money,
  SICK_DAYS_PER_YEAR, PROBATION_DAYS, isHourlyPaid,
} from './payProjection';

/**
 * This page tells somebody what they are going to be paid, so the bar for
 * these is higher than usual: a number that is wrong in a way that looks
 * right is worse than no page at all — they would budget against it.
 *
 * The rules mirror Manage Payroll deliberately. Where a test looks
 * over-cautious, that is why.
 */

const round = (n) => Math.round(n * 100) / 100;

const shift = (over = {}) => ({
  id: 's1', date: '2026-09-15', startTime: '15:00', endTime: '19:00',
  status: 'published', ...over,
});

describe('pay periods — 11th-25th and 26th-10th', () => {
  it('places a mid-month date', () => {
    expect(periodFor('2026-09-15')).toEqual({ start: '2026-09-11', end: '2026-09-25' });
  });

  it('places the boundaries themselves', () => {
    expect(periodFor('2026-09-11').start).toBe('2026-09-11');
    expect(periodFor('2026-09-25').end).toBe('2026-09-25');
    expect(periodFor('2026-09-26')).toEqual({ start: '2026-09-26', end: '2026-10-10' });
    expect(periodFor('2026-09-10')).toEqual({ start: '2026-08-26', end: '2026-09-10' });
  });

  it('crosses a year boundary in both directions', () => {
    expect(periodFor('2026-12-28')).toEqual({ start: '2026-12-26', end: '2027-01-10' });
    expect(periodFor('2027-01-05')).toEqual({ start: '2026-12-26', end: '2027-01-10' });
  });

  it('handles February without inventing a 30th', () => {
    expect(periodFor('2026-02-27')).toEqual({ start: '2026-02-26', end: '2026-03-10' });
    expect(periodFor('2026-03-05')).toEqual({ start: '2026-02-26', end: '2026-03-10' });
  });

  it('is not fooled by UTC — a bare ISO date parses as the day before in Pacific', () => {
    // The classic trap. If periodFor used `new Date('2026-09-11')` this
    // would land in the previous period.
    expect(periodFor('2026-09-11').start).toBe('2026-09-11');
    expect(periodFor('2026-09-26').start).toBe('2026-09-26');
  });

  it('steps backwards and forwards without gaps or overlaps', () => {
    let p = periodFor('2026-09-15');
    for (let i = 0; i < 30; i++) {
      const prev = stepPeriod(p, -1);
      expect(prev.end < p.start).toBe(true);          // no overlap
      const back = stepPeriod(prev, 1);
      expect(back).toEqual(p);                        // and it round-trips
      p = prev;
    }
  });

  it('labels readably', () => {
    expect(periodLabel({ start: '2026-09-11', end: '2026-09-25' })).toBe('11–25 September');
    expect(periodLabel({ start: '2026-09-26', end: '2026-10-10' })).toBe('26 September – 10 October');
  });

  it('knows what is inside it', () => {
    const p = { start: '2026-09-11', end: '2026-09-25' };
    expect(isInPeriod('2026-09-11', p)).toBe(true);
    expect(isInPeriod('2026-09-25', p)).toBe(true);
    expect(isInPeriod('2026-09-10', p)).toBe(false);
    expect(isInPeriod('2026-09-26', p)).toBe(false);
    expect(isInPeriod(null, p)).toBe(false);
  });
});

describe('hours — the same rule as Manage Payroll', () => {
  it('measures a shift', () => {
    expect(scheduledHours(shift())).toBe(4);
    expect(scheduledHours(shift({ startTime: '09:00', endTime: '14:30' }))).toBe(5.5);
  });

  it('is zero for unreadable times rather than NaN', () => {
    expect(scheduledHours(shift({ startTime: null }))).toBe(0);
    expect(scheduledHours({})).toBe(0);
  });

  it('pays the override when one is set', () => {
    expect(payHours(shift({ payHoursOverride: 3.5 }))).toBe(3.5);
  });

  it('pays NOTHING for a no-show, whatever the override says', () => {
    // Copied from Admin.jsx deliberately: the no-show wins.
    expect(payHours(shift({ noShow: true }))).toBe(0);
    expect(payHours(shift({ noShow: true, payHoursOverride: 4 }))).toBe(0);
  });

  it('ignores a nonsense override and falls back to the clock', () => {
    expect(payHours(shift({ payHoursOverride: 'four' }))).toBe(4);
    expect(payHours(shift({ payHoursOverride: NaN }))).toBe(4);
    expect(payHours(shift({ payHoursOverride: null }))).toBe(4);
  });

  it('flags a row an admin actually changed', () => {
    expect(isAdjusted(shift({ payHoursOverride: 3 }))).toBe(true);
    expect(isAdjusted(shift({ payHoursOverride: 4 }))).toBe(false);   // same as scheduled
    expect(isAdjusted(shift())).toBe(false);
  });

  it('applies NO overtime — because payroll does not either', () => {
    // A twelve-hour day pays twelve hours here, exactly as the real sheet
    // exports it. Inventing time-and-a-half would disagree with the money
    // that actually arrives.
    expect(payHours(shift({ startTime: '08:00', endTime: '20:00' }))).toBe(12);
  });
});

describe('summarisePeriod', () => {
  const period = { start: '2026-09-11', end: '2026-09-25' };
  const rows = [
    shift({ id: 'a', date: '2026-09-12' }),
    shift({ id: 'b', date: '2026-09-15', payHoursOverride: 3 }),
    shift({ id: 'c', date: '2026-09-20', noShow: true }),
    shift({ id: 'd', date: '2026-09-30' }),                       // next period
    shift({ id: 'e', date: '2026-09-13', status: 'draft' }),      // never published
    shift({ id: 'f', date: '2026-09-14', status: 'cancelled' }),
  ];

  it('counts only published shifts inside the period', () => {
    const s = summarisePeriod(rows, period);
    expect(s.rows.map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(s.shiftCount).toBe(3);
  });

  it('separates what was scheduled from what will be paid', () => {
    const s = summarisePeriod(rows, period);
    expect(s.scheduled).toBe(12);   // 4 + 4 + 4
    expect(s.pay).toBe(7);          // 4 + 3 + 0 (no-show)
  });

  it('surfaces how settled the period is', () => {
    const s = summarisePeriod(rows, period);
    expect(s.adjusted).toBe(1);
    expect(s.noShows).toBe(1);
    expect(s.reviewed).toBe(0);
  });

  it('orders rows by date then start time', () => {
    const s = summarisePeriod([
      shift({ id: 'late', date: '2026-09-15', startTime: '17:00', endTime: '19:00' }),
      shift({ id: 'early', date: '2026-09-15', startTime: '09:00', endTime: '12:00' }),
      shift({ id: 'first', date: '2026-09-12' }),
    ], period);
    expect(s.rows.map(r => r.id)).toEqual(['first', 'early', 'late']);
  });

  it('counts a sick day once even across two rows', () => {
    const s = summarisePeriod([
      shift({ id: 'x', date: '2026-09-16', sickPay: true }),
      shift({ id: 'y', date: '2026-09-16', sickPay: true, startTime: '09:00', endTime: '12:00' }),
    ], period);
    expect(s.sickDays).toBe(1);
  });

  it('splits what is already worked from what is still to come', () => {
    // Mid-period, "am I on track" needs both halves. Today's own shift
    // counts as still to come — the day is not over.
    const s = summarisePeriod(rows, period, '2026-09-15');
    expect(s.done).toBe(4);        // the 12th
    expect(s.upcoming).toBe(3);    // the 15th (today, 3h override) + the 20th no-show (0)
    expect(round(s.done + s.upcoming)).toBe(s.pay);
  });

  it('counts everything as done once the period has passed', () => {
    const s = summarisePeriod(rows, period, '2026-10-01');
    expect(s.done).toBe(s.pay);
    expect(s.upcoming).toBe(0);
  });

  it('counts everything as upcoming before the period starts', () => {
    const s = summarisePeriod(rows, period, '2026-09-01');
    expect(s.upcoming).toBe(s.pay);
    expect(s.done).toBe(0);
  });

  it('is empty, not broken, with nothing to show', () => {
    const s = summarisePeriod([], period);
    expect(s).toMatchObject({ shiftCount: 0, scheduled: 0, pay: 0 });
    expect(summarisePeriod(null, period).rows).toEqual([]);
  });
});

describe('sick leave — the BC ESA minimum', () => {
  it('gives five days a year once probation is served', () => {
    const s = sickStatus({ hireDate: '2020-01-01', asOf: '2026-09-15' });
    expect(s.entitlement).toBe(SICK_DAYS_PER_YEAR);
    expect(s.remaining).toBe(5);
    expect(s.onProbation).toBe(false);
  });

  it('withholds nothing but says so during the first ninety days', () => {
    const s = sickStatus({ hireDate: '2026-08-01', asOf: '2026-09-15' });
    expect(s.onProbation).toBe(true);
    expect(s.remaining).toBe(0);
    expect(s.eligibleFrom).toBe('2026-10-30');   // 90 days after hire
    expect(s.daysIn).toBe(45);
  });

  it('turns eligible exactly on day ninety', () => {
    const hire = '2026-06-01';
    expect(sickStatus({ hireDate: hire, asOf: '2026-08-29' }).onProbation).toBe(true);
    expect(sickStatus({ hireDate: hire, asOf: '2026-08-30' }).onProbation).toBe(false);
  });

  it('counts days taken this year only', () => {
    const s = sickStatus({
      hireDate: '2020-01-01', asOf: '2026-09-15',
      sickDates: ['2026-02-03', '2026-05-10', '2025-11-01'],
    });
    expect(s.used).toBe(2);
    expect(s.remaining).toBe(3);
  });

  it('counts days recorded outside Ratio against the same allowance', () => {
    const s = sickStatus({
      hireDate: '2020-01-01', asOf: '2026-09-15',
      sickDates: ['2026-02-03'], externalSickDates: ['2026-03-04', '2026-04-05'],
    });
    expect(s.used).toBe(3);
    expect(s.remaining).toBe(2);
  });

  it('never counts the same date twice', () => {
    const s = sickStatus({
      hireDate: '2020-01-01', asOf: '2026-09-15',
      sickDates: ['2026-02-03'], externalSickDates: ['2026-02-03'],
    });
    expect(s.used).toBe(1);
  });

  it('never goes negative when more were taken than allowed', () => {
    const s = sickStatus({
      hireDate: '2020-01-01', asOf: '2026-09-15',
      sickDates: ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06'],
    });
    expect(s.remaining).toBe(0);
  });

  it('treats a missing hire date as eligible, and says the date is missing', () => {
    // Same call the payroll page makes: withholding leave because nobody
    // filled in a form is the worse failure.
    const s = sickStatus({ asOf: '2026-09-15' });
    expect(s.hireDateMissing).toBe(true);
    expect(s.onProbation).toBe(false);
    expect(s.remaining).toBe(5);
  });

  it('uses the settled ninety-day figure', () => {
    expect(PROBATION_DAYS).toBe(90);
  });
});

describe('statutory holidays in a period', () => {
  const period = { start: '2026-08-26', end: '2026-09-10' };
  // Labour Day 2026 is Monday 7 September.
  const holidays = [
    { date: '2026-09-07', name: 'Labour Day' },
    { date: '2026-09-05', name: 'Team day' },          // not statutory
    { date: '2026-12-25', name: 'Christmas Day' },     // not in this period
  ];

  const workDays = (from, count) => {
    const out = [];
    const d = new Date(2026, 7, from, 12);
    for (let i = 0; i < count; i++) {
      out.push(shift({
        id: `w${i}`,
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      }));
      d.setDate(d.getDate() + 1);
    }
    return out;
  };

  it('finds only the real statutory day inside the period', () => {
    const stats = statsInPeriod(holidays, period, workDays(10, 20));
    expect(stats.map(s => s.name)).toEqual(['Labour Day']);
  });

  it('qualifies somebody with fifteen days in the previous thirty', () => {
    const stats = statsInPeriod(holidays, period, workDays(10, 20));
    expect(stats[0].qualifies).toBe(true);
    expect(stats[0].daysWorked).toBeGreaterThanOrEqual(15);
    expect(stats[0].hours).toBeGreaterThan(0);
  });

  it('does not qualify somebody with too few, and pays zero', () => {
    const stats = statsInPeriod(holidays, period, workDays(25, 5));
    expect(stats[0].qualifies).toBe(false);
    expect(stats[0].hours).toBe(0);
    expect(stats[0].daysWorked).toBeLessThan(15);
  });

  it('is empty when the centre has no holidays configured', () => {
    expect(statsInPeriod(null, period, [])).toEqual([]);
    expect(statsInPeriod([], period, [])).toEqual([]);
  });
});

describe('money', () => {
  it('multiplies hours by rate', () => {
    expect(grossPay(20, 21.5)).toBe(430);
    expect(grossPay(7.25, 20)).toBe(145);
  });

  it('rounds to the cent', () => {
    expect(grossPay(3.33, 19.99)).toBe(66.57);
  });

  it('returns null — not zero — without a usable rate', () => {
    // "$0.00" reads as an answer. Null lets the page ask for the rate.
    expect(grossPay(20, null)).toBeNull();
    expect(grossPay(20, 0)).toBeNull();
    expect(grossPay(20, -5)).toBeNull();
    expect(grossPay(20, 'twenty')).toBeNull();
    expect(grossPay(null, 20)).toBeNull();
    expect(grossPay(undefined, 20)).toBeNull();
  });

  it('but zero hours really is zero pay, not a gap', () => {
    // The distinction that matters: nobody scheduled this period earns
    // nothing, and the page should say so plainly.
    expect(grossPay(0, 20)).toBe(0);
  });

  it('rejects an implausible rate rather than showing a fantasy', () => {
    expect(isPlausibleRate(21.5)).toBe(true);
    expect(isPlausibleRate(0)).toBe(false);
    expect(isPlausibleRate(-1)).toBe(false);
    expect(isPlausibleRate(2150)).toBe(false);      // cents typed as dollars
    expect(isPlausibleRate('abc')).toBe(false);
  });

  it('formats Canadian dollars', () => {
    expect(money(430)).toMatch(/430\.00/);
    expect(money(null)).toBe('—');
    expect(money('abc')).toBe('—');
  });
});

describe('isHourlyPaid — who this page is for', () => {
  const CFG = { salaryStaff: ['Neeru Sharma', 'Vinod Kumar'] };

  it('includes everyone paid for the hours they work', () => {
    expect(isHourlyPaid({ displayName: 'Kaitlyn MacDonald' }, CFG)).toBe(true);
    expect(isHourlyPaid({ displayName: 'A Trainee' }, CFG)).toBe(true);
  });

  it('excludes volunteers — a pay page for unpaid work is wrong, not empty', () => {
    expect(isHourlyPaid({ displayName: 'Helper', isVolunteer: true }, CFG)).toBe(false);
  });

  it('excludes salaried staff, who are not paid from the hourly sheet', () => {
    expect(isHourlyPaid({ displayName: 'Neeru Sharma' }, CFG)).toBe(false);
    expect(isHourlyPaid({ displayName: '  neeru sharma  ' }, CFG)).toBe(false);
  });

  it('copes with no centre config', () => {
    expect(isHourlyPaid({ displayName: 'Anyone' }, null)).toBe(true);
    expect(isHourlyPaid({}, {})).toBe(true);
  });
});
