import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import {
  ChevronLeft, ChevronRight, Info, Lock, Pencil, Check, X,
  Stethoscope, CalendarClock, ShieldQuestion,
} from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { watchOwnRate, saveOwnRate } from '../lib/payRate';
import {
  periodFor, stepPeriod, periodLabel, summarisePeriod, sickStatus,
  statsInPeriod, grossPay, isPlausibleRate, money, todayISO, isHourlyPaid,
  SICK_DAYS_PER_YEAR, PROBATION_DAYS, STAT_MIN_QUALIFYING_DAYS,
} from '../lib/payProjection';
import { Card, Pill, Btn, Lbl, Loading } from '../components/newlook/ui';
import { fmtTime, fmtDay } from '../components/newlook/format';

/**
 * My Pay — an instructor's own pay period, as far as Ratio knows it.
 *
 * DESIGN STANCE: this is money, so it is built to be trusted rather than
 * enjoyed. Calm, precise, tabular figures, and every number says where it
 * came from. No animation, no celebration, no big green arrow. People
 * budget against this.
 *
 * The two rules the whole page follows:
 *
 *   1. HOURS ARE THE FACT, MONEY IS THE ESTIMATE. Hours come from their own
 *      shift rows. The dollar figure is hours × a number they typed. So
 *      hours are always shown, and the money is clearly derived from them.
 *
 *   2. THE CAVEAT SITS WITH THE NUMBER, NOT IN A FOOTER. Anything that
 *      could be mistaken for a payslip carries "estimate · QuickBooks is
 *      what you're paid" within a glance of itself.
 */
export default function MyPay() {
  const { profile, activeCenterId, centerConfig, isVolunteer } = useAuth();
  const today = todayISO();

  const [period, setPeriod] = useState(() => periodFor(today));
  const [shifts, setShifts] = useState(null);
  const [rate, setRate] = useState(undefined);        // undefined = loading
  const [editingRate, setEditingRate] = useState(false);

  useEffect(() => {
    if (!profile?.uid || !activeCenterId) return undefined;
    return onSnapshot(
      query(
        collection(db, 'shifts'),
        where('centerId', '==', activeCenterId),
        where('userId', '==', profile.uid),
      ),
      snap => setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setShifts([]),
    );
  }, [profile?.uid, activeCenterId]);

  useEffect(() => {
    if (!profile?.uid) return undefined;
    return watchOwnRate(profile.uid, setRate);
  }, [profile?.uid]);

  const summary = useMemo(
    () => summarisePeriod(shifts || [], period, today), [shifts, period, today]);

  const sick = useMemo(() => sickStatus({
    hireDate: profile?.hireDate || profile?.startDate || null,
    // Sick days come off their own rows, which is all this page can see.
    sickDates: (shifts || []).filter(s => s.sickPay === true).map(s => s.date),
    externalSickDates: Array.isArray(profile?.externalSickDates) ? profile.externalSickDates : [],
    asOf: today,
  }), [profile, shifts, today]);

  const stats = useMemo(
    () => statsInPeriod(centerConfig?.holidays, period, shifts || []),
    [centerConfig?.holidays, period, shifts]);

  const isCurrent = period.start === periodFor(today).start;
  const gross = grossPay(summary.pay, rate);
  const doneGross = grossPay(summary.done, rate);

  // The route is reachable by anyone signed in, so the page gates itself.
  // A volunteer is unpaid and salaried staff aren't paid from the hourly
  // sheet — for either, hours × rate is not their pay, and an empty page
  // would leave them guessing why.
  if (!isHourlyPaid({ displayName: profile?.displayName, isVolunteer }, centerConfig)) {
    return (
      <div className="nl mx-auto w-full max-w-lg pb-6">
        <Card>
          <b className="block text-[15px]">This page is for hourly staff</b>
          <p className="mt-1.5 text-[13.5px] leading-relaxed" style={{ color: 'var(--nl-ink2)' }}>
            {isVolunteer
              ? 'Volunteer hours are unpaid, so there is nothing to project here. Your shifts are still on the Schedule page.'
              : "You're paid outside the hourly sheet, so hours × a rate wouldn't be what you receive. The centre's payroll records are the place to look."}
          </p>
          <Btn to="/" variant="quiet" size="sm" className="mt-3">Back to home</Btn>
        </Card>
      </div>
    );
  }

  if (shifts === null || rate === undefined) return <Loading label="Reading your shifts…" />;

  return (
    <div className="nl mx-auto w-full max-w-2xl space-y-3.5 pb-28 lg:pb-6">

      {/* ── Period ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={() => setPeriod(p => stepPeriod(p, -1))}
          aria-label="Previous pay period"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border"
          style={{ borderColor: 'var(--nl-rule)', color: 'var(--nl-ink2)' }}>
          <ChevronLeft size={18} />
        </button>

        <div className="min-w-0 text-center">
          <h1 className="nl-display truncate text-[21px] font-semibold">{periodLabel(period)}</h1>
          <div className="mt-0.5 text-[12px]" style={{ color: 'var(--nl-muted)' }}>
            {isCurrent ? 'Current pay period' : 'Pay period'}
          </div>
        </div>

        <button type="button" onClick={() => setPeriod(p => stepPeriod(p, 1))}
          aria-label="Next pay period"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border"
          style={{ borderColor: 'var(--nl-rule)', color: 'var(--nl-ink2)' }}>
          <ChevronRight size={18} />
        </button>
      </div>

      {/* ── The figure ─────────────────────────────────────────── */}
      <div className="rounded-2xl border p-5"
        style={{ background: 'var(--nl-card)', borderColor: 'var(--nl-rule)' }}>

        {gross != null ? (
          <>
            <Lbl>Estimated gross this period</Lbl>
            <div className="nl-display mt-1 text-[40px] font-bold leading-none tabular-nums">
              {money(gross)}
            </div>
            <div className="mt-1.5 text-[13px]" style={{ color: 'var(--nl-muted)' }}>
              {summary.pay} hours × {money(rate)}/hr · before tax, CPP and EI
            </div>
          </>
        ) : (
          <>
            <Lbl>Hours this period</Lbl>
            <div className="nl-display mt-1 text-[40px] font-bold leading-none tabular-nums">
              {summary.pay}<span className="ml-1 text-[20px] font-semibold">h</span>
            </div>
            <div className="mt-1.5 text-[13px]" style={{ color: 'var(--nl-muted)' }}>
              Add your hourly rate below to see what that comes to.
            </div>
          </>
        )}

        {/* Done vs still to come — the "am I on track" question. */}
        {summary.shiftCount > 0 && (
          <div className="mt-4">
            <div className="flex h-2 w-full overflow-hidden rounded-full"
              style={{ background: 'var(--nl-raised)' }}>
              <div style={{
                width: `${summary.pay > 0 ? (summary.done / summary.pay) * 100 : 0}%`,
                background: 'var(--nl-ok)',
              }} />
            </div>
            <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[12.5px]">
              <span style={{ color: 'var(--nl-ink2)' }}>
                <b className="tabular-nums">{summary.done}h</b> worked
                {doneGross != null && <span style={{ color: 'var(--nl-muted)' }}> · {money(doneGross)}</span>}
              </span>
              <span style={{ color: 'var(--nl-muted)' }}>
                <b className="tabular-nums">{summary.upcoming}h</b> still to come
              </span>
            </div>
          </div>
        )}

        {/* The caveat lives WITH the number, not in a footer. */}
        <p className="mt-4 flex items-start gap-2 rounded-lg px-3 py-2.5 text-[12.5px] leading-relaxed"
          style={{ background: 'var(--nl-warnw)', color: '#5C3A05' }}>
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>
            <b>This is an estimate, not a payslip.</b> It has no tax, CPP or EI
            taken off, and the hours can still change while payroll is reviewed.
            What you&apos;re actually paid comes from QuickBooks.
          </span>
        </p>
      </div>

      {/* ── Your rate ──────────────────────────────────────────── */}
      <RateBox rate={rate} editing={editingRate} setEditing={setEditingRate}
        uid={profile?.uid} />

      {/* ── The shifts behind the number ───────────────────────── */}
      <div>
        <Lbl className="mb-1.5">
          {summary.shiftCount} {summary.shiftCount === 1 ? 'shift' : 'shifts'} in this period
        </Lbl>
        {summary.shiftCount === 0 ? (
          <Card>
            <p className="text-[13.5px]" style={{ color: 'var(--nl-muted)' }}>
              Nothing scheduled in {periodLabel(period)}.
            </p>
          </Card>
        ) : (
          <Card className="!p-0">
            {summary.rows.map((r, i) => (
              <div key={r.id}
                className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? 'border-t' : ''}`}
                style={{ borderColor: 'var(--nl-rule)' }}>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-semibold">
                    {fmtDay(r.date, { weekday: 'short', month: 'short', day: 'numeric' })}
                  </span>
                  <span className="block truncate text-[12px]" style={{ color: 'var(--nl-muted)' }}>
                    {fmtTime(r.startTime)} – {fmtTime(r.endTime)}
                    {r.subRole ? ` · ${r.subRole}` : ''}
                  </span>
                </span>

                {r.noShow && <Pill tone="warn">No show</Pill>}
                {r.sick && <Pill tone="note">Sick</Pill>}
                {r.adjusted && !r.noShow && (
                  <Pill tone="note" className="whitespace-nowrap">
                    was {r.scheduled}h
                  </Pill>
                )}

                <span className="shrink-0 text-right">
                  <span className="block text-[14px] font-bold tabular-nums"
                    style={{ color: r.pay === 0 ? 'var(--nl-muted)' : 'var(--nl-ink)' }}>
                    {r.pay}h
                  </span>
                  {rate != null && (
                    <span className="block text-[11px] tabular-nums" style={{ color: 'var(--nl-muted)' }}>
                      {money(grossPay(r.pay, rate))}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </Card>
        )}

        {summary.adjusted > 0 && (
          <p className="mt-2 px-1 text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>
            {summary.adjusted} {summary.adjusted === 1 ? 'shift has' : 'shifts have'} been
            adjusted by payroll — the original scheduled hours are shown beside them.
          </p>
        )}
      </div>

      {/* ── Sick leave ─────────────────────────────────────────── */}
      <Card>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            style={{ background: 'var(--nl-notew)', color: 'var(--nl-note)' }}>
            <Stethoscope size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <b className="block text-[14.5px]">Paid sick leave</b>
            {sick.onProbation ? (
              <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--nl-ink2)' }}>
                You&apos;re in your first {PROBATION_DAYS} days
                {sick.daysIn != null && ` (day ${sick.daysIn})`}. BC&apos;s minimum
                starts after that — you&apos;ll have {SICK_DAYS_PER_YEAR} paid days
                from <b>{fmtDay(sick.eligibleFrom, { month: 'long', day: 'numeric' })}</b>.
              </p>
            ) : (
              <>
                <p className="mt-1 text-[13px]" style={{ color: 'var(--nl-ink2)' }}>
                  <b className="tabular-nums">{sick.remaining} of {sick.entitlement}</b> days
                  left for {sick.year}.
                </p>
                <div className="mt-2 flex gap-1.5">
                  {Array.from({ length: sick.entitlement }, (_, i) => (
                    <span key={i} className="h-2 flex-1 rounded-full"
                      style={{ background: i < sick.used ? 'var(--nl-note)' : 'var(--nl-raised)' }} />
                  ))}
                </div>
                <p className="mt-2 text-[12px]" style={{ color: 'var(--nl-muted)' }}>
                  {sick.used === 0
                    ? "You haven't taken any this year."
                    : `${sick.used} taken: ${sick.dates.map(d => fmtDay(d, { month: 'short', day: 'numeric' })).join(', ')}.`}
                </p>
              </>
            )}
            {sick.hireDateMissing && (
              <p className="mt-2 text-[12px]" style={{ color: 'var(--nl-warn)' }}>
                Your start date isn&apos;t on file, so this assumes you&apos;re past
                probation. Worth asking the centre to add it.
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* ── Statutory holidays ─────────────────────────────────── */}
      {stats.length > 0 && stats.map(st => (
        <Card key={st.date}>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
              style={{
                background: st.qualifies ? 'var(--nl-okw)' : 'var(--nl-raised)',
                color: st.qualifies ? 'var(--nl-ok)' : 'var(--nl-muted)',
              }}>
              <CalendarClock size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <b className="text-[14.5px]">{st.name}</b>
                <span className="text-[12px]" style={{ color: 'var(--nl-muted)' }}>
                  {fmtDay(st.date, { weekday: 'long', month: 'long', day: 'numeric' })}
                </span>
              </div>

              {st.qualifies ? (
                <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--nl-ink2)' }}>
                  You qualify for stat pay — about{' '}
                  <b className="tabular-nums">{st.hours}h</b>
                  {rate != null && <> ({money(grossPay(st.hours, rate))})</>}, the average
                  of your {st.daysWorked} qualifying days.
                </p>
              ) : (
                <p className="mt-1 text-[13px] leading-relaxed" style={{ color: 'var(--nl-ink2)' }}>
                  You worked <b className="tabular-nums">{st.daysWorked}</b> of the{' '}
                  {STAT_MIN_QUALIFYING_DAYS} days needed in the 30 days before it,
                  so this one isn&apos;t paid.
                </p>
              )}

              <div className="mt-2 flex gap-[3px]">
                {Array.from({ length: STAT_MIN_QUALIFYING_DAYS }, (_, i) => (
                  <span key={i} className="h-2 flex-1 rounded-full"
                    style={{
                      background: i < st.daysWorked
                        ? (st.qualifies ? 'var(--nl-ok)' : 'var(--nl-warn)')
                        : 'var(--nl-raised)',
                    }} />
                ))}
              </div>
              <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>
                {Math.min(st.daysWorked, STAT_MIN_QUALIFYING_DAYS)} of {STAT_MIN_QUALIFYING_DAYS} qualifying
                days in the 30 before {fmtDay(st.date, { month: 'short', day: 'numeric' })}
              </p>
            </div>
          </div>
        </Card>
      ))}

      {/* ── The closing caveat, in full ────────────────────────── */}
      <Card>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0" style={{ color: 'var(--nl-muted)' }}>
            <ShieldQuestion size={17} />
          </span>
          <div className="text-[12.5px] leading-relaxed" style={{ color: 'var(--nl-muted)' }}>
            <b style={{ color: 'var(--nl-ink2)' }}>Where these numbers come from.</b>{' '}
            Hours are your own scheduled shifts, with any adjustment payroll has
            already made. Sick leave and stat pay follow BC Employment Standards
            minimums. This feature is new and still being checked against the real
            sheet, so treat it as a guide — if something looks wrong, it probably is,
            and the centre would like to know.
          </div>
        </div>
      </Card>
    </div>
  );
}

/**
 * The rate box.
 *
 * Says who can see the number BEFORE asking for it. Somebody typing their
 * wage into a work tool deserves to know where it goes without having to
 * assume, and "private" is a word that gets used loosely.
 */
function RateBox({ rate, editing, setEditing, uid }) {
  const [draft, setDraft] = useState(rate != null ? String(rate) : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const commit = async () => {
    const trimmed = draft.trim();
    if (trimmed === '') { setError('Enter your hourly rate, or cancel.'); return; }
    if (!isPlausibleRate(trimmed)) {
      setError("That doesn't look like an hourly rate. Try something like 20.50.");
      return;
    }
    setSaving(true);
    try {
      await saveOwnRate(uid, Number(trimmed));
      setEditing(false);
      setError('');
    } catch (e) {
      setError(e?.message || 'Could not save that.');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Lbl>Your hourly rate</Lbl>
            <div className="mt-1 text-[19px] font-bold tabular-nums">
              {rate != null ? `${money(rate)}/hr` : 'Not set'}
            </div>
          </div>
          <Btn variant={rate != null ? 'quiet' : 'solid'} size="sm"
            onClick={() => { setDraft(rate != null ? String(rate) : ''); setEditing(true); }}
            className="w-full justify-center sm:w-auto">
            <Pencil size={13} /> {rate != null ? 'Change' : 'Add your rate'}
          </Btn>
        </div>
        <p className="mt-3 flex items-start gap-2 text-[12px] leading-relaxed"
          style={{ color: 'var(--nl-muted)' }}>
          <Lock size={13} className="mt-0.5 shrink-0" />
          <span>
            Other instructors can&apos;t see this. The centre owner and admins can.
            It&apos;s only used here, to multiply by your hours — it never goes into
            payroll or anywhere else.
          </span>
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <Lbl>Your hourly rate</Lbl>
      <div className="mt-2 flex items-center gap-2">
        <div className="flex flex-1 items-center rounded-xl border px-3"
          style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }}>
          <span className="text-[16px] font-semibold" style={{ color: 'var(--nl-muted)' }}>$</span>
          <input
            autoFocus
            type="text"
            inputMode="decimal"
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
            placeholder="20.50"
            aria-label="Your hourly rate in dollars"
            className="w-full bg-transparent py-3 pl-1.5 text-[17px] font-semibold tabular-nums outline-none"
            style={{ color: 'var(--nl-ink)' }}
          />
          <span className="text-[13px]" style={{ color: 'var(--nl-muted)' }}>/hr</span>
        </div>
        <button type="button" onClick={commit} disabled={saving}
          aria-label="Save rate"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-white disabled:opacity-60"
          style={{ background: 'var(--nl-brand)' }}>
          <Check size={18} />
        </button>
        <button type="button" onClick={() => { setEditing(false); setError(''); }}
          aria-label="Cancel"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border"
          style={{ borderColor: 'var(--nl-rule)', color: 'var(--nl-muted)' }}>
          <X size={18} />
        </button>
      </div>
      {error && (
        <p className="mt-2 text-[12.5px] font-semibold" style={{ color: 'var(--nl-brand)' }}>{error}</p>
      )}
      <p className="mt-3 flex items-start gap-2 text-[12px] leading-relaxed"
        style={{ color: 'var(--nl-muted)' }}>
        <Lock size={13} className="mt-0.5 shrink-0" />
        <span>
          Saved to your own private record. Other instructors can&apos;t see it;
          the centre owner and admins can.
        </span>
      </p>
    </Card>
  );
}
