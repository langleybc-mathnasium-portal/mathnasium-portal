// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Does each front door actually RENDER?
 *
 * This exists because two render-time crashes reached production in a row
 * — a temporal-dead-zone bug on Manage Payroll, and whatever took out the
 * new home — and neither `vite build`, nor eslint, nor 699 unit tests could
 * see them. All three inspect code; none of them run React. The only thing
 * that catches a component which throws while rendering is rendering it.
 *
 * The auth context and Firestore are stubbed, so this asserts the component
 * itself is sound, not that the data is right.
 */

// ── Firestore, routed BY COLLECTION.
//    A mock that hands every listener the same rows is worse than no mock:
//    the availability listener received shift documents, the clash check
//    saw nonsense, and a test passed for the wrong reason. `collection()`
//    carries its path through `query()` so each subscription gets its own
//    data, the way the real thing does. ──
const snapshots = { rows: [] };
const rowsFor = (q) => {
  const key = String(q?.__c || '').split('/').pop();
  return snapshots[key] !== undefined ? snapshots[key] : snapshots.rows;
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
    // Deliver synchronously so the door renders its loaded state.
    if (typeof next === 'function') {
      const rows = rowsFor(q);
      next({ docs: rows.map((r, i) => ({ id: r.id || `d${i}`, data: () => r })) });
    }
    return () => {};
  },
}));
vi.mock('../../lib/scheduler-data', () => ({
  watchCheckIns: (_c, _d, cb) => { cb({}); return () => {}; },
  watchWalkIns: (_c, _d, cb) => { cb({}); return () => {}; },
}));

const authValue = { current: {} };
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => authValue.current,
}));

const { default: InstructorHome } = await import('./InstructorHome');
const { default: HostHome } = await import('./HostHome');
const { default: DirectorHome } = await import('./DirectorHome');
const { default: OwnerHome } = await import('./OwnerHome');

const BASE_AUTH = {
  profile: { uid: 'u1', displayName: 'Kaitlyn MacDonald' },
  activeCenterId: 'langley',
  mySubRoles: ['Elementary'],
  canTakeShifts: true,
  centerConfig: {
    name: 'Mathnasium',
    holidays: [{ name: "New Year's Day", date: '2026-01-01' }],
    staffingBudget: {},
  },
};

// A believable shift row, matching the live document shape.
const shift = (over = {}) => ({
  id: 's1', centerId: 'langley', userId: 'u1', userName: 'Kaitlyn MacDonald',
  date: '2026-09-12', startTime: '09:00', endTime: '14:00',
  subRole: 'Elementary', instructorType: 'Instructor', status: 'published',
  ...over,
});

function draw(ui) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

beforeEach(() => {
  authValue.current = { ...BASE_AUTH };
  snapshots.rows = [];
  for (const k of ['shifts', 'availability', 'openShifts', 'announcements',
                   'users', 'leads', 'schedulerStudents']) {
    snapshots[k] = [];
  }
});
afterEach(() => { cleanup(); });

describe('every door renders with no data at all', () => {
  // The state a brand-new centre is in, and the state every door passes
  // through on first paint. A crash here is a crash for everybody.
  it('instructor', () => {
    expect(() => draw(<InstructorHome />)).not.toThrow();
  });
  it('host', () => {
    expect(() => draw(<HostHome />)).not.toThrow();
  });
  it('director', () => {
    expect(() => draw(<DirectorHome />)).not.toThrow();
  });
  it('owner', () => {
    expect(() => draw(<OwnerHome />)).not.toThrow();
  });
});

describe('every door renders with real-shaped data', () => {
  it('instructor shows the shift', () => {
    snapshots.shifts = [shift()];
    draw(<InstructorHome />);
    expect(screen.getAllByText(/9:00 AM/).length).toBeGreaterThan(0);
  });

  it('host shows the floor', () => {
    snapshots.shifts = [shift({ date: todayStr(), startTime: '00:00', endTime: '23:59' })];
    draw(<HostHome />);
    expect(screen.getByText(/Kaitlyn MacDonald/)).toBeTruthy();
  });

  it('director lists what needs doing', () => {
    snapshots.shifts = [shift({ signOutConfirmedBy: 'instructor', payrollResolved: false })];
    draw(<DirectorHome />);
    expect(screen.getByText(/Needs you/)).toBeTruthy();
  });

  it('owner shows the centre', () => {
    snapshots.shifts = [shift()];
    draw(<OwnerHome />);
    expect(screen.getByText(/Mathnasium/)).toBeTruthy();
  });
});

describe('the availability clash — the path that actually crashed', () => {
  // Live availability documents are one row per person per day, and a
  // person can have SEVERAL. `availabilityWindows` iterates them, so
  // handing it a single document threw "(dayAvail || []) is not iterable"
  // and took the whole director door down.
  const avail = (over = {}) => ({
    id: 'a1', centerId: 'langley', userId: 'u1', userName: 'Kaitlyn MacDonald',
    date: '2026-09-12', startTime: '16:00', endTime: '19:00', comment: '',
    ...over,
  });

  it('renders a clash without throwing, and names it', () => {
    // Scheduled 09:00–14:00, available only 16:00–19:00.
    snapshots.shifts = [shift()];
    snapshots.availability = [avail()];
    expect(() => draw(<DirectorHome />)).not.toThrow();
    expect(screen.getByText(/outside submitted availability/i)).toBeTruthy();
  });

  it('merges split rows instead of inventing a clash at the seam', () => {
    // 09:00–12:00 and 12:00–14:00 cover a 09:00–14:00 shift completely.
    snapshots.shifts = [shift()];
    snapshots.availability = [
      avail({ id: 'a1', startTime: '09:00', endTime: '12:00' }),
      avail({ id: 'a2', startTime: '12:00', endTime: '14:00' }),
    ];
    draw(<DirectorHome />);
    expect(screen.queryByText(/outside submitted availability/i)).toBeNull();
  });

  it('never flags someone who submitted nothing', () => {
    snapshots.shifts = [shift()];        // shifts only, no availability rows
    draw(<DirectorHome />);
    expect(screen.queryByText(/outside submitted availability/i)).toBeNull();
  });
});

describe('the shapes that break things', () => {
  it('survives a centre with no config at all', () => {
    authValue.current = { ...BASE_AUTH, centerConfig: null };
    for (const Door of [InstructorHome, HostHome, DirectorHome, OwnerHome]) {
      expect(() => { draw(<Door />); cleanup(); }).not.toThrow();
    }
  });

  it('survives a profile that has not loaded yet', () => {
    authValue.current = { ...BASE_AUTH, profile: null, activeCenterId: null };
    for (const Door of [InstructorHome, HostHome, DirectorHome, OwnerHome]) {
      expect(() => { draw(<Door />); cleanup(); }).not.toThrow();
    }
  });

  it('survives shifts with missing times', () => {
    snapshots.shifts = [shift({ startTime: null, endTime: undefined })];
    for (const Door of [InstructorHome, HostHome, DirectorHome, OwnerHome]) {
      expect(() => { draw(<Door />); cleanup(); }).not.toThrow();
    }
  });

  it('survives no sub-roles', () => {
    authValue.current = { ...BASE_AUTH, mySubRoles: undefined };
    snapshots.shifts = [shift()];
    expect(() => draw(<InstructorHome />)).not.toThrow();
  });
});

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
