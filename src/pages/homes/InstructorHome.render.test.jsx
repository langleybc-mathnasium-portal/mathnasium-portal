// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Does the floor-staff home actually RENDER?
 *
 * This exists because two render-time crashes reached production in a row —
 * a temporal-dead-zone bug on Manage Payroll, then a crash in the (since
 * removed) director board — and neither `vite build`, nor eslint, nor 700
 * unit tests could see either. All three inspect code; none of them run
 * React. The only thing that catches a component which throws while
 * rendering is rendering it.
 */

// ── Firestore, routed BY COLLECTION. A mock that hands every listener the
//    same rows is worse than no mock: it lets a test pass for the wrong
//    reason. `collection()` carries its path through `query()`. ──
const snapshots = {};
const rowsFor = (q) => {
  const key = String(q?.__c || '').split('/').pop();
  return snapshots[key] || [];
};

vi.mock('../../firebase', () => ({ db: {}, auth: {} }));
vi.mock('firebase/firestore', () => ({
  collection: (...a) => ({ __c: a.slice(1).join('/') }),
  query: (c) => c,
  where: () => ({}),
  orderBy: () => ({}),
  limit: () => ({}),
  doc: (...a) => ({ __d: a.slice(1).join('/') }),
  onSnapshot: (q, next) => {
    if (typeof next === 'function') {
      const rows = rowsFor(q);
      next({ docs: rows.map((r, i) => ({ id: r.id || `d${i}`, data: () => r })) });
    }
    return () => {};
  },
}));

// The side sheet comes through scheduler-data's document watcher.
const sideSheet = { current: {} };
vi.mock('../../lib/scheduler-data', () => ({
  watchInstructorAssignments: (_c, _d, cb) => { cb(sideSheet.current); return () => {}; },
}));

const authValue = { current: {} };
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authValue.current }));

const { default: InstructorHome } = await import('./InstructorHome');

const BASE_AUTH = {
  profile: { uid: 'u1', displayName: 'Kaitlyn MacDonald' },
  activeCenterId: 'langley',
  mySubRoles: ['Elementary'],
  canTakeShifts: true,
  isInstructor: true,
};

const todayStr = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// Matches the live shift document shape.
const shift = (over = {}) => ({
  id: 's1', centerId: 'langley', userId: 'u1', userName: 'Kaitlyn MacDonald',
  date: '2099-09-12', startTime: '09:00', endTime: '14:00',
  subRole: 'Elementary', instructorType: 'Instructor', status: 'published',
  ...over,
});

const draw = () => render(<MemoryRouter><InstructorHome /></MemoryRouter>);

beforeEach(() => {
  authValue.current = { ...BASE_AUTH };
  sideSheet.current = {};
  for (const k of ['shifts', 'openShifts', 'announcements', 'users']) snapshots[k] = [];
});
afterEach(() => { cleanup(); });

describe('it renders', () => {
  it('with no data at all — the state a new starter is in', () => {
    expect(() => draw()).not.toThrow();
    expect(screen.getByText(/No shifts booked/)).toBeTruthy();
  });

  it('with a shift', () => {
    snapshots.shifts = [shift()];
    draw();
    expect(screen.getAllByText(/9:00 AM/).length).toBeGreaterThan(0);
  });

  it('with a profile that has not loaded yet', () => {
    authValue.current = { ...BASE_AUTH, profile: null, activeCenterId: null };
    expect(() => draw()).not.toThrow();
  });

  it('with shifts missing their times', () => {
    snapshots.shifts = [shift({ startTime: null, endTime: undefined })];
    expect(() => draw()).not.toThrow();
  });

  it('with no sub-roles — nothing to match open shifts against', () => {
    authValue.current = { ...BASE_AUTH, mySubRoles: undefined };
    snapshots.shifts = [shift()];
    snapshots.openShifts = [{ id: 'o1', date: '2099-09-13', subRole: 'Elementary' }];
    expect(() => draw()).not.toThrow();
    expect(screen.queryByText(/open shift/i)).toBeNull();
  });
});

describe('what it puts first', () => {
  it("says you're on today when the shift is today", () => {
    snapshots.shifts = [shift({ date: todayStr() })];
    draw();
    expect(screen.getByText(/You're on today/)).toBeTruthy();
  });

  it('calls a future shift the next shift instead', () => {
    snapshots.shifts = [shift()];
    draw();
    expect(screen.getByText(/Next shift/)).toBeTruthy();
  });

  it('surfaces a missing sign-out as the one thing needing action', () => {
    snapshots.shifts = [shift({ signOutRequestSentAt: '2026-09-08T20:00:00Z' })];
    draw();
    expect(screen.getByText(/Needs you/)).toBeTruthy();
    expect(screen.getByText(/signed in but never signed out/)).toBeTruthy();
  });

  it('says nothing about sign-outs once one is confirmed', () => {
    snapshots.shifts = [shift({
      signOutRequestSentAt: '2026-09-08T20:00:00Z',
      signOutConfirmedTime: '14:00',
    })];
    draw();
    expect(screen.queryByText(/Needs you/)).toBeNull();
  });

  it('never counts a draft or cancelled shift as your next one', () => {
    snapshots.shifts = [
      shift({ id: 'd1', date: '2099-09-10', status: 'draft' }),
      shift({ id: 'c1', date: '2099-09-11', status: 'cancelled' }),
      shift({ id: 'p1', date: '2099-09-12', startTime: '15:00', endTime: '19:00' }),
    ];
    draw();
    expect(screen.getAllByText(/3:00 PM/).length).toBeGreaterThan(0);
  });

  it('only offers open shifts the person is actually qualified for', () => {
    snapshots.shifts = [shift()];
    snapshots.openShifts = [
      { id: 'o1', date: '2099-09-14', subRole: 'Elementary' },
      { id: 'o2', date: '2099-09-15', subRole: 'High School' },
      { id: 'o3', date: '2099-09-16', subRole: 'Elementary', claimedBy: 'someone' },
    ];
    draw();
    expect(screen.getByText(/1 open shift/)).toBeTruthy();   // not 2, not 3
  });
});

describe('mobile', () => {
  it('leaves clearance at the bottom for the tab bar', () => {
    // Content hidden behind a fixed bar is the classic phone-layout bug.
    const { container } = draw();
    expect(container.firstChild.className).toMatch(/pb-28/);
  });

  it('is a single column — nothing that can squeeze on a narrow screen', () => {
    snapshots.shifts = [shift()];
    const { container } = draw();
    const cols = container.querySelectorAll('[class*="grid-cols-"]');
    expect(cols.length).toBe(0);
  });

  it('carries the .nl token scope so its styles resolve', () => {
    const { container } = draw();
    expect(container.firstChild.className).toMatch(/\bnl\b/);
  });

  it('offers a way back to the classic view without the sidebar', () => {
    // On a phone the sidebar is behind a hamburger, so the escape hatch
    // has to exist on the page itself.
    draw();
    expect(screen.getByText(/Classic view/)).toBeTruthy();
  });
});

describe('which side am I on, and when do I move', () => {
  // A real day out of Neeru's sheet. Jason Soo is Elementary 3:00–5:00 and
  // High School 5:00–6:30 — the transfer instructors currently have to ask
  // about out loud.
  const REAL_DAY = {
    'EM|15:00': ['Jason Soo', 'Kaitlyn MacDonald'],
    'EM|15:30': ['Jason Soo', 'Kaitlyn MacDonald'],
    'EM|16:00': ['Jason Soo', 'Kaitlyn MacDonald'],
    'EM|16:30': ['Jason Soo', 'Kaitlyn MacDonald'],
    'EM|17:00': ['Kaitlyn MacDonald'],
    'EM|17:30': ['Kaitlyn MacDonald'],
    'HS|17:00': ['Jason Soo', 'Luke Huang'],
    'HS|17:30': ['Jason Soo', 'Luke Huang'],
    'HS|18:00': ['Jason Soo', 'Luke Huang'],
  };

  const asJason = () => {
    authValue.current = {
      ...BASE_AUTH,
      profile: { uid: 'u1', displayName: 'Jason Soo' },
    };
    snapshots.shifts = [shift({ date: todayStr(), startTime: '15:00', endTime: '18:30' })];
    sideSheet.current = REAL_DAY;
  };

  it('shows the blocks, collapsed — not eight half hours', () => {
    asJason();
    draw();
    expect(screen.getByText('3:00 PM – 5:00 PM')).toBeTruthy();
    expect(screen.getByText('5:00 PM – 6:30 PM')).toBeTruthy();
    // "High School" legitimately appears twice — the block label and the
    // "you move to" sentence — so assert on presence, not uniqueness.
    expect(screen.getAllByText('Elementary').length).toBeGreaterThan(0);
    expect(screen.getAllByText('High School').length).toBeGreaterThan(0);
    // The half-hour boundaries inside a block must NOT appear.
    expect(screen.queryByText('3:00 PM – 3:30 PM')).toBeNull();
  });

  it('says in words when the transfer happens', () => {
    asJason();
    draw();
    const line = screen.getByText(/You move to/);
    expect(line.textContent).toBe('You move to High School at 5:00 PM.');
  });

  it('says so plainly when there is no transfer at all', () => {
    authValue.current = {
      ...BASE_AUTH, profile: { uid: 'u2', displayName: 'Luke Huang' },
    };
    snapshots.shifts = [shift({ date: todayStr(), startTime: '17:00', endTime: '18:30' })];
    sideSheet.current = REAL_DAY;
    draw();
    expect(screen.getByText(/the whole shift/).textContent)
      .toContain('High School');
    // He never changes side, so nothing may claim he does — this caught a
    // real bug where somebody yet to start their shift was told they were
    // "moving to" the only side they were ever on.
    expect(screen.queryByText(/You move to/)).toBeNull();
  });

  it('tells you when sides have not been posted yet', () => {
    snapshots.shifts = [shift({ date: todayStr() })];
    sideSheet.current = {};          // Neeru hasn't filled it in
    draw();
    expect(screen.getByText(/aren't posted for today yet/)).toBeTruthy();
  });

  it('stays quiet about an unposted FUTURE day', () => {
    // A shift next week has no sides yet and that is normal — a permanent
    // "not posted" note would train people to ignore this section.
    snapshots.shifts = [shift({ date: '2099-09-12' })];
    sideSheet.current = {};
    draw();
    expect(screen.queryByText(/aren't posted/)).toBeNull();
  });

  it('shows nothing for somebody not on the sheet', () => {
    snapshots.shifts = [shift({ date: todayStr() })];
    sideSheet.current = { 'EM|15:00': ['Someone Else'] };
    draw();
    expect(screen.queryByText('Elementary')).toBeNull();
    // ...and says why, since it IS today.
    expect(screen.getByText(/aren't posted for today yet/)).toBeTruthy();
  });

  it('survives a malformed sheet without taking the page down', () => {
    snapshots.shifts = [shift({ date: todayStr() })];
    sideSheet.current = { garbage: ['Kaitlyn MacDonald'], 'EM|nope': 'x' };
    expect(() => draw()).not.toThrow();
  });
});
