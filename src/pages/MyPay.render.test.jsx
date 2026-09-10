// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The pay page, rendered.
 *
 * Higher bar than usual: this tells somebody what they are going to be
 * paid. A figure that is wrong in a way that looks right is worse than no
 * page — they would budget against it. So as well as "does it render",
 * these check the things that must never appear: a dollar amount with no
 * rate behind it, pay for a no-show, or the page at all for somebody who
 * isn't paid by the hour.
 */

const snapshots = {};
const rowsFor = (q) => snapshots[String(q?.__c || '').split('/').pop()] || [];

vi.mock('../firebase', () => ({ db: {}, auth: {} }));
vi.mock('firebase/firestore', () => ({
  collection: (...a) => ({ __c: a.slice(1).join('/') }),
  query: (c) => c,
  where: () => ({}),
  orderBy: () => ({}),
  limit: () => ({}),
  doc: (...a) => ({ __d: a.slice(1).join('/') }),
  onSnapshot: (q, next) => {
    if (typeof next === 'function') {
      next({ docs: rowsFor(q).map((r, i) => ({ id: r.id || `d${i}`, data: () => r })) });
    }
    return () => {};
  },
}));

const storedRate = { current: null };
const saved = { current: [] };
vi.mock('../lib/payRate', () => ({
  watchOwnRate: (_uid, cb) => { cb(storedRate.current); return () => {}; },
  saveOwnRate: async (_uid, r) => { saved.current.push(r); storedRate.current = r; return r; },
}));

const authValue = { current: {} };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authValue.current }));

const { default: MyPay } = await import('./MyPay');

const BASE_AUTH = {
  profile: { uid: 'u1', displayName: 'Kaitlyn MacDonald', hireDate: '2020-01-01' },
  activeCenterId: 'langley',
  isVolunteer: false,
  centerConfig: { salaryStaff: ['Neeru Sharma'], holidays: [] },
};

// Inside the 11–25 September period the fixed clock sits in.
const shift = (over = {}) => ({
  id: 's1', centerId: 'langley', userId: 'u1',
  date: '2026-09-12', startTime: '15:00', endTime: '19:00',
  status: 'published', subRole: 'Elementary', ...over,
});

const draw = () => render(<MemoryRouter><MyPay /></MemoryRouter>);

beforeEach(() => {
  // Fixed clock: 15 September 2026, 4pm. Without this the period on screen
  // and the done/upcoming split depend on when the suite runs.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 15, 16, 0, 0));
  authValue.current = { ...BASE_AUTH };
  storedRate.current = null;
  saved.current = [];
  for (const k of ['shifts']) snapshots[k] = [];
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('it renders', () => {
  it('with no shifts at all', () => {
    expect(() => draw()).not.toThrow();
    expect(screen.getByText(/Nothing scheduled in/)).toBeTruthy();
  });

  it('with shifts', () => {
    snapshots.shifts = [shift()];
    draw();
    expect(screen.getByText('11–25 September')).toBeTruthy();
    expect(screen.getByText('Current pay period')).toBeTruthy();
  });

  it('with a profile that has not loaded', () => {
    authValue.current = { ...BASE_AUTH, profile: null, activeCenterId: null };
    expect(() => draw()).not.toThrow();
  });

  it('with no centre config', () => {
    authValue.current = { ...BASE_AUTH, centerConfig: null };
    snapshots.shifts = [shift()];
    expect(() => draw()).not.toThrow();
  });

  it('with shifts missing their times', () => {
    snapshots.shifts = [shift({ startTime: null, endTime: undefined })];
    expect(() => draw()).not.toThrow();
  });
});

describe('never shows money it cannot stand behind', () => {
  it('leads with HOURS, not dollars, until a rate is entered', () => {
    snapshots.shifts = [shift()];
    draw();
    expect(screen.getByText(/Hours this period/)).toBeTruthy();
    expect(screen.getByText(/Add your hourly rate/)).toBeTruthy();
    // No dollar figure anywhere — not even $0.00, which would read as an answer.
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it('shows gross once a rate exists, and shows its working', () => {
    storedRate.current = 20;
    snapshots.shifts = [shift()];        // 4 hours
    draw();
    expect(screen.getByText(/Estimated gross this period/)).toBeTruthy();
    // $80.00 legitimately appears twice — the hero and the shift row — so
    // assert presence, and check the hero's working line as whole text.
    expect(screen.getAllByText(/\$80\.00/).length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('4 hours × $20.00/hr');
    expect(document.body.textContent).toContain('before tax, CPP and EI');
  });

  it('pays a no-show nothing', () => {
    storedRate.current = 20;
    snapshots.shifts = [shift({ noShow: true })];
    draw();
    expect(screen.getByText('No show')).toBeTruthy();
    expect(screen.getAllByText('0h').length).toBeGreaterThan(0);
  });

  it("shows payroll's adjusted figure alongside what was scheduled", () => {
    storedRate.current = 20;
    snapshots.shifts = [shift({ payHoursOverride: 3 })];
    draw();
    expect(screen.getByText('was 4h')).toBeTruthy();
    expect(screen.getAllByText('3h').length).toBeGreaterThan(0);
  });

  it('never counts a draft shift into the figure', () => {
    storedRate.current = 20;
    snapshots.shifts = [shift({ status: 'draft' })];
    draw();
    expect(screen.getByText(/Nothing scheduled in/)).toBeTruthy();
  });
});

describe('the caveat is impossible to miss', () => {
  it('says it is not a payslip, right under the number', () => {
    storedRate.current = 20;
    snapshots.shifts = [shift()];
    draw();
    expect(screen.getByText(/This is an estimate, not a payslip/)).toBeTruthy();
    expect(screen.getByText(/comes from QuickBooks/)).toBeTruthy();
  });

  it('names the deductions it has NOT taken off', () => {
    storedRate.current = 20;
    snapshots.shifts = [shift()];
    draw();
    expect(screen.getByText(/before tax, CPP and EI/)).toBeTruthy();
  });
});

describe('the rate box tells you who can see it', () => {
  it('says so before you type anything', () => {
    draw();
    expect(screen.getByText(/Other instructors can't see this/)).toBeTruthy();
    expect(screen.getByText(/owner and admins can/)).toBeTruthy();
  });

  it('offers to add one when none is set', () => {
    draw();
    expect(screen.getByText(/Add your rate/)).toBeTruthy();
  });

  it('shows the current rate when one is set', () => {
    storedRate.current = 20.5;
    draw();
    expect(screen.getAllByText(/\$20\.50\/hr/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Change/)).toBeTruthy();
  });
});

describe('sick leave', () => {
  it('shows what is left for somebody past probation', () => {
    draw();
    expect(screen.getByText(/days left for 2026/)).toBeTruthy();
  });

  it('explains probation rather than showing zero days left', () => {
    authValue.current = {
      ...BASE_AUTH,
      profile: { ...BASE_AUTH.profile, hireDate: '2026-08-20' },
    };
    draw();
    expect(screen.getByText(/first 90 days/)).toBeTruthy();
    expect(screen.getByText(/you'll have 5 paid days/i)).toBeTruthy();
  });

  it('flags a missing start date instead of hiding the assumption', () => {
    authValue.current = {
      ...BASE_AUTH,
      profile: { uid: 'u1', displayName: 'Kaitlyn MacDonald' },
    };
    draw();
    expect(screen.getByText(/start date isn't on file/)).toBeTruthy();
  });
});

describe('who the page is for', () => {
  it('turns a volunteer away with a reason', () => {
    authValue.current = { ...BASE_AUTH, isVolunteer: true };
    draw();
    expect(screen.getByText(/This page is for hourly staff/)).toBeTruthy();
    expect(screen.getByText(/Volunteer hours are unpaid/)).toBeTruthy();
    expect(screen.queryByText(/Estimated gross/)).toBeNull();
  });

  it('turns salaried staff away with a different reason', () => {
    authValue.current = {
      ...BASE_AUTH,
      profile: { ...BASE_AUTH.profile, displayName: 'Neeru Sharma' },
    };
    draw();
    expect(screen.getByText(/This page is for hourly staff/)).toBeTruthy();
    expect(screen.getByText(/paid outside the hourly sheet/)).toBeTruthy();
  });

  it('lets an ordinary instructor in', () => {
    snapshots.shifts = [shift()];
    draw();
    expect(screen.queryByText(/This page is for hourly staff/)).toBeNull();
  });
});
