/**
 * payRate.js — a person's own hourly rate.
 *
 * WHERE IT LIVES AND WHO CAN READ IT
 *   `users/{uid}/private/pay`. That subtree is readable and writable by the
 *   person themselves plus owner / super-admin / admin (firestore.rules,
 *   `match /private/{document=**}`). It is NOT on the user document, which
 *   every signed-in user can read — putting a wage there would show all 33
 *   staff each other's pay.
 *
 *   Leadership CAN see what somebody entered. That is a deliberate choice,
 *   not an oversight, and the page says so in plain words next to the box.
 *   People should know who can see a number before they type it.
 *
 * WHAT IT IS FOR
 *   Multiplying hours by it to estimate gross pay. Ratio does not otherwise
 *   hold wages, does not send this anywhere, and never uses it in payroll
 *   exports — QuickBooks remains the source of truth.
 */

import { doc, onSnapshot, setDoc, deleteField, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';

const rateRef = (uid) => doc(db, 'users', uid, 'private', 'pay');

/** Subscribe to the signed-in user's own rate. Returns an unsubscribe. */
export function watchOwnRate(uid, cb) {
  if (!uid) { cb(null); return () => {}; }
  return onSnapshot(
    rateRef(uid),
    (snap) => cb(snap.exists() ? (snap.data()?.hourlyRate ?? null) : null),
    // A read failure means "we don't know it", which is the same state as
    // never having set one — the page asks for it rather than breaking.
    () => cb(null),
  );
}

/** Save a rate. Pass null to clear it. */
export async function saveOwnRate(uid, rate) {
  if (!uid) throw new Error('Not signed in.');
  if (rate == null) {
    await updateDoc(rateRef(uid), { hourlyRate: deleteField(), updatedAt: new Date().toISOString() });
    return null;
  }
  const value = Math.round(Number(rate) * 100) / 100;
  if (!Number.isFinite(value) || value <= 0) throw new Error('That rate is not a number.');
  await setDoc(rateRef(uid), {
    hourlyRate: value,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  return value;
}
