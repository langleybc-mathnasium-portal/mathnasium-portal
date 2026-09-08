import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Clock, Check, AlertTriangle, Loader2 } from 'lucide-react';
import RatioLogo from '../components/RatioLogo';

/**
 * ConfirmSignOut — the page an instructor lands on from the
 * "sign-in recorded, sign-out missing" email.
 *
 * PUBLIC BY DESIGN. The token in the URL is the whole authorisation, and
 * the reason is practical: this is opened on a phone, days after the shift,
 * by someone who is not logged in and will not go and find their password
 * to fix a two-second lapse. What the token can do is deliberately tiny —
 * set the sign-out time on one shift, to a time an admin already proposed,
 * once. See api/send-password-reset.js.
 *
 * The page asks for nothing and shows one button. Everything it needs to
 * say is on screen before the tap: the day, the sign-in Radius recorded,
 * and the exact time that will be submitted. Nobody should have to guess
 * what they're agreeing to.
 */
export default function ConfirmSignOut() {
  const [params] = useSearchParams();
  const token = params.get('t') || '';

  // A malformed link should say so on arrival, not after a pointless tap.
  // Derived in the initialisers rather than an effect — there's nothing to
  // synchronise with, it's just the starting state for this URL.
  const looksValid = /^[0-9a-f]{64}$/.test(token);
  const BAD_LINK = 'That link is not valid. Check you opened the most recent email, '
                 + 'or ask the centre to send a new one.';

  // 'idle' | 'sending' | 'done' | 'error'
  const [state, setState] = useState(looksValid ? 'idle' : 'error');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(looksValid ? '' : BAD_LINK);

  const confirm = async () => {
    setState('sending');
    setError('');
    try {
      const r = await fetch('/api/send-password-reset?action=confirm-signout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data?.error || 'Something went wrong. Please try again.');
        setState('error');
        return;
      }
      setResult(data);
      setState('done');
    } catch {
      setError('Could not reach Ratio. Check your connection and try again.');
      setState('error');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2">
          <RatioLogo size={22} alt="Ratio" />
          <span className="text-xs uppercase tracking-[0.25em] text-gray-500">Ratio</span>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          {state === 'done' ? (
            <Done result={result} />
          ) : state === 'error' ? (
            <Problem message={error} />
          ) : (
            <Ask token={token} state={state} onConfirm={confirm} />
          )}
        </div>

        <p className="mt-5 text-center text-xs leading-relaxed text-gray-500">
          Left at a different time? Don&apos;t use the button — reply to the email
          or tell the centre, and they&apos;ll set the right time by hand.
        </p>
      </div>
    </div>
  );
}

function Ask({ state, onConfirm }) {
  return (
    <>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <Clock size={18} />
        </span>
        <div>
          <h1 className="text-lg font-bold text-gray-900">Confirm your sign-out</h1>
          <p className="mt-1 text-sm leading-relaxed text-gray-600">
            Radius recorded your sign-in for this shift but no sign-out.
            Confirming below tells payroll you finished at your scheduled time.
          </p>
        </div>
      </div>

      {/* The times themselves live in the email, which is the copy the
          person actually read. Repeating them here would mean trusting the
          URL to carry them — and anything in the URL is something a
          recipient could edit before tapping. */}
      <p className="mt-4 rounded-lg bg-gray-50 px-3 py-2.5 text-xs leading-relaxed text-gray-600">
        The shift and time are the ones named in your email. They were set by
        the centre — this button doesn&apos;t let you change them.
      </p>

      <button
        onClick={onConfirm}
        disabled={state === 'sending'}
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {state === 'sending'
          ? <><Loader2 size={16} className="animate-spin" /> Confirming…</>
          : <><Check size={16} /> Confirm my sign-out time</>}
      </button>
    </>
  );
}

function Done({ result }) {
  const when = result?.date
    ? new Date(`${result.date}T12:00:00`).toLocaleDateString('en-CA', {
        weekday: 'long', month: 'long', day: 'numeric',
      })
    : null;
  return (
    <div className="text-center">
      <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
        <Check size={24} />
      </span>
      <h1 className="text-lg font-bold text-gray-900">
        {result?.alreadyDone ? 'Already confirmed' : 'Thanks — that’s confirmed'}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-gray-600">
        {when ? <>Your shift on <b className="text-gray-900">{when}</b> is recorded as</> : <>Recorded as</>}
        {' '}
        <b className="text-gray-900 tabular-nums">
          {fmt(result?.clockIn)} – {fmt(result?.signOutTime)}
        </b>.
      </p>
      <p className="mt-3 text-sm text-gray-600">
        Payroll will review it before the period is finalised. Nothing else is needed from you.
      </p>
    </div>
  );
}

function Problem({ message }) {
  return (
    <div className="text-center">
      <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-red-600">
        <AlertTriangle size={22} />
      </span>
      <h1 className="text-lg font-bold text-gray-900">We couldn&apos;t confirm that</h1>
      <p className="mt-2 text-sm leading-relaxed text-gray-600">{message}</p>
    </div>
  );
}

function fmt(t) {
  if (!t) return '—';
  const [hStr, mStr] = String(t).split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(h)) return String(t);
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return m ? `${h}:${String(m).padStart(2, '0')} ${ampm}` : `${h}:00 ${ampm}`;
}
