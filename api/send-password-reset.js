// POST /api/send-password-reset
//
// TWO UNAUTHENTICATED FLOWS LIVE HERE.
//   Vercel Hobby caps this project at 12 serverless functions and api/ is
//   exactly at 12 (see CLAUDE.md), so a new endpoint isn't available. This
//   file is the right host for the second one because its security posture
//   already matches: it is public BY DESIGN and holds no privileged
//   capability that a bug in the new branch could reach. Multiplexing onto
//   an authenticated endpoint instead would have meant a public code path
//   sitting next to privileged ones, which is how auth bugs happen.
//
//   1. (no `action`)          send a password reset email
//   2. ?action=confirm-signout redeem a one-time sign-out confirm token
//
// Sends a password reset email via Resend (the same pipe used by all
// transactional mail) rather than Firebase's default sender. Firebase's
// default emails come from noreply@<project>.firebaseapp.com and tend
// to land in spam or get filtered by Gmail; routing through Resend
// means they arrive from your verified domain and hit the inbox.
//
// Two flows use this endpoint:
//   1. The "Forgot password" link on the public Login page (no auth)
//   2. The admin "Send reset link" button in Manage Users / Manage
//      Roles (no auth required either — the admin already has access
//      to the user's email and the same effect could be triggered by
//      passing it to the forgot-password form)
//
// Security:
//   - Never reveals whether an email exists on the platform (always
//     returns 200, even if the user isn't found). Avoids the endpoint
//     becoming an email-enumeration oracle.
//   - generatePasswordResetLink throws for unknown emails — we catch
//     that case and silently succeed.
//
// Body: { email: string, continueUrl?: string }
// Response: 200 { sent: true }  (regardless of whether the user existed)
//
// Required env vars (already set in Vercel for /api/send-email):
//   RESEND_API_KEY
//   RESEND_FROM
//   FIREBASE_SERVICE_ACCOUNT

import { Resend } from 'resend';
import { getAuth, getFirestore } from './_lib/firebase-admin.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let _resend = null;
function resendClient() {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY env var is not set in Vercel');
  _resend = new Resend(key);
  return _resend;
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function buildEmail({ to, resetLink }) {
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const subject = 'Reset your Ratio password';

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#1f2937;line-height:1.6;max-width:480px;">
<p style="margin:0 0 14px 0;font-size:16px;font-weight:500;">Reset your password</p>
<p style="margin:0 0 14px 0;">
Someone (hopefully you) asked to reset the password for the Ratio account associated with <strong>${esc(to)}</strong>.
</p>
<p style="margin:0 0 14px 0;">
Click the button below to set a new password. The link expires after one hour.
</p>
<p style="margin:20px 0;">
  <a href="${esc(resetLink)}" style="background:#dc2626;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;display:inline-block;font-weight:600;">Reset your password</a>
</p>
<p style="margin:0 0 14px 0;font-size:13px;color:#6b7280;">
If the button doesn't work, copy and paste this link into your browser:<br>
<a href="${esc(resetLink)}" style="color:#dc2626;word-break:break-all;">${esc(resetLink)}</a>
</p>
<p style="margin:0 0 14px 0;font-size:13px;color:#6b7280;">
Didn't ask for this? You can safely ignore this email — your password won't change unless you click the link.
</p>
<p style="margin:24px 0 0 0;color:#6b7280;font-size:12px;">— Ratio</p>
</div>`;

  const text =
    `Reset your password\n\n` +
    `Someone (hopefully you) asked to reset the password for the Ratio account associated with ${to}.\n\n` +
    `Click the link below to set a new password. The link expires after one hour.\n\n` +
    `${resetLink}\n\n` +
    `Didn't ask for this? You can safely ignore this email — your password won't change unless you click the link.\n\n` +
    `— Ratio`;

  return { subject, html, text };
}

/**
 * Redeem a sign-out confirmation token.
 *
 * The token IS the authorisation — the instructor is not logged in and, on
 * a phone, very likely can't be without friction. That is only safe because
 * of how narrow the grant is: 256 bits of entropy, single use, expiring,
 * and it authorises exactly one write — setting the sign-out time on the
 * one shift the token names, to the time the ADMIN proposed when the
 * request was created. The caller supplies no time of their own, so a
 * leaked link cannot be used to claim arbitrary hours.
 *
 * Every check is re-run here rather than trusted from the client, and the
 * token is marked used in the same transaction as the shift write, so a
 * double-tap on a slow phone connection can't apply twice.
 */
async function confirmSignOut(req, res, body) {
  const token = String(body?.token || '').trim();
  // Shape-check before touching Firestore: the doc id is 64 hex chars, so
  // anything else is a malformed or probing request, not a lookup.
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return res.status(400).json({ error: 'That link is not valid.' });
  }

  const db = getFirestore();
  const reqRef = db.collection('signOutRequests').doc(token);

  try {
    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(reqRef);
      if (!snap.exists) return { code: 404, error: 'That link is not valid.' };

      const r = snap.data() || {};
      if (r.usedAt || r.status === 'confirmed') {
        // Already done. Report it as success-shaped so a second tap reads
        // as "you're all set", not as an error the person must act on.
        return {
          code: 200, alreadyDone: true,
          date: r.date, signOutTime: r.proposedSignOut, clockIn: r.clockIn,
        };
      }
      if (r.status && r.status !== 'pending') {
        return { code: 410, error: 'That request is no longer active.' };
      }
      if (!r.expiresAt || new Date(r.expiresAt).getTime() <= Date.now()) {
        return { code: 410, error: 'That link has expired. Ask the centre to send a new one.' };
      }
      if (!r.shiftId || !r.proposedSignOut) {
        return { code: 409, error: 'That request is incomplete. Ask the centre to send a new one.' };
      }

      const shiftRef = db.collection('shifts').doc(r.shiftId);
      const shiftSnap = await tx.get(shiftRef);
      if (!shiftSnap.exists) {
        return { code: 409, error: 'That shift no longer exists.' };
      }

      const now = new Date().toISOString();
      // The instructor supplied this, so it is labelled as such and the row
      // stays flagged for review in payroll. It is deliberately NOT marked
      // payrollResolved — confirming is an answer, not a sign-off.
      tx.update(shiftRef, {
        signOutConfirmedTime: r.proposedSignOut,
        signOutConfirmedBy: 'instructor',
        signOutConfirmedAt: now,
      });
      tx.update(reqRef, { status: 'confirmed', usedAt: now });

      return {
        code: 200, alreadyDone: false,
        date: r.date, signOutTime: r.proposedSignOut, clockIn: r.clockIn,
      };
    });

    const { code, error, ...rest } = outcome;
    if (error) return res.status(code).json({ error });
    return res.status(200).json({ ok: true, ...rest });
  } catch (err) {
    console.error('[confirm-signout] transaction failed:', err?.message || err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // Second flow — see the header. Branches before any password-reset work.
  if (String(req.query?.action || body?.action || '') === 'confirm-signout') {
    return confirmSignOut(req, res, body);
  }

  const email = String(body?.email || '').trim().toLowerCase();
  const continueUrl = String(body?.continueUrl || '').trim() || undefined;

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Valid email is required' });
  }

  const fromAddress = process.env.RESEND_FROM;
  if (!fromAddress) {
    return res.status(500).json({ error: 'RESEND_FROM env var is not set' });
  }

  let resetLink = null;
  try {
    resetLink = await getAuth().generatePasswordResetLink(
      email,
      continueUrl ? { url: continueUrl, handleCodeInApp: false } : undefined,
    );
  } catch (err) {
    // Most common case: auth/user-not-found. Don't leak existence —
    // return success regardless. We still log internally for debugging.
    const code = err?.code || '';
    if (code === 'auth/user-not-found') {
      return res.status(200).json({ sent: true });
    }
    console.error('[send-password-reset] generatePasswordResetLink failed:', err);
    return res.status(500).json({ error: 'Could not generate reset link' });
  }

  try {
    const { subject, html, text } = buildEmail({ to: email, resetLink });
    const { error } = await resendClient().emails.send({
      from: fromAddress,
      to: [email],
      subject,
      html,
      text,
    });
    if (error) {
      console.error('[send-password-reset] Resend send error:', error);
      return res.status(502).json({ error: error.message || 'Email send failed' });
    }
    return res.status(200).json({ sent: true });
  } catch (err) {
    console.error('[send-password-reset]', err);
    return res.status(500).json({ error: err.message || 'Send failed' });
  }
}
