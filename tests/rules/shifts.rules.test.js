/**
 * Firestore security-rules tests — schedule writes.
 *
 * These run against the real rules file in the Firestore emulator, so they
 * test what actually ships rather than a restatement of it. Boot with:
 *
 *   npm run test:rules
 *
 * The rules being covered here replaced `allow create/update: if isSignedIn()`
 * on `shifts` and `openShifts`. Shifts are what payroll bills from, so the
 * cases that matter most are the negative ones: an instructor must not be
 * able to move a clock, take someone else's row, or hand themselves work
 * they aren't allowed to pick up.
 */
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, getDoc } from 'firebase/firestore';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';

const CENTRE = 'langley';
const OTHER  = 'burnaby';

let testEnv;

/** Firestore handle acting as a signed-in uid. */
const as = (uid) => testEnv.authenticatedContext(uid).firestore();

/** A shift row. Overrides let each test vary one field at a time. */
const shift = (over = {}) => ({
  centerId:  CENTRE,
  userId:    'inst1',
  userName:  'Inst One',
  date:      '2026-09-01',
  startTime: '15:00',
  endTime:   '19:00',
  role:      'Instructor',
  subRole:   'Elementary',
  status:    'live',
  ...over,
});

const openShift = (over = {}) => ({
  centerId:  CENTRE,
  date:      '2026-09-01',
  startTime: '15:00',
  endTime:   '19:00',
  subRole:   'Elementary',
  status:    'open',
  ...over,
});

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'ratio-rules-test',
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => { await testEnv.cleanup(); });

beforeEach(async () => {
  await testEnv.clearFirestore();
  // Every rule here starts with profileExists(), so each actor needs a
  // real user doc. Managers/Hosts are seeded via centerMemberships rather
  // than the legacy top-level field, because that's the path a modern
  // account actually takes — and the one most likely to be got wrong.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const u = (id, data) => setDoc(doc(db, 'users', id), {
      approved: true, centerIds: [CENTRE], ...data,
    });
    await Promise.all([
      u('owner1',   { role: 'owner' }),
      u('admin1',   { role: 'admin' }),
      u('mgr1',     { role: 'instructor', centerMemberships: { [CENTRE]: { instructorType: 'Manager' } } }),
      u('host1',    { role: 'instructor', centerMemberships: { [CENTRE]: { instructorType: 'Host' } } }),
      // A Manager at a DIFFERENT centre — must not be able to reach in here.
      u('mgrOther', { role: 'instructor', centerIds: [OTHER], centerMemberships: { [OTHER]: { instructorType: 'Manager' } } }),
      u('inst1',    { role: 'instructor', instructorType: 'Instructor' }),
      u('inst2',    { role: 'instructor', instructorType: 'Instructor' }),
      u('trainee1', { role: 'instructor', centerMemberships: { [CENTRE]: { instructorType: 'Training' } } }),
      u('vol1',     { role: 'instructor', centerMemberships: { [CENTRE]: { isVolunteer: true } } }),
    ]);
  });
});

/** Seed a document past the rules, so tests start from a known state. */
const seed = (path, id, data) => testEnv.withSecurityRulesDisabled(
  (ctx) => setDoc(doc(ctx.firestore(), path, id), data),
);

describe('shifts — create', () => {
  it('lets ops staff schedule anybody', async () => {
    for (const uid of ['owner1', 'admin1', 'mgr1', 'host1']) {
      await assertSucceeds(setDoc(doc(as(uid), 'shifts', `s-${uid}`), shift()));
    }
  });

  it('lets an instructor create a row assigned to themselves (claim flow)', async () => {
    await assertSucceeds(setDoc(doc(as('inst1'), 'shifts', 's1'), shift({ userId: 'inst1' })));
  });

  it('stops an instructor creating a row for someone else', async () => {
    await assertFails(setDoc(doc(as('inst1'), 'shifts', 's1'), shift({ userId: 'inst2' })));
  });

  it('stops trainees and volunteers picking up work', async () => {
    await assertFails(setDoc(doc(as('trainee1'), 'shifts', 's1'), shift({ userId: 'trainee1' })));
    await assertFails(setDoc(doc(as('vol1'), 'shifts', 's2'), shift({ userId: 'vol1' })));
  });

  it("stops a manager from another centre scheduling here", async () => {
    await assertFails(setDoc(doc(as('mgrOther'), 'shifts', 's1'), shift()));
  });
});

describe('shifts — update', () => {
  beforeEach(() => seed('shifts', 's1', shift()));

  it('lets an instructor take a shift over, times untouched (swap accept)', async () => {
    await assertSucceeds(updateDoc(doc(as('inst2'), 'shifts', 's1'), {
      userId: 'inst2', userName: 'Inst Two',
    }));
  });

  // The reason this rule exists.
  it('stops an instructor moving the clock on their OWN shift', async () => {
    await assertFails(updateDoc(doc(as('inst1'), 'shifts', 's1'), { endTime: '23:00' }));
    await assertFails(updateDoc(doc(as('inst1'), 'shifts', 's1'), { startTime: '09:00' }));
    await assertFails(updateDoc(doc(as('inst1'), 'shifts', 's1'), { date: '2026-09-02' }));
  });

  it('stops an instructor taking a shift over AND moving the clock', async () => {
    await assertFails(updateDoc(doc(as('inst2'), 'shifts', 's1'), {
      userId: 'inst2', endTime: '23:00',
    }));
  });

  it('stops an instructor editing a shift they end up owning no part of', async () => {
    await assertFails(updateDoc(doc(as('inst2'), 'shifts', 's1'), { userName: 'Tampered' }));
  });

  it('lets ops staff change hours', async () => {
    await assertSucceeds(updateDoc(doc(as('owner1'), 'shifts', 's1'), { endTime: '20:00' }));
    await assertSucceeds(updateDoc(doc(as('mgr1'), 'shifts', 's1'), { endTime: '21:00' }));
  });

  it('stops trainees taking a shift over', async () => {
    await assertFails(updateDoc(doc(as('trainee1'), 'shifts', 's1'), {
      userId: 'trainee1', userName: 'Trainee',
    }));
  });
});

describe('shifts — delete', () => {
  beforeEach(() => seed('shifts', 's1', shift()));

  it('is ops-only', async () => {
    await assertFails(deleteDoc(doc(as('inst1'), 'shifts', 's1')));
    await assertFails(deleteDoc(doc(as('mgrOther'), 'shifts', 's1')));
    await assertSucceeds(deleteDoc(doc(as('mgr1'), 'shifts', 's1')));
  });
});

describe('openShifts', () => {
  beforeEach(() => seed('openShifts', 'o1', openShift()));

  it('lets an eligible instructor claim one', async () => {
    await assertSucceeds(updateDoc(doc(as('inst1'), 'openShifts', 'o1'), {
      status: 'claimed', claimedBy: 'inst1', claimedByName: 'Inst One',
    }));
  });

  it('stops an instructor rewriting the hours instead of claiming', async () => {
    await assertFails(updateDoc(doc(as('inst1'), 'openShifts', 'o1'), { endTime: '23:00' }));
  });

  it('stops an instructor claiming it on somebody else\'s behalf', async () => {
    await assertFails(updateDoc(doc(as('inst1'), 'openShifts', 'o1'), {
      status: 'claimed', claimedBy: 'inst2', claimedByName: 'Inst Two',
    }));
  });

  it('stops a claim that also moves the clock', async () => {
    await assertFails(updateDoc(doc(as('inst1'), 'openShifts', 'o1'), {
      status: 'claimed', claimedBy: 'inst1', endTime: '23:00',
    }));
  });

  it('stops trainees and volunteers claiming', async () => {
    await assertFails(updateDoc(doc(as('trainee1'), 'openShifts', 'o1'), {
      status: 'claimed', claimedBy: 'trainee1',
    }));
    await assertFails(updateDoc(doc(as('vol1'), 'openShifts', 'o1'), {
      status: 'claimed', claimedBy: 'vol1',
    }));
  });

  it('only lets ops staff post and remove open shifts', async () => {
    await assertFails(setDoc(doc(as('inst1'), 'openShifts', 'o2'), openShift()));
    await assertSucceeds(setDoc(doc(as('mgr1'), 'openShifts', 'o2'), openShift()));
    await assertFails(deleteDoc(doc(as('inst1'), 'openShifts', 'o1')));
    await assertSucceeds(deleteDoc(doc(as('host1'), 'openShifts', 'o1')));
  });
});

describe('schedulerInstructorAssignments — which side am I on', () => {
  const PATH = `centers/${CENTRE}/schedulerInstructorAssignments`;
  const DAY = { 'EM|15:00': ['Inst One'], 'HS|17:00': ['Inst One'] };

  it('lets any instructor at this centre read their own rota', async () => {
    // The widened rule. Before it, the answer to "which side am I on
    // today?" existed only on the director's screen and a printed sheet.
    await seed(PATH, '2026-09-01', DAY);
    for (const uid of ['inst1', 'inst2', 'trainee1', 'vol1']) {
      await assertSucceeds(getDoc(doc(as(uid), PATH, '2026-09-01')));
    }
  });

  it('still lets floor staff and leadership read it', async () => {
    await seed(PATH, '2026-09-01', DAY);
    for (const uid of ['owner1', 'admin1', 'mgr1', 'host1']) {
      await assertSucceeds(getDoc(doc(as(uid), PATH, '2026-09-01')));
    }
  });

  it('does NOT let staff from another centre read it', async () => {
    // The read widened to members of THIS centre, not to everybody signed in.
    await seed(PATH, '2026-09-01', DAY);
    await assertFails(getDoc(doc(as('mgrOther'), PATH, '2026-09-01')));
  });

  it('does not let an instructor write it — reading is not editing', async () => {
    // Neeru assigns sides. An instructor moving themselves to the other
    // side of the room would be exactly the wrong outcome of this change.
    for (const uid of ['inst1', 'trainee1', 'vol1']) {
      await assertFails(setDoc(doc(as(uid), PATH, '2026-09-02'), DAY));
    }
  });

  it('still lets the people who staff the floor write it', async () => {
    for (const uid of ['owner1', 'admin1', 'mgr1', 'host1']) {
      await assertSucceeds(setDoc(doc(as(uid), PATH, '2026-09-02'), DAY));
    }
  });
});

describe('schedulerTemplates — saved staffing shapes', () => {
  const tpl = { name: 'Term time', config: { minPerDay: 8, maxPerDay: 11, perDay: {} }, centerId: CENTRE };
  const path = `centers/${CENTRE}/schedulerTemplates`;

  it('lets schedule-builders save a shape', async () => {
    for (const uid of ['owner1', 'admin1', 'mgr1', 'host1']) {
      await assertSucceeds(setDoc(doc(as(uid), path, `t-${uid}`), tpl));
    }
  });

  it('stops instructors and trainees writing one', async () => {
    await assertFails(setDoc(doc(as('inst1'), path, 't1'), tpl));
    await assertFails(setDoc(doc(as('trainee1'), path, 't2'), tpl));
  });

  it('stops a manager from another centre writing here', async () => {
    await assertFails(setDoc(doc(as('mgrOther'), path, 't1'), tpl));
  });

  // Read is deliberately the same tier as write. The picker only renders
  // inside the Auto-Scheduler panel, which instructors can't open, so
  // granting them read would be access nothing in the app uses.
  it('lets schedule-builders read the picker, and nobody else', async () => {
    await seed(path, 't1', tpl);
    await assertSucceeds(getDoc(doc(as('mgr1'), path, 't1')));
    await assertSucceeds(getDoc(doc(as('owner1'), path, 't1')));
    await assertFails(getDoc(doc(as('inst1'), path, 't1')));
    await assertFails(getDoc(doc(as('mgrOther'), path, 't1')));
  });
});
