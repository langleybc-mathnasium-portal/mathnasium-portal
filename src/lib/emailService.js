/**
 * emailService.js
 * Handles all notification emails for the Ratio platform (Mathnasium
 * Langley, Chilliwack, and any future centres). Sign-off in every
 * template is "— Ratio" so the branding stays consistent across
 * centres; centre-specific context appears in the subject line and
 * body, not the footer.
 *
 * Architecture: this file builds the subject + plain-text body for each
 * notification, batches the recipients into a single payload, and POSTs to
 * /api/send-email — a Vercel serverless function that fans the batch out
 * through Resend (see api/send-email.js + RESEND_SETUP.md).
 *
 * The serverless function requires a Firebase ID token, so we attach the
 * current user's token before sending.
 *
 * The four public APIs (notifyOpenShift, notifySchedulePosted,
 * notifyShiftClaimed, notifyTimeOffDecision) keep the same signatures
 * they had under EmailJS, so callers (Admin / Schedule / ShiftBoard) need
 * no changes.
 */

import { auth } from '../firebase';

import { SIGNOUT_TTL_DAYS } from './signOut';

const SEND_ENDPOINT = '/api/send-email';

// ─── Send primitive ────────────────────────────────────────────────────────

/**
 * POST a batch of emails to /api/send-email. Fire-and-forget by default —
 * failures are logged but don't throw, so a Resend outage won't disrupt
 * the user-facing UX flow that triggered the email.
 *
 * @param {Array} emails - array of { to, to_name, subject, body, cta_text?, cta_link? }
 */
async function sendBatch(emails) {
  if (!Array.isArray(emails) || emails.length === 0) return false;

  let idToken = null;
  try {
    idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  } catch (err) {
    console.error('[emailService] Failed to read ID token:', err);
    return false;
  }
  if (!idToken) {
    console.warn('[emailService] No signed-in user; skipping email batch.');
    return false;
  }

  try {
    const r = await fetch(SEND_ENDPOINT, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${idToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ emails }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      console.error('[emailService] Send failed:', r.status, data);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[emailService] Network error sending batch:', err);
    return false;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function fmtTime(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return m === 0 ? `${h}:00 ${ampm}` : `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

function firstName(displayName, fallback = 'Team') {
  return displayName?.split(' ')[0] || fallback;
}

function portalUrl() {
  // window is fine — every caller of these functions is browser-side.
  return typeof window !== 'undefined' ? window.location.origin : '';
}

// ─── Notify: new open shift posted ─────────────────────────────────────────

/**
 * @param {object} shift        - the openShift Firestore document
 * @param {Array}  staffEmails  - array of { email, displayName } for all approved staff
 */
export async function notifyOpenShift(shift, staffEmails) {
  if (!Array.isArray(staffEmails) || staffEmails.length === 0) return;

  const dateFormatted = fmtDate(shift.date);
  const shiftTime = `${fmtTime(shift.startTime)} – ${fmtTime(shift.endTime)}`;
  const shiftRole = shift.subRole || shift.role || 'Any role';

  const subject = `New open shift posted: ${dateFormatted}`;
  const body =
    `A new open shift has been posted:\n\n` +
    `Date: ${dateFormatted}\n` +
    `Time: ${shiftTime}\n` +
    `Role: ${shiftRole}\n\n` +
    `First come, first served — claim it on the portal.`;
  const cta_link = portalUrl();

  const emails = staffEmails
    .filter(s => s?.email)
    .map(({ email, displayName }) => ({
      to:       email,
      to_name:  firstName(displayName, 'Instructor'),
      subject,
      body,
      cta_text: 'Claim the shift',
      cta_link,
    }));

  await sendBatch(emails);
}

// ─── Notify: schedule posted ───────────────────────────────────────────────

/**
 * Per-user personalised schedule-posted notification.
 *
 * Each instructor receives an email listing ONLY their own shifts and
 * count — never "144 shifts posted." If a staff member is assigned zero
 * shifts in the published batch, they're skipped entirely (no email).
 *
 * @param {object} params
 * @param {Array}  params.shifts      - the just-published shift docs
 *                                       ({ id, userId, userName, date,
 *                                       startTime, endTime, role, subRole })
 * @param {Array}  params.staffUsers  - array of { uid, email, displayName }
 *                                       — email may be undefined when the
 *                                       caller hasn't fetched private contact
 *                                       (function silently skips those users)
 * @param {string} params.monthLabel  - e.g. 'June'
 * @param {number|string} params.year - e.g. 2026
 */
export async function notifySchedulePosted({ shifts, staffUsers, monthLabel, year }) {
  if (!Array.isArray(staffUsers) || staffUsers.length === 0) return;
  if (!Array.isArray(shifts) || shifts.length === 0) return;

  const monthYear = `${monthLabel} ${year}`;
  const cta_link = portalUrl();

  // Group shifts by user identity. Match on uid (preferred — stable) AND
  // userName (legacy fallback for shifts created before the auto-scheduler
  // started stamping uid).
  const shiftsByUid  = new Map();
  const shiftsByName = new Map();
  for (const s of shifts) {
    if (s.userId) {
      if (!shiftsByUid.has(s.userId)) shiftsByUid.set(s.userId, []);
      shiftsByUid.get(s.userId).push(s);
    }
    if (s.userName) {
      if (!shiftsByName.has(s.userName)) shiftsByName.set(s.userName, []);
      shiftsByName.get(s.userName).push(s);
    }
  }

  const emails = [];
  for (const user of staffUsers) {
    if (!user?.email) continue;
    const mine = (shiftsByUid.get(user.uid) || shiftsByName.get(user.displayName) || []);
    // De-dupe — if both matchers hit the same shift (uid + name both set),
    // we'd otherwise double-count.
    const uniq = Array.from(new Map(mine.map(s => [s.id, s])).values());
    if (uniq.length === 0) continue;

    uniq.sort((a, b) =>
      (a.date || '').localeCompare(b.date || '') ||
      (a.startTime || '').localeCompare(b.startTime || ''),
    );

    const shiftLines = uniq.map(s => {
      const date = fmtDate(s.date);
      const time = `${fmtTime(s.startTime)} – ${fmtTime(s.endTime)}`;
      const tag  = s.subRole ? ` · ${s.subRole}` : (s.role ? ` · ${s.role}` : '');
      return `• ${date} · ${time}${tag}`;
    }).join('\n');

    const n = uniq.length;
    // Phrasing note — this email goes out on EVERY publish batch (a week,
    // a day, a single shift, or a whole month), so we deliberately frame
    // the content as "newly added" instead of a totals view. Staff were
    // reading "You have 1 shift" as "1 shift for the whole month" and
    // panicking; "1 new shift was just added" makes it clear this is an
    // update, not their full allocation.
    const noun = n === 1 ? 'shift' : 'shifts';
    emails.push({
      to:       user.email,
      to_name:  firstName(user.displayName, 'Instructor'),
      subject:  `${n} new ${noun} added to your ${monthYear} schedule`,
      body:
        `${n} new ${noun} ${n === 1 ? 'has' : 'have'} been added to your ${monthYear} schedule:\n\n` +
        shiftLines + '\n\n' +
        `Heads up — this email only covers what was just published in this batch. ` +
        `Tap the button below to see your full ${monthLabel} schedule, including any shifts already on it.`,
      cta_text: 'View my full schedule',
      cta_link,
    });
  }

  await sendBatch(emails);
}

// ─── Notify: shift claimed (confirms claimer + CCs admins) ─────────────────

/**
 * @param {object} shift           - the openShift doc
 * @param {object} claimer         - { email, displayName }
 * @param {Array}  adminRecipients - array of { email, displayName } for admins to CC
 */
export async function notifyShiftClaimed(shift, claimer, adminRecipients = []) {
  if (!claimer?.email) return;

  const dateFormatted = fmtDate(shift.date);
  const shiftTime = `${fmtTime(shift.startTime)} – ${fmtTime(shift.endTime)}`;
  const shiftRole = shift.subRole || shift.role || '';
  const cta_link  = portalUrl();

  const emails = [];

  // 1) Confirmation to the person who claimed it
  emails.push({
    to:       claimer.email,
    to_name:  firstName(claimer.displayName, 'Instructor'),
    subject:  `Shift confirmed: ${dateFormatted}`,
    body:
      `You've successfully claimed the open shift:\n\n` +
      `Date: ${dateFormatted}\n` +
      `Time: ${shiftTime}\n` +
      (shiftRole ? `Role: ${shiftRole}\n\n` : `\n`) +
      `It's now on your schedule.`,
    cta_text: 'View your schedule',
    cta_link,
  });

  // 2) Notify each admin (skip the claimer if they're also an admin)
  adminRecipients
    .filter(a => a?.email && a.email !== claimer.email)
    .forEach(admin => {
      emails.push({
        to:       admin.email,
        to_name:  firstName(admin.displayName, 'Admin'),
        subject:  `${claimer.displayName || 'A staff member'} claimed the ${dateFormatted} shift`,
        body:
          `${claimer.displayName || 'A staff member'} just claimed an open shift:\n\n` +
          `Date: ${dateFormatted}\n` +
          `Time: ${shiftTime}\n` +
          (shiftRole ? `Role: ${shiftRole}\n` : ''),
        cta_text: 'View the schedule',
        cta_link,
      });
    });

  await sendBatch(emails);
}

// ─── Notify: new announcement posted ──────────────────────────────────────

/**
 * Fan out a new-announcement email to every approved staff member at
 * the centre. Fire-and-forget — failures don't block the Firestore
 * write that triggered the post.
 *
 * @param {object} params
 * @param {object} params.post         - announcement doc fields ({ title, text, category, author, pinned })
 * @param {Array}  params.staffEmails  - array of { email, displayName } for every staff recipient
 * @param {string} params.centerName   - human centre label (e.g. "Mathnasium Langley")
 */
export async function notifyAnnouncement({ post, staffEmails, centerName }) {
  if (!Array.isArray(staffEmails) || staffEmails.length === 0) return;
  if (!post?.title) return;

  const tag = post.category ? ` [${String(post.category).toUpperCase()}]` : '';
  const subject = `${post.pinned ? '📌 ' : ''}${centerName || 'Ratio'} announcement${tag}: ${post.title}`;
  const body =
    `${post.title}\n\n` +
    `${post.text || ''}\n\n` +
    `— Posted by ${post.author || 'an admin'}`;

  const cta_link = portalUrl() + '/announcements';

  const emails = staffEmails
    .filter(s => s?.email)
    .map(({ email, displayName }) => ({
      to:       email,
      to_name:  firstName(displayName, 'Team'),
      subject,
      body,
      cta_text: 'Open Ratio',
      cta_link,
    }));

  await sendBatch(emails);
}

// ─── Notify: time-off decision ─────────────────────────────────────────────

/**
 * @param {object} request   - the timeOffRequests doc (startDate, endDate, reason, ...)
 * @param {object} recipient - { email, displayName }
 * @param {'approved'|'denied'} decision
 */
export async function notifyTimeOffDecision(request, recipient, decision) {
  if (!recipient?.email) return;

  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  const startLabel = request.startDate
    ? new Date(request.startDate + 'T00:00:00').toLocaleDateString('en-US', opts)
    : '';
  const endLabel = request.endDate
    ? new Date(request.endDate + 'T00:00:00').toLocaleDateString('en-US', opts)
    : '';
  const sameDay = request.startDate === request.endDate;
  const dateRange = sameDay ? startLabel : `${startLabel} – ${endLabel}`;

  const approved = decision === 'approved';
  const subject = approved ? `Time-off request approved` : `Time-off request update`;
  const body = approved
    ? `Your time-off request for ${dateRange} has been approved.\n\n` +
      (request.reason ? `Reason you submitted: ${request.reason}\n\n` : '') +
      `Enjoy the time off.`
    : `Your time-off request for ${dateRange} was not approved this time.\n\n` +
      (request.reason ? `Reason you submitted: ${request.reason}\n\n` : '') +
      `If you have questions, please follow up with management.`;

  await sendBatch([{
    to:       recipient.email,
    to_name:  firstName(recipient.displayName),
    subject,
    body,
    cta_text: 'View your schedule',
    cta_link: portalUrl(),
  }]);
}

// ─── Notify: signed in, never signed out ───────────────────────────────────

/**
 * Ask one instructor to confirm the sign-out Radius never recorded.
 *
 * The tone matters here. This email is sent to someone who DID come to
 * work — the missing tap-out is a two-second lapse, not a misdeed — and it
 * arrives days later, once payroll is being reconciled. So it opens by
 * saying we know they were in, states the time we intend to use, and makes
 * confirming it one tap. Nobody is asked to log in, remember a password,
 * or find a page.
 *
 * The link carries a single-use token that expires. It authorises exactly
 * one thing: setting the sign-out time on that one shift.
 *
 * @param {object} p
 * @param {object} p.recipient  - { email, displayName }
 * @param {string} p.date       - shift date, YYYY-MM-DD
 * @param {string} p.clockIn    - recorded sign-in, "HH:MM"
 * @param {string} p.scheduledEnd - proposed sign-out, "HH:MM"
 * @param {string} p.token      - the confirm token
 * @param {string} [p.centreName]
 * @returns {Promise<boolean>} whether the batch was accepted
 */
export async function notifyMissingSignOut({
  recipient, date, clockIn, scheduledEnd, token, centreName,
}) {
  if (!recipient?.email || !token) return false;

  const when = fmtDate(date);
  const inAt = fmtTime(clockIn);
  const outAt = fmtTime(scheduledEnd);
  const where = centreName ? ` at ${centreName}` : '';

  const body =
    `Radius shows you signed in on ${when}${where} at ${inAt}, but no sign-out was recorded for that shift.\n` +
    `\n` +
    `Your scheduled finish was ${outAt}. If that's when you left, confirm it below and payroll will use it — ` +
    `you don't need to log in.\n` +
    `\n` +
    `If you actually left at a different time, don't use the button — reply to this email or let the centre ` +
    `know, and we'll set the right time by hand.\n` +
    `\n` +
    `This link works once and expires in ${SIGNOUT_TTL_DAYS} days.`;

  return sendBatch([{
    to: recipient.email,
    to_name: firstName(recipient.displayName),
    subject: `Sign-in recorded, sign-out missing \u2014 ${when}`,
    body,
    cta_text: `Confirm ${outAt} sign-out`,
    cta_link: `${portalUrl()}/confirm-signout?t=${encodeURIComponent(token)}`,
  }]);
}
