/**
 * emailService.js
 * Handles all EmailJS notifications for the Mathnasium Langley portal.
 *
 * Setup required in emailjs.com dashboard:
 *   1. Create a service (Gmail recommended) → copy the Service ID
 *   2. Create TWO templates:
 *      a) Open shift template  → copy Template ID
 *      b) Schedule posted template → copy Template ID
 *   3. Copy your Public Key from Account → API Keys
 *
 * Replace the four REPLACE_ME values below with your real IDs.
 */

import emailjs from '@emailjs/browser';

// ─── Config ────────────────────────────────────────────────────────────────
const EMAILJS_PUBLIC_KEY   = 'JErgTz7binenNVyXC';
const EMAILJS_SERVICE_ID   = 'service_qxreryj';
const TEMPLATE_OPEN_SHIFT  = 'template_7fgpdjy';
const TEMPLATE_SCHEDULE    = 'template_7bshbzg';

// Initialize once
emailjs.init(EMAILJS_PUBLIC_KEY);

/**
 * Send a single email via EmailJS.
 * @param {string} templateId
 * @param {object} params   - template variables
 */
async function sendEmail(templateId, params) {
  try {
    await emailjs.send(EMAILJS_SERVICE_ID, templateId, params);
  } catch (err) {
    console.error('[EmailJS] Failed to send:', err);
  }
}

/**
 * Notify all staff that a new open shift has been posted.
 *
 * Required EmailJS template variables (use these exact names in your template):
 *   {{to_email}}       - recipient email
 *   {{to_name}}        - recipient first name
 *   {{shift_date}}     - e.g. "Monday, June 2"
 *   {{shift_time}}     - e.g. "3:00 PM – 7:00 PM"
 *   {{shift_role}}     - e.g. "Instructor" or blank
 *   {{portal_link}}    - link to the portal
 *
 * @param {object} shift        - the openShift Firestore document
 * @param {Array}  staffEmails  - array of { email, displayName } for all approved staff
 */
export async function notifyOpenShift(shift, staffEmails) {
  const dateFormatted = new Date(shift.date + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const fmt = (t) => {
    if (!t) return '';
    const [hStr, mStr] = t.split(':');
    let h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return m === 0 ? `${h}:00 ${ampm}` : `${h}:${String(m).padStart(2, '0')} ${ampm}`;
  };

  const shiftTime = `${fmt(shift.startTime)} – ${fmt(shift.endTime)}`;
  const portalLink = window.location.origin;

  // Send one email per staff member so names are personalised
  const sends = staffEmails.map(({ email, displayName }) =>
    sendEmail(TEMPLATE_OPEN_SHIFT, {
      to_email:   email,
      to_name:    displayName?.split(' ')[0] || 'Instructor',
      shift_date: dateFormatted,
      shift_time: shiftTime,
      shift_role: shift.role || 'Any role',
      portal_link: portalLink,
    })
  );

  await Promise.allSettled(sends);
}

/**
 * Notify all staff that the schedule has been posted.
 *
 * Required EmailJS template variables:
 *   {{to_email}}       - recipient email
 *   {{to_name}}        - recipient first name
 *   {{month_year}}     - e.g. "June 2026"
 *   {{shift_count}}    - total shifts in the schedule
 *   {{portal_link}}    - link to the portal
 *
 * @param {object} schedule     - the draftSchedule object from generateSchedule()
 * @param {Array}  staffEmails  - array of { email, displayName } for all approved staff
 */
export async function notifySchedulePosted(schedule, staffEmails) {
  const totalShifts = schedule.days.reduce((s, d) => s + d.assignedEmployees.length, 0);
  const portalLink  = window.location.origin;

  const sends = staffEmails.map(({ email, displayName }) =>
    sendEmail(TEMPLATE_SCHEDULE, {
      to_email:    email,
      to_name:     displayName?.split(' ')[0] || 'Instructor',
      month_year:  `${schedule.month} ${schedule.year}`,
      shift_count: String(totalShifts),
      portal_link: portalLink,
    })
  );

  await Promise.allSettled(sends);
}
