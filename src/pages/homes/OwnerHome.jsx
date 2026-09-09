import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../../firebase';
import { useAuth } from '../../contexts/AuthContext';
import { resolveWeekdayModel, budgetForDates, datesBetween } from '../../lib/budgetBuckets';
import { countsInRatio } from '../../lib/ratioCount';
import { Card, Lbl, Btn, Stat, Meter, AllClear, Loading } from '../../components/newlook/ui';
import { fmtDay, todayISO, asDate } from '../../components/newlook/format';

/**
 * The owner's door — outcomes, not operations.
 *
 * Their question is "are we growing, and is it costing what it should?"
 * Shifts, timesheets and availability do not appear: those are the
 * director's page and the host's board. They are still one click away.
 *
 * AN OWNER'S PAGE SHOULD USUALLY BE BORING. The healthy state is stated out
 * loud rather than left as blank space a reader has to interpret.
 */
export default function OwnerHome() {
  const { activeCenterId, centerConfig } = useAuth();
  const today = todayISO();
  const month = today.slice(0, 7);

  const [leads, setLeads] = useState(null);
  const [students, setStudents] = useState(null);
  const [staff, setStaff] = useState(null);
  const [shifts, setShifts] = useState(null);

  const monthStart = `${month}-01`;
  const monthEnd = useMemo(() => {
    const d = asDate(monthStart);
    d.setMonth(d.getMonth() + 1);
    d.setDate(0);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }, [monthStart]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      collection(db, 'centers', activeCenterId, 'leads'),
      snap => setLeads(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setLeads([]),
    );
  }, [activeCenterId]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      collection(db, 'centers', activeCenterId, 'schedulerStudents'),
      snap => setStudents(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setStudents([]),
    );
  }, [activeCenterId]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', activeCenterId)),
      snap => setStaff(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => u.approved !== false)),
      () => setStaff([]),
    );
  }, [activeCenterId]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(
        collection(db, 'shifts'),
        where('centerId', '==', activeCenterId),
        where('date', '>=', monthStart),
      ),
      snap => setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(s => s.date <= monthEnd && s.status !== 'cancelled' && s.status !== 'draft')),
      () => setShifts([]),
    );
  }, [activeCenterId, monthStart, monthEnd]);

  // ── The funnel. Real lead statuses: new / contacted / assessed /
  //    enrolled / lost (src/lib/leads.js). ─────────────────────────
  const funnel = useMemo(() => {
    if (!leads) return null;
    const live = leads.filter(l => l.status !== 'lost');
    const assessed = leads.filter(l => l.status === 'assessed' || l.status === 'enrolled');
    const enrolled = leads.filter(l => l.status === 'enrolled');
    return { leads: live.length, assessed: assessed.length, enrolled: enrolled.length };
  }, [leads]);

  const activeStudents = useMemo(() => {
    if (!students) return null;
    // `status` is set by the Student Scheduler; anything not explicitly
    // inactive counts, which matches how the roster is read elsewhere.
    return students.filter(s => s.status !== 'inactive' && s.status !== 'archived').length;
  }, [students]);

  const budget = useMemo(() => {
    const model = resolveWeekdayModel(centerConfig);
    const holidays = new Set((centerConfig?.holidays || []).map(h => h?.date || h));
    return budgetForDates(datesBetween(monthStart, monthEnd), model, {
      isClosed: (d) => holidays.has(d),
    });
  }, [centerConfig, monthStart, monthEnd]);

  const scheduled = useMemo(() => {
    if (!shifts) return null;
    return Math.round(shifts.reduce((n, s) => n + hoursOf(s), 0) * 10) / 10;
  }, [shifts]);

  /** Rostered-ratio per open day this month — real, from the shift rows. */
  const days = useMemo(() => {
    if (!shifts) return [];
    const byDate = new Map();
    for (const s of shifts) {
      byDate.set(s.date, [...(byDate.get(s.date) || []), s]);
    }
    return [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, list]) => ({ date, onRatio: list.filter(countsInRatio).length, total: list.length }));
  }, [shifts]);

  const maxOnRatio = days.reduce((n, d) => Math.max(n, d.onRatio), 0) || 1;

  if (leads === null || shifts === null) return <Loading label="Reading the centre…" />;

  const pct = budget.total > 0 ? Math.round(((scheduled || 0) / budget.total) * 100) : 0;

  return (
    <div className="space-y-5 pb-4">
      <div>
        <h1 className="nl-display text-[26px] font-semibold">
          {centerConfig?.name || 'Your centre'}
        </h1>
        <p className="mt-0.5 text-[13.5px]" style={{ color: 'var(--nl-muted)' }}>
          {asDate(monthStart).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })}
        </p>
      </div>

      {/* ── How families arrive ─────────────────────────────────── */}
      <div>
        <Lbl className="mb-2">How families arrive</Lbl>
        {funnel && (funnel.leads > 0 || funnel.enrolled > 0) ? (
          <div className="grid grid-cols-3 gap-2.5">
            <Stage n={funnel.leads} k="Live leads" />
            <Stage n={funnel.assessed} k="Assessed"
              rate={funnel.leads > 0 ? `${Math.round((funnel.assessed / funnel.leads) * 100)}% of leads` : null} />
            <Stage n={funnel.enrolled} k="Enrolled"
              rate={funnel.assessed > 0 ? `${Math.round((funnel.enrolled / funnel.assessed) * 100)}% of assessed` : null} />
          </div>
        ) : (
          <AllClear title="No leads logged yet"
            note="Leads added in the Leads tab appear here as a funnel." />
        )}
      </div>

      {/* ── The numbers that matter ─────────────────────────────── */}
      <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Stat n={activeStudents ?? '—'} k="Active students" />
        <Stat n={staff ? staff.length : '—'} k="Staff on the roster" />
        <Stat n={scheduled ?? '—'} k="Hours scheduled this month"
          sub={budget.total > 0 ? `of ${budget.total} budgeted` : null}
          tone={scheduled != null && scheduled > budget.total ? 'var(--nl-warn)' : undefined} />
        <Stat n={`${pct}%`} k="Of staffing budget used"
          tone={pct > 100 ? 'var(--nl-warn)' : 'var(--nl-ok)'} />
      </div>

      {budget.total > 0 && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Lbl>Hours against budget</Lbl>
              <div className="mt-1 text-[13px]" style={{ color: 'var(--nl-muted)' }}>
                {budget.openDays} open days
                {budget.closedDays > 0 && ` · ${budget.closedDays} closed day${budget.closedDays === 1 ? '' : 's'} excluded`}
              </div>
            </div>
            <span className="nl-display text-[22px] font-semibold"
              style={{ color: pct > 100 ? 'var(--nl-warn)' : 'var(--nl-ok)' }}>
              {scheduled} / {budget.total}
            </span>
          </div>
          <div className="mt-3">
            <Meter value={scheduled || 0} max={budget.total}
              tone={pct > 100 ? 'var(--nl-warn)' : 'var(--nl-ok)'} />
          </div>
        </Card>
      )}

      {/* ── Staffing depth, day by day ──────────────────────────── */}
      {days.length > 0 && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Lbl>People on ratio, every open day this month</Lbl>
              <div className="mt-1 text-[13px]" style={{ color: 'var(--nl-muted)' }}>
                {days.length} day{days.length === 1 ? '' : 's'} rostered · tallest bar is {maxOnRatio}
              </div>
            </div>
          </div>
          <div className="mt-3 flex h-14 items-end gap-[3px]">
            {days.map(d => (
              <i key={d.date}
                title={`${fmtDay(d.date)} — ${d.onRatio} on ratio, ${d.total} rostered`}
                className="flex-1 rounded-sm"
                style={{
                  height: `${Math.max(6, (d.onRatio / maxOnRatio) * 100)}%`,
                  background: d.onRatio === 0 ? 'var(--nl-warn)' : 'var(--nl-ok)',
                }} />
            ))}
          </div>
          <div className="mt-1.5 flex justify-between text-[10.5px]" style={{ color: 'var(--nl-muted)' }}>
            <span>{fmtDay(days[0].date, { month: 'short', day: 'numeric' })}</span>
            <span>{fmtDay(days[days.length - 1].date, { month: 'short', day: 'numeric' })}</span>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        <Btn to="/center-analytics" variant="quiet" size="sm">Centre Analytics</Btn>
        <Btn to="/leads" variant="quiet" size="sm">Leads</Btn>
        <Btn to="/staffing-budget" variant="quiet" size="sm">Staffing Budget</Btn>
        <Btn to="/case-study" variant="quiet" size="sm">Case Study</Btn>
      </div>
    </div>
  );
}

function Stage({ n, k, rate }) {
  return (
    <Card className="text-center">
      <div className="nl-display text-[30px] font-bold leading-none">{n}</div>
      <div className="mt-1.5 text-[11.5px] font-semibold" style={{ color: 'var(--nl-muted)' }}>{k}</div>
      {rate && <div className="mt-1 text-[11px] font-bold" style={{ color: 'var(--nl-ok)' }}>{rate}</div>}
    </Card>
  );
}

function hoursOf(s) {
  const [h1, m1] = String(s.startTime || '').split(':').map(Number);
  const [h2, m2] = String(s.endTime || '').split(':').map(Number);
  if (![h1, m1, h2, m2].every(Number.isFinite)) return 0;
  return Math.max(0, ((h2 * 60 + m2) - (h1 * 60 + m1)) / 60);
}
