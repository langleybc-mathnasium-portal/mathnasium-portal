import { useState, useEffect, useMemo, useRef, Fragment } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  collection, onSnapshot, doc, updateDoc, deleteDoc, deleteField,
  addDoc, query, where, orderBy, writeBatch, getDoc, getDocs, setDoc,
} from 'firebase/firestore';
import { db, auth, serverTimestamp } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toast, confirmDialog } from '../lib/notify';
import {
  subscribeTemplates, saveTemplate, deleteTemplate,
  applyTemplateConfig, describeTemplate,
} from '../lib/schedulerTemplates';
import {
  Settings, UserCheck, UserX, Trash2, Clock, Tag,
  ChevronLeft, ChevronRight, ChevronDown, Table, Wand2, CheckCircle, Check,
  AlertTriangle, Send, RotateCcw, Edit3, ArrowRightLeft, Plus, X, StickyNote,
  DollarSign, Download, CalendarRange, BarChart3, Mail, Loader2, UserPlus,
  Users, Activity, Briefcase, Copy, CalendarX, Upload, Search, ArrowUp,
  ArrowLeft, LayoutGrid, Calendar, HelpCircle, TrendingUp, HandHeart, Megaphone,
  Shield,
} from 'lucide-react';
import {
  format, startOfWeek, addWeeks, subWeeks, addDays, isSameDay, isSameWeek,
  startOfMonth, endOfMonth, subMonths, addMonths,
} from 'date-fns';
import { generateSchedule, FIXED_SCHEDULES, DEFAULT_AUTO_HOST_NAMES } from '../lib/scheduler';
import { SUB_ROLES, SUB_ROLE_STYLES, STAFF_CAPABILITIES, isFlexRole, subRoleShort, expandSubRoles, styleFor as subRoleStyleFor } from '../lib/subRoles';
import Avatar from '../components/Avatar';
import { DEFAULT_CENTER_ID } from '../lib/centers';
import {
  LANGLEY_DEFAULT_CONFIG, SHIFT_ASSIGNMENTS, DEFAULT_CENTER_CONFIG,
  assignmentFor, assignmentColorHex, assignmentShort, contrastText,
  stateColorHex, staffTypeColorHex,
  isOperatingDay, holidayFor, ALL_WEEKDAYS, resolveInstructionalHours,
} from '../lib/centerConfig';
import CoverageGrid from '../components/CoverageGrid';
import CentreRolesTab from '../components/CentreRolesTab';
import ApptotoAppointmentsCard from '../components/ApptotoAppointmentsCard';
import { buildTimeOffIndex, timeOffOn, withoutApprovedTimeOff } from '../lib/timeOff';
import { availabilityConflict, describeConflict } from '../lib/availabilityFit';
import { isTrainingShift, trainingIds as trainingIdsFor } from '../lib/staffTypes';
import { RATIO_FIELD, defaultIncludedInRatio, countsInRatio, withRatioDefault, ratioHint, isRatioOverridden } from '../lib/ratioCount';
import { roleRatioDefault } from '../lib/roles';
import IntakeAnalyticsCard from '../components/IntakeAnalyticsCard';
import CenterSettingsTab from '../components/CenterSettingsTab';
import HolidaysEditor from '../components/HolidaysEditor';
import {
  notifyOpenShift, notifySchedulePosted, notifyTimeOffDecision,
  notifyMissingSignOut,
} from '../lib/emailService';
import { attachEmails } from '../lib/userContact';
import { weekdayBudgetTotal, resolveWeekdayModel } from '../lib/budgetBuckets';
import { isPaidStatHoliday, statPayForHoliday, minusDays } from '../lib/statPay';
import {
  signOutState, resolvedActualHours, effectiveSignOut,
  buildSignOutRequest, newSignOutToken, SIGNOUT_TTL_DAYS, payrollNeedsReview,
} from '../lib/signOut';
import { parseRadiusRows } from '../lib/radiusTimesheet';
import { fmtTime as fmt12h } from '../lib/availabilityLog';
import {
  resolveUserForCenter,
  membershipFieldPath,
  isPerCentreField,
  buildInitialMembership,
} from '../lib/centerMembership';

/**
 * Why a shift must end after it starts.
 *
 * Nothing stopped an 11pm–7pm shift being saved, and once saved it went
 * quiet rather than loud: the coverage grid derives its columns from the
 * shifts themselves and only counts ones with a forward range, so a
 * reversed shift vanished from the window AND from every half-hour slot
 * while still producing a staff row and still counting in "N staff
 * total". The person looked rostered and un-scheduled at the same time.
 *
 * Overnight shifts aren't a missing feature here — every surface in the
 * app treats a shift as living inside one calendar day — so end <= start
 * is always a typo, and the right place to catch it is before it's
 * written.
 *
 * Returns a human-readable reason, or null when the times are fine.
 */
function shiftTimeProblem(startTime, endTime) {
  const toMins = (t) => {
    const [h, m] = String(t || '').split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
  };
  const s = toMins(startTime);
  const e = toMins(endTime);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return 'Enter both a start and an end time.';
  if (e === s) return 'The start and end times are identical.';
  if (e < s)   return 'The end time is before the start time.';
  return null;
}

// instructorType values. This is a JOB TITLE, not a permission — access
// comes from `role` (owner / admin_assistant / director / admin / …) plus
// the permission set resolved in AuthContext.
//
// Only the fallback now: the live list comes from the centre's own role
// registry via useRoleOptions() below. 'Owner' used to be pinned here
// because signup stamps it on the first account at a centre, and without
// a matching option the select rendered blank — so editing anything else
// about that person committed the wrong title. useRoleOptions() fixes
// that at the root by always including the value the record actually
// holds, which also covers a custom role someone has since deleted.
const ROLE_OPTIONS = [
  'Instructor', 'Lead', 'Host', 'Admin',
  'Manager', 'Center Director', 'Dir. of Education',
  'Training', 'Volunteer',
];

// Roles that don't teach a specific level — the "Teaching Level" field is
// hidden for them when scheduling (Host, Admin, Directors, Volunteer).
// Instructor / Lead / Manager DO teach or float the floor, so they keep it.
const NON_TEACHING_ROLES = new Set(['Host', 'Admin', 'Center Director', 'Dir. of Education', 'Volunteer']);
function shiftNeedsTeachingLevel(role) {
  return !NON_TEACHING_ROLES.has(role);
}

// Sub-roles (teaching specializations) live in src/lib/subRoles.js.
// Each shift is shown on the admin grid with a single "assignment" color
// (Elementary Instructor, Highschool Instructor, …) — see assignmentFor()
// and assignmentColorHex() in src/lib/centerConfig.js. Those nine colors
// are per-center and editable from Super Admin → Appearance.

// Friendly hour-of-day label, '9a', '12p', '5p' style. Used by the
// coverage heatmap on the Analytics tab.
function hourLabel(h) {
  const hh = ((h % 24) + 24) % 24;
  const ampm = hh < 12 ? 'a' : 'p';
  let display = hh % 12;
  if (display === 0) display = 12;
  return `${display}${ampm}`;
}

function fmtHHMM(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const ampm = h >= 12 ? 'p' : 'a';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2,'0')}${ampm}`;
}

// Inline "this shift should have paid N hours" input, used by the payroll
// gap panel. Local state so typing doesn't re-render the whole payroll tab.
function GapHoursInput({ onSave }) {
  const [val, setVal] = useState('');
  const commit = () => {
    const n = Number(val);
    if (!isFinite(n) || n <= 0) return;
    onSave(n);
    setVal('');
  };
  return (
    <span className="flex items-center gap-1">
      <input
        type="number" step="0.25" min="0" value={val} placeholder="hrs"
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') commit(); }}
        className="w-16 rounded-md border border-amber-300 px-1.5 py-0.5 text-right text-[11px] focus:border-amber-500 focus:outline-none"
      />
      <button
        onClick={commit}
        disabled={!(Number(val) > 0)}
        className="rounded-md border border-emerald-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-40"
      >
        Pay this
      </button>
    </span>
  );
}

// ─── Sick-pay policy (BC ESA minimum) ──────────────────────────────────
// 5 paid sick days per calendar year, available once the 90-day probation
// is served. Module-scope because BOTH the payroll summary and the Sick
// Days tab need them, and the payroll summary runs first — declaring them
// inside the component below the summary would put them in the temporal
// dead zone.
const SICK_DAYS_PER_YEAR = 5;
const PROBATION_DAYS = 90;

// Which of a person's sick DATES are actually payable.
//
// Entitlement is consumed chronologically across the WHOLE calendar year,
// not per pay period — whether today's sick day is paid depends on how many
// were taken before it. A date is unpaid when the person was still on
// probation that day, or when the 5-day allowance is already spent.
//
// A missing hire date counts as ELIGIBLE: withholding pay because nobody
// filled in a form is the worse failure mode. Those rows are flagged in the
// export so the gap gets fixed.
function paidSickDates(sickDates, hireDate) {
  const paid = new Set();
  let used = 0;
  for (const ds of [...sickDates].sort()) {
    if (used >= SICK_DAYS_PER_YEAR) break;
    if (hireDate) {
      const daysIn = Math.floor(
        (new Date(ds + 'T00:00:00') - new Date(hireDate + 'T00:00:00')) / 86400000,
      );
      if (daysIn < PROBATION_DAYS) continue; // on probation that day → unpaid
    }
    paid.add(ds);
    used += 1;
  }
  return paid;
}

function shiftHours(s) {
  if (!s.startTime || !s.endTime) return 0;
  const [sh, sm] = s.startTime.split(':').map(Number);
  const [eh, em] = s.endTime.split(':').map(Number);
  const result = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
  return isNaN(result) || result < 0 ? 0 : result;
}

// Hours we actually PAY for a shift: the manual Payroll h override when one
// is set, otherwise the scheduled length. No-shows pay nothing.
//
// This is the figure stat pay must average. BC ESA s.46 bases an average
// day's pay on wages "paid or payable", not on time physically on site —
// so when someone clocks 8.17h against an 8.00h shift and we pay 8.00h,
// 8.00h is the wage earned. Feeding raw scheduled time in meant a resolved
// discrepancy (say, a forgotten sign-out corrected down to 2.00h) never
// reached the stat average, which then disagreed with the money we paid.
function payableShiftHours(s) {
  if (!s) return 0;
  if (s.noShow === true) return 0;
  if (typeof s.payHoursOverride === 'number' && isFinite(s.payHoursOverride)) {
    return Math.max(0, s.payHoursOverride);
  }
  return shiftHours(s);
}

function normalizeTimeToHHMM(str) {
  if (!str) return '';
  str = str.trim();
  if (/^\d{1,2}:\d{2}$/.test(str)) return str.padStart(5, '0');
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(str)) return str.slice(0, 5).padStart(5, '0');
  const m = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2];
    const ampm = m[4].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${min}`;
  }
  return str;
}

function calcTimeDiffHours(timeInStr, timeOutStr) {
  const t1 = normalizeTimeToHHMM(timeInStr);
  const t2 = normalizeTimeToHHMM(timeOutStr);
  if (!t1 || !t2) return 0;
  const [h1, m1] = t1.split(':').map(Number);
  const [h2, m2] = t2.split(':').map(Number);
  if (isNaN(h1) || isNaN(m1) || isNaN(h2) || isNaN(m2)) return 0;
  const diff = ((h2 * 60 + m2) - (h1 * 60 + m1)) / 60;
  return diff > 0 ? Math.round(diff * 100) / 100 : 0;
}

// ── Shared Modal Shell ─────────────────────────────────────────────────────────
function Modal({ title, onClose, children }) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 rounded p-1 hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Map JS getDay() → centerConfig day name (Mon–Sat). Sunday returns null
// so callers can fall back gracefully on centres that don't operate Sundays.
const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Resolve "what should the time fields default to?" for a given date + user
// from this centre's config. Hosts → operating hours (full open-to-close);
// everyone else → instructional hours (teaching window). Falls back to
// the legacy 3pm–8pm range only if the config doesn't have hours for the
// day-of-week at all (which shouldn't happen post-migration).
function defaultShiftTimesFor(date, userLike, centerConfig) {
  const FALLBACK = { start: '15:00', end: '20:00' };
  if (!date) return FALLBACK;
  const d = typeof date === 'string' ? new Date(date + 'T00:00:00') : date;
  const dayName = DOW_NAMES[d.getDay()];
  if (!dayName) return FALLBACK;
  const isHost = (userLike?.instructorType || '').toLowerCase() === 'host';
  // Hosts get operating hours (unchanged). Instructors get the
  // date-resolved instructional hours so any active override (e.g.
  // summerHours2026) is reflected automatically in shift defaults.
  const bucket = isHost
    ? centerConfig?.operatingHours
    : resolveInstructionalHours(centerConfig, d);
  const hours = bucket?.[dayName];
  return hours && hours.start && hours.end ? hours : FALLBACK;
}

// Flex-role picker — two mutually-exclusive toggles (STEAM / Summer Camp).
// A flex shift means the person is present and PAID but is NOT working as
// a floor instructor that shift, so they're excluded from Supply & Demand
// and Student Scheduler instructor counts. Passing '' clears the flag.
/**
 * The role names this centre actually uses, for every "Role" dropdown on
 * this page. Comes from the centre's role registry (Manage Roles → Centre
 * Roles), so a role someone invented there is immediately assignable to a
 * person and to a shift — that's what makes the editor more than a list.
 *
 * ROLE_OPTIONS remains the fallback for a centre whose registry hasn't
 * loaded yet, and it is what the registry seeds itself from, so the two
 * agree out of the box.
 */
function useRoleOptions(current) {
  const { centreRoles } = useAuth();
  return useMemo(() => {
    const names = centreRoles?.length ? centreRoles.map(r => r.name) : ROLE_OPTIONS;
    // A record can carry a title the registry doesn't list: 'Owner' from
    // signup, or a custom role that has since been deleted. Without its
    // own option the select renders BLANK, and saving anything else about
    // that person then commits the wrong title. Append it instead, so the
    // dropdown always shows the truth and only changes what you change.
    if (current && !names.includes(current)) return [...names, current];
    return names;
  }, [centreRoles, current]);
}

/**
 * "Included in Ratio" — the one control that decides whether this shift
 * counts toward the instructor:student ratio.
 *
 * Before this existed, seven surfaces each guessed the answer from the
 * role and disagreed with each other (see src/lib/ratioCount.js). Now the
 * answer is stored on the shift and this toggle is where it's set.
 *
 * The toggle SEEDS from the role — on for Instructor / Lead / Manager, off
 * for Host, Admin, directors, Training, Volunteer and flex work — and then
 * stays wherever you put it. Changing the role afterwards re-seeds it only
 * while you haven't touched it yourself, so picking a role never silently
 * overrides a deliberate choice.
 */
function RatioToggle({ value, onChange, role }) {
  const { centreRoles } = useAuth();
  const seeded = roleRatioDefault(centreRoles, { role });
  const overridden = value !== seeded;
  return (
    <label
      className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
        value ? 'border-emerald-200 bg-emerald-50/60' : 'border-gray-300 bg-gray-50'
      }`}
    >
      <div className="pr-3">
        <p className={`text-xs font-semibold ${value ? 'text-emerald-900' : 'text-gray-900'}`}>
          Included in Ratio
        </p>
        <p className={`text-xs mt-0.5 ${value ? 'text-emerald-700/80' : 'text-gray-600'}`}>
          {ratioHint(value)}
        </p>
        {overridden && (
          <p className="mt-1 text-xs font-medium text-amber-700">
            Overrides the default for {role || 'a shift with no role'}.
          </p>
        )}
      </div>
      <div className="relative inline-flex shrink-0 mt-0.5">
        <input
          type="checkbox"
          checked={value}
          onChange={e => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <div className="peer h-5 w-9 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-emerald-500 peer-checked:after:translate-x-full peer-checked:after:border-white" />
      </div>
    </label>
  );
}

/**
 * Keeps an "Included in Ratio" toggle in sync with the role picker until
 * the user takes it over. Returns [value, setValue, onRoleChange] — call
 * onRoleChange from the role/flex-role setters instead of setting them
 * directly, so re-seeding and the dirty flag stay in one place.
 */
function useRatioToggle(initialShift) {
  const { centreRoles } = useAuth();
  const [touched, setTouched] = useState(() => isRatioOverridden(initialShift));
  const [included, setIncluded] = useState(
    () => (typeof initialShift?.[RATIO_FIELD] === 'boolean'
      ? initialShift[RATIO_FIELD]
      : roleRatioDefault(centreRoles, initialShift || {})),
  );
  const setByUser = (next) => { setTouched(true); setIncluded(next); };
  // Re-seed from the centre's own default for the newly picked role —
  // so a role created with "Counts toward the ratio" ticked seeds ON —
  // but never once a human has moved the toggle themselves.
  const reseed = (nextRole) => {
    setIncluded(cur => (touched ? cur : roleRatioDefault(centreRoles, { role: nextRole })));
  };
  return [included, setByUser, reseed];
}

// ── Add Shift Modal ────────────────────────────────────────────────────────────
function AddShiftModal({ date, user, users, availability, timeOffIndex, centerConfig, onClose, onSave }) {
  const [selectedUser, setSelectedUser] = useState(user?.uid || '');
  // Default the time fields from this centre's configured hours for the
  // picked date's day-of-week — Hosts get operating hours, instructors
  // get instructional hours. Updates if the selected user changes.
  const initialDefaults = defaultShiftTimesFor(date, user, centerConfig);
  const [startTime, setStartTime] = useState(initialDefaults.start);
  const [endTime, setEndTime] = useState(initialDefaults.end);
  const [role, setRole] = useState(user?.instructorType || '');
  const [shiftType, setShiftType] = useState('In-Centre');
  // Default sub-role guesses from the instructor's teaching track.
  // Online is its own platform — anyone tagged Online gets Online shifts.
  const guessSubRole = (u) => {
    const subs = u?.subRoles || [];
    if (subs.includes('Online')) return 'Online';
    if (subs.includes('Highschool')) return 'Highschool';
    return 'Elementary';
  };
  const [subRole, setSubRole] = useState(guessSubRole(user));
  // Whether this shift counts toward the instructor:student ratio. Seeded
  // from the role, then owned by whoever touches the toggle.
  const [includedInRatio, setIncludedInRatio, reseedRatio] = useRatioToggle({
    role: user?.instructorType || '',
  });
  const roleOptions = useRoleOptions(role);
  const handleRoleChange = (next) => { setRole(next); reseedRatio(next); };

  const avail = availability.filter(a => a.userId === selectedUser && a.date === date);
  const availComment = avail.find(a => a.comment)?.comment || '';
  // Time off outranks availability (src/lib/timeOff.js). Adding a shift
  // onto an approved day off is still ALLOWED — sometimes you agree a
  // swap verbally — but it must never look like a normal green day.
  const selectedTimeOff = timeOffOn(timeOffIndex, selectedUser, date);

  // When the instructor selection changes, re-guess the sub-role default
  // AND re-default the time fields (Host vs Instructor have different
  // default windows).
  const handleSelectUser = (uid) => {
    setSelectedUser(uid);
    const next = users.find(u => u.uid === uid);
    setSubRole(guessSubRole(next));
    const d = defaultShiftTimesFor(date, next, centerConfig);
    setStartTime(d.start);
    setEndTime(d.end);
  };

  const handleSubmit = async () => {
    if (!selectedUser || !date) return;
    const problem = shiftTimeProblem(startTime, endTime);
    if (problem) { toast.error(`${problem} A shift has to end after it starts.`); return; }
    const profile = users.find(u => u.uid === selectedUser);
    await onSave({
      userId: profile.uid,
      userName: profile.displayName,
      date,
      startTime,
      endTime,
      role,
      shiftType,
      subRole: shiftNeedsTeachingLevel(role) ? subRole : '',
      [RATIO_FIELD]: includedInRatio,
      // New shifts land as drafts. The owner reviews them on the weekly
      // grid (drafts show striped) and clicks Publish when ready.
      // Instructors don't see drafts on their Schedule page.
      status: 'draft',
    });
    onClose();
  };

  return (
    <Modal
      title={`Add Shift — ${new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`}
      onClose={onClose}
    >
      <div className="space-y-3">
        {/* Instructor selector — only shown when no user pre-selected */}
        {!user && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">Instructor</label>
            <select
              value={selectedUser}
              onChange={e => handleSelectUser(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
            >
              <option value="">Select instructor...</option>
              {users.map(u => <option key={u.uid} value={u.uid}>{u.displayName}</option>)}
            </select>
          </div>
        )}

        {/* Show selected instructor name when pre-filled */}
        {user && (
          <div className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2">
            <Avatar user={user} size={28} />
            <span className="text-sm font-medium text-gray-800">{user.displayName}</span>
            {user.instructorType && <span className="text-xs text-gray-400">· {user.instructorType}</span>}
          </div>
        )}

        {/* Availability hint */}
        {selectedUser && (() => {
          const availText = avail.map(a => (
            (a.startTime === '00:00' && (a.endTime === '23:59' || a.endTime === '24:00'))
              ? 'Full day'
              : `${a.startTime}–${a.endTime}`
          )).join(', ');
          if (selectedTimeOff) {
            const approved = selectedTimeOff.status === 'approved';
            return (
              <div className={`rounded-lg px-3 py-2 text-xs ${approved ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}>
                <p className="font-semibold">
                  {approved ? '⛔ Approved time off on this date' : '⚠ Time off requested for this date'}
                </p>
                <p className="mt-0.5">
                  {selectedTimeOff.startDate}
                  {selectedTimeOff.endDate !== selectedTimeOff.startDate ? ` – ${selectedTimeOff.endDate}` : ''}
                  {selectedTimeOff.reason ? ` · ${selectedTimeOff.reason}` : ''}
                </p>
                {avail.length > 0 && (
                  <p className="mt-0.5 opacity-80">
                    {approved ? 'Overrides' : 'Still marked'} available: {availText}
                  </p>
                )}
              </div>
            );
          }
          return (
            <div className={`rounded-lg px-3 py-2 text-xs ${avail.length > 0 ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
              {avail.length > 0
                ? <>✓ Available: {availText}</>
                : '⚠ No availability submitted for this date'}
            </div>
          );
        })()}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Start Time</label>
            <input
              type="time" value={startTime}
              onChange={e => setStartTime(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">End Time</label>
            <input
              type="time" value={endTime}
              onChange={e => setEndTime(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Instructor comment from availability */}
        {availComment && (
          <div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800">
            <span className="font-semibold">Instructor note: </span>{availComment}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Role</label>
            <select
              value={role}
              onChange={e => handleRoleChange(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
            >
              <option value="">No role</option>
              {roleOptions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Shift Type</label>
            <select
              value={shiftType}
              onChange={e => setShiftType(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
            >
              <option value="In-Centre">In-Centre</option>
              <option value="Online">Online</option>
              <option value="Both">In-Centre + Online</option>
            </select>
          </div>
        </div>

        {shiftNeedsTeachingLevel(role) && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Teaching Level <span className="text-red-500">*</span>
            </label>
            <select
              value={subRole}
              onChange={e => setSubRole(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
            >
              {SUB_ROLES.map(sr => <option key={sr} value={sr}>{sr}</option>)}
            </select>
            <p className="mt-1 text-xs text-gray-400">
              Required for shift swaps — only instructors with this sub-role can take it.
            </p>
          </div>
        )}

        <RatioToggle value={includedInRatio} onChange={setIncludedInRatio} role={role} />

        <button
          onClick={handleSubmit}
          disabled={!selectedUser}
          className="w-full rounded-lg bg-red-600 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 transition-colors mt-1"
        >
          Add Shift
        </button>
      </div>
    </Modal>
  );
}

// ── Edit Shift Modal ───────────────────────────────────────────────────────────
function EditShiftModal({ shift, onClose, onSave, onDelete, onPublish }) {
  const [startTime, setStartTime] = useState(shift.startTime || '15:00');
  const [endTime, setEndTime] = useState(shift.endTime || '20:00');
  const [role, setRole] = useState(shift.role || '');
  const [shiftType, setShiftType] = useState(shift.shiftType || 'In-Centre');
  const [subRole, setSubRole] = useState(shift.subRole || 'Elementary');
  // Sick Pay flag — set when an instructor calls in sick. The shift stays
  // on the schedule (so we have a record) but the payroll tab reports it
  // under a separate "Sick" column instead of regular worked hours.
  const [sickPay, setSickPay] = useState(!!shift.sickPay);
  // No-Show flag — instructor was scheduled but didn't come in and it's
  // NOT a sick day. Unpaid. Stays on the schedule so we have a record
  // that they were originally assigned, but excluded from payroll and
  // from the day's paid-hours total. Mutually exclusive with sickPay.
  const [noShow, setNoShow] = useState(!!shift.noShow);
  // Included in Ratio. An existing shift opens on whatever it was saved
  // with; a legacy shift with no stored value opens on the role default.
  const [includedInRatio, setIncludedInRatio, reseedRatio] = useRatioToggle(shift);
  const roleOptions = useRoleOptions(role);
  const handleRoleChange = (next) => { setRole(next); reseedRatio(next); };

  return (
    <Modal
      title="Edit Shift"
      onClose={onClose}
    >
      <p className="text-sm text-gray-500 mb-4">
        {shift.userName} · {new Date(shift.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
      </p>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Start Time</label>
            <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">End Time</label>
            <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Role</label>
            <select value={role} onChange={e => handleRoleChange(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none">
              <option value="">No role</option>
              {roleOptions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Shift Type</label>
            <select value={shiftType} onChange={e => setShiftType(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none">
              <option value="In-Centre">In-Centre</option>
              <option value="Online">Online</option>
              <option value="Both">In-Centre + Online</option>
            </select>
          </div>
        </div>
        {shiftNeedsTeachingLevel(role) && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Teaching Level <span className="text-red-500">*</span>
            </label>
            <select value={subRole} onChange={e => setSubRole(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none">
              {SUB_ROLES.map(sr => <option key={sr} value={sr}>{sr}</option>)}
            </select>
            <p className="mt-1 text-xs text-gray-400">
              Required for shift swaps — only instructors with this sub-role can take it.
            </p>
          </div>
        )}

        {/* Sick Pay toggle — flips this shift into the "Sick" payroll bucket
            without removing it from the schedule. Useful when an instructor
            calls in sick and you still want them paid for the planned hours. */}
        <label className="flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 cursor-pointer">
          <div className="pr-3">
            <p className="text-xs font-semibold text-amber-900">Sick Pay</p>
            <p className="text-xs text-amber-700/80 mt-0.5">
              Mark this shift as sick. Hours are tracked separately on the payroll tab.
            </p>
          </div>
          <div className="relative inline-flex shrink-0 mt-0.5">
            <input
              type="checkbox"
              checked={sickPay}
              onChange={e => { setSickPay(e.target.checked); if (e.target.checked) setNoShow(false); }}
              className="peer sr-only"
            />
            <div className="peer h-5 w-9 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-amber-500 peer-checked:after:translate-x-full peer-checked:after:border-white" />
          </div>
        </label>

        {/* No-Show toggle — instructor was scheduled but didn't show up
            AND isn't calling in sick. Shift stays on the record so we
            can see what they were originally assigned, but hours are
            zeroed for payroll and pulled from the day's paid total. */}
        <label className="flex items-start justify-between gap-3 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 cursor-pointer">
          <div className="pr-3">
            <p className="text-xs font-semibold text-gray-900">No-Show</p>
            <p className="text-xs text-gray-600 mt-0.5">
              Instructor didn&apos;t come in. Unpaid — subtracts from the day&apos;s hours but keeps the shift on the record.
            </p>
          </div>
          <div className="relative inline-flex shrink-0 mt-0.5">
            <input
              type="checkbox"
              checked={noShow}
              onChange={e => { setNoShow(e.target.checked); if (e.target.checked) setSickPay(false); }}
              className="peer sr-only"
            />
            <div className="peer h-5 w-9 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white" />
          </div>
        </label>

        <RatioToggle value={includedInRatio} onChange={setIncludedInRatio} role={role} />

        {/* Draft state banner + Publish button — only shown when this shift
            is still in draft. Publishing flips status to 'live' so the
            instructor sees it on their Schedule. */}
        {shift.status === 'draft' && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
            <p className="font-semibold mb-0.5">This shift is a draft</p>
            <p className="text-amber-800/80">The instructor can&apos;t see it until you publish.</p>
            <button
              onClick={() => onPublish && onPublish()}
              className="mt-2 w-full rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white hover:bg-emerald-700 transition-colors"
            >
              Publish this shift
            </button>
          </div>
        )}

        {/* A shift whose times produce 0 hours is invisible to payroll — it
            shows on the grid with no hours label and pays nothing. Block it
            at the source rather than discovering it on payroll day. */}
        {!(shiftHours({ startTime, endTime }) > 0) && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
            ⚠ These times work out to 0 hours, so this shift would pay nothing. Check the start and end times.
          </p>
        )}
        <div className="flex gap-2 pt-1">
          <button
            onClick={() => {
              const problem = shiftTimeProblem(startTime, endTime);
              if (problem) { toast.error(`${problem} A shift has to end after it starts.`); return; }
              onSave({ startTime, endTime, role, shiftType, subRole: shiftNeedsTeachingLevel(role) ? subRole : '', sickPay, noShow, [RATIO_FIELD]: includedInRatio });
            }}
            disabled={!(shiftHours({ startTime, endTime }) > 0)}
            className="flex-1 rounded-lg bg-red-600 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40">
            Save Changes
          </button>
          <button onClick={onDelete}
            className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50">
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── User Availability (Week) Modal ─────────────────────────────────────────
// Owner / admin clicks a name in the weekly-grid left column → modal opens
// showing that person's availability for each day of the visible week.
// Read-only: this is a viewing tool, not an editor. Includes their already-
// scheduled shifts on each day so the admin can compare "available 3–7"
// vs "scheduled 4–6" at a glance.
function UserAvailabilityModal({ user, weekDays, availability, shifts, timeOffIndex, onClose }) {
  const userAvail = availability.filter(a => a.userId === user.uid);
  const userShifts = shifts.filter(s => s.userId === user.uid);
  const isFull = (a) => a?.startTime === '00:00' && (a?.endTime === '23:59' || a?.endTime === '24:00');
  // weekDays is pre-filtered to operating days only (e.g. Mon–Sat = 6
  // entries, not 7), so use first/last instead of index 6.
  const firstDay = weekDays[0];
  const lastDay  = weekDays[weekDays.length - 1];
  return (
    <Modal
      title={`Availability — ${user.displayName}`}
      onClose={onClose}
    >
      <div className="-mt-2 mb-3 flex items-center gap-2">
        <Avatar user={user} size={28} />
        <p className="text-xs text-gray-500">
          {firstDay && lastDay
            ? <>Week of {format(firstDay, 'MMM d')} – {format(lastDay, 'MMM d, yyyy')}</>
            : 'No operating days this week'}
        </p>
      </div>
      <div className="space-y-2">
        {weekDays.map(d => {
          const ds = format(d, 'yyyy-MM-dd');
          const dayAvail   = userAvail.filter(a => a.date === ds);
          const dayShifts  = userShifts.filter(s => s.date === ds);
          const dayOff     = timeOffOn(timeOffIndex, user.uid, ds);
          const hasAnything = dayAvail.length > 0 || dayShifts.length > 0 || !!dayOff;
          return (
            <div
              key={ds}
              className={`rounded-lg border px-3 py-2 ${hasAnything ? 'bg-white border-gray-200' : 'bg-gray-50 border-gray-100'}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-gray-800">
                  {format(d, 'EEE')} <span className="text-gray-400 font-normal">· {format(d, 'MMM d')}</span>
                </p>
                {dayOff ? (
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                    dayOff.status === 'approved'
                      ? 'border-red-200 bg-red-50 text-red-700'
                      : 'border-amber-300 bg-amber-50 text-amber-800'
                  }`}>
                    Time off · {dayOff.status === 'approved' ? 'Approved' : 'Pending'}
                  </span>
                ) : !hasAnything && (
                  <span className="text-xs text-gray-400 italic">No availability submitted</span>
                )}
              </div>
              {/* When a day is off, the submitted hours below are shown
                  struck through rather than removed — the record of what
                  they originally offered still matters if the request is
                  later denied. */}
              {dayOff && dayAvail.length > 0 && (
                <p className="mt-1 text-[11px] text-gray-500">
                  {dayOff.status === 'approved' ? 'Overrides the availability below.' : 'Availability below is still pending a decision.'}
                </p>
              )}
              {dayAvail.length > 0 && (
                <div className="mt-1 space-y-1">
                  {dayAvail.map((a, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                      <span className="text-xs text-emerald-800 font-medium">
                        {isFull(a) ? 'Full day · anytime' : `${fmtHHMM(a.startTime)} – ${fmtHHMM(a.endTime)}`}
                      </span>
                      {a.comment && (
                        <span className="text-xs text-blue-600 italic truncate">&quot;{a.comment}&quot;</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {dayShifts.length > 0 && (
                <div className="mt-1 space-y-1">
                  {dayShifts.map(s => (
                    <div key={s.id} className="flex items-center gap-2">
                      <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                      <span className="text-xs text-gray-700">
                        Scheduled {fmtHHMM(s.startTime)} – {fmtHHMM(s.endTime)}
                        {s.role ? ` · ${s.role}` : ''}
                      </span>
                      {s.status === 'draft' && (
                        <span className="rounded bg-amber-100 px-1 py-px text-[10px] font-bold uppercase tracking-wider text-amber-700">Draft</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

// ── Add Staff Modal ──────────────────────────────────────────────────────
// Owner / AA / admin creates a new staff account without making the new
// hire sign up themselves. The server-side handler (POST /api/users/
// create-staff) creates the Auth account, writes a pre-approved Firestore
// profile, and emails a "set your password" link. Owner never sees or
// touches a password.
function AddStaffModal({ onClose, onSubmit }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [instructorType, setInstructorType] = useState('Instructor');
  const roleOptions = useRoleOptions(instructorType);
  const [subRoles, setSubRoles] = useState(['Elementary']);
  const [sendResetEmail, setSendResetEmail] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggleSubRole = (sr) => {
    setSubRoles(p => p.includes(sr) ? p.filter(x => x !== sr) : [...p, sr]);
  };

  const handleSubmit = async () => {
    setError('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Enter a valid email.');
      return;
    }
    if (!displayName.trim()) {
      setError('Enter the staff member\'s full name.');
      return;
    }
    setSaving(true);
    try {
      await onSubmit({
        email: email.trim().toLowerCase(),
        displayName: displayName.trim(),
        phone: phone.trim(),
        instructorType,
        subRoles,
        sendResetEmail,
      });
    } catch (err) {
      setError(err?.message || 'Could not create account.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Add Staff" onClose={onClose}>
      <p className="text-xs text-gray-500 -mt-2 mb-3">
        Creates a pre-approved account at your centre. The new staff member
        gets an email with a link to set their own password and sign in.
      </p>
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Full name</label>
          <input
            type="text" autoFocus value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="Jane Doe"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Email</label>
          <input
            type="email" value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="jane@example.com"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Phone <span className="text-gray-400 font-normal">(optional)</span></label>
          <input
            type="tel" value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="604-555-0199"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Role / Type</label>
            <select
              value={instructorType}
              onChange={e => setInstructorType(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
            >
              {roleOptions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Sub-Roles &amp; Capabilities</label>
          <div className="flex flex-wrap gap-2">
            {STAFF_CAPABILITIES.map(sr => {
              const active = subRoles.includes(sr);
              const style = SUB_ROLE_STYLES[sr];
              return (
                <button
                  key={sr}
                  type="button"
                  onClick={() => toggleSubRole(sr)}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold border-2 transition-all ${
                    active
                      ? `${style.pillBg} ${style.pillText} border-transparent`
                      : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${active ? style.dot : 'bg-gray-300'}`} />
                  {sr}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-gray-400">Required so they can claim and be auto-scheduled.</p>
        </div>
        <label className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 cursor-pointer">
          <input
            type="checkbox" checked={sendResetEmail}
            onChange={e => setSendResetEmail(e.target.checked)}
            className="mt-0.5 accent-red-600 h-4 w-4"
          />
          <span className="text-xs text-gray-700">
            <strong>Email a &ldquo;set your password&rdquo; link now.</strong>{' '}
            <span className="text-gray-500">
              Off only if you&apos;ll resend later from the staff card.
            </span>
          </span>
        </label>

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 flex items-start gap-2">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button
            onClick={onClose}
            disabled={saving}
            className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="flex-1 rounded-lg bg-red-600 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving ? <><Loader2 size={14} className="animate-spin" /> Creating…</> : <><UserPlus size={14} /> Create staff</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Edit Staff Modal ─────────────────────────────────────────────────────
// Owner / AA / admin tweaks role / sub-roles / toggles on an
// existing staff member. All writes go through onUpdateField so per-centre
// membership semantics + Firestore rules apply automatically.
function EditStaffModal({ user, onClose, onUpdateField, onTerminate, onSendReset }) {
  const { canSeeCenterSettings: canTerminate } = useAuth();
  // Above the early return on purpose: a hook after a conditional return
  // changes hook order between renders and React throws.
  const roleOptions = useRoleOptions(user?.instructorType);
  if (!user) return null;
  // Expanded, so a legacy 'Both' shows as Elementary + Highschool ticked.
  // Toggling anything here then writes the expanded list back, which
  // retires the old tag on that user without a bulk migration.
  const subRoles = expandSubRoles(user.subRoles);
  return (
    <Modal title={`Edit — ${user.displayName || user.email}`} onClose={onClose}>
      <p className="text-xs text-gray-500 -mt-2 mb-3 truncate">
        {user.email}
        {user.phone ? ` · ${user.phone}` : ''}
      </p>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="mb-1 block text-xs text-gray-500">Role / Type</label>
            <select
              value={user.instructorType || 'Instructor'}
              onChange={e => onUpdateField(user.uid, 'instructorType', e.target.value)}
              className="w-full rounded border px-2 py-1.5 text-xs focus:border-red-500 focus:outline-none"
            >
              {roleOptions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">Max Days/Week</label>
            <input
              type="number" min={1} max={6}
              value={user.maxDaysPerWeek || 5}
              onChange={e => onUpdateField(user.uid, 'maxDaysPerWeek', Number(e.target.value))}
              className="w-full rounded border px-2 py-1.5 text-xs focus:border-red-500 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs text-gray-500 font-medium">Sub-Roles &amp; Capabilities</label>
          <div className="flex flex-wrap gap-2">
            {STAFF_CAPABILITIES.map(sr => {
              const active = subRoles.includes(sr);
              const style = SUB_ROLE_STYLES[sr];
              return (
                <button
                  key={sr}
                  type="button"
                  onClick={() => {
                    const updated = active
                      ? subRoles.filter(r => r !== sr)
                      : [...subRoles, sr];
                    onUpdateField(user.uid, 'subRoles', updated);
                  }}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold border-2 transition-all ${
                    active
                      ? `${style.pillBg} ${style.pillText} border-transparent`
                      : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${active ? style.dot : 'bg-gray-300'}`} />
                  {sr}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-start justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <div className="pr-3">
            <p className="text-xs font-semibold text-gray-700">Guaranteed shift</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Always scheduled when they submit availability.
              {user.instructorType === 'Host' && ' Hosts also auto-promote to Instructor on shortage days.'}
            </p>
          </div>
          <label className="relative inline-flex cursor-pointer items-center shrink-0 mt-0.5">
            <input
              type="checkbox"
              checked={user.guaranteed === true}
              onChange={e => onUpdateField(user.uid, 'guaranteed', e.target.checked)}
              className="peer sr-only"
            />
            <div className="peer h-5 w-9 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-emerald-600 peer-checked:after:translate-x-full peer-checked:after:border-white" />
          </label>
        </div>

        <div className="flex items-start justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <div className="pr-3">
            <p className="text-xs font-semibold text-gray-700">Volunteer</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Unpaid help. Excluded from payroll + Radius reports. Not auto-scheduled.
            </p>
          </div>
          <label className="relative inline-flex cursor-pointer items-center shrink-0 mt-0.5">
            <input
              type="checkbox"
              checked={user.isVolunteer === true}
              onChange={e => onUpdateField(user.uid, 'isVolunteer', e.target.checked)}
              className="peer sr-only"
            />
            <div className="peer h-5 w-9 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-amber-600 peer-checked:after:translate-x-full peer-checked:after:border-white" />
          </label>
        </div>

        <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-100">
          {user.email && (
            <button
              onClick={() => onSendReset(user)}
              className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              <Mail size={13} /> Send reset email
            </button>
          )}
          {/* Terminate replaces the old "Remove staff", which only deleted
              the profile and sign-in and left every shift, availability
              row and log entry behind under a person who no longer
              existed. Owner-level only — it erases payroll history. */}
          {canTerminate && (
            <button
              onClick={() => onTerminate(user)}
              className="ml-auto flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
              title="Permanently erase this person and all of their records from Ratio"
            >
              <Trash2 size={13} /> Terminate
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Orphaned records — data left behind by an account that was deleted
 * without clearing it.
 *
 * Deleting a user's PROFILE used to be all "Remove staff" did. Their
 * shifts, availability, notification preferences and log entries stayed in
 * the database with no account attached — invisible to Manage Staff, so
 * there was no way to find or clear them from inside the app. Ten people
 * and 189 documents had built up that way before this existed.
 *
 * Terminate doesn't leave orphans any more, so this is a mop for history
 * rather than something that should keep filling up. It stays because
 * imports and hand-edits can still create them, and silent build-up is
 * exactly what caused the problem the first time.
 */
function OrphanedRecordsPanel() {
  const { user: authUser, canSeeCenterSettings } = useAuth();
  const [open, setOpen]       = useState(false);
  const [loading, setLoading] = useState(false);
  const [orphans, setOrphans] = useState(null);
  const [busy, setBusy]       = useState(null);
  const [error, setError]     = useState(null);

  const call = async (body) => {
    const idToken = authUser ? await authUser.getIdToken() : null;
    if (!idToken) throw new Error('Not signed in.');
    const r = await fetch('/api/users/reject-user', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 207) throw new Error(data?.error || `Failed (${r.status}).`);
    return data;
  };

  const scan = async () => {
    setLoading(true); setError(null);
    try { setOrphans((await call({ mode: 'orphans' })).orphans || []); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const openPanel = () => { setOpen(true); if (!orphans) scan(); };

  // Same contract as Terminate: the record is downloaded before anything
  // is deleted, so there is always a copy of what went.
  const purge = async (orphan) => {
    const ok = await confirmDialog({
      title: `Clear ${orphan.total} orphaned record${orphan.total === 1 ? '' : 's'} for "${orphan.name}"?`,
      body: 'Their record downloads first, then the documents are deleted. '
        + 'There is no account attached to this data — nobody loses access.',
      confirmLabel: 'Download and clear',
      destructive: true,
    });
    if (!ok) return;
    setBusy(orphan.name); setError(null);
    try {
      const data = await call({ mode: 'orphan-purge', name: orphan.name });
      const blob = new Blob([JSON.stringify(data.export, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ratio-orphaned-${orphan.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${format(new Date(), 'yyyy-MM-dd')}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (data.warning) toast.error(data.warning, 9000);
      else toast.success(`Cleared ${data.total} record${data.total === 1 ? '' : 's'} for ${orphan.name}.`);
      setOrphans(cur => (cur || []).filter(o => o.name !== orphan.name));
    } catch (err) {
      setError(err.message);
    } finally { setBusy(null); }
  };

  if (!canSeeCenterSettings) return null;

  const total = (orphans || []).reduce((n, o) => n + o.total, 0);

  return (
    <div className="rounded-2xl border bg-white shadow-sm">
      <button onClick={() => (open ? setOpen(false) : openPanel())}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-bold text-gray-900">
        <span className="flex items-center gap-2">
          <Search size={15} className="text-gray-400" />
          Orphaned records
          {orphans && orphans.length > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
              {orphans.length} {orphans.length === 1 ? 'name' : 'names'} · {total} docs
            </span>
          )}
        </span>
        <span className="text-xs font-normal text-gray-400">{open ? 'Hide' : 'Check'}</span>
      </button>

      {open && (
        <div className="border-t px-4 py-3">
          <p className="mb-3 text-xs text-gray-500">
            Shifts, availability and preferences belonging to accounts that were deleted without
            clearing their data. Nobody has access through these &mdash; there&rsquo;s no account attached.
            Clearing one downloads its record first.
          </p>

          {loading && (
            <div className="flex items-center gap-2 py-3 text-sm text-gray-500">
              <Loader2 size={15} className="animate-spin" /> Scanning every collection…
            </div>
          )}
          {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700">{error}</p>}

          {orphans && orphans.length === 0 && (
            <p className="flex items-center gap-2 py-2 text-sm text-emerald-700">
              <Check size={15} /> Nothing orphaned. Every record belongs to a live account.
            </p>
          )}

          {orphans && orphans.length > 0 && (
            <ul className="divide-y">
              {orphans.map(o => (
                <li key={o.name} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="font-semibold text-gray-800">{o.name}</span>
                  <span className="font-mono text-xs text-gray-500">{o.total} docs</span>
                  <span className="flex flex-wrap gap-1">
                    {Object.entries(o.counts).map(([c, n]) => (
                      <span key={c} className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-600">
                        {c} {n}
                      </span>
                    ))}
                  </span>
                  {o.lastDate && (
                    <span className="text-[10px] text-gray-400">last {o.lastDate}</span>
                  )}
                  <button
                    onClick={() => purge(o)}
                    disabled={!!busy}
                    className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-red-300 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40"
                  >
                    {busy === o.name ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                    {busy === o.name ? 'Clearing…' : 'Download & clear'}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {orphans && (
            <button onClick={scan} disabled={loading || !!busy}
              className="mt-2 text-xs text-gray-400 hover:text-gray-700 disabled:opacity-40">
              Re-scan
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Terminate Staff — the irreversible one.
 *
 * Erases a person from Ratio: their sign-in, their profile, and every
 * document that belongs to them (shifts, availability, time off, chat they
 * wrote, notification preferences, availability and audit log entries).
 *
 * Two guards, because this cannot be undone:
 *
 *   1. It downloads a full JSON record of everything about to be deleted
 *      BEFORE deleting any of it. Payroll records have to be kept for four
 *      years in BC; erasing 100+ shifts with no copy would break that.
 *      The download is not optional and not a checkbox.
 *
 *   2. It requires typing the person's full name. A confirm dialog is one
 *      misplaced click; a name is not something you type by accident.
 */
function TerminateStaffModal({ user, onClose, onDone }) {
  const { user: authUser } = useAuth();
  const [loading, setLoading]   = useState(true);
  const [working, setWorking]   = useState(false);
  const [error, setError]       = useState(null);
  const [preview, setPreview]   = useState(null);
  const [typed, setTyped]       = useState('');
  const [exported, setExported] = useState(false);

  const fullName = (user?.displayName || '').trim();
  // Forgiving on case and inner spacing — this is a confirmation, not a
  // spelling test. It still can't be satisfied by a stray click.
  const norm = (v) => v.trim().toLowerCase().replace(/\s+/g, ' ');
  const nameMatches = fullName.length > 0 && norm(typed) === norm(fullName);

  const call = async (mode) => {
    const idToken = authUser ? await authUser.getIdToken() : null;
    if (!idToken) throw new Error('Not signed in.');
    const r = await fetch('/api/users/reject-user', {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: user.uid, mode }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 207) throw new Error(data?.error || `Failed (${r.status}).`);
    return data;
  };

  // Count what's there as soon as the modal opens, so the number in front
  // of you is the real one rather than a guess.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await call('preview');
        if (alive) { setPreview(data); setLoading(false); }
      } catch (err) {
        if (alive) { setError(err.message); setLoading(false); }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid]);

  const downloadRecord = () => {
    const blob = new Blob([JSON.stringify(preview.export, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ratio-termination-${fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${format(new Date(), 'yyyy-MM-dd')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setExported(true);
  };

  const terminate = async () => {
    setWorking(true);
    setError(null);
    try {
      const data = await call('terminate');
      if (data.warning) toast.error(data.warning, 9000);
      else toast.success(`${fullName} has been terminated and removed from Ratio.`);
      onDone();
    } catch (err) {
      setError(err.message);
      setWorking(false);
    }
  };

  const rows = Object.entries(preview?.counts || {});
  const LABELS = {
    shifts: 'Shifts', availability: 'Availability', openShifts: 'Open shifts',
    timeOffRequests: 'Time-off requests', chat: 'Chat messages they wrote',
    availabilityLog: 'Availability log entries', notificationPreferences: 'Notification preferences',
    auditLog: 'Audit log entries',
  };

  return (
    <Modal title={`Terminate ${fullName || 'staff member'}`} onClose={working ? () => {} : onClose}>
      <div className="space-y-3">
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-900">
          <b>This cannot be undone.</b> It deletes their sign-in and every record of them in Ratio.
          They will not be able to log in, and they will disappear from the schedule, availability,
          payroll and every other screen.
        </p>

        {loading && (
          <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
            <Loader2 size={15} className="animate-spin" /> Counting what would be deleted…
          </div>
        )}

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700">{error}</p>
        )}

        {preview && (
          <>
            <div className="rounded-xl border bg-gray-50 px-3 py-2.5">
              <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-gray-500">
                What will be deleted — {preview.total} document{preview.total === 1 ? '' : 's'}
              </p>
              {rows.length === 0 ? (
                <p className="text-xs text-gray-500">No records beyond their profile and sign-in.</p>
              ) : (
                <ul className="space-y-0.5">
                  {rows.map(([k, n]) => (
                    <li key={k} className="flex justify-between text-xs text-gray-700">
                      <span>{LABELS[k] || k}</span>
                      <span className="font-mono font-semibold">{n}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 border-t pt-2 text-xs text-gray-500">
                Plus their profile and their Firebase sign-in account.
              </p>
            </div>

            {/* Step 1 — the record leaves the building first. */}
            <button
              onClick={downloadRecord}
              className={`flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                exported
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                  : 'border-gray-300 bg-white text-gray-800 hover:bg-gray-50'
              }`}
            >
              {exported ? <Check size={15} /> : <Download size={15} />}
              {exported ? 'Record downloaded' : '1. Download their record first'}
            </button>
            <p className="text-xs text-gray-500">
              A JSON file with every shift, date and hour. Payroll records have to be kept for four
              years, so keep this somewhere safe before continuing.
            </p>

            {/* Step 2 — type the name. */}
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">
                2. Type <b>{fullName}</b> to confirm
              </label>
              <input
                type="text"
                value={typed}
                onChange={e => setTyped(e.target.value)}
                placeholder={fullName}
                autoComplete="off"
                disabled={working}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none disabled:bg-gray-50"
              />
            </div>

            <button
              onClick={terminate}
              disabled={!exported || !nameMatches || working}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 py-2.5 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-40"
            >
              {working ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
              {working ? 'Terminating…' : `Terminate ${fullName}`}
            </button>
            {!exported && (
              <p className="text-center text-xs text-gray-400">Download the record to continue.</p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

// ── Add Open Shift Modal ───────────────────────────────────────────────────────
function AddOpenShiftModal({ date, centerConfig, onClose, onSave }) {
  // Open shifts default to instructional hours for that day (it's the
  // teaching window someone would be claiming). Owner can override before
  // saving.
  const initial = defaultShiftTimesFor(date, null, centerConfig);
  const [startTime, setStartTime] = useState(initial.start);
  const [endTime, setEndTime] = useState(initial.end);
  const [role, setRole] = useState('');
  const [subRole, setSubRole] = useState('Elementary');
  // The claimer inherits this, so the decision is made when the shift is
  // posted rather than left to whoever happens to pick it up.
  const [includedInRatio, setIncludedInRatio, reseedRatio] = useRatioToggle({ role: '' });
  const roleOptions = useRoleOptions(role);
  const handleRoleChange = (next) => { setRole(next); reseedRatio(next); };

  const handleSubmit = async () => {
    const problem = shiftTimeProblem(startTime, endTime);
    if (problem) { toast.error(`${problem} A shift has to end after it starts.`); return; }
    await onSave({
      date, startTime, endTime, role,
      subRole: shiftNeedsTeachingLevel(role) ? subRole : '',
      [RATIO_FIELD]: includedInRatio,
    });
    onClose();
  };

  return (
    <Modal
      title={`Add Open Shift — ${new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`}
      onClose={onClose}
    >
      <div className="space-y-3">
        <p className="text-xs text-gray-500">An open shift can be claimed by any instructor whose sub-role matches.</p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Start Time</label>
            <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">End Time</label>
            <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Role / Tag (optional)</label>
            <select value={role} onChange={e => handleRoleChange(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none">
              <option value="">Any role</option>
              {roleOptions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          {shiftNeedsTeachingLevel(role) && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                Teaching Level <span className="text-red-500">*</span>
              </label>
              <select value={subRole} onChange={e => setSubRole(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none">
                {SUB_ROLES.map(sr => <option key={sr} value={sr}>{sr}</option>)}
              </select>
            </div>
          )}
        </div>
        <RatioToggle value={includedInRatio} onChange={setIncludedInRatio} role={role} />
        <button onClick={handleSubmit}
          className="w-full rounded-lg bg-orange-500 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 transition-colors mt-1">
          Post Open Shift
        </button>
      </div>
    </Modal>
  );
}

// ── Bulk delete shifts (single day or range) ───────────────────────────
// Dropdown widget on Manage Payroll. Single date deletes that day (e.g.
// stat holiday); two dates deletes everything in between (e.g. clean a
// whole month before importing from another tool).
function BulkDeleteShiftsByDate({ onConfirm }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 transition-colors"
        title="Bulk-delete shifts on a date or in a date range">
        <Trash2 size={14} /> Delete shifts
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-96 rounded-xl border border-gray-200 bg-white p-4 shadow-lg">
          <h4 className="font-bold text-gray-900 text-sm mb-1">Delete shifts in date range</h4>
          <p className="text-xs text-gray-500 mb-3">
            Set <b>From</b> only (leave To blank) to delete one day — e.g. a stat holiday.
            Set both to wipe a full range before importing payroll from another tool.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-xs text-gray-500 mb-0.5">From</span>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="block">
              <span className="block text-xs text-gray-500 mb-0.5">To (optional)</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
            </label>
          </div>
          <div className="mt-3 flex gap-2 justify-end">
            <button onClick={() => { setOpen(false); setFrom(''); setTo(''); }}
              className="rounded px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100">
              Cancel
            </button>
            <button
              disabled={!from}
              onClick={async () => {
                await onConfirm(from, to || from);
                setOpen(false);
                setFrom(''); setTo('');
              }}
              className="rounded bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed">
              Delete shifts
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Import shifts from When I Work CSV ─────────────────────────────────
// Parses the WIW export format we already know:
//   col 2 = Employee Name, col 4 = date dd/mm/yyyy,
//   col 5 = Time In, col 6 = Time Out, col 8 = Duration (Hours)
// Preview lets the owner remap any unmatched employee name to a Ratio
// user (uses the radiusName alias same as payroll), then batch-imports.
function ImportFromWiwButton({ approvedUsers, onImport, onDeleteRange }) {
  const [open, setOpen] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [importing, setImporting] = useState(false);
  const [wipeFirst, setWipeFirst] = useState(false);
  const fileRef = useRef(null);

  // Tokenise + fuzzy compare (same logic as payroll matcher).
  const nameTokens = (raw) => String(raw || '').toLowerCase()
    .replace(/[.'`]/g, '').split(/[\s-]+/).filter(Boolean);
  const namesMatch = (a, b) => {
    const ta = nameTokens(a), tb = nameTokens(b);
    if (ta.length === 0 || tb.length === 0) return false;
    if (ta.length === 1 || tb.length === 1) return ta[0] === tb[0];
    return ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1];
  };
  const findUser = (wiwName) =>
    approvedUsers.find(u =>
      namesMatch(u.displayName, wiwName) ||
      (u.radiusName && namesMatch(u.radiusName, wiwName))
    );

  // dd/mm/yyyy OR yyyy-mm-dd → YYYY-MM-DD
  const isoDate = (d) => {
    const v = String(d || '').trim();
    let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    return null;
  };
  // "3:26 PM" / "10:30 am" / "15:30" → "15:26"
  const toHHMM = (t) => {
    const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?$/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const mm = m[2];
    const ampm = (m[3] || '').toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2,'0')}:${mm}`;
  };
  // Hours between two HH:MM strings (positive even if end < start by 1 min
  // due to rounding — we cap at 24).
  const hoursBetween = (start, end) => {
    if (!start || !end) return 0;
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const mins = (eh * 60 + em) - (sh * 60 + sm);
    return Math.max(0, Math.min(24, mins / 60));
  };
  // Map WIW position → Ratio role/subRole.
  const positionToRoleSub = (pos) => {
    const p = String(pos || '').toLowerCase();
    if (p.includes('high school')) return { role: 'Instructor', subRole: 'Highschool' };
    if (p.includes('elementary'))  return { role: 'Instructor', subRole: 'Elementary' };
    if (p.includes('@home') || p.includes('m@home') || p.includes('online'))
                                   return { role: 'Instructor', subRole: 'Online' };
    // Imported 'training' rows now keep their own role rather than being
    // flattened into Instructor — otherwise they'd silently count toward
    // coverage the moment they were pasted in.
    if (p.includes('training'))    return { role: 'Training', subRole: 'Elementary' };
    if (p.includes('lead'))        return { role: 'Lead Instructor', subRole: 'Highschool' };
    if (p.includes('admin'))       return { role: 'Host',  subRole: 'Elementary' };
    if (p.includes('manager') || p.includes('director'))
                                   return { role: 'Host',  subRole: 'Elementary' };
    if (p.includes('sick'))        return { role: 'Instructor', subRole: 'Elementary', sickPay: true };
    return { role: 'Instructor', subRole: 'Elementary' };
  };

  // Find column indexes by header label so we don't rely on fixed offsets
  // — WIW changes column order between Payroll and Schedule exports.
  const indexOfHeader = (headerRow, ...candidates) => {
    const lc = headerRow.map(h => String(h || '').trim().toLowerCase());
    for (const c of candidates) {
      const i = lc.indexOf(c.toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  };

  const handleFile = async (file) => {
    if (!file) return;
    // Accept both CSV and XLSX. WIW's native export is .xlsx with multiple
    // sheets; the Schedule export's per-shift rows live on the
    // "Schedules Summary" sheet. We pick that sheet by name when present,
    // otherwise fall back to the first sheet (which covers the legacy
    // Payroll CSV format).
    let rows;
    const isXlsx = /\.xlsx?$/i.test(file.name) ||
      file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.type === 'application/vnd.ms-excel';
    if (isXlsx) {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      // Prefer "Schedules Summary" or anything that contains "schedule";
      // otherwise first sheet.
      const preferred = wb.SheetNames.find(n => /schedules?\s*summary/i.test(n))
        || wb.SheetNames.find(n => /schedule/i.test(n))
        || wb.SheetNames[0];
      const sheet = wb.Sheets[preferred];
      rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    } else {
      const text = await file.text();
      rows = text.split(/\r?\n/).map(line => line.split(','));
    }

    // Find the header row — the first row that contains a recognisable
    // shift-date label. Then look up the columns we need by name.
    let headerIdx = -1, header = null;
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const cells = rows[i].map(c => String(c || '').toLowerCase());
      if (cells.some(c => /shift start date|date/.test(c)) &&
          cells.some(c => /first name|employee name/.test(c) || c === 'name') ) {
        headerIdx = i; header = rows[i]; break;
      }
    }
    if (headerIdx < 0) {
      // Legacy Payroll CSV had no recognisable header on row 1 — fall back
      // to the original fixed-column path (col 2 name, col 4 dd/mm/yyyy,
      // col 5 in, col 6 out).
      const entries = parseLegacyFixedCols(rows);
      setParsed(entries);
      return;
    }

    const colDate    = indexOfHeader(header, 'Shift Start Date', 'Date');
    const colStart   = indexOfHeader(header, 'Shift Start Time', 'Time In', 'Start');
    const colEnd     = indexOfHeader(header, 'Shift End Time',   'Time Out', 'End');
    const colFirst   = indexOfHeader(header, 'First Name');
    const colLast    = indexOfHeader(header, 'Last Name');
    const colName    = indexOfHeader(header, 'Employee Name', 'Name');
    const colPos     = indexOfHeader(header, 'Position', 'Role');
    const colBreak   = indexOfHeader(header, 'Unpaid Break');

    const entries = [];
    const nameToUid = new Map();
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const date = isoDate(r[colDate]);
      if (!date) continue;
      // Build name from either First + Last or single Name column.
      const name = colFirst >= 0 && colLast >= 0
        ? `${(r[colFirst] || '').trim()} ${(r[colLast] || '').trim()}`.trim()
        : (r[colName] || '').trim();
      if (!name) continue;
      const startTime = toHHMM(r[colStart]);
      const endTime   = toHHMM(r[colEnd]);
      if (!startTime || !endTime) continue;
      const breakMin = colBreak >= 0 ? (parseFloat(r[colBreak]) || 0) : 0;
      const hours = Math.max(0, hoursBetween(startTime, endTime) - breakMin / 60);
      const rs = positionToRoleSub(r[colPos]);

      if (!nameToUid.has(name)) {
        const u = findUser(name);
        nameToUid.set(name, u ? u.uid : '');
      }
      const uid = nameToUid.get(name);
      const user = uid ? approvedUsers.find(u => u.uid === uid) : null;
      entries.push({
        wiwName: name,
        userId: uid,
        userName: user?.displayName || name,
        role:    user?.instructorType || rs.role,
        subRole: rs.subRole,
        sickPay: !!rs.sickPay,
        date, startTime, endTime,
        hours: Math.round(hours * 100) / 100,
      });
    }
    setParsed({ entries, nameToUid });
  };

  // Old Payroll CSV path — col 2 = name, col 4 = dd/mm/yyyy, col 5 = in,
  // col 6 = out, col 8 = hours. Kept so the old format still works.
  const parseLegacyFixedCols = (rows) => {
    const entries = [];
    const nameToUid = new Map();
    for (const row of rows) {
      if (row.length < 9) continue;
      const date = isoDate((row[4] || '').trim());
      if (!date) continue;
      const name = (row[2] || '').trim();
      if (!name) continue;
      const startTime = toHHMM(row[5]);
      const endTime   = toHHMM(row[6]);
      if (!startTime || !endTime) continue;
      const hours = parseFloat(row[8]);
      if (!nameToUid.has(name)) {
        const u = findUser(name);
        nameToUid.set(name, u ? u.uid : '');
      }
      const uid = nameToUid.get(name);
      const user = uid ? approvedUsers.find(u => u.uid === uid) : null;
      entries.push({
        wiwName: name,
        userId: uid,
        userName: user?.displayName || name,
        role:    user?.instructorType || 'Instructor',
        subRole: (user?.subRoles || []).includes('Online') ? 'Online'
              : (user?.subRoles || []).includes('Highschool') ? 'Highschool'
              : 'Elementary',
        date, startTime, endTime,
        hours: isNaN(hours) ? 0 : hours,
      });
    }
    return { entries, nameToUid };
  };

  // Remap one of the wiwName → uid choices and re-resolve all rows.
  const remap = (wiwName, uid) => {
    const next = new Map(parsed.nameToUid);
    next.set(wiwName, uid);
    const user = uid ? approvedUsers.find(u => u.uid === uid) : null;
    const entries = parsed.entries.map(e => e.wiwName === wiwName ? ({
      ...e,
      userId: uid,
      userName: user?.displayName || wiwName,
      role: user?.instructorType || e.role,
      subRole: (user?.subRoles || []).includes('Online') ? 'Online'
            : (user?.subRoles || []).includes('Highschool') ? 'Highschool'
            : 'Elementary',
    }) : e);
    setParsed({ entries, nameToUid: next });
  };

  // Per-name summary for the preview list.
  const summary = parsed
    ? [...new Set(parsed.entries.map(e => e.wiwName))].map(n => {
        const rows = parsed.entries.filter(e => e.wiwName === n);
        const totalHrs = rows.reduce((s, r) => s + (r.hours || 0), 0);
        const uid = parsed.nameToUid.get(n);
        return { wiwName: n, uid, rowCount: rows.length, totalHrs, dates: rows.map(r => r.date) };
      })
    : [];

  const minDate = parsed ? summary.flatMap(s => s.dates).sort()[0] : null;
  const maxDate = parsed ? summary.flatMap(s => s.dates).sort().pop() : null;

  const doImport = async () => {
    if (!parsed) return;
    setImporting(true);
    try {
      if (wipeFirst && minDate && maxDate) {
        await onDeleteRange(minDate, maxDate);
      }
      await onImport(parsed.entries);
      setOpen(false);
      setParsed(null);
      setWipeFirst(false);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 transition-colors"
        title="Import shifts from a When I Work CSV export">
        <Upload size={14} /> Import from WIW
      </button>
      {open && (
        <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4" onClick={() => !importing && setOpen(false)}>
          <div className="relative w-full max-w-3xl rounded-xl bg-white shadow-2xl flex flex-col max-h-[85vh]" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b flex items-center justify-between">
              <div>
                <h3 className="font-bold text-gray-900">Import shifts from When I Work</h3>
                <p className="text-xs text-gray-500">
                  Drop your WIW CSV export — works with any date range. Each row becomes a shift in Ratio.
                </p>
              </div>
              <button onClick={() => !importing && setOpen(false)} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {!parsed && (
                <div>
                  <button onClick={() => fileRef.current?.click()}
                    className="w-full rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 py-12 text-center hover:bg-gray-100 transition-colors">
                    <Upload className="mx-auto text-gray-400 mb-2" size={32} />
                    <div className="text-sm font-semibold text-gray-700">Click to upload WIW payroll export</div>
                    <div className="text-xs text-gray-500 mt-1">Accepts .xlsx (native WIW export) and .csv</div>
                  </button>
                  <input ref={fileRef} type="file"
                    accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                    className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
                </div>
              )}

              {parsed && (
                <div className="space-y-4">
                  <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-sm text-blue-900">
                    Parsed <b>{parsed.entries.length}</b> shifts across <b>{summary.length}</b> employees
                    {minDate && maxDate && <> from <b>{minDate}</b> to <b>{maxDate}</b></>}.
                  </div>
                  <div>
                    <h4 className="font-semibold text-sm text-gray-900 mb-2">Employee matching</h4>
                    <div className="rounded-lg border border-gray-200 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-xs text-gray-500">
                          <tr>
                            <th className="px-3 py-2 text-left">WIW name</th>
                            <th className="px-3 py-2 text-left">Maps to Ratio user</th>
                            <th className="px-3 py-2 text-right">Shifts</th>
                            <th className="px-3 py-2 text-right">Hours</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.map(s => (
                            <tr key={s.wiwName} className={`border-t border-gray-100 ${s.uid ? '' : 'bg-amber-50'}`}>
                              <td className="px-3 py-2 font-medium text-gray-900">{s.wiwName}</td>
                              <td className="px-3 py-2">
                                <select value={s.uid || ''} onChange={e => remap(s.wiwName, e.target.value)}
                                  className={`w-full rounded border px-2 py-1 text-xs ${s.uid ? 'border-gray-300' : 'border-amber-300 bg-white'}`}>
                                  <option value="">— skip this person —</option>
                                  {approvedUsers.map(u => (
                                    <option key={u.uid} value={u.uid}>{u.displayName}</option>
                                  ))}
                                </select>
                              </td>
                              <td className="px-3 py-2 text-right text-gray-700">{s.rowCount}</td>
                              <td className="px-3 py-2 text-right text-gray-700">{s.totalHrs.toFixed(2)}h</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {summary.some(s => !s.uid) && (
                      <p className="mt-2 text-xs text-amber-700">
                        Rows in amber will be SKIPPED on import. Map them to a Ratio user above or accept the skip.
                      </p>
                    )}
                  </div>
                  <label className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 cursor-pointer">
                    <input type="checkbox" checked={wipeFirst} onChange={e => setWipeFirst(e.target.checked)}
                      className="mt-0.5" />
                    <span className="text-sm">
                      <b className="text-red-800">Delete existing shifts from {minDate} to {maxDate} first</b>
                      <span className="block text-xs text-red-700 mt-0.5">
                        Use this when migrating from WIW so the imported numbers are clean.
                        Existing Ratio shifts in that range will be permanently removed.
                      </span>
                    </span>
                  </label>
                </div>
              )}
            </div>

            {parsed && (
              <div className="border-t bg-gray-50 px-6 py-3 flex items-center justify-between">
                <button onClick={() => setParsed(null)} disabled={importing}
                  className="text-sm text-gray-600 hover:text-gray-900">
                  ← Upload a different file
                </button>
                <button onClick={doImport} disabled={importing}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:bg-gray-300">
                  {importing ? 'Importing…' : `Import ${parsed.entries.filter(e => e.userId).length} shifts`}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sick Days roster (year-to-date) ────────────────────────────────────
// Per-employee tally of sick days used vs remaining for the current
// calendar year, with probation status. Policy: 5 sick days per year,
// available once the 3-month probation is over. "Used" counts distinct
// calendar dates where a sickPay-tagged shift exists for that person.
function SickDaysTab({ rows, year, maxPerYear, probationDays, onSetHireDate, onAddExternalSickDate, onRemoveExternalSickDate }) {
  const [query, setQuery] = useState('');
  const filtered = query
    ? rows.filter(r => r.name.toLowerCase().includes(query.toLowerCase()))
    : rows;

  // Roll-up tallies for the header summary.
  const eligibleCount = rows.filter(r => r.eligible).length;
  const onProbationCount = rows.length - eligibleCount;
  const totalUsed = rows.reduce((s, r) => s + r.used, 0);
  const totalRemaining = rows.reduce((s, r) => s + r.remaining, 0);

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b bg-amber-50/40">
        <div className="flex flex-wrap items-center gap-3">
          <Activity size={18} className="text-amber-700 shrink-0" />
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900">
              Sick Days · {year}
            </h3>
            <p className="text-xs text-gray-600">
              Policy: {maxPerYear} paid sick days per calendar year, available after the {probationDays}-day probation period (BC ESA minimum).
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full bg-emerald-100 text-emerald-800 px-2 py-1 font-semibold">{eligibleCount} eligible</span>
            <span className="rounded-full bg-gray-100 text-gray-700 px-2 py-1 font-semibold">{onProbationCount} on probation</span>
            <span className="rounded-full bg-amber-100 text-amber-800 px-2 py-1 font-semibold">{totalUsed} used</span>
            <span className="rounded-full bg-blue-100 text-blue-800 px-2 py-1 font-semibold">{totalRemaining} remaining</span>
          </div>
        </div>
        <div className="mt-3 relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text" value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search staff…"
            className="w-full rounded-md border border-gray-300 pl-8 pr-3 py-1.5 text-sm" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2 text-left">Staff</th>
              <th className="px-4 py-2 text-left">Role</th>
              <th className="px-4 py-2 text-left">Hire date</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-center">Used</th>
              <th className="px-4 py-2 text-center">Remaining</th>
              <th className="px-4 py-2 text-left">Sick dates this year</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.uid} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-2 font-medium text-gray-900">{r.name}</td>
                <td className="px-4 py-2 text-xs text-gray-600">{r.role}</td>
                <td className="px-4 py-2">
                  <input type="date" defaultValue={r.hireDate || ''}
                    onBlur={e => onSetHireDate(r.uid, e.target.value)}
                    className="rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-700" />
                  {r.hireDate && (
                    <div className="text-[10px] text-gray-400 mt-0.5">{r.daysIn} day{r.daysIn === 1 ? '' : 's'} in</div>
                  )}
                </td>
                <td className="px-4 py-2">
                  {r.onProbation
                    ? <span className="rounded-full bg-gray-100 text-gray-700 px-2 py-0.5 text-xs font-semibold">On probation</span>
                    : <span className="rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-xs font-semibold">Eligible</span>}
                </td>
                <td className={`px-4 py-2 text-center font-bold ${r.used > 0 ? 'text-amber-700' : 'text-gray-400'}`}>
                  {r.used}
                </td>
                <td className={`px-4 py-2 text-center font-bold ${r.remaining === 0 && r.eligible ? 'text-red-600' : 'text-blue-700'}`}>
                  {r.eligible ? r.remaining : '—'}
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">
                  {r.sickDates.length === 0 && r.externalSickDates.length === 0
                    ? <span className="text-gray-300">— none —</span>
                    : (
                      <>
                        {r.sickDates.map(d => (
                          <span key={d} className="inline-block rounded bg-amber-50 border border-amber-200 px-1.5 py-0.5 mr-1 mb-1">{d}</span>
                        ))}
                        {/* Days taken outside Ratio — no shift exists for them,
                            so nothing else can know they happened. They still
                            consume the annual entitlement. */}
                        {r.externalSickDates.map(d => (
                          <span key={d} className="inline-flex items-center gap-1 rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 mr-1 mb-1">
                            {d}
                            <span className="text-[9px] uppercase tracking-wide text-gray-500">off-system</span>
                            <button
                              onClick={() => onRemoveExternalSickDate(r.uid, d)}
                              title="Remove this day"
                              className="text-gray-400 hover:text-red-600"
                            >×</button>
                          </span>
                        ))}
                      </>
                    )}
                  <div className="mt-1">
                    <input
                      type="date"
                      value=""
                      onChange={e => e.target.value && onAddExternalSickDate(r.uid, e.target.value)}
                      title="Record a sick day taken outside Ratio — it still uses up their entitlement."
                      className="rounded border border-dashed border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-500"
                    />
                    <span className="ml-1 text-[10px] text-gray-400">+ day taken outside Ratio</span>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500 text-sm">
                {query ? `No staff match "${query}".` : 'No active staff at this centre yet.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="px-5 py-3 text-[11px] text-gray-500 border-t bg-gray-50/50">
        Tip: a shift becomes "sick" when you toggle the Sick Pay flag while editing it. Sick shifts are paid out under the sick budget line and don't count toward regular payroll hours.
      </p>
    </div>
  );
}

// Stat Pay roster — same shape as SickDaysTab, but for statutory-holiday
// eligibility in the current pay period. One row per staffer: shifts in the
// qualifying window, stat hours they'd be paid, and whether they qualify.
function StatPayTab({ holidays, rows }) {
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [minShifts, setMinShifts] = useState(0);
  // Which staff have their day-by-day working open. Keyed by name; several
  // can be open at once so two people's windows can be compared side by side.
  const [expanded, setExpanded] = useState(() => new Set());
  const toggleExpanded = (name) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const roles = [...new Set(rows.map(r => r.role).filter(Boolean))].sort();
  const filtered = rows.filter(r => {
    if (query && !r.name.toLowerCase().includes(query.toLowerCase())) return false;
    if (roleFilter !== 'all' && r.role !== roleFilter) return false;
    if (minShifts > 0 && (r.shifts ?? 0) < minShifts) return false;
    return true;
  });

  // Totals reflect the current filter — narrowing to a role shows that role's
  // stat total; with no filters it's the whole period.
  const shownEligible = filtered.filter(r => r.qualifies).length;
  const shownTotal = Math.round(filtered.reduce((s, r) => s + (r.qualifies ? r.totalStat : 0), 0) * 100) / 100;
  const multi = holidays.length > 1;
  // Spell out the qualifying window rather than making people count back 30
  // days by hand. It runs from 30 days before the holiday up to the day
  // before it — the holiday itself is never part of its own window.
  const shortDate = (iso) => new Date(iso + 'T00:00:00')
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const subtitle = holidays.length === 0
    ? 'No statutory holiday falls in this pay period.'
    : holidays.map(h => `${h.name || 'Holiday'} · ${h.date} (window: ${shortDate(minusDays(h.date, 30))} – ${shortDate(minusDays(h.date, 1))})`).join('   ·   ');

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b bg-purple-50/40">
        <div className="flex flex-wrap items-center gap-3">
          <Activity size={18} className="text-purple-700 shrink-0" />
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900">Stat Pay</h3>
            <p className="text-xs text-gray-600">
              {subtitle} — qualify at 15+ <b>days worked</b> in the 30 days before the holiday. Stat hours = an average day's pay: total hours ÷ days worked (BC ESA). Two shifts in one day count as one day. <b>Paid sick days count</b> toward the 15 — the Act says "worked or earned wages" — and rows that include them are broken out below.
            </p>
          </div>
        </div>
        <div className="mt-3 relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text" value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search staff…"
            className="w-full rounded-md border border-gray-300 pl-8 pr-3 py-1.5 text-sm" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            {/* Totals + filters, each cell aligned directly over its column:
                total hrs over "Stat hrs eligible", eligible count over
                "Status", the role filter over "Role", the shift filter over
                "Shifts in window". */}
            <tr className="border-b border-gray-200">
              <th className="px-4 py-2 text-left align-middle normal-case">
                <span className="text-sm font-bold text-gray-900">Total Stat Pay</span>
              </th>
              <th className="px-4 py-2 text-left align-middle normal-case font-normal">
                <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)}
                  className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700">
                  <option value="all">All roles</option>
                  {roles.map(role => <option key={role} value={role}>{role}</option>)}
                </select>
              </th>
              <th className="px-4 py-2 text-center align-middle normal-case font-normal">
                <select value={minShifts} onChange={e => setMinShifts(Number(e.target.value))}
                  className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700">
                  <option value={0}>Any</option>
                  <option value={15}>15+ (eligible)</option>
                  <option value={10}>10+</option>
                  <option value={5}>5+</option>
                  <option value={1}>1+</option>
                </select>
              </th>
              <th className="px-4 py-2 text-center align-middle normal-case">
                <span className="rounded-full bg-purple-100 text-purple-800 px-2 py-1 text-xs font-semibold">{shownTotal.toFixed(2)}h total</span>
              </th>
              <th className="px-4 py-2 text-left align-middle normal-case">
                <span className="rounded-full bg-emerald-100 text-emerald-800 px-2 py-1 text-xs font-semibold">{shownEligible} eligible</span>
              </th>
              {multi && <th className="px-4 py-2" />}
            </tr>
            <tr>
              <th className="px-4 py-2 text-left">Staff</th>
              <th className="px-4 py-2 text-left">Role</th>
              <th className="px-4 py-2 text-center">Days worked in window</th>
              <th className="px-4 py-2 text-center">Stat hrs eligible</th>
              <th className="px-4 py-2 text-left">Status</th>
              {multi && <th className="px-4 py-2 text-left">Holidays</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => {
              const shifts = r.shifts ?? 0;
              const isOpen = expanded.has(r.name);
              return (
                <Fragment key={r.name}>
                <tr className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium text-gray-900">{r.name}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">{r.role}</td>
                  {/* Paid sick days count toward the 15 under the BC ESA
                      ("worked OR earned wages"), so a roster number can look
                      inflated with no visible reason. Show the split whenever
                      sick days are part of it, and let the whole cell expand
                      into the day-by-day working behind the number. */}
                  <td className="px-4 py-2 text-center">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(r.name)}
                      aria-expanded={isOpen}
                      title="Show every qualifying day and the average-day maths"
                      className={`group inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-bold transition-colors hover:bg-purple-50 ${
                        r.qualifies ? 'text-emerald-700' : 'text-gray-400'
                      }`}>
                      <ChevronRight
                        size={13}
                        className={`shrink-0 text-gray-400 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      />
                      <span>
                        {shifts}<span className="text-[10px] font-normal text-gray-400"> / 15</span>
                        {(r.sickDays || 0) > 0 && (
                          <span className="block text-[10px] font-normal text-gray-500">
                            {shifts - r.sickDays} worked + {r.sickDays} sick
                          </span>
                        )}
                      </span>
                    </button>
                  </td>
                  <td className={`px-4 py-2 text-center font-bold ${r.qualifies ? 'text-purple-700' : 'text-gray-300'}`}>
                    {r.qualifies ? `${r.totalStat.toFixed(2)}h` : '—'}
                  </td>
                  <td className="px-4 py-2">
                    {r.qualifies
                      ? <span className="rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-xs font-semibold">Eligible</span>
                      : <span className="rounded-full bg-gray-100 text-gray-700 px-2 py-0.5 text-xs font-semibold">Not eligible</span>}
                  </td>
                  {multi && (
                    <td className="px-4 py-2 text-xs text-gray-600">
                      {r.perHoliday.some(h => h.qualifies)
                        ? r.perHoliday.filter(h => h.qualifies).map(h => (
                            <span key={h.holiday.date} className="inline-block rounded bg-purple-50 border border-purple-200 px-1.5 py-0.5 mr-1 mb-1">
                              {(h.holiday.name || 'Holiday')}: {h.statHours.toFixed(2)}h
                            </span>
                          ))
                        : <span className="text-gray-300">— none —</span>}
                    </td>
                  )}
                </tr>
                {/* Day-by-day working. Everything here is already computed by
                    statPayForHoliday — showing it just saves exporting a
                    spreadsheet to answer "why is this number what it is?". */}
                {isOpen && (
                  <tr className="border-t border-gray-100 bg-gray-50/70">
                    <td colSpan={multi ? 6 : 5} className="px-4 py-3">
                      {r.perHoliday.length === 0 && (
                        <p className="text-xs text-gray-500">No qualifying window for this person.</p>
                      )}
                      {r.perHoliday.map(h => {
                        const days = h.days || [];
                        const lastDay = minusDays(h.holiday.date, 1);
                        return (
                          <div key={h.holiday.date} className="mb-3 last:mb-0">
                            <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                              <span className="text-xs font-semibold text-gray-800">
                                {h.holiday.name || 'Holiday'} · {h.holiday.date}
                              </span>
                              <span className="text-[11px] text-gray-500">
                                window {shortDate(h.windowStart || minusDays(h.holiday.date, 30))} – {shortDate(lastDay)}
                              </span>
                            </div>
                            {/* The arithmetic, spelled out. */}
                            <div className="mb-2 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs">
                              {h.qualifies ? (
                                <span className="text-gray-700">
                                  <b>{(h.totalHours ?? 0).toFixed(2)}h</b> paid over <b>{h.count}</b> qualifying day{h.count !== 1 ? 's' : ''}
                                  {' '}÷ {h.count} = <b className="text-purple-700">{h.statHours.toFixed(2)}h</b> average day's pay
                                  {(h.sickDays || 0) > 0 && (
                                    <span className="text-gray-500"> · includes {h.sickDays} paid sick day{h.sickDays !== 1 ? 's' : ''}</span>
                                  )}
                                </span>
                              ) : (
                                <span className="text-gray-600">
                                  <b>{h.count}</b> qualifying day{h.count !== 1 ? 's' : ''} — needs 15.
                                  {' '}<span className="text-gray-500">
                                    {15 - h.count} more day{15 - h.count !== 1 ? 's' : ''} in the window would qualify. No stat pay.
                                  </span>
                                </span>
                              )}
                            </div>
                            {days.length === 0 ? (
                              <p className="text-[11px] text-gray-500">No wage-earning days in this window.</p>
                            ) : (
                              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-5">
                                {days.map(d => (
                                  <div key={d.date}
                                    className={`flex items-center justify-between rounded border px-2 py-1 text-[11px] ${
                                      d.sick
                                        ? 'border-amber-200 bg-amber-50 text-amber-800'
                                        : 'border-gray-200 bg-white text-gray-700'
                                    }`}>
                                    <span>{shortDate(d.date)}{d.sick && <span className="ml-1 font-semibold">sick</span>}</span>
                                    <span className="font-semibold">{d.hours.toFixed(2)}h</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            <p className="mt-1.5 text-[10px] text-gray-400">
                              Hours shown are what we pay — the Payroll h override where one is set, otherwise the
                              scheduled length. Drafts, no-shows and volunteer shifts are excluded.
                            </p>
                          </div>
                        );
                      })}
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={multi ? 6 : 5} className="px-4 py-8 text-center text-gray-500 text-sm">
                {rows.length === 0 ? 'No statutory holiday in this pay period.' : 'No staff match the current filters.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="px-5 py-3 text-[11px] text-gray-500 border-t bg-gray-50/50">
        Stat hours are paid on top of worked hours. Click any <b>days worked</b> figure to expand the day-by-day working behind it. The same breakdown is in the "Stat Pay" sheet of the payroll export.
      </p>
    </div>
  );
}

// ── Main Admin Component ───────────────────────────────────────────────────────
export default function Admin() {
  const { user, activeCenterId, centerConfig, canSeeCenterSettings, canManageOperations } = useAuth();
  // The centre's staffing day model. Manage Staff Schedule's day headers
  // used to divide by a HARDCODED constant while the Staffing Budget page
  // edited a completely separate per-period number — so editing the budget
  // changed one page and not the other, and the two had drifted to 538h vs
  // 688h for the same fortnight. Both now read this.
  const weekdayModel = useMemo(() => resolveWeekdayModel(centerConfig), [centerConfig]);
  const [users, setUsers]               = useState([]);
  const [availability, setAvailability] = useState([]);
  const [shifts, setShifts]             = useState([]);
  const [openShiftsList, setOpenShiftsList] = useState([]);
  const [timeOffRequests, setTimeOffRequests] = useState([]);
  // One index for every (person, day) covered by a live time-off
  // request, so the weekly grid doesn't re-scan the array in each of
  // its ~200 cells. Declared beside the state rather than further down
  // the component: everything below consumes it, and anything after
  // the canManageOperations early return would be a conditional hook.
  const timeOffIndex = useMemo(() => buildTimeOffIndex(timeOffRequests), [timeOffRequests]);
  // Active tab. Sidebar deep-links (?tab=analytics, ?tab=settings) seed the
  // initial state and re-sync if the URL changes — so clicking "Center
  // Analytics" in the super-admin sidebar opens the right tab.
  const [searchParams, setSearchParams] = useSearchParams();
  // Managers and Hosts get in via ProtectedRoute's allowOps with full
  // admin-panel access (same as plain Admin) — no tab restriction needed.
  const [tab, setTab] = useState(searchParams.get('tab') || 'spreadsheet');
  // Manage Staff has two halves: the per-PERSON editor (who is what) and
  // the per-ROLE editor (what a role can do). They were on different pages
  // — the second lived at /manage-roles under Centre — which meant setting
  // someone up took two screens in two places. Same tab now.
  const [usersSubtab, setUsersSubtab] = useState('staff');
  const [terminateUser, setTerminateUser] = useState(null);
  useEffect(() => {
    const t = searchParams.get('tab');
    if (t && t !== tab) setTab(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  // Keep the URL in sync when the user clicks a tab so refreshing or sharing
  // the URL lands you back where you were.
  const selectTab = (key) => {
    setTab(key);
    const next = new URLSearchParams(searchParams);
    if (key === 'spreadsheet') next.delete('tab');
    else next.set('tab', key);
    setSearchParams(next, { replace: true });
  };

  // Spreadsheet state
  const [weekStart, setWeekStart]       = useState(startOfWeek(new Date()));

  // Modals
  const [addShiftModal, setAddShiftModal]       = useState(null); // { date, user }
  const [editShiftModal, setEditShiftModal]     = useState(null); // shift object
  const [addOpenShiftModal, setAddOpenShiftModal] = useState(null); // { date }
  const [availabilityModalUser, setAvailabilityModalUser] = useState(null); // user object
  const [addStaffOpen, setAddStaffOpen]     = useState(false);
  const [editStaffUser, setEditStaffUser]   = useState(null);
  const [userSearch, setUserSearch]         = useState('');

  // Auto-scheduler state
  // Range type: 'week' (Mon–Sat of the picked date) or 'day'. Month-at-a-time
  // was removed — the centre doesn't plan that far out any more, and a month
  // of demand-driven staffing is stale long before it's worked. The engine
  // still accepts month+year for back-compat; nothing here passes it.
  const [schedRangeType, setSchedRangeType] = useState('week');
  const [schedDayDate,   setSchedDayDate]   = useState(format(new Date(), 'yyyy-MM-dd'));
  // Default week-anchor is the current week's Monday.
  const [schedWeekDate,  setSchedWeekDate]  = useState(
    format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd')
  );
  // The picked range as concrete dates. Everything downstream — the generator,
  // and pulling real bookings to size each day — works in actual dates.
  const schedRangeDates = useMemo(() => {
    if (schedRangeType === 'day') {
      return { start: schedDayDate, end: schedDayDate };
    }
    const wkStart = new Date(schedWeekDate + 'T00:00:00');
    return {
      start: format(wkStart, 'yyyy-MM-dd'),
      end:   format(addDays(wkStart, 6), 'yyyy-MM-dd'),
    };
  }, [schedRangeType, schedDayDate, schedWeekDate]);
  // Per-date demand curves from the last "Staff from bookings" run. Held here
  // (rather than only inside the staffing matrix) because generateSchedule's
  // post-pass needs them to stagger shifts around the rush.
  const [bookingDemand, setBookingDemand] = useState(null);
  // Peak students booked on a date, or null when that date wasn't sized from
  // bookings. Used to label the draft roster with the demand behind it.
  const bookingDemandPeak = (date) => bookingDemand?.[date]?.peakStudents ?? null;
  const [draftSchedule, setDraftSchedule] = useState(null);
  const [generating, setGenerating]   = useState(false);
  const [posting, setPosting]         = useState(false);
  const [schedConfig, setSchedConfig] = useState({
    minPerDay: 8, maxPerDay: 11, maxDaysPerWeek: 5, fairDistribution: true,
  });
  // 'classic'  — the original engine: pick N people per day, times come
  //              from their availability.
  // 'coverage' — demand curve → shift shapes → people. Opt-in, so the
  //              live path is unchanged until an owner chooses it.
  const [editingDay, setEditingDay]   = useState(null);
  const [schedError, setSchedError]   = useState('');
  // Day-centric draft review — which day index is focused in the week strip.
  const [selectedDayIndex, setSelectedDayIndex] = useState(0);
  // Set of day-indexes that have their CoverageGrid expanded.
  const [expandedDays, setExpandedDays] = useState(new Set());

  const toggleDayExpanded = (i) => {
    setExpandedDays(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  // Payroll state
  const today = new Date();
  const defaultPeriod = today.getDate() >= 11 && today.getDate() <= 25
    ? { start: `${format(today, 'yyyy-MM')}-11`, end: `${format(today, 'yyyy-MM')}-25` }
    : today.getDate() > 25
      ? { start: `${format(today, 'yyyy-MM')}-26`, end: format(new Date(today.getFullYear(), today.getMonth() + 1, 10), 'yyyy-MM-dd') }
      : { start: format(new Date(today.getFullYear(), today.getMonth() - 1, 26), 'yyyy-MM-dd'), end: `${format(new Date(today.getFullYear(), today.getMonth(), 10), 'yyyy-MM')}-10` };
  const [payStart, setPayStart] = useState(defaultPeriod.start);
  const [payEnd,   setPayEnd]   = useState(defaultPeriod.end);
  const [radiusData, setRadiusData] = useState([]); // parsed Radius timesheet rows
  const [radiusFileName, setRadiusFileName] = useState('');
  // Whether the Radius import card is expanded. Defaults false so the
  // card auto-collapses to a 1-line chip once a timesheet is loaded,
  // freeing vertical space for the per-person reconciliation below.
  // Owner clicks Re-import on the chip to expand again.
  const [radiusExpanded, setRadiusExpanded] = useState(false);
  const [radiusError, setRadiusError] = useState('');

  // Firestore subscriptions — all scoped to the active center.
  // Users use array-contains on centerIds (since some staff work at multiple
  // centers); everything else filters on the single centerId field.
  useEffect(() => {
    // Sliding date window for shifts / availability / openShifts so live
    // reads don't scale with centre-age. 180 days back covers payroll
    // history, weekly grid navigation, and auto-scheduler look-back; older
    // docs still exist in Firestore for ad-hoc queries.
    const WINDOW_DAYS = 180;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);
    const y = cutoff.getFullYear();
    const m = String(cutoff.getMonth() + 1).padStart(2, '0');
    const d = String(cutoff.getDate()).padStart(2, '0');
    const windowStart = `${y}-${m}-${d}`;

    const u1 = onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', activeCenterId)),
      snap => setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    const u2 = onSnapshot(
      query(
        collection(db, 'availability'),
        where('centerId', '==', activeCenterId),
        where('date', '>=', windowStart),
        orderBy('date'),
      ),
      snap => setAvailability(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    const u3 = onSnapshot(
      query(
        collection(db, 'shifts'),
        where('centerId', '==', activeCenterId),
        where('date', '>=', windowStart),
        orderBy('date'),
      ),
      snap => setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    const u4 = onSnapshot(
      query(
        collection(db, 'openShifts'),
        where('centerId', '==', activeCenterId),
        where('date', '>=', windowStart),
        orderBy('date'),
      ),
      snap => setOpenShiftsList(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    // timeOffRequests stays unbounded — low volume per centre and no
    // single `date` field to filter on (range lives in startDate/endDate).
    const u5 = onSnapshot(
      query(collection(db, 'timeOffRequests'), where('centerId', '==', activeCenterId)),
      snap => setTimeOffRequests(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => {
        const ta = a.createdAt?.seconds ?? 0;
        const tb = b.createdAt?.seconds ?? 0;
        return tb - ta;
      }))
    );
    return () => { u1(); u2(); u3(); u4(); u5(); };
  }, [activeCenterId]);

  // Owners, super-admins, and any account flagged `internal: true` are
  // hidden from "actual working staff" surfaces (weekly grid, Manage Users,
  // payroll, etc.). The displayName === 'Admin Team' check is a legacy
  // fallback so the existing internal account stays hidden until someone
  // sets the flag on its user doc — once the flag is set the name match
  // becomes irrelevant.
  // Admin Assistants show up in the staff list — they get scheduled and
  // appear on payroll like anyone else. Owners and super-admins are
  // hidden from operational surfaces BY DEFAULT — with one exception:
  // if the owner is also listed as fixedStaff (e.g. Vinod as Center
  // Director) they still need to appear on the schedule grid so their
  // shifts render. Payroll exclusion is handled separately below.
  const fixedStaffNamesForVisibility = useMemo(
    () => new Set(Object.keys(centerConfig?.fixedStaff || {})),
    [centerConfig?.fixedStaff],
  );
  const isVisibleStaff = (u) => {
    if (!u) return false;
    if (u.internal === true) return false;
    if (u.displayName === 'Admin Team') return false;
    // Owner / super-admin are hidden from the schedule roster by
    // default. Director is owner-EQUIVALENT for permissions but still
    // needs to appear on the schedule (they run the floor). So
    // directors show unconditionally; owners / super-admins only
    // show when they're also listed as fixed staff (defensive
    // fallback in case someone promotes a working staffer to owner).
    if (u.role === 'director') return true;
    const hidden = u.role === 'owner' || u.role === 'super_admin';
    if (hidden) {
      return u.displayName && fixedStaffNamesForVisibility.has(u.displayName);
    }
    return true;
  };

  // Resolve every user against the active centre so per-centre fields
  // (instructorType, subRoles, guaranteed, approved, etc.)
  // hoist to the top level for this centre's view. Reads downstream
  // (`u.instructorType`, …) keep working unchanged but
  // now reflect the centre-scoped value instead of a global one.
  const usersForCentre = useMemo(
    () => users.map(u => resolveUserForCenter(u, activeCenterId)),
    [users, activeCenterId],
  );

  // Trainees at this centre: paid and scheduled, but never auto-assigned
  // and never counted as coverage. Derived here, beside usersForCentre,
  // so both the tally and the auto-scheduler read the same set.
  const trainingUserIds = useMemo(
    () => trainingIdsFor(usersForCentre, activeCenterId),
    [usersForCentre, activeCenterId],
  );

  const approvedUsers = usersForCentre
    .filter(u => u.approved && isVisibleStaff(u))
    .sort((a, b) => {
      const firstName = name => (name || '').split(' ')[0].toLowerCase();
      return firstName(a.displayName).localeCompare(firstName(b.displayName));
    });
  const pendingUsers  = usersForCentre.filter(u => !u.approved && isVisibleStaff(u));

  // User management
  //
  // Approval is per-centre — an admin at Centre A approving a user
  // does NOT auto-approve them at Centre B. We also seed a default
  // membership entry the first time we touch this centre's record so
  // every other field has a per-centre row to live in.
  const handleApprove = async (uid) => {
    const target = users.find(u => u.uid === uid || u.id === uid);
    const existing = target?.centerMemberships?.[activeCenterId];
    const payload = existing
      ? { [membershipFieldPath(activeCenterId, 'approved')]: true }
      : {
          [`centerMemberships.${activeCenterId}`]: {
            ...buildInitialMembership({
              instructorType: target?.instructorType,
              maxDaysPerWeek: target?.maxDaysPerWeek,
              subRoles:       target?.subRoles,
              guaranteed:     target?.guaranteed,
              approved:       true,
              isVolunteer:    target?.isVolunteer,
            }),
          },
        };
    // Keep legacy top-level `approved` in sync the FIRST time a user
    // gets approved anywhere — so any code that still reads the top
    // level (or queries for approved:true) keeps working. After that
    // we leave it alone — per-centre is the source of truth.
    if (target && target.approved !== true) payload.approved = true;
    await updateDoc(doc(db, 'users', uid), payload);
  };

  // Reject = disable the Firebase Auth account AND delete the Firestore
  // profile. We can't do the Auth half from the client (the client SDK can
  // only touch the *current* user), so this routes through the server-side
  // endpoint at /api/users/reject-user, which uses the Admin SDK.
  //
  // Without the server route, a "rejected" user could still authenticate
  // and just bounce on the pending screen — their credential would linger
  // on the platform indefinitely. The endpoint fully removes them.
  // POST /api/users/create-staff — admin SDK creates the Auth account +
  // Firestore profile in one round trip so the owner doesn't have to
  // wait for the new hire to sign up. Optionally fires a password-reset
  // email so the new user can set their own password immediately.
  const handleCreateStaff = async (payload) => {
    const idToken = await auth.currentUser?.getIdToken();
    const r = await fetch('/api/users/create-staff', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        ...payload,
        centerId: activeCenterId,
        continueUrl: window.location.origin + '/login',
      }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data?.error || `Request failed (${r.status})`);
    }
    const data = await r.json();
    setAddStaffOpen(false);
    if (data.resetEmailSent) {
      toast.success(`Created ${data.displayName}. Reset email sent to ${data.email}.`);
    } else if (data.resetEmailError) {
      toast.error(`Created ${data.displayName}, but reset email failed: ${data.resetEmailError}`, 8000);
    } else {
      toast.success(`Created ${data.displayName}.`);
    }
  };

  // Fire a password reset email to an existing staff member from the
  // staff card. Uses the same /api/send-password-reset endpoint as the
  // login page so there's one delivery path to maintain.
  const handleSendStaffReset = async (target) => {
    if (!target?.email) {
      toast.error('No email on file for this staff member.');
      return;
    }
    const ok = await confirmDialog({
      title: 'Send password reset?',
      message: `An email will be sent to ${target.email} with a link to reset their password.`,
      confirmText: 'Send reset email',
    });
    if (!ok) return;
    try {
      const r = await fetch('/api/send-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: target.email,
          continueUrl: window.location.origin + '/login',
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `Request failed (${r.status})`);
      }
      toast.success(`Reset email sent to ${target.email}.`);
    } catch (err) {
      toast.error(err?.message || 'Failed to send reset email.');
    }
  };

  const handleReject = async (uid) => {
    const target = users.find(u => u.id === uid);
    const niceName = target?.displayName || target?.email || 'this user';
    const ok = await confirmDialog({
      title: `Reject ${niceName}?`,
      message:
        'Their sign-in will be disabled and their profile will be removed. ' +
        'They will need to sign up again from scratch if they want back in.',
      confirmText: 'Reject user',
      danger: true,
    });
    if (!ok) return;

    try {
      const idToken = user ? await user.getIdToken() : null;
      if (!idToken) throw new Error('Not signed in.');
      const r = await fetch('/api/users/reject-user', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${idToken}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ uid }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(data?.error || `Reject failed (${r.status}).`);
      }
      if (data.warning) {
        toast.error(data.warning, 7000);
      } else {
        toast.success(`${niceName} has been rejected.`);
      }
    } catch (err) {
      toast.error(err?.message || 'Failed to reject user.');
    }
  };

  // Approving a time-off request also clears any shifts the user already
  // had inside that range — otherwise they'd stay on the schedule on a day
  // they have approved leave. We convert them to open shifts (rather than
  // delete) so coverage can still be picked up by someone else. All writes
  // go through a single batch so an interruption leaves a consistent state.
  // Date fields are 'YYYY-MM-DD' strings, which compare lexically as ISO.
  const handleApproveTimeOff = async (req) => {
    await updateDoc(doc(db, 'timeOffRequests', req.id), { status: 'approved' });

    const conflicting = shifts.filter(s =>
      s.userId === req.userId &&
      s.date && s.date >= req.startDate && s.date <= req.endDate,
    );
    if (conflicting.length > 0) {
      const batch = writeBatch(db);
      for (const s of conflicting) {
        batch.delete(doc(db, 'shifts', s.id));
        const newRef = doc(collection(db, 'openShifts'));
        batch.set(newRef, {
          date:        s.date,
          startTime:   s.startTime,
          endTime:     s.endTime,
          role:        s.role || 'Instructor',
          subRole:     s.subRole || 'Elementary',
          shiftType:   s.shiftType || 'In-Centre',
          centerId:    s.centerId || activeCenterId,
          status:      'open',
          claimedBy:   null,
          claimedByName: null,
          postedAt:    new Date().toISOString(),
          // Provenance so admins can tell where this open shift came from.
          openedFrom:        'time_off_approval',
          originalUserId:    s.userId || null,
          originalUserName:  s.userName || req.userName || null,
        });
      }
      await batch.commit();
    }

    const recipient = approvedUsers.find(u => u.id === req.userId);
    if (recipient?.email) {
      notifyTimeOffDecision(req, recipient, 'approved');
    }
  };
  // Per-centre operational fields (instructorType, subRoles,
  // guaranteed, approved, maxDaysPerWeek) write to the active centre's
  // membership entry. Everything else writes to the top-level field as
  // before. See src/lib/centerMembership.js for the full list.
  //
  // First-touch seeding: if there's no membership entry for this centre
  // yet, we create the whole map so subsequent edits don't see undefined
  // siblings. This is what keeps a user's Centre A edits truly isolated
  // from their Centre B settings.
  /**
   * A person's name is COPIED onto every shift when the shift is created,
   * and the centre's salaryStaff list stores names rather than ids. Both
   * are snapshots, so renaming someone silently breaks them:
   *
   *   • their old-name shifts stop matching the roster, so hours land in
   *     "no account" instead of the assigned total
   *   • a salaried person who renames drops out of the salary exclusion
   *     and starts appearing in hourly payroll — a real money bug
   *
   * Rather than teach all ~50 name-matching sites about renames, repair
   * the copies once, here, at the moment the name actually changes.
   */
  const propagateRename = async (uid, oldName, newName) => {
    let shiftsFixed = 0;
    try {
      const snap = await getDocs(query(collection(db, 'shifts'), where('userId', '==', uid)));
      const stale = snap.docs.filter(d => (d.data().userName || '') !== newName);
      // writeBatch caps at 500 ops; chunk so a long-tenured staffer with
      // hundreds of shifts doesn't blow the limit.
      for (let i = 0; i < stale.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of stale.slice(i, i + 400)) batch.update(d.ref, { userName: newName });
        await batch.commit();
        shiftsFixed += Math.min(400, stale.length - i);
      }
    } catch (err) {
      console.error('[rename] shift backfill failed:', err);
      toast.error('Name saved, but their past shifts still show the old name. Tell Enterprise.');
      return;
    }

    // salaryStaff is a list of names on the centre config.
    try {
      const list = Array.isArray(centerConfig?.salaryStaff) ? centerConfig.salaryStaff : [];
      if (list.includes(oldName)) {
        await setDoc(
          doc(db, 'centers', activeCenterId, 'config', 'main'),
          { salaryStaff: list.map(n => (n === oldName ? newName : n)) },
          { merge: true },
        );
      }
    } catch (err) {
      console.error('[rename] salaryStaff update failed:', err);
      toast.error('Name saved, but check the salaried staff list in Centre Settings.');
      return;
    }

    if (shiftsFixed > 0) {
      toast.success(`Renamed. Updated ${shiftsFixed} shift${shiftsFixed === 1 ? '' : 's'} to match.`);
    }
  };

  const handleUpdateUserField = async (uid, field, value) => {
    if (!isPerCentreField(field)) {
      const before = field === 'displayName'
        ? (users.find(u => u.uid === uid || u.id === uid)?.displayName || '')
        : null;
      await updateDoc(doc(db, 'users', uid), { [field]: value });
      // Only after the write lands — never repair toward a name that
      // didn't save.
      //
      // Deliberately runs even when the text is UNCHANGED: anyone renamed
      // before this repair existed still has stale shifts, and re-saving
      // their name is the obvious way for an admin to fix it without a
      // special button. It's a no-op (one indexed query, no writes) when
      // nothing is stale.
      if (field === 'displayName' && value) {
        await propagateRename(uid, before, value);
      }
      return;
    }
    const target = users.find(u => u.uid === uid || u.id === uid);
    const hasMembership = !!target?.centerMemberships?.[activeCenterId];
    if (hasMembership) {
      await updateDoc(doc(db, 'users', uid), {
        [membershipFieldPath(activeCenterId, field)]: value,
      });
      return;
    }
    // No row for this centre yet — seed it with sensible defaults
    // (carried over from the legacy top-level values so the user
    // doesn't appear to reset when an admin clicks one field) and
    // overlay the new value for the field being edited.
    const seeded = buildInitialMembership({
      instructorType: target?.instructorType,
      maxDaysPerWeek: target?.maxDaysPerWeek,
      subRoles:       target?.subRoles,
      guaranteed:     target?.guaranteed,
      approved:       target?.approved,
      isVolunteer:    target?.isVolunteer,
    });
    seeded[field] = value;
    await updateDoc(doc(db, 'users', uid), {
      [`centerMemberships.${activeCenterId}`]: seeded,
    });
  };

  // Shift CRUD
  const handleAddShift = async (shiftData) => {
    // Backstop: the modals validate before calling, but this is the last
    // gate before a bad range reaches the database, and every other
    // surface trusts what's stored here.
    const problem = shiftTimeProblem(shiftData.startTime, shiftData.endTime);
    if (problem) { toast.error(`${problem} Shift not saved.`); return; }
    // withRatioDefault stamps `includedInRatio` when the caller didn't set
    // it — the Add Shift modal always does, one-click paths (Radius import)
    // don't, and neither should ever write a shift without an answer.
    await addDoc(collection(db, 'shifts'), withRatioDefault({ ...shiftData, centerId: shiftData.centerId || activeCenterId }));
  };

  // Bulk-delete shifts in a date range (single day if from === to).
  // Used both for stat-holiday days AND for cleaning out a whole period
  // before importing from When I Work. Currently UNREFERENCED — the
  // toolbar that used to surface it was removed. Kept around because
  // owner may want it back (in a Settings menu or admin-only context).
  // eslint-disable-next-line no-unused-vars
  const handleBulkDeleteShiftsForDate = async (from, to) => {
    if (!from) return;
    const end = to || from;
    const matching = shifts.filter(s => s.date >= from && s.date <= end);
    if (matching.length === 0) {
      toast.info(`No shifts found between ${from} and ${end}.`);
      return;
    }
    const names = [...new Set(matching.map(s => s.userName).filter(Boolean))];
    const isRange = from !== end;
    const ok = await confirmDialog({
      title: `Delete ${matching.length} shift${matching.length === 1 ? '' : 's'} ${isRange ? `from ${from} to ${end}` : `on ${from}`}?`,
      body: `This will permanently remove every Ratio shift in that ${isRange ? 'date range' : 'date'} at this centre.\n\nStaff affected (${names.length}):\n• ${names.slice(0, 12).join('\n• ')}${names.length > 12 ? `\n• …and ${names.length - 12} more` : ''}`,
      confirmLabel: `Delete ${matching.length} shift${matching.length === 1 ? '' : 's'}`,
      destructive: true,
    });
    if (!ok) return;
    // Firestore batches max out at 500 writes — chunk.
    for (let i = 0; i < matching.length; i += 400) {
      const batch = writeBatch(db);
      for (const s of matching.slice(i, i + 400)) batch.delete(doc(db, 'shifts', s.id));
      await batch.commit();
    }
    toast.success(`Deleted ${matching.length} shift${matching.length === 1 ? '' : 's'}.`);
  };

  // Bulk-import shifts from a parsed When I Work CSV. Each entry has been
  // pre-matched in the modal to either a Ratio user (by uid) or marked
  // "skip" by the owner. We just batch-write the chosen ones.
  // Currently UNREFERENCED — the WIW import button was removed from the
  // payroll toolbar. Kept so re-mounting the importer later doesn't
  // require re-writing the handler.
  // eslint-disable-next-line no-unused-vars
  const handleImportWiwShifts = async (entries) => {
    const valid = entries.filter(e => e.userId && e.date && e.startTime && e.endTime);
    if (valid.length === 0) {
      toast.info('No valid shifts to import.');
      return 0;
    }
    for (let i = 0; i < valid.length; i += 400) {
      const batch = writeBatch(db);
      for (const e of valid.slice(i, i + 400)) {
        const ref = doc(collection(db, 'shifts'));
        batch.set(ref, {
          userId: e.userId,
          userName: e.userName,
          date: e.date,
          startTime: e.startTime,
          endTime: e.endTime,
          role: e.role || 'Instructor',
          subRole: e.subRole || 'Elementary',
          shiftType: 'In-Centre',
          status: 'published',
          source: 'wiw-import',
          centerId: activeCenterId,
          [RATIO_FIELD]: defaultIncludedInRatio({ role: e.role || 'Instructor' }),
        });
      }
      await batch.commit();
    }
    toast.success(`Imported ${valid.length} shift${valid.length === 1 ? '' : 's'} from When I Work.`);
    return valid.length;
  };

  // One-click "Schedule shift" from a Radius CSV row.
  //
  // Use case: a staff member clocked into Radius but doesn't have a
  // Ratio-side shift for that day, so the Payroll tab flags them
  // "Not scheduled". Instead of forcing the owner to open Add Shift and
  // re-type the times, this turns the actual clock-in/out into a real
  // shift in one click.
  //
  // Behaviour: try to match the Radius row's staff name to an approved
  // user by displayName; if no match, fall back to opening the existing
  // AddShiftModal so the owner can pick the right person manually.
  // Currently UNREFERENCED — the "Schedule shift" button on unscheduled-
  // Radius rows was removed per owner request (payroll is not the right
  // surface for creating shifts). Kept around so it can be re-mounted
  // from elsewhere (e.g. Manage Schedule) without rewriting.
  // eslint-disable-next-line no-unused-vars
  const handleScheduleFromRadius = async (personName, radiusEntry) => {
    const user = approvedUsers.find(
      u => (u.displayName || '').toLowerCase() === (personName || '').toLowerCase()
    );
    if (!user) {
      // Can't match by name — open Add Shift modal pre-filled with the date.
      setAddShiftModal({ date: radiusEntry.date, user: null });
      return;
    }
    const subs = user.subRoles || [];
    const subRole = subs.includes('Online')     ? 'Online'
                  : subs.includes('Highschool') ? 'Highschool'
                  : 'Elementary';
    await handleAddShift({
      userId: user.uid,
      userName: user.displayName,
      date: radiusEntry.date,
      startTime: normalizeTimeToHHMM(radiusEntry.timeIn),
      endTime:   normalizeTimeToHHMM(radiusEntry.timeOut),
      role: user.instructorType || '',
      shiftType: 'In-Centre',
      subRole,
      // Created from Radius — mark the source so we can audit later
      // and so the existing payroll-compare logic treats it as confirmed.
      source: 'radius-import',
      status: 'published',
    });
    try {
      const { toast } = await import('../lib/notify');
      toast.success(`Shift created for ${user.displayName} on ${radiusEntry.date}`);
    } catch { /* notify optional */ }
  };

  const handleSaveEditShift = async ({ startTime, endTime, role, shiftType, subRole, sickPay, noShow, ...rest }) => {
    await updateDoc(doc(db, 'shifts', editShiftModal.id), {
      startTime, endTime, role, shiftType, subRole,
      sickPay: !!sickPay,
      noShow:  !!noShow,
      // `flexRole` is deliberately NOT in this payload. STEAM / Summer
      // Camp were removed, so the modal no longer sends one — and writing
      // `flexRole: undefined || null` would have quietly erased the tag
      // from one of the 58 historical summer shifts the moment anyone
      // opened and saved it. Leave whatever is stored alone.
      //
      // Always written as a real boolean, so an edited shift stops
      // relying on the legacy role-derived fallback from that point on.
      // The fallback reads the stored shift, so an old flex shift still
      // resolves correctly if the field were ever missing.
      [RATIO_FIELD]: rest[RATIO_FIELD] === undefined
        ? countsInRatio({ ...editShiftModal, role })
        : !!rest[RATIO_FIELD],
    });
    setEditShiftModal(null);
  };

  const handleDeleteEditShift = async () => {
    await deleteDoc(doc(db, 'shifts', editShiftModal.id));
    setEditShiftModal(null);
  };

  // Open Shifts
  const handleAddOpenShift = async ({ date, startTime, endTime, role, subRole }) => {
    const shiftPayload = {
      date, startTime, endTime, role,
      subRole: subRole || 'Elementary',
      centerId: activeCenterId,
      status: 'open', claimedBy: null, claimedByName: null,
      postedAt: new Date().toISOString(),
    };
    await addDoc(collection(db, 'openShifts'), shiftPayload);

    // Email every approved staff member with a real email address.
    const staffEmails = approvedUsers
      .filter(u => u.email)
      .map(u => ({ email: u.email, displayName: u.displayName }));
    notifyOpenShift(shiftPayload, staffEmails);
  };

  const handleDeleteOpenShift = id => deleteDoc(doc(db, 'openShifts', id));

  // Calendar grid — only days this centre actually operates on (Super Admin
  // → Operating Days). Holidays stay in the grid so it's obvious at a glance
  // when a day is a stat closure vs a regular off-day; each holiday column
  // renders as "Closed" with the holiday name below.
  const weekDays = useMemo(() =>
    Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
      .filter(d => isOperatingDay(d, centerConfig)),
  [weekStart, centerConfig]);

  const {
    totalAssignedHours, volunteerHoursThisWeek, trainingHoursThisWeek, salaryHoursThisWeek,
    sickHoursThisWeek, sickByDate, noAccountHoursThisWeek,
  } = useMemo(() => {
    const ws = format(weekStart, 'yyyy-MM-dd');
    const we = format(addDays(weekStart, 6), 'yyyy-MM-dd');
    // "Total assigned" is an HOURLY figure — it's the number the staffing
    // budget and payroll are read against, so anyone who isn't paid by the
    // hour has to stay out of it. Two groups get pulled out and tracked in
    // their own chips instead:
    //   • Volunteers — unpaid.
    //   • Salary staff (Vinod / Neeru) — they do get scheduled shifts for
    //     coverage, but their hours don't cost hourly wages, so counting
    //     them inflated every weekly and per-day total on this page.
    // Both still appear on the grid; they're just not in the hourly total.
    //
    // Note this rebuilds the salary/volunteer sets locally rather than
    // reusing the ones defined further down — those are declared after this
    // hook runs, so referencing them here would hit the temporal dead zone.
    const volunteerIds = new Set(
      usersForCentre.filter(u => u.isVolunteer === true).map(u => u.uid),
    );
    const volunteerNames = new Set(
      usersForCentre.filter(u => u.isVolunteer === true).map(u => u.displayName).filter(Boolean),
    );
    // Mirrors payroll's exclusion set exactly: the salaryStaff config PLUS
    // hidden-from-ops accounts (owner / super-admin / director / internal /
    // "Admin Team"). Vin sits in the second group, Neeru in the first, so
    // checking only salaryStaff would have left one of them in the total.
    const salaryNames = new Set(
      Array.isArray(centerConfig?.salaryStaff) ? centerConfig.salaryStaff : [],
    );
    for (const u of usersForCentre) {
      const hidden = u.role === 'owner' || u.role === 'super_admin' || u.role === 'director'
        || u.internal === true || u.displayName === 'Admin Team';
      if (hidden && u.displayName) salaryNames.add(u.displayName);
    }
    // Ids for the same people. Without this, making the "no account" check
    // id-aware below would REMOVE the accidental safety net that used to
    // catch a renamed salaried person: they'd stop being "no account",
    // fail the name-only salary check, and land in the paid total.
    //
    // Resolved HERE from salaryNames rather than reusing the component's
    // salaryIds/hiddenIds — those are declared further down the file, and
    // this memo's callback runs during render before that line executes.
    // Referencing them was a temporal-dead-zone crash.
    const salaryIdSet = new Set();
    for (const u of usersForCentre) {
      if (u.uid && u.displayName && salaryNames.has(u.displayName)) salaryIdSet.add(u.uid);
    }
    const isSalaryLike = (sh) =>
      (sh.userId && salaryIdSet.has(sh.userId)) || (sh.userName && salaryNames.has(sh.userName));
    // The grid only has rows for people with a portal account; shifts for
    // anyone else surface as the footer's "+N no account" note. This total
    // has to use the same rule or "Total assigned" wouldn't equal the sum of
    // the day headers sitting right below it — those hours get their own
    // chip instead so nothing is silently dropped.
    const portalNames = new Set(users.map(u => u.displayName));
    // …and by uid. A shift stores a SNAPSHOT of the person's name at the
    // moment it was created, so anyone who has since been renamed stops
    // matching portalNames and gets counted as "no account" — subtracting
    // their hours from the assigned total even though the grid, which
    // matches on s.userId === u.uid, is happily rendering their shifts in
    // their row. Checking the id first makes the two agree.
    const portalIds = new Set(users.map(u => u.uid).filter(Boolean));
    const hasPortalAccount = (sh) =>
      (sh.userId && portalIds.has(sh.userId)) || portalNames.has(sh.userName);

    let paid = 0;
    let volunteer = 0;
    let training = 0;
    let salary = 0;
    let sick = 0;
    let noAccount = 0;
    const sickDates = new Map(); // date → sick hours that day
    for (const s of shifts) {
      if (s.date < ws || s.date > we) continue;
      // No-show shifts are unpaid — subtract from the day's hours by
      // simply not counting them.
      if (s.noShow === true) continue;
      const hrs = shiftHours(s);
      const isVolunteer = (s.userId && volunteerIds.has(s.userId))
        || (s.userName && volunteerNames.has(s.userName));
      // Sick shifts come OUT of the assigned total. Nobody worked those
      // hours, so counting them made this page disagree with payroll, the
      // analytics projection and the staffing budget — all three of which
      // hold sick in its own bucket. They're surfaced per-day on the grid
      // instead, so the cover gap is still obvious.
      if (s.sickPay === true) {
        if (!isVolunteer) {
          sick += hrs;
          sickDates.set(s.date, (sickDates.get(s.date) || 0) + hrs);
        }
        continue;
      }
      if (isVolunteer)                                    volunteer += hrs;
      // Training hours are PAID but deliberately kept out of `paid`, which
      // is the number the staffing budget is managed against. Counting a
      // shadowing trainee there would make the centre look like it spent
      // its floor budget on coverage it didn't actually get. Surfaced as
      // its own chip so the cost is visible rather than hidden.
      else if (isTrainingShift(s))                        training  += hrs;
      else if (isSalaryLike(s))                           salary    += hrs;
      else if (!hasPortalAccount(s))                      noAccount += hrs;
      else                                                paid      += hrs;
    }
    return {
      totalAssignedHours: paid,
      volunteerHoursThisWeek: volunteer,
      trainingHoursThisWeek: training,
      salaryHoursThisWeek: salary,
      sickHoursThisWeek: sick,
      sickByDate: sickDates,
      noAccountHoursThisWeek: noAccount,
    };
  }, [shifts, weekStart, users, usersForCentre, centerConfig]);

  // Auto-scheduler
  const handleGenerate = async () => {
    setGenerating(true); setSchedError(''); setDraftSchedule(null);
    try {
      // Approved time off removes the day from what the scheduler can
      // fill. Same helper the grid displays with, so what an admin SEES
      // and what the generator DOES can't drift apart.
      const filteredAvailability = withoutApprovedTimeOff(availability, timeOffIndex)
        // Trainees never get auto-scheduled. They shadow a specific person
        // on a specific day, which is a judgement call an admin makes — and
        // if the generator placed them they'd be filling a slot they can't
        // actually cover.
        .filter(a => !trainingUserIds.has(a.userId));

      // Build previous months availability fallback (up to 6 months back).
      // Anchored on the month the RANGE starts in, since there's no longer a
      // month picker to read.
      const previousMonthsAvail = [];
      const anchorDate = new Date((schedRangeDates?.start || schedDayDate) + 'T12:00:00');
      const monthNum = anchorDate.getMonth() + 1;
      for (let i = 1; i <= 6; i++) {
        let prevMonth = monthNum - i;
        let prevYear = anchorDate.getFullYear();
        if (prevMonth <= 0) { prevMonth += 12; prevYear -= 1; }
        const startStr = `${prevYear}-${String(prevMonth).padStart(2,'0')}-01`;
        const endStr = `${prevYear}-${String(prevMonth).padStart(2,'0')}-31`;
        const monthAvail = withoutApprovedTimeOff(
          availability.filter(a => a.date >= startStr && a.date <= endStr),
          timeOffIndex,
        );
        previousMonthsAvail.push(monthAvail);
      }

      // Volunteers are not auto-scheduled — they're unpaid help that the
      // owner adds to specific days manually. They stay in approvedUsers
      // for the "Add from approved staff" picker in Edit Day mode, but
      // the auto-scheduler ignores them.
      const schedulableUsers = approvedUsers.filter(u => u.isVolunteer !== true);

      // Always an explicit date range now, so the engine never generates
      // outside the picked window. It derives its own display label.
      const rangeArgs = {
        startDate: schedRangeDates.start,
        endDate:   schedRangeDates.end,
      };

      const result = generateSchedule({
        instructors: schedulableUsers,
        availability: filteredAvailability,
        previousMonthsAvail,
        ...rangeArgs,
        config: schedConfig,
        centerConfig,   // per-center hours, fixed staff, guaranteed names
        priorShifts: shifts,  // seed fairness from already-saved shifts this month
      });
      // Stagger shifts around the demand curve.
      //
      // generateSchedule gives everyone the same block — their availability
      // clamped to instructional hours. On a day whose rush is the first
      // ninety minutes, that puts the whole team on the floor for four hours.
      // This reshapes those blocks to follow the bookings, without changing
      // WHO works: the engine already weighed rank, fairness, sub-role
      // balance and weekly caps, and re-deciding that here would fight it.
      //
      // Only runs when real booking demand has been loaded, and never drops
      // anyone — someone the curve doesn't need keeps the longest block they
      // can cover, because over-staffing is cheap and un-scheduling a person
      // who was told they're working is not.
      if (bookingDemand && schedConfig.shapeShiftsToDemand !== false) {
        try {
          const { shapeShifts, toMinutes } = await import('../lib/shift-shaping');
          const hoursSoFar = {};

          for (const day of result.days) {
            const curve = bookingDemand[day.date];
            if (!curve?.slotKeys?.length) continue;

            const people = day.assignedEmployees.map(name => {
              const shift = day.shiftTimes?.[name] || '';
              const [rawStart, rawEnd] = shift.split(' - ');
              const availStart = toMinutes(rawStart);
              const availEnd = toMinutes(rawEnd);
              if (availStart == null || availEnd == null) return null;
              const role = day.roles?.[name] || 'Instructor';
              return {
                name,
                role,
                isHost: role === 'Host',
                // Leads outrank instructors; everyone else sorts after them.
                rank: role === 'Lead' ? 0 : 1,
                hoursSoFar: hoursSoFar[name] || 0,
                availStart,
                availEnd,
              };
            }).filter(Boolean);

            if (people.length === 0) continue;

            const { shifts, uncovered, notes } = shapeShifts({
              required: curve.required,
              slotKeys: curve.slotKeys,
              people,
              minShiftHours: Number(schedConfig.minShiftHours) > 0
                ? Number(schedConfig.minShiftHours)
                : 2,
            });

            for (const [name, s] of Object.entries(shifts)) {
              day.shiftTimes[name] = `${s.start} - ${s.end}`;
              hoursSoFar[name] =
                (hoursSoFar[name] || 0) + (toMinutes(s.end) - toMinutes(s.start)) / 60;
            }

            day.shiftShaping = { uncovered, notes };
            for (const u of uncovered) {
              result.warnings.push(
                `⚠ ${day.dayOfWeek} ${day.dayNumber}: nobody free for the ${u.start}–${u.end} block (${u.reason}).`
              );
            }
          }
        } catch (err) {
          // Shaping is an enhancement — a failure here must not cost the
          // owner a schedule they otherwise have.
          console.error('[shapeShiftsToDemand] failed:', err);
          result.warnings.push(
            '⚠ Could not stagger shifts around demand; times are the full instructional window.'
          );
        }
      }

      setDraftSchedule(result);
      setSelectedDayIndex(0);
    } catch (err) {
      setSchedError(`Scheduler error: ${err.message}`);
    } finally {
      setGenerating(false);
    }
  };

  // Human label for the generated range. The engine's `month` field is a
  // summary that can already BE a range ("Aug 31 – Sep 6"), so build this from
  // the real start/end dates instead of stitching strings together.
  const draftRangeLabel = useMemo(() => {
    if (!draftSchedule?.startDate) return '';
    const a = new Date(draftSchedule.startDate + 'T12:00:00');
    const b = new Date((draftSchedule.endDate || draftSchedule.startDate) + 'T12:00:00');
    const sameDay = draftSchedule.startDate === draftSchedule.endDate;
    if (sameDay) return format(a, 'EEE, MMM d yyyy');
    const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
    return sameMonth
      ? `${format(a, 'MMM d')} – ${format(b, 'd, yyyy')}`
      : `${format(a, 'MMM d')} – ${format(b, 'MMM d, yyyy')}`;
  }, [draftSchedule]);

  const handleEditDay = (i) => setEditingDay({ index: i, ...draftSchedule.days[i] });
  const handleSaveEditDay = () => {
    if (!editingDay) return;
    const newDays = [...draftSchedule.days];
    newDays[editingDay.index] = {
      date: editingDay.date, dayOfWeek: editingDay.dayOfWeek,
      dayNumber: editingDay.dayNumber,
      assignedEmployees: editingDay.assignedEmployees,
      availableEmployees: editingDay.availableEmployees,
      shiftTimes: editingDay.shiftTimes,
      roles: editingDay.roles,
      subRoles: editingDay.subRoles,
      countingStaffCount: editingDay.assignedEmployees.filter(
        n => ['Instructor','Lead'].includes(editingDay.roles?.[n] || 'Instructor')
      ).length,
    };
    setDraftSchedule({ ...draftSchedule, days: newDays });
    setEditingDay(null);
  };

  const handleRemoveFromDay = name =>
    setEditingDay(p => ({ ...p, assignedEmployees: p.assignedEmployees.filter(n => n !== name) }));
  // Default instructional / full-day hours per day-of-week, used when an
  // admin adds someone to a day in the draft editor (and we have no
  // submitted availability to read from).
  const DRAFT_DEFAULT_HOURS = {
    Monday:    { instr: ['15:00', '19:00'], host: ['10:00', '20:00'] },
    Tuesday:   { instr: ['15:00', '19:00'], host: ['10:00', '20:00'] },
    Wednesday: { instr: ['15:00', '19:00'], host: ['10:00', '20:00'] },
    Thursday:  { instr: ['15:00', '19:00'], host: ['10:00', '20:00'] },
    Friday:    { instr: ['15:00', '18:00'], host: ['10:00', '19:00'] },
    Saturday:  { instr: ['10:00', '14:00'], host: ['09:00', '15:00'] },
  };

  const handleAddToDay = name => {
    if (editingDay.assignedEmployees.includes(name)) return;
    // Look up the user's teaching track so the new shift gets tagged.
    // Online is its own platform — anyone tagged Online gets Online shifts.
    const u = approvedUsers.find(usr => usr.displayName === name);
    const subs = u?.subRoles || [];
    let pickedSubRole;
    if (subs.includes('Online')) pickedSubRole = 'Online';
    else if (subs.includes('Highschool')) pickedSubRole = 'Highschool';
    else pickedSubRole = 'Elementary';
    // Default shift time: Hosts get full-day, everyone else gets instructional hours
    const defaults = DRAFT_DEFAULT_HOURS[editingDay.dayOfWeek] || DRAFT_DEFAULT_HOURS.Monday;
    const isHost = u?.instructorType === 'Host';
    const [defStart, defEnd] = isHost ? defaults.host : defaults.instr;
    // Volunteers get role='Volunteer' so the shift is visually labelled as
    // such on the schedule. Payroll filtering keys off the user flag, not
    // the shift role, so this is purely cosmetic / informational.
    const role = u?.isVolunteer === true
      ? 'Volunteer'
      : (u?.instructorType || 'Instructor');
    setEditingDay(p => ({
      ...p,
      assignedEmployees: [...p.assignedEmployees, name],
      roles:      { ...(p.roles      || {}), [name]: role },
      subRoles:   { ...(p.subRoles   || {}), [name]: pickedSubRole },
      shiftTimes: { ...(p.shiftTimes || {}), [name]: `${defStart} - ${defEnd}` },
    }));
  };

  // Parse a shift-time string ("15:00 - 19:00" or "11:00 AM - 7:00 PM")
  // back into [startHHMM, endHHMM]. Used by the draft time editor below.
  const parseShiftTimeStr = (str) => {
    if (!str) return ['15:00', '19:00'];
    const parts = String(str).split(' - ');
    if (parts.length !== 2) return ['15:00', '19:00'];
    const norm = (p) => {
      const t = p.trim();
      if (/^\d{1,2}:\d{2}$/.test(t)) return t.padStart(5, '0');
      const m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (m) {
        let h = parseInt(m[1], 10);
        const min = m[2];
        const ampm = m[3].toUpperCase();
        if (ampm === 'PM' && h !== 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;
        return `${String(h).padStart(2,'0')}:${min}`;
      }
      return '15:00';
    };
    return [norm(parts[0]), norm(parts[1])];
  };

  const handleUpdateDayShiftTime = (name, field, value) => {
    setEditingDay(p => {
      const current = p.shiftTimes?.[name] || '';
      const [s, e] = parseShiftTimeStr(current);
      const ns = field === 'start' ? value : s;
      const ne = field === 'end'   ? value : e;
      return {
        ...p,
        shiftTimes: { ...(p.shiftTimes || {}), [name]: `${ns} - ${ne}` },
      };
    });
  };

  const handleUpdateDaySubRole = (name, value) => {
    setEditingDay(p => ({
      ...p,
      subRoles: { ...(p.subRoles || {}), [name]: value },
    }));
  };

  // Convert "11:00 AM" → "11:00", "2:00 PM" → "14:00" for Firestore storage
  const toHHMM = (timeStr) => {
    const m = timeStr.trim().match(/^(\d+):(\d+)\s*(AM|PM)$/i);
    if (!m) return '15:00';
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ampm = m[3].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
  };

  // Write fixed staff shifts for a set of date strings to Firestore.
  // Reads from the active center's fixedStaff config when available,
  // falling back to legacy FIXED_SCHEDULES so behavior is preserved
  // pre-migration.
  const seedFixedShiftsForDates = async (dates) => {
    const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const fixedStaffMap = (centerConfig?.fixedStaff && Object.keys(centerConfig.fixedStaff).length > 0)
      ? centerConfig.fixedStaff
      : FIXED_SCHEDULES;
    const fixedNames = Object.keys(fixedStaffMap).map(n => n.toLowerCase());

    // Step 1: Delete ALL existing fixed staff shifts for these dates (prevents duplicates)
    const deleteBatch = writeBatch(db);
    let deleteCount = 0;
    for (const s of shifts) {
      if (dates.includes(s.date) && fixedNames.includes(s.userName?.toLowerCase())) {
        deleteBatch.delete(doc(db, 'shifts', s.id));
        deleteCount++;
      }
    }
    if (deleteCount > 0) await deleteBatch.commit();

    // Step 2: Write fresh shifts
    const insertBatch = writeBatch(db);
    for (const dateStr of dates) {
      const d = new Date(dateStr + 'T00:00:00');
      const jsDay = d.getDay();
      const pythonWeekday = jsDay === 0 ? 6 : jsDay - 1;
      const dayName = DAY_NAMES[pythonWeekday];
      if (!dayName) continue;
      const weekOfMonth = Math.floor((d.getDate() - 1) / 7) + 1;
      for (const [name, sched] of Object.entries(fixedStaffMap)) {
        const shiftStr = sched[dayName];
        if (!shiftStr || shiftStr.toLowerCase() === 'off') continue;
        if (dayName === 'Saturday' && sched.saturday_weeks) {
          if (!sched.saturday_weeks.includes(weekOfMonth)) continue;
        }
        const parts = shiftStr.split(' - ');
        if (parts.length !== 2) continue;
        const user = users.find(u => u.displayName?.trim().toLowerCase() === name.toLowerCase());
        const ref = doc(collection(db, 'shifts'));
        insertBatch.set(ref, {
          userId: user?.uid || name,
          userName: name,
          centerId: activeCenterId,
          date: dateStr,
          startTime: toHHMM(parts[0]),
          endTime: toHHMM(parts[1]),
          role: sched.role,
          subRole: 'Elementary',
          // An explicit countsTowardRatio on the fixed-staff config entry
          // is a deliberate decision about that person (Sabrina counts,
          // the directors don't), so it carries straight onto the shift.
          // Without one, fall back to the role default.
          [RATIO_FIELD]: typeof sched.countsTowardRatio === 'boolean'
            ? sched.countsTowardRatio
            : defaultIncludedInRatio({ role: sched.role }),
          // Fixed-staff shifts also land as drafts so admin can review the
          // whole month together before publishing. (They have predictable
          // hours so review is fast, but the draft step keeps the
          // experience consistent.)
          status: 'draft',
          autoScheduled: true,
          fixedStaff: true,
        });
      }
    }
    await insertBatch.commit();
  };

  // (Removed: handleSeedFixedStaffWeek + handlePurgeAndReseed — the
  // associated "Sync Fixed Staff This Week" and "Fix Duplicates" buttons
  // are gone. If a one-time cleanup is ever needed again, check git
  // history for the previous implementations.)

  // Reset ALL shifts in Firestore — complete clean slate. Gated by a
  // type-to-confirm input so an accidental click can't wipe everything.
  // ── Multi-center migration (Phase 1 groundwork) ──────────────────────────
  // One-time backfill: creates the centers/langley doc and stamps centerId
  // onto every existing doc that doesn't already have one. Safe to run
  // multiple times — it skips docs that already have centerId.
  const [migrationRunning, setMigrationRunning] = useState(false);
  const [migrationResult, setMigrationResult] = useState(null);
  const handleRunCenterMigration = async () => {
    const ok = await confirmDialog({
      title: 'Run multi-center migration?',
      message:
        `• Creates a "${DEFAULT_CENTER_ID}" center doc if one doesn't exist\n` +
        `• Stamps centerId="${DEFAULT_CENTER_ID}" onto every existing user, shift, availability, openShift, time-off request, chat, announcement, and notificationPreferences doc\n` +
        '• Skips any doc that already has a centerId (safe to run multiple times)',
      confirmText: 'Run migration',
    });
    if (!ok) return;
    setMigrationRunning(true);
    setMigrationResult(null);
    try {
      const stats = { center: 0, config: 0, users: 0, shifts: 0, availability: 0, openShifts: 0, timeOffRequests: 0, chat: 0, announcements: 0, notificationPreferences: 0 };

      // 1. Ensure centers/{DEFAULT_CENTER_ID} exists
      const centerRef = doc(db, 'centers', DEFAULT_CENTER_ID);
      const centerSnap = await getDoc(centerRef);
      if (!centerSnap.exists()) {
        await setDoc(centerRef, {
          id: DEFAULT_CENTER_ID,
          name: 'Mathnasium Langley',
          city: 'Langley',
          province: 'BC',
          country: 'Canada',
          timezone: 'America/Vancouver',
          createdAt: serverTimestamp(),
        });
        stats.center = 1;
      }

      // 1b. Ensure centers/{DEFAULT_CENTER_ID}/config/main exists.
      // Seeds with Langley's current values (instructional hours, fixed staff,
      // guaranteed names, salary list) so the data-driven config doesn't
      // accidentally come up empty and break the scheduler.
      const configRef = doc(db, 'centers', DEFAULT_CENTER_ID, 'config', 'main');
      const configSnap = await getDoc(configRef);
      if (!configSnap.exists()) {
        await setDoc(configRef, {
          ...LANGLEY_DEFAULT_CONFIG,
          createdAt: serverTimestamp(),
        });
        stats.config = 1;
      }

      // 2. Backfill every other collection. Users get extra love: if they
      // already have centerId (from a previous partial migration) but not the
      // centerIds[] array, we add it — otherwise the new array-contains query
      // and rules can't find them.
      const collectionsToMigrate = [
        'users', 'shifts', 'availability', 'openShifts',
        'timeOffRequests', 'chat', 'announcements', 'notificationPreferences',
      ];
      for (const colName of collectionsToMigrate) {
        const snap = await getDocs(collection(db, colName));
        const toUpdate = snap.docs.filter(d => {
          const data = d.data();
          if (colName === 'users') {
            return !data.centerId || !Array.isArray(data.centerIds);
          }
          return !data.centerId;
        });
        const CHUNK = 450;
        for (let i = 0; i < toUpdate.length; i += CHUNK) {
          const b = writeBatch(db);
          for (const d of toUpdate.slice(i, i + CHUNK)) {
            const data = d.data();
            const updates = {};
            if (!data.centerId) updates.centerId = DEFAULT_CENTER_ID;
            if (colName === 'users' && !Array.isArray(data.centerIds)) {
              updates.centerIds = [data.centerId || DEFAULT_CENTER_ID];
            }
            if (Object.keys(updates).length > 0) {
              b.update(d.ref, updates);
            }
          }
          await b.commit();
        }
        stats[colName] = toUpdate.length;
      }
      setMigrationResult({ ok: true, stats });
    } catch (err) {
      setMigrationResult({ ok: false, error: err?.message || String(err) });
    } finally {
      setMigrationRunning(false);
    }
  };

  // Publish a set of draft shifts. Flips each one's status from 'draft'
  // to 'live' atomically. Idempotent: anything that's already live is
  // skipped, so calling this on a mixed set is safe.
  //
  // Email/chat notification fires only the *first* time shifts are
  // published in a given month — we check whether any live shifts
  // already exist for that month before sending, so editing one shift
  // and re-publishing doesn't spam staff. `silent: true` skips notify
  // entirely (useful for per-shift publishes that follow a big bulk
  // publish in the same minute).
  const handlePublishShifts = async (shiftDocs, { silent = false } = {}) => {
    const drafts = (shiftDocs || []).filter(s => s.status === 'draft');
    if (drafts.length === 0) {
      toast.info('Nothing to publish — these shifts are already live.');
      return { published: 0 };
    }
    // Group dates by YYYY-MM so we can decide per-month whether this is
    // a first-publish (notify) or a follow-up (silent).
    const monthsTouched = new Set(drafts.map(s => (s.date || '').slice(0, 7)));

    const batch = writeBatch(db);
    for (const s of drafts) {
      batch.update(doc(db, 'shifts', s.id), {
        status: 'live',
        publishedAt: serverTimestamp(),
      });
    }
    await batch.commit();

    if (!silent) {
      // Per-month notification fan-out. Two distinct signals:
      //
      //  1. CHAT POST — gated to once-per-month-per-centre. The "schedule
      //     is live!" announcement is spammy if repeated; only fires on
      //     the FIRST publish for a given month (no prior live shifts).
      //
      //  2. EMAIL — fires on EVERY draft→live transition, because the
      //     emails are now PER-USER and each recipient only sees their
      //     own shifts. Mid-month additions (a missing shift, a new
      //     instructor onboarded) correctly notify just the affected
      //     people. The old "first publish" gate was hiding these.
      for (const ym of monthsTouched) {
        const monthStart = `${ym}-01`;
        const [yy, mm] = ym.split('-').map(Number);
        const lastDay = new Date(yy, mm, 0).getDate();
        const monthEnd = `${ym}-${String(lastDay).padStart(2, '0')}`;
        const publishedThisMonth = drafts.filter(s => s.date >= monthStart && s.date <= monthEnd);
        const monthLabel = new Date(yy, mm - 1, 1).toLocaleDateString('en-US',
          { month: 'long', year: 'numeric' });

        // ── Chat announcement (gated to first-publish of the month) ──
        const otherLiveInMonth = shifts.filter(s =>
          s.status !== 'draft' &&
          s.date >= monthStart && s.date <= monthEnd &&
          !drafts.some(d => d.id === s.id)
        );
        if (otherLiveInMonth.length === 0) {
          await addDoc(collection(db, 'chat'), {
            text: `📅 The ${monthLabel} schedule is live! Check your shifts on the Schedule page.`,
            userId: 'system',
            userName: centerConfig?.name || 'Mathnasium',
            userRole: 'system',
            centerId: activeCenterId,
            createdAt: serverTimestamp(),
            type: 'schedule_posted',
          });
        }

        // ── Per-user personalised emails (NOT gated) ──
        // Each instructor gets their own shift list + count — never the
        // centre total. Users with zero shifts in this batch are silently
        // skipped (no inbox spam). Emails live in users/{uid}/private/
        // contact post-privacy-split, so attachEmails() reads them from
        // the sub-doc when the user doc no longer carries the field.
        try {
          const usersWithEmail = await attachEmails(approvedUsers);
          await notifySchedulePosted({
            shifts:     publishedThisMonth,
            staffUsers: usersWithEmail,
            monthLabel: new Date(yy, mm - 1, 1).toLocaleDateString('en-US', { month: 'long' }),
            year:       yy,
          });
        } catch (notifyErr) {
          // Fire-and-forget — never block the publish flow on email send.
          console.error('[publish] notification batch failed:', notifyErr);
        }
      }
    }

    toast.success(`Published ${drafts.length} shift${drafts.length === 1 ? '' : 's'}.`);
    return { published: drafts.length };
  };

  // Wrappers for the three publish granularities — keep call sites simple.
  const handlePublishSingleShift = (s) => handlePublishShifts([s]);
  const handlePublishDay = (dateStr) => {
    const dayDrafts = shifts.filter(s => s.date === dateStr && s.status === 'draft');
    return handlePublishShifts(dayDrafts);
  };
  const handlePublishWeek = (weekStartDate, weekEndDate) => {
    const weekDrafts = shifts.filter(s =>
      s.date >= weekStartDate && s.date <= weekEndDate && s.status === 'draft'
    );
    return handlePublishShifts(weekDrafts);
  };
  const handlePublishAllDrafts = () => {
    const allDrafts = shifts.filter(s => s.status === 'draft');
    return handlePublishShifts(allDrafts);
  };

  const handlePostSchedule = async () => {
    if (!draftSchedule) return;
    setPosting(true);
    try {
      const batch = writeBatch(db);
      for (const day of draftSchedule.days) {
        for (const name of day.assignedEmployees) {
          if (FIXED_SCHEDULES[name]) continue;
          const user = approvedUsers.find(u => u.displayName === name);
          const shiftStr = day.shiftTimes?.[name] || '';
          const [startRaw, endRaw] = shiftStr.includes(' - ')
            ? shiftStr.split(' - ') : ['15:00', '20:00'];
          const startTime = startRaw?.includes('M') ? toHHMM(startRaw) : (startRaw || '15:00');
          const endTime   = endRaw?.includes('M')   ? toHHMM(endRaw)   : (endRaw   || '20:00');
          const ref = doc(collection(db, 'shifts'));
          batch.set(ref, {
            userId: user?.uid || name, userName: name,
            centerId: activeCenterId,
            date: day.date, startTime, endTime,
            role: day.roles?.[name] || 'Instructor',
            subRole: day.subRoles?.[name] || 'Elementary',
            [RATIO_FIELD]: defaultIncludedInRatio({ role: day.roles?.[name] || 'Instructor' }),
            // Drafts by default — owner publishes from the weekly grid
            // (per-shift / per-day / per-week). Instructors don't see
            // drafts; the "schedule posted" email fires on first publish.
            status: 'draft', autoScheduled: true,
          });
        }
      }
      await batch.commit();

      const allDates = draftSchedule.days.map(d => d.date);
      await seedFixedShiftsForDates(allDates);

      const totalShifts = draftSchedule.days.reduce((s, d) => s + d.assignedEmployees.length, 0);

      // No chat post / staff email here anymore — those happen on Publish,
      // since instructors don't see drafts. Owner goes to the weekly grid
      // to review and publish.
      setDraftSchedule(null);
      toast.success(`${totalShifts} shifts saved as drafts. Open the weekly grid to review and publish.`);
    } catch (err) {
      setSchedError(`Failed to post: ${err.message}`);
    } finally {
      setPosting(false);
    }
  };

  // Salaried staff are excluded from hourly payroll (read from this center's
  // config so each location can have its own list).
  const salaryStaff = useMemo(() => (
    new Set(Array.isArray(centerConfig?.salaryStaff) ? centerConfig.salaryStaff : [])
  ), [centerConfig]);

  // salaryStaff and hiddenFromOps are lists of NAMES, and a shift carries
  // the name it was created with — so a rename silently breaks both. The
  // id sets below resolve those names against the CURRENT roster, letting
  // every check match on uid first and fall back to name.
  //
  // This matters more than it looks: these sets decide who is EXCLUDED
  // from assigned hours. A salaried person whose shifts no longer match
  // by name stops being excluded and starts inflating the total as if you
  // were paying them hourly.
  const salaryIds = (() => {
    const set = new Set();
    for (const u of users) {
      if (u.uid && u.displayName && salaryStaff.has(u.displayName)) set.add(u.uid);
    }
    return set;
  })();

  const hiddenIds = (() => {
    const set = new Set();
    for (const u of users) {
      const hidden = u.role === 'owner' || u.role === 'super_admin' || u.role === 'director'
        || u.internal === true
        || u.displayName === 'Admin Team';
      if (hidden && u.uid) set.add(u.uid);
    }
    return set;
  })();

  const volunteerIdSet = (() => {
    const set = new Set();
    for (const u of usersForCentre) {
      if (u.isVolunteer === true && u.uid) set.add(u.uid);
    }
    return set;
  })();

  /** Does this shift belong to someone in `ids` / `names`? Id wins. */
  const shiftIsFor = (sh, ids, names) =>
    (sh.userId && ids.has(sh.userId)) || (sh.userName && names.has(sh.userName));

  // Volunteers — per-user toggle in Manage Users. Excluded from hourly
  // payroll AND from the Radius timesheet compare so they don't appear on
  // pay reports at all. Resolved against the active centre so a person
  // can be a volunteer at one centre and paid staff at another.
  const volunteerNames = useMemo(() => {
    const set = new Set();
    for (const u of usersForCentre) {
      if (u.isVolunteer === true && u.displayName) set.add(u.displayName);
    }
    return set;
  }, [usersForCentre]);

  // Owners, super-admins, directors, and the shared "Admin Team" account
  // never belong on payroll — keep their names out by display name (which
  // is what shifts reference). Directors are salaried like owners so
  // the same exclusion applies.
  const hiddenFromOps = useMemo(() => {
    const set = new Set();
    for (const u of users) {
      const hidden = u.role === 'owner' || u.role === 'super_admin' || u.role === 'director'
        || u.internal === true
        || u.displayName === 'Admin Team';
      if (hidden && u.displayName) set.add(u.displayName);
    }
    return set;
  }, [users]);

  // ─── Earlier-in-the-year sick shifts ──────────────────────────────────
  // Sick entitlement is annual, but the live `shifts` listener only covers a
  // 180-day sliding window. By December that window starts in June, so sick
  // days taken earlier in the year are simply absent from `shifts` — and
  // everyone silently looks like they still have allowance left, which would
  // quietly pay sick days that aren't owed. Backfill just the missing slice
  // (Jan 1 → window start) with a ONE-OFF read; it fetches nothing for the
  // first half of the year, and it's the same query shape as the live
  // listener so it needs no extra Firestore index.
  const [priorYearSickShifts, setPriorYearSickShifts] = useState([]);
  useEffect(() => {
    if (!activeCenterId) return;
    const yearStart = `${new Date().getFullYear()}-01-01`;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 180);
    const windowStart = format(cutoff, 'yyyy-MM-dd');
    if (windowStart <= yearStart) { setPriorYearSickShifts([]); return; }
    let cancelled = false;
    getDocs(query(
      collection(db, 'shifts'),
      where('centerId', '==', activeCenterId),
      where('date', '>=', yearStart),
      where('date', '<', windowStart),
    ))
      .then(snap => {
        if (cancelled) return;
        setPriorYearSickShifts(
          snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.sickPay === true),
        );
      })
      .catch(() => { if (!cancelled) setPriorYearSickShifts([]); });
    return () => { cancelled = true; };
  }, [activeCenterId]);

  // Everything needed to count a full calendar year of sick days.
  const shiftsForSickYear = useMemo(
    () => [...shifts, ...priorYearSickShifts],
    [shifts, priorYearSickShifts],
  );

  // Payroll summary — all shifts in the selected pay period grouped by person
  const payrollSummary = useMemo(() => {
    if (!payStart || !payEnd) return [];
    const periodShifts = shifts.filter(s =>
      s.date >= payStart &&
      s.date <= payEnd &&
      s.status !== 'draft' &&
      s.role !== 'Volunteer' &&
      !salaryStaff.has(s.userName) &&
      !volunteerNames.has(s.userName) &&
      !hiddenFromOps.has(s.userName)
    );

    // Also include fixed staff from FIXED_SCHEDULES who may not have Firestore shifts yet
    const byPerson = {};

    // From Firestore shifts. Each shift contributes to either the worked
    // bucket (totalHours / shifts) OR the sick bucket (sickHours / sick
    // shift count) based on its sickPay flag. Worked totals stay the
    // headline figure; sick totals show as a separate column so payroll
    // can pay them out under the sick-pay budget line.
    // Normalize a display name so grouping is robust to trailing
    // whitespace, capitalization, and repeated spaces. Two shifts
    // with userName "Benjamin Gong" and "benjamin gong " must
    // resolve to the same person or payroll will show them as two
    // separate rows (and double-count on export).
    const normName = (n) => (n || '').trim().toLowerCase().replace(/\s+/g, ' ');
    for (const s of periodShifts) {
      // usersForCentre hoists the per-centre instructorType so payroll
      // shows "Host" vs "Instructor" based on what they did AT THIS
      // CENTRE, not whatever they happen to be at another one.
      // Resolve by uid first (stable), fall back to case-insensitive
      // name match so a shift missing userId still groups correctly.
      const user = usersForCentre.find(u =>
        (s.userId && u.uid === s.userId) ||
        normName(u.displayName) === normName(s.userName),
      );
      // Grouping key prefers the resolved user's uid (guaranteed
      // unique per person) so two shifts with slightly different
      // name spellings both land in the same bucket.
      const key = user?.uid || normName(s.userName) || s.userId || 'unknown';
      if (!byPerson[key]) {
        byPerson[key] = {
          // Canonicalise name from the resolved user doc — falls back
          // to whatever the shift stamped if there's no user match.
          name: user?.displayName || s.userName || key,
          userId: user?.uid || s.userId || null,
          role: s.role || user?.instructorType || 'Instructor',
          shifts: [],
          totalHours: 0,
          // payHours = what we actually pay. Defaults to scheduled total
          // but each shift can override (e.g. instructor stayed an extra
          // half hour). See the Pay h column on the per-person table.
          payHours: 0,
          sickHours: 0,
          sickCount: 0,
          // Sick split by entitlement — filled in after the loop, once the
          // whole year's sick dates are known.
          sickPaidHours: 0,
          sickUnpaidHours: 0,
          sickDatesInPeriod: new Map(), // date → hours, for the split below
          noHireDate: false,
          // No-shows — scheduled but not worked. Tracked separately so the
          // headline/scheduled figures can exclude them (they're not owed).
          noShowHours: 0,
          noShowCount: 0,
        };
      }
      const hrs = shiftHours(s);
      const isSick   = !!s.sickPay;
      const isNoShow = !!s.noShow;
      // payHoursOverride is a per-shift owner override. When unset, pay
      // matches scheduled (the centre's default — "we pay what we
      // scheduled"). When set (via double-click on the Pay h cell), the
      // override wins and the diff between scheduled and paid is
      // intentional (early leave / stayed late / negotiated time).
      //
      // No-show forces payHrs to 0 regardless of any override — the
      // instructor didn't come in, they don't get paid. The scheduled
      // hours stay visible in the row so we can see they WERE
      // originally assigned.
      const payHrs = isNoShow
        ? 0
        : (typeof s.payHoursOverride === 'number' && isFinite(s.payHoursOverride))
          ? s.payHoursOverride
          : hrs;
      byPerson[key].shifts.push({
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        hours: hrs,
        payHours: payHrs,
        payHoursOverride: typeof s.payHoursOverride === 'number' ? s.payHoursOverride : null,
        // payrollResolved — admin has explicitly signed off this shift's
        // Pay h value (even when the Sched/Actual diff is flagged red).
        // The red flag dims to green once true; the value remains editable.
        payrollResolved: s.payrollResolved === true,
        // payrollNote — free-text explanation attached to this shift, e.g.
        // "She forgot to sign out. She actually worked 3:15 PM – 5:30 PM."
        // Documentation only: it never changes Pay h or the raw Radius
        // punch times, it just records WHY a row looks the way it does so
        // the reason survives past the person who resolved it.
        payrollNote: typeof s.payrollNote === 'string' ? s.payrollNote : '',
        payrollNoteBy: typeof s.payrollNoteBy === 'string' ? s.payrollNoteBy : '',
        payrollNoteAt: s.payrollNoteAt || null,
        // Sign-out an instructor supplied themselves, when Radius has a
        // clock-in but no tap-out. Must be projected explicitly — this is
        // an allow-list, and signOutState() reads these off the row.
        signOutConfirmedTime: typeof s.signOutConfirmedTime === 'string' ? s.signOutConfirmedTime : '',
        signOutConfirmedBy:   typeof s.signOutConfirmedBy === 'string' ? s.signOutConfirmedBy : '',
        signOutConfirmedAt:   s.signOutConfirmedAt || null,
        signOutRequestSentAt: s.signOutRequestSentAt || null,
        userId: s.userId || null,
        shiftId: s.id,
        sick: isSick,
        noShow: isNoShow,
      });
      if (isSick) {
        byPerson[key].sickHours += hrs;
        byPerson[key].sickCount += 1;
        byPerson[key].sickDatesInPeriod.set(
          s.date, (byPerson[key].sickDatesInPeriod.get(s.date) || 0) + hrs,
        );
      } else {
        byPerson[key].totalHours += hrs;
        byPerson[key].payHours   += payHrs;
        if (isNoShow) {
          byPerson[key].noShowHours += hrs;
          byPerson[key].noShowCount += 1;
        }
      }
    }

    // Sort each person's shifts by date + round totals so the UI doesn't
    // show 7.000000001-style float dust.
    for (const key of Object.keys(byPerson)) {
      byPerson[key].shifts.sort((a, b) => a.date.localeCompare(b.date));
      byPerson[key].totalHours = Math.round(byPerson[key].totalHours * 100) / 100;
      byPerson[key].payHours   = Math.round(byPerson[key].payHours   * 100) / 100;
      byPerson[key].sickHours  = Math.round(byPerson[key].sickHours  * 100) / 100;
      byPerson[key].noShowHours = Math.round(byPerson[key].noShowHours * 100) / 100;
    }

    // ─── Split this period's sick hours into payable vs not ─────────────
    // Needs the person's sick dates for the WHOLE year, because the 5-day
    // allowance is spent chronologically — a sick day in this period is only
    // paid if fewer than 5 were taken before it. Payroll used to add none of
    // it to Total Payable, so every sick hour went unpaid regardless.
    {
      const year = (payStart || '').slice(0, 4);
      const yearSickByName = new Map();
      for (const s of shiftsForSickYear) {
        if (!s.sickPay || !s.userName || !s.date) continue;
        if (!s.date.startsWith(year)) continue;
        const k = normName(s.userName);
        if (!yearSickByName.has(k)) yearSickByName.set(k, new Set());
        yearSickByName.get(k).add(s.date);
      }
      for (const p of Object.values(byPerson)) {
        if (p.sickHours <= 0) continue;
        const user = usersForCentre.find(u =>
          (p.userId && u.uid === p.userId) || normName(u.displayName) === normName(p.name),
        );
        const hire = user?.hireDate
          || (user?.approvedAt?.toDate ? user.approvedAt.toDate().toISOString().slice(0, 10) : null)
          || (user?.createdAt?.toDate  ? user.createdAt.toDate().toISOString().slice(0, 10)  : null);
        p.noHireDate = !hire;
        // Sick days taken outside Ratio spend entitlement too — without them
        // someone who's actually used all 5 still looks like they have one
        // left, and the day gets paid when it shouldn't be.
        const external = (Array.isArray(user?.externalSickDates) ? user.externalSickDates : [])
          .filter(d => typeof d === 'string' && d.startsWith(year));
        const allDates = new Set([
          ...(yearSickByName.get(normName(p.name)) || new Set()),
          ...external,
        ]);
        const paid = paidSickDates(allDates, hire);
        let paidH = 0, unpaidH = 0;
        for (const [ds, hrs] of p.sickDatesInPeriod) {
          if (paid.has(ds)) paidH += hrs; else unpaidH += hrs;
        }
        p.sickPaidHours   = Math.round(paidH * 100) / 100;
        p.sickUnpaidHours = Math.round(unpaidH * 100) / 100;
      }
    }

    // ─── Stat (statutory holiday) pay ───────────────────────────────────
    // For each PAID statutory holiday in the pay period, anyone with 15+
    // DAYS worked in the 30 calendar days before it qualifies, and is paid
    // an average day (total hours ÷ days worked). Rules and the reasoning
    // behind them live in lib/statPay.js, which is unit tested. Multiple
    // stat days in the same pay period add up.
    //
    // Note: people who qualify (15+ prior-30-day shifts) but have NO
    // shifts in the pay period itself won't appear here, since this loop
    // only walks byPerson — which is built from shifts inside the period.
    // Rare (typically a vacationer); admin can add a manual entry.
    // Group EVERY shift by a STABLE person identity for the stat-pay window.
    // Prefer userId; else map the userName to a roster member's uid; else the
    // raw name. This keeps the prior-30-day count correct when a timesheet
    // import (e.g. Radius) tags the same person with a slightly different
    // name than the scheduler used — previously that mismatch zeroed out
    // their stat pay because aggregation was by exact userName.
    const nameToUid = {};
    for (const u of usersForCentre) {
      if (u?.displayName && u?.uid) nameToUid[u.displayName] = u.uid;
    }
    const canonId = (s) => s.userId || nameToUid[s.userName] || s.userName;
    const shiftsByPerson = {};
    for (const s of shifts) {
      if (!s.date) continue;
      const id = canonId(s);
      if (!id) continue;
      if (!shiftsByPerson[id]) shiftsByPerson[id] = [];
      shiftsByPerson[id].push(s);
    }
    // Only genuinely statutory holidays pay. The holidays list also holds
    // ordinary closures — being shut on Sat Aug 1 as well as BC Day on Mon
    // Aug 3 used to pay stat TWICE. See isPaidStatHoliday.
    const statHolidays = (Array.isArray(centerConfig?.holidays) ? centerConfig.holidays : [])
      .filter(h => h?.date && h.date >= payStart && h.date <= payEnd && isPaidStatHoliday(h));
    for (const key of Object.keys(byPerson)) {
      const person = byPerson[key];
      const pid = person.userId || nameToUid[person.name] || person.name;
      const personShifts = shiftsByPerson[pid] || [];
      person.statHours = 0;
      person.statDays = 0;
      person.statEntries = []; // [{ date, name, hours, basisDays, windowStart, totalHrs, days:[...] }]
      for (const h of statHolidays) {
        // Qualification is by DAY worked, not by shift record, and skips
        // drafts / no-shows / volunteer shifts. See lib/statPay.js.
        const r = statPayForHoliday(personShifts, h.date, payableShiftHours);
        if (!r.qualifies) continue;
        person.statHours += r.hours;
        person.statDays  += 1;
        person.statEntries.push({
          date: h.date,
          name: h.name || 'Statutory Holiday',
          hours: r.hours,
          basisDays: r.daysWorked,
          windowStart: r.windowStart,
          totalHrs: r.totalHours,
          // The exact days that qualified this person — the audit trail the
          // Stat Pay export sheet lists so staff can check the math by hand.
          days: r.days,
        });
      }
      person.statHours = Math.round(person.statHours * 100) / 100;
    }

    // Sort people alphabetically by last name
    return Object.values(byPerson).sort((a, b) => {
      const lastA = a.name.split(' ').pop() || a.name;
      const lastB = b.name.split(' ').pop() || b.name;
      return lastA.localeCompare(lastB);
    });
  }, [shifts, shiftsForSickYear, usersForCentre, payStart, payEnd, salaryStaff, volunteerNames, hiddenFromOps, centerConfig]);

  // Force a shift's payroll hours without touching its (broken) times.
  // Unblocks a payroll run today; the times still want fixing on the
  // schedule so the shift stops reading as 0h everywhere else.
  const setGapPayHours = async (shiftId, hours) => {
    if (!shiftId || !(hours > 0)) return;
    try {
      await updateDoc(doc(db, 'shifts', shiftId), {
        payHoursOverride: hours,
        payrollResolved: true,
      });
      toast.success(`Set to ${hours}h — fix the shift times on the schedule too.`);
    } catch (e) { toast.error(e?.message || 'Failed to update.'); }
  };

  // ─── Shifts in this period that pay nothing ───────────────────────────
  // Payroll silently drops anything still in DRAFT — new shifts land as
  // drafts and only enter payroll once published. So a shift that someone
  // genuinely worked can be missing from payroll entirely, with no warning
  // anywhere: they just get paid nothing for it. (Summer Camp / STEAM flex
  // shifts are NOT excluded by role — that part works fine; it's the draft
  // status that hides them.)
  //
  // This surfaces every shift in the period contributing zero hours, with
  // the reason, so it's caught before the export instead of after payday.
  // Deliberate exclusions — volunteers, salaried, hidden accounts, no-shows
  // — are left out; they're intentional and already visible elsewhere.
  const payrollGaps = useMemo(() => {
    if (!payStart || !payEnd) return [];
    const out = [];
    for (const s of shifts) {
      if (!s.date || s.date < payStart || s.date > payEnd) continue;
      const name = s.userName || '(unnamed)';
      if (s.role === 'Volunteer' || volunteerNames.has(name)) continue;
      if (salaryStaff.has(name) || hiddenFromOps.has(name)) continue;
      if (s.noShow === true) continue;
      let reason = null;
      if (s.status === 'draft') reason = 'Still a draft — publish it to pay it';
      else if (!s.startTime || !s.endTime) reason = 'No start/end time — counts as 0 hours';
      else if (shiftHours(s) <= 0) reason = 'Start and end are the same — 0 hours';
      else if (s.payHoursOverride === 0) reason = 'Payroll hours manually set to 0';
      if (!reason) continue;
      out.push({
        shift: s,
        id: s.id,
        date: s.date,
        name,
        reason,
        isDraft: s.status === 'draft',
        label: `${s.flexRole || s.role || 'Instructor'} · ${fmtHHMM(s.startTime) || '?'}–${fmtHHMM(s.endTime) || '?'}`,
        hours: shiftHours(s),
      });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  }, [shifts, payStart, payEnd, salaryStaff, volunteerNames, hiddenFromOps]);

  // Sick days tracker — per-user counts for the current calendar year.
  //
  // Policy: every employee who has completed 3-month probation is eligible
  // for 5 sick days per calendar year (BC ESA minimum). We count any
  // shifts with sickPay === true in the current year, regardless of pay
  // period. Probation start date is taken from the user's hireDate field
  // if set; otherwise falls back to the Firestore createdAt timestamp.
  const sickDaysSummary = useMemo(() => {
    const now = new Date();
    const yearStart = `${now.getFullYear()}-01-01`;
    const yearEnd   = `${now.getFullYear()}-12-31`;
    const today     = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

    // Used = count of distinct dates with sick shifts in the current year.
    // (If they took half a day sick, we count it as 1 — same as employers
    // typically do.)
    const sickDatesByName = new Map();
    for (const s of shiftsForSickYear) {
      if (!s.sickPay || !s.userName || !s.date) continue;
      if (s.date < yearStart || s.date > yearEnd) continue;
      if (!sickDatesByName.has(s.userName)) sickDatesByName.set(s.userName, new Set());
      sickDatesByName.get(s.userName).add(s.date);
    }

    const out = [];
    for (const u of approvedUsers) {
      if (!u.displayName) continue;
      // Skip people we already exclude from payroll (volunteers, hidden).
      if (volunteerNames.has(u.displayName) || hiddenFromOps.has(u.displayName)) continue;

      // Probation calculation
      const hire = u.hireDate
        || (u.approvedAt?.toDate ? u.approvedAt.toDate().toISOString().slice(0,10) : null)
        || (u.createdAt?.toDate  ? u.createdAt.toDate().toISOString().slice(0,10)  : null);
      let onProbation = true, daysIn = 0;
      if (hire) {
        const d1 = new Date(hire + 'T00:00:00');
        const d2 = new Date(today + 'T00:00:00');
        daysIn = Math.floor((d2 - d1) / (24 * 3600 * 1000));
        onProbation = daysIn < PROBATION_DAYS;
      }

      // Days taken outside Ratio (previous employer's records, a day nobody
      // logged, a centre transfer) have no shift to count, but they still
      // spend the annual entitlement. Recorded by hand on this tab.
      const externalSickDates = (Array.isArray(u.externalSickDates) ? u.externalSickDates : [])
        .filter(d => typeof d === 'string' && d >= yearStart && d <= yearEnd)
        .sort();
      const allSickDates = new Set([
        ...(sickDatesByName.get(u.displayName) || new Set()),
        ...externalSickDates,
      ]);
      const used = allSickDates.size;
      const remaining = onProbation ? 0 : Math.max(0, SICK_DAYS_PER_YEAR - used);

      out.push({
        uid: u.uid,
        name: u.displayName,
        role: u.instructorType || 'Instructor',
        hireDate: hire,
        daysIn,
        onProbation,
        used,
        remaining,
        eligible: !onProbation,
        // Per-date list for the expandable tooltip
        sickDates: [...(sickDatesByName.get(u.displayName) || new Set())].sort(),
        externalSickDates,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [shiftsForSickYear, approvedUsers, volunteerNames, hiddenFromOps]);

  // Sub-tab inside Manage Payroll: "This period" or "Sick days".
  const [payrollSubtab, setPayrollSubtab] = useState('period');

  // Diagnostic for stat pay — flags WHY a person did or didn't qualify
  // for stat pay on each holiday in the pay period. Used by the small
  // info panel on the payroll tab when stat pay isn't showing up.
  const statDiagnostic = useMemo(() => {
    if (!payStart || !payEnd) return null;
    const holidaysList = Array.isArray(centerConfig?.holidays) ? centerConfig.holidays : [];
    const allInPeriod = holidaysList.filter(h => h?.date && h.date >= payStart && h.date <= payEnd);
    // Only real statutory holidays pay. Plain closures are surfaced
    // separately so it's obvious why they aren't generating stat pay,
    // rather than them just silently vanishing from this tab.
    const inPeriod = allInPeriod.filter(isPaidStatHoliday);
    const closuresInPeriod = allInPeriod.filter(h => !isPaidStatHoliday(h));
    // Aggregate by a STABLE identity (userId, else roster-name→uid, else raw
    // name) so a timesheet import that renames a person slightly doesn't
    // split their shifts and hide their stat-pay qualification. Mirrors the
    // payroll calc above.
    const nameToUid = {};
    const uidToName = {};
    for (const u of usersForCentre) {
      if (u?.displayName && u?.uid) { nameToUid[u.displayName] = u.uid; uidToName[u.uid] = u.displayName; }
    }
    const canonId = (s) => s.userId || nameToUid[s.userName] || s.userName;
    // Exclude the same people the hourly payroll excludes — salaried staff
    // (e.g. the Centre Director + Director of Education), volunteers, and
    // anyone hidden from ops. Stat pay is an hourly-staff entitlement, so
    // these roles shouldn't appear in the diagnostic or the Stat Pay tab.
    const isExcluded = (name) =>
      salaryStaff.has(name) || volunteerNames.has(name) || hiddenFromOps.has(name);
    const byPerson = {};
    for (const s of shifts) {
      if (!s.date) continue;
      const id = canonId(s);
      if (!id) continue;
      const dispName = uidToName[id] || s.userName || id;
      if (isExcluded(dispName) || isExcluded(s.userName)) continue;
      if (!byPerson[id]) byPerson[id] = { name: dispName, shifts: [] };
      byPerson[id].shifts.push(s);
    }
    // Uses the same lib as the payroll calc, so this tab and the money can
    // never disagree — they used to be two separate copies of the rule.
    const detail = inPeriod.map(h => {
      const perPerson = Object.values(byPerson).map(p => {
        const r = statPayForHoliday(p.shifts, h.date, payableShiftHours);
        return {
          name: p.name, count: r.daysWorked, qualifies: r.qualifies, statHours: r.hours,
          // Carried through so the roster can show what made up the count.
          // Paid sick days legally qualify, which looks wrong at a glance
          // unless the split is visible.
          sickDays: r.sickDays, workedDays: r.workedDays,
          // Full working for the expandable breakdown: every qualifying day
          // and the two numbers the average is built from. Cheap to carry —
          // it's already computed — and it saves exporting a spreadsheet
          // just to answer "why is this person's stat pay 4.88?".
          days: r.days, totalHours: r.totalHours, windowStart: r.windowStart,
        };
      }).sort((a, b) => b.count - a.count);
      return { holiday: h, windowStart: statPayForHoliday([], h.date, payableShiftHours).windowStart, perPerson };
    });
    return {
      holidaysConfigured: holidaysList.length,
      inPeriod,
      closuresInPeriod,
      detail,
    };
  }, [shifts, usersForCentre, centerConfig?.holidays, payStart, payEnd, salaryStaff, volunteerNames, hiddenFromOps]);

  // Roster shape for the Stat Pay sub-tab (mirrors sickDaysSummary). One row
  // per person, merged across every stat holiday in the period, with role
  // looked up from payroll / the centre roster.
  const statPaySummary = useMemo(() => {
    if (!statDiagnostic || statDiagnostic.inPeriod.length === 0) {
      return { holidays: [], rows: [] };
    }
    const roleByName = new Map();
    for (const p of payrollSummary) roleByName.set(p.name, p.role);
    for (const u of usersForCentre) {
      if (u.displayName && !roleByName.has(u.displayName)) {
        roleByName.set(u.displayName, u.instructorType || 'Instructor');
      }
    }
    const byName = new Map();
    for (const d of statDiagnostic.detail) {
      for (const p of d.perPerson) {
        if (!byName.has(p.name)) {
          byName.set(p.name, {
            name: p.name,
            role: roleByName.get(p.name) || 'Instructor',
            perHoliday: [],
            totalStat: 0,
            qualifies: false,
          });
        }
        const row = byName.get(p.name);
        row.perHoliday.push({
          holiday: d.holiday, count: p.count, qualifies: p.qualifies, statHours: p.statHours,
          sickDays: p.sickDays, workedDays: p.workedDays,
          days: p.days, totalHours: p.totalHours, windowStart: p.windowStart,
        });
        if (p.qualifies) { row.totalStat += p.statHours; row.qualifies = true; }
      }
    }
    const rows = [...byName.values()]
      .map(r => ({
        ...r,
        totalStat: Math.round(r.totalStat * 100) / 100,
        // Highest window shift count across the period's holidays — used to
        // rank the not-yet-eligible staff by who's closest to the 15 mark.
        shifts: r.perHoliday.reduce((mx, h) => Math.max(mx, h.count || 0), 0),
        // Sick/worked split from whichever holiday supplied that peak count,
        // so the breakdown shown always adds up to the number beside it.
        sickDays: (r.perHoliday.reduce(
          (best, h) => (!best || (h.count || 0) > (best.count || 0)) ? h : best, null,
        ) || {}).sickDays || 0,
      }))
      .sort((a, b) => {
        if (a.qualifies !== b.qualifies) return Number(b.qualifies) - Number(a.qualifies);
        // Eligible: highest stat pay first. Not yet eligible: closest to 15 first.
        if (a.qualifies) return (b.totalStat - a.totalStat) || a.name.localeCompare(b.name);
        return (b.shifts - a.shifts) || a.name.localeCompare(b.name);
      });
    return { holidays: statDiagnostic.inPeriod, rows };
  }, [statDiagnostic, payrollSummary, usersForCentre]);

  // Update a user's hire date (used by the Sick days tab so the owner
  // can correct probation dates without going to Manage Staff).
  const handleSetHireDate = async (userId, dateStr) => {
    if (!userId) return;
    await updateDoc(doc(db, 'users', userId), { hireDate: dateStr || null });
  };

  // Sick days taken outside Ratio. Stored on the user because they're a
  // property of the person's year, not of any shift — there is no shift.
  const handleAddExternalSickDate = async (userId, dateStr) => {
    if (!userId || !dateStr) return;
    const u = users.find(x => (x.uid || x.id) === userId);
    const cur = Array.isArray(u?.externalSickDates) ? u.externalSickDates : [];
    if (cur.includes(dateStr)) return;
    try {
      await updateDoc(doc(db, 'users', userId), {
        externalSickDates: [...cur, dateStr].sort(),
      });
      toast.success('Recorded — it now counts against their 5 days.');
    } catch (e) { toast.error(e?.message || 'Failed to update.'); }
  };
  const handleRemoveExternalSickDate = async (userId, dateStr) => {
    if (!userId || !dateStr) return;
    const u = users.find(x => (x.uid || x.id) === userId);
    const cur = Array.isArray(u?.externalSickDates) ? u.externalSickDates : [];
    try {
      await updateDoc(doc(db, 'users', userId), {
        externalSickDates: cur.filter(d => d !== dateStr),
      });
    } catch (e) { toast.error(e?.message || 'Failed to update.'); }
    try { toast.success('Hire date saved'); } catch { /* ignore */ }
  };

  // Pay period helpers
  const payPeriodLabel = payStart && payEnd
    ? `${new Date(payStart + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(payEnd + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    : '';

  // Payout date label — for centres on the 11th–25th / 26th–10th schedule
  // the pattern is: period ending on the 25th → paid on the 30th; period
  // ending on the 10th → paid on the 15th. Both fall 5 days after the
  // period close. If the centre's period ends on a different day, we
  // still show end+5 (e.g. ending 31st → paid 5 days later) which matches
  // the same "5-day arrears" cadence.
  const payoutLabel = payEnd ? (() => {
    const end = new Date(payEnd + 'T00:00:00');
    end.setDate(end.getDate() + 5);
    return end.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  })() : '';

  // Headline "Total hours" = what we actually PAY, i.e. the sum of Pay h.
  // That means no-shows count 0 and per-shift overrides are honoured — the
  // same number Export Final Payroll ships to QuickBooks. (It used to sum
  // scheduled hours, so a no-show still inflated the period total.)
  const totalPayrollHours = payrollSummary.reduce((s, p) => s + (p.payHours ?? p.totalHours), 0);
  // Scheduled total kept separate — the export's Detail sheet needs a real
  // "Scheduled h" grand total, which is NOT the same number now that the
  // headline nets off no-shows and honours Pay h overrides.
  const totalScheduledHours = payrollSummary.reduce((s, p) => s + (p.totalHours || 0), 0);
  const totalNoShowHours  = payrollSummary.reduce((s, p) => s + (p.noShowHours || 0), 0);
  const totalNoShowCount  = payrollSummary.reduce((s, p) => s + (p.noShowCount || 0), 0);

  // What actually gets paid: worked + payable sick + stat. Worked hours
  // alone were the only figure on screen, so a sick day looked like it had
  // simply gone missing — the money was never added up anywhere you could
  // see it before the export.
  const payableFor = (p) =>
    (p.payHours ?? p.totalHours ?? 0) + (p.sickPaidHours || 0) + (p.statHours || 0);
  const totalPayableHours = payrollSummary.reduce((s, p) => s + payableFor(p), 0);
  const totalSickPaidHours = payrollSummary.reduce((s, p) => s + (p.sickPaidHours || 0), 0);
  const totalStatHours = payrollSummary.reduce((s, p) => s + (p.statHours || 0), 0);

  // Add / remove a staff member from the salaryStaff list (which the payroll
  // filter uses to keep salaried people off the hourly sheet). Writes are
  // merged so the rest of the centre config is untouched.
  const handleExcludeFromPayroll = async (name) => {
    if (!activeCenterId || !name) return;
    const current = Array.isArray(centerConfig?.salaryStaff) ? centerConfig.salaryStaff : [];
    if (current.includes(name)) return;
    await setDoc(
      doc(db, 'centers', activeCenterId, 'config', 'main'),
      { salaryStaff: [...current, name], updatedAt: serverTimestamp() },
      { merge: true },
    );
  };
  const handleIncludeInPayroll = async (name) => {
    if (!activeCenterId || !name) return;
    const current = Array.isArray(centerConfig?.salaryStaff) ? centerConfig.salaryStaff : [];
    if (!current.includes(name)) return;
    await setDoc(
      doc(db, 'centers', activeCenterId, 'config', 'main'),
      { salaryStaff: current.filter(n => n !== name), updatedAt: serverTimestamp() },
      { merge: true },
    );
  };

  // Map an instructorType / role string to the short code used in the
  // owner's existing QuickBooks worksheet. Best-effort — anything we
  // don't recognise defaults to 'I' (Instructor). Update the mapping
  // here if the centre adds a new role abbreviation.
  const roleAbbrev = (role) => {
    const r = String(role || '').toLowerCase();
    if (r.includes('director'))  return 'CD';
    if (r.includes('manager'))   return 'CD';
    if (r.includes('assistant')) return 'ACD';
    if (r.includes('admin'))     return 'ACD';
    if (r.includes('lead'))      return 'LI';
    if (r.includes('volunteer')) return 'V';
    if (r.includes('host'))      return 'I';
    return 'I';
  };

  // Export to XLSX — two sheets:
  //   1. "Detail"     — every shift, per person + totals (existing format)
  //   2. "Attendance" — one row per person for QuickBooks (Total Hours =
  //      Payroll Hours, the owner's bookkeeping value). Volunteers count
  //      0 in the Employees column; everyone else is 1. Sick pay sums the
  //      per-person sickHours. Special Cases stays empty for manual fill.
  const handleExportPayroll = async () => {
    const fmtTime = (t) => {
      if (!t) return '';
      const [hStr, mStr] = t.split(':');
      let h = parseInt(hStr, 10);
      const m = parseInt(mStr, 10);
      const ampm = h >= 12 ? 'PM' : 'AM';
      if (h > 12) h -= 12;
      if (h === 0) h = 12;
      return `${h}:${String(m).padStart(2,'0')} ${ampm}`;
    };

    // Dynamically load SheetJS (same pattern as the Radius importer).
    if (!window.XLSX) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
    const XLSX = window.XLSX;

    // ── Sheet 1: Detail (per shift, per person + per-person totals) ──
    // Note rides along as the last column so a resolved row carries its
    // justification into the file — an auditor reading the export sees WHY
    // a shift was paid the way it was, not just that someone signed off.
    const detailRows = [
      ['Name', 'Role', 'Date', 'Start', 'End', 'Scheduled h', 'Payroll h', 'Resolved', 'Note'],
    ];
    for (const person of payrollSummary) {
      for (const s of person.shifts) {
        const dateLabel = new Date(s.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        detailRows.push([
          person.name,
          person.role,
          dateLabel,
          fmtTime(s.startTime),
          fmtTime(s.endTime),
          s.hours.toFixed(2),
          (s.payHours ?? s.hours).toFixed(2),
          s.payrollResolved ? '✓' : '',
          s.payrollNote || '',
        ]);
      }
      detailRows.push([
        person.name, '', 'TOTAL', '', '',
        person.totalHours.toFixed(2),
        (person.payHours ?? person.totalHours).toFixed(2),
        '',
        '',
      ]);
      detailRows.push([]);
    }
    const grandPay = payrollSummary.reduce(
      (s, p) => s + (p.payHours ?? p.totalHours ?? 0), 0,
    );
    detailRows.push([
      '', '', 'GRAND TOTAL', '', '',
      Math.round(totalScheduledHours * 100) / 100,
      Math.round(grandPay * 100) / 100,
      '',
      '',
    ]);

    // ── Sheet 2: Attendance (QuickBooks-shaped) ──
    // Column meanings, left to right:
    //   Employee Attendance — name (role abbrev)
    //   Regular Pay         — hours actually worked (was "Total Hours")
    //   Employees           — 1 per paid head, blank for volunteers
    //   Sick Pay            — payable sick hours (first 5 days/yr, post-probation)
    //   Sick (Unpaid)       — sick beyond entitlement: recorded, not paid
    //   Stat Holiday Pay    — stat hours (was "Stat Pay Hrs")
    //   Total Hours         — worked + payable sick + stat (was "Total Payable Hrs")
    //   Special Cases       — data-gap notes
    // Heads up for future edits: "Total Hours" names the GRAND TOTAL here.
    // It used to name the worked-hours column, which is now "Regular Pay".
    const attendanceRows = [
      ['Employee Attendance', 'Regular Pay', 'Employees', 'Sick Pay', 'Sick (Unpaid)', 'Stat Holiday Pay', 'Total Hours', 'Special Cases'],
    ];
    let totalHoursSum = 0;
    let employeesCount = 0;
    let sickSum = 0;
    let sickUnpaidSum = 0;
    let statSum = 0;
    // Sort alphabetically by last name where possible — matches the
    // owner's existing template format.
    const lastNameKey = (n) => {
      const parts = String(n || '').trim().split(/\s+/);
      return (parts[parts.length - 1] || '').toLowerCase();
    };
    const sorted = [...payrollSummary].sort((a, b) =>
      lastNameKey(a.name).localeCompare(lastNameKey(b.name)),
    );
    for (const person of sorted) {
      const abbrev = roleAbbrev(person.role);
      const isVolunteer = abbrev === 'V';
      const totalH = Math.round((person.payHours ?? person.totalHours ?? 0) * 100) / 100;
      // Sick splits by entitlement: the first 5 days of the calendar year
      // (after probation) are payable, the rest are recorded but unpaid.
      const sickH       = Math.round((person.sickPaidHours   || 0) * 100) / 100;
      const sickUnpaidH = Math.round((person.sickUnpaidHours || 0) * 100) / 100;
      const statH = Math.round((person.statHours || 0) * 100) / 100;
      // Total payable = worked + PAYABLE sick + stat. Sick used to be left
      // out entirely, so with no stat pay this column just mirrored Total
      // Hours and every sick hour in the sheet was paid to nobody.
      const payableH = Math.round((totalH + sickH + statH) * 100) / 100;
      // Flag the data gap rather than silently guessing at eligibility.
      const notes = person.noHireDate && (sickH > 0 || sickUnpaidH > 0)
        ? 'No hire date on file — sick paid by default; confirm probation'
        : '';
      attendanceRows.push([
        `${person.name} (${abbrev})`,
        totalH || '',
        isVolunteer ? '' : 1,
        sickH || '',
        sickUnpaidH || '',
        statH || '',
        payableH || '',
        notes,
      ]);
      totalHoursSum += totalH;
      if (!isVolunteer) employeesCount += 1;
      sickSum += sickH;
      sickUnpaidSum += sickUnpaidH;
      statSum += statH;
    }
    attendanceRows.push([]);
    attendanceRows.push([
      'Totals',
      Math.round(totalHoursSum * 100) / 100,
      employeesCount,
      Math.round(sickSum * 100) / 100 || '',
      Math.round(sickUnpaidSum * 100) / 100 || '',
      Math.round(statSum * 100) / 100 || '',
      Math.round((totalHoursSum + sickSum + statSum) * 100) / 100 || '',
      '',
    ]);

    // ── Sheet 3: Stat Pay audit (only when the period has a stat holiday
    // with qualifiers). A failsafe list of exactly which shifts made each
    // person qualify, so staff can eyeball the average-day math by hand. ──
    const anyStat = payrollSummary.some(p => (p.statEntries || []).length > 0);
    const statRows = [];
    if (anyStat) {
      statRows.push(['Stat Pay Audit', `${payStart} to ${payEnd}`]);
      statRows.push(['Qualify = 15+ DAYS worked in the 30 days before the holiday (two shifts in one day count once). Stat pay hours = total hours in that window ÷ days worked. Drafts, no-shows and volunteer shifts are excluded; paid sick days count.']);
      statRows.push([]);
      // Distinct holidays in play, chronological.
      const holidayMap = new Map();
      for (const p of payrollSummary) {
        for (const e of (p.statEntries || [])) {
          if (!holidayMap.has(e.date)) holidayMap.set(e.date, { date: e.date, name: e.name, windowStart: e.windowStart });
        }
      }
      const holidays = [...holidayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
      for (const h of holidays) {
        statRows.push([`${h.name} · ${h.date}`, `window ${h.windowStart} → ${h.date}`]);
        const people = payrollSummary
          .filter(p => (p.statEntries || []).some(e => e.date === h.date))
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const p of people) {
          const e = p.statEntries.find(x => x.date === h.date);
          statRows.push([]);
          statRows.push([p.name, `${e.basisDays} days worked`, `stat pay: ${e.hours.toFixed(2)}h`]);
          statRows.push(['', 'Date', 'Hours that day', '']);
          for (const d of (e.days || [])) statRows.push(['', d.date, d.hours, '']);
          statRows.push(['', '', `Total ${e.totalHrs}h ÷ ${e.basisDays} days`, `avg ${e.hours.toFixed(2)}h`]);
        }
        statRows.push([]);
        statRows.push([]);
      }
    }

    // ── Workbook assembly ──
    const wb = XLSX.utils.book_new();
    const wsAttendance = XLSX.utils.aoa_to_sheet(attendanceRows);
    const wsDetail     = XLSX.utils.aoa_to_sheet(detailRows);
    // Reasonable default column widths so the file opens looking right.
    // Sized to the header text — "Stat Holiday Pay" and "Sick (Unpaid)" are
    // wider than the old titles, and Special Cases holds a full sentence.
    wsAttendance['!cols'] = [
      { wch: 28 }, { wch: 13 }, { wch: 11 }, { wch: 10 }, { wch: 14 }, { wch: 18 }, { wch: 13 }, { wch: 52 },
    ];
    wsDetail['!cols'] = [
      { wch: 22 }, { wch: 14 }, { wch: 16 }, { wch: 10 }, { wch: 10 },
      { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 52 },
    ];
    // Attendance first so it's the default tab when opened (it's the
    // sheet the owner actually files in QuickBooks).
    XLSX.utils.book_append_sheet(wb, wsAttendance, 'Attendance');
    XLSX.utils.book_append_sheet(wb, wsDetail,     'Detail');
    // Stat Pay audit sheet only appears when the period actually has stat pay.
    if (anyStat) {
      const wsStat = XLSX.utils.aoa_to_sheet(statRows);
      wsStat['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 22 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, wsStat, 'Stat Pay');
    }
    XLSX.writeFile(wb, `payroll_${payStart}_to_${payEnd}.xlsx`);
  };

  // Parse Radius XLSX export — loads xlsx via script tag (no npm needed).
  //
  // We do NOT hard-code column indices (`row[2]`, `row[4]`, ...). Radius
  // changed their column order in the past and silently broke this import.
  // Instead we locate the header row by looking for a known cell value
  // ("Employee Name") and build a name→index map. If Radius adds or moves
  // a column, the import still works as long as the header text is intact.
  const handleRadiusImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setRadiusError('');
    setRadiusFileName(file.name);

    try {
      // Dynamically load SheetJS from CDN if not already loaded
      if (!window.XLSX) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }

      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });

      // Parsing lives in src/lib/radiusTimesheet.js so it can be run against
      // real export files in tests — it used to be inline here, which meant
      // the only way to find out whether it handled a given file was to
      // click Upload and squint. That is how missed sign-outs stayed broken.
      const { entries, error } = parseRadiusRows(rows);
      if (error) {
        setRadiusError(error);
        return;
      }
      setRadiusData(entries);
    } catch (err) {
      setRadiusError('Failed to parse file. Make sure it is the Radius Excel export.');
      console.error(err);
    }
    e.target.value = '';
  };

  const updateRadiusEntry = (index, field, value) => {
    setRadiusData(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      if (field === 'timeIn' || field === 'timeOut') {
        const entry = updated[index];
        updated[index] = { ...updated[index], actualHours: calcTimeDiffHours(entry.timeIn, entry.timeOut) };
      }
      return updated;
    });
  };

  const deleteRadiusEntry = (index) => {
    setRadiusData(prev => prev.filter((_, i) => i !== index));
  };

  // ── Pay h override (per-shift) ──────────────────────────────────────
  // The Pay h column on the payroll table defaults to the scheduled
  // hours. Owners can double-click any cell to override (e.g. when an
  // instructor stays an extra half hour or leaves early). Persisting
  // null/empty REMOVES the override so the column reverts to scheduled.
  //
  // Writes go straight to the shift doc — payrollSummary re-derives
  // from `shifts` on the next snapshot, so the column + per-person Pay
  // total update without any local state plumbing.
  const [payEditing, setPayEditing] = useState({ shiftId: null, draft: '' });
  const beginPayEdit = (shift) => {
    setPayEditing({
      shiftId: shift.shiftId,
      draft: (shift.payHoursOverride ?? shift.hours).toString(),
    });
  };
  const commitPayEdit = async () => {
    const { shiftId, draft } = payEditing;
    if (!shiftId) return;
    setPayEditing({ shiftId: null, draft: '' });
    const trimmed = (draft || '').trim();
    try {
      if (trimmed === '') {
        // Empty input = reset to scheduled. Persist deleteField() so the
        // shift doc actually loses the override rather than carrying a 0.
        await updateDoc(doc(db, 'shifts', shiftId), { payHoursOverride: deleteField() });
        toast.success('Pay hours reset to scheduled.');
        return;
      }
      const n = Number(trimmed);
      if (!isFinite(n) || n < 0) { toast.error('Pay hours must be a number ≥ 0.'); return; }
      await updateDoc(doc(db, 'shifts', shiftId), { payHoursOverride: Math.round(n * 100) / 100 });
    } catch (e) { toast.error(e?.message || 'Failed to save pay hours.'); }
  };
  const cancelPayEdit = () => setPayEditing({ shiftId: null, draft: '' });

  // ── Resolve flagged payroll row ─────────────────────────────────────
  // Pressing the ✓ button on a red (discrepant / missing-from-Radius)
  // shift marks it acknowledged by the admin. The Pay h value stays
  // editable — resolve is "I've reviewed this and the Pay h I set is
  // what we're paying," not a freeze. Stored per-shift so it survives
  // page reloads and is visible to anyone who opens the period later.
  const handleResolveShift = async (shiftId, next = true) => {
    if (!shiftId) return;
    try {
      await updateDoc(doc(db, 'shifts', shiftId), { payrollResolved: !!next });
    } catch (e) { toast.error(e?.message || 'Failed to update.'); }
  };

  // ── Shift notes ─────────────────────────────────────────────────────
  // A note explains WHY a row was resolved the way it was. Without one,
  // "Resolved" is an unexplained override: two months later nobody knows
  // whether Joanne was paid 2.00h because she forgot to clock out or
  // because someone fat-fingered the number. The note is the audit trail.
  //
  // Deliberately documentation-only. Writing "she actually worked
  // 3:15–5:30" does NOT rewrite the Radius punch times or Pay h — the
  // raw clock data stays intact and the diff stays visible. The note
  // sits alongside the discrepancy, it doesn't paper over it.
  const [noteEditing, setNoteEditing] = useState({ shiftId: null, draft: '' });

  // Suggested wording, offered when resolving. The overwhelmingly common
  // case is a missed sign-out — someone clocks in, teaches, and walks
  // out without tapping out, so Radius shows a wildly long shift. We
  // pre-fill the scheduled times because that's almost always what they
  // actually worked. Fully editable; it's a starting point, not a claim.
  const buildNoteTemplate = (s, fmtT) => {
    if (!s) return '';
    const span = `${fmtT(s.startTime)} – ${fmtT(s.endTime)}`;
    if (s.missingFromRadius) {
      return `No clock-in recorded. Worked the scheduled shift, ${span}.`;
    }
    // Clocked out much later than scheduled — the classic forgotten tap-out.
    if (s.shiftDiff > 0.5) {
      return `Forgot to sign out. Actually worked ${span}.`;
    }
    if (s.shiftDiff < -0.5) {
      return `Left early / short shift. Paying the scheduled ${span}.`;
    }
    return '';
  };

  const beginNoteEdit = (shift, prefill = '') => {
    setNoteEditing({
      shiftId: shift.shiftId,
      draft: shift.payrollNote || prefill || '',
    });
  };
  const cancelNoteEdit = () => setNoteEditing({ shiftId: null, draft: '' });

  const commitNoteEdit = async () => {
    const { shiftId, draft } = noteEditing;
    if (!shiftId) return;
    const trimmed = (draft || '').trim();
    setNoteEditing({ shiftId: null, draft: '' });
    try {
      // Clearing the box removes the note entirely rather than storing an
      // empty string, so the icon reverts to its outlined "no note" state.
      await updateDoc(doc(db, 'shifts', shiftId), trimmed
        ? {
            payrollNote: trimmed,
            payrollNoteBy: user?.displayName || user?.email || 'Admin',
            payrollNoteAt: new Date().toISOString(),
          }
        : {
            payrollNote: deleteField(),
            payrollNoteBy: deleteField(),
            payrollNoteAt: deleteField(),
          });
    } catch (e) { toast.error(e?.message || 'Failed to save note.'); }
  };

  // Resolving opens the note field pre-filled instead of silently closing
  // the row. Skippable — the Resolve still lands immediately, the note
  // box just stays open awaiting an explanation.
  const handleResolveWithNote = async (shift, fmtT) => {
    await handleResolveShift(shift.shiftId, true);
    if (!shift.payrollNote) beginNoteEdit(shift, buildNoteTemplate(shift, fmtT));
  };

  // ── Mark a payroll row as a No Show ─────────────────────────────────
  // The instructor was scheduled but didn't come in. The shift stays on
  // the sheet (greyed) so it's visible that they WERE assigned, but it
  // pays 0 and drops out of the period's Total hours + the export.
  //
  // Marking also clears any manual Pay h override (it's moot at 0) and
  // auto-resolves the row — "not in Radius because they didn't show" is
  // an explanation, not an outstanding discrepancy. Un-marking restores
  // scheduled pay and re-flags the row for review.
  const handleToggleNoShow = async (shiftId, next = true) => {
    if (!shiftId) return;
    try {
      await updateDoc(doc(db, 'shifts', shiftId), next
        ? { noShow: true,  payHoursOverride: null, payrollResolved: true }
        : { noShow: false, payrollResolved: false });
    } catch (e) { toast.error(e?.message || 'Failed to update.'); }
  };

  // Export gated by unresolved count. When everything's resolved, just
  // export. When some are still flagged, confirm before letting them
  // proceed — admin should know what they're shipping.
  const handleExportFinalPayroll = async (unresolvedCount) => {
    if (unresolvedCount > 0) {
      const ok = await confirmDialog({
        title: `${unresolvedCount} discrepancy ${unresolvedCount === 1 ? 'is' : 'are'} still unresolved`,
        message: `Some payroll rows are flagged as needing review and haven't been marked Resolved. Export anyway?`,
        confirmText: 'Export anyway',
        cancelText: 'Cancel — let me resolve first',
        danger: true,
      });
      if (!ok) return;
    }
    handleExportPayroll();
  };

  /**
   * Every "signed in, never signed out" row in the loaded period.
   *
   * Flattened across people so the admin sees one list to act on rather
   * than hunting amber badges down a long table. Rows already confirmed
   * drop out on their own — their state is 'self-confirmed', not 'open'.
   */
  const openSignOuts = useMemo(() => {
    if (!comparisonSummary) return [];
    const out = [];
    for (const person of comparisonSummary.perPerson || []) {
      for (const s of person.shiftComparisons || []) {
        // 'open' means the shift has ended and there is still no tap-out.
        // 'in-progress' (they're at work right now) is excluded by that check
        // — a real export taken at 4pm had 14 of its 17 open punches in that
        // state, and emailing them would have asked people at their desks to
        // confirm they'd gone home.
        if (!s || s.signOutState !== 'open' || s.noShow) continue;
        out.push({ person: person.name, userId: s.userId, shift: s, row: s.actual });
      }
    }
    return out.sort((a, b) => a.shift.date.localeCompare(b.shift.date)
      || a.person.localeCompare(b.person));
  }, [comparisonSummary]);

  const [sendingSignOuts, setSendingSignOuts] = useState(false);

  /**
   * Email each affected instructor a one-tap confirm link.
   *
   * Deliberately admin-triggered rather than automatic on import. The same
   * period gets imported more than once — a partial export, a corrected
   * file, a second look — and firing staff email on every upload would
   * send duplicates for shifts still being checked. A human presses this
   * when the list looks right.
   *
   * A token doc is written first and the email only goes out if that
   * succeeded, so there is never a link in someone's inbox that Ratio
   * can't redeem. Failures are reported per person; one bad address
   * doesn't stop the rest.
   */
  const handleSendSignOutRequests = async () => {
    if (openSignOuts.length === 0 || sendingSignOuts) return;
    const ok = await confirmDialog({
      title: `Email ${openSignOuts.length} ${openSignOuts.length === 1 ? 'instructor' : 'instructors'}?`,
      message: `Each person gets a link to confirm the scheduled finish time for their shift. `
             + `The link works once and expires in ${SIGNOUT_TTL_DAYS} days. `
             + `Anyone who already confirmed is not included.`,
      confirmText: `Send ${openSignOuts.length}`,
      cancelText: 'Cancel',
    });
    if (!ok) return;

    setSendingSignOuts(true);
    let sent = 0;
    const failed = [];
    try {
      // Emails live in users/{uid}/private/contact, so they have to be
      // fetched rather than read off the user doc.
      const withEmail = await attachEmails(
        users.filter(u => openSignOuts.some(o => o.userId && o.userId === u.id)),
      );
      const emailById = new Map(withEmail.map(u => [u.id, u]));

      for (const item of openSignOuts) {
        const u = item.userId ? emailById.get(item.userId) : null;
        if (!u?.email) { failed.push(`${item.person} (no email on file)`); continue; }
        try {
          const token = newSignOutToken();
          await setDoc(
            doc(db, 'signOutRequests', token),
            buildSignOutRequest({
              shift: item.shift,
              row: item.row,
              user: u,
              centerId: activeCenterId,
              requestedBy: user?.email || user?.displayName || null,
            }),
          );
          const delivered = await notifyMissingSignOut({
            recipient: { email: u.email, displayName: u.displayName },
            date: item.shift.date,
            clockIn: normalizeTimeToHHMM(item.row?.timeIn),
            scheduledEnd: normalizeTimeToHHMM(item.shift.endTime),
            token,
            centreName: centerConfig?.name,
          });
          if (!delivered) { failed.push(`${item.person} (send failed)`); continue; }
          // Stamped on the shift so the panel can say "already asked" and
          // a re-import doesn't look like nothing happened.
          await updateDoc(doc(db, 'shifts', item.shift.shiftId), {
            signOutRequestSentAt: new Date().toISOString(),
          });
          sent += 1;
        } catch (err) {
          failed.push(`${item.person} (${err?.message || 'failed'})`);
        }
      }
    } finally {
      setSendingSignOuts(false);
    }

    if (sent > 0) toast.success(`Sent ${sent} sign-out ${sent === 1 ? 'request' : 'requests'}.`);
    if (failed.length > 0) toast.error(`Could not send to: ${failed.join(', ')}`);
  };

  const addRadiusEntry = (name) => {
    setRadiusData(prev => [...prev, { name, date: payStart, timeIn: '', timeOut: '', actualHours: 0 }]);
  };

  // Build comparison: for each person in payroll, match Radius rows.
  //
  // Real fuzzy name matcher. Radius sometimes uses "Brianna E. Smith" or
  // "Sarah-Jane Doe" while the portal has "Brianna Smith" / "Sarah Jane
  // Doe", and the old "strict equals after trim" missed both. We tokenise
  // on whitespace AND hyphens, drop dots and apostrophes, and consider
  // two names a match if their first token matches AND their last token
  // matches. Single-word names fall back to exact-token equality.
  //
  // For staff whose Radius name doesn't share a first OR last token with
  // their Ratio displayName (legal first names, married names, etc., e.g.
  // "Jieun (Joanne) Lee"), the owner saves a `radiusName` alias on the
  // user profile and the matcher tries it as a second name too.
  const comparisonSummary = useMemo(() => {
    if (radiusData.length === 0) return null;
    const nameTokens = (raw) => String(raw || '')
      .toLowerCase()
      .replace(/[.'`]/g, '')      // drop punctuation that doesn't affect identity
      .split(/[\s-]+/)            // split on whitespace + hyphens
      .filter(Boolean);
    // Radius holds the LEGAL first name; Ratio holds the name people go by
    // ("Devanshi Mistry" vs "Dev Mistry", "Benjamin Gong" vs "Ben Gong").
    // Treat one first name as matching the other when it's a prefix of it,
    // 3+ chars so "Jo" doesn't sweep up Joanne AND Jonathan. Only used when
    // BOTH names carry a surname, and the surname must still match exactly —
    // that anchors it, so the only false-positive left is two staff who share
    // a surname AND whose first names prefix one another. If that ever
    // happens, the radiusName alias on the user doc still wins.
    const firstNamesMatch = (a, b) => {
      if (a === b) return true;
      const [short, long] = a.length <= b.length ? [a, b] : [b, a];
      return short.length >= 3 && long.startsWith(short);
    };
    const namesMatch = (a, b) => {
      const ta = nameTokens(a);
      const tb = nameTokens(b);
      if (ta.length === 0 || tb.length === 0) return false;
      // Single-token name on either side — no surname to anchor a nickname
      // guess, so require an exact hit.
      if (ta.length === 1 || tb.length === 1) return ta[0] === tb[0];
      return firstNamesMatch(ta[0], tb[0]) && ta[ta.length - 1] === tb[tb.length - 1];
    };
    // Pull the user's radiusName from the canonical user list so the
    // matcher can recognise both "Joanne Lee" and "Jieun Lee".
    const userByPersonName = new Map(
      usersForCentre.map(u => [(u.displayName || '').toLowerCase(), u])
    );
    const personMatchesRadius = (personName, radiusName) => {
      if (namesMatch(personName, radiusName)) return true;
      const u = userByPersonName.get((personName || '').toLowerCase());
      if (u?.radiusName && namesMatch(u.radiusName, radiusName)) return true;
      return false;
    };
    // Track which Radius rows got attributed to ANY person so we can
    // surface the leftovers (rows whose name doesn't match any user) and
    // let the owner map them by clicking — saving the alias on the user.
    const attributedIdxs = new Set();
    const perPerson = payrollSummary.map(person => {
      const radiusRows = radiusData
        .map((r, idx) => ({ ...r, _idx: idx }))
        .filter(r => personMatchesRadius(person.name, r.name));
      for (const r of radiusRows) attributedIdxs.add(r._idx);
      const actualHours = radiusRows.reduce((s, r) => s + r.actualHours, 0);
      // Scheduled baseline for the Sched-vs-Actual comparison EXCLUDES
      // no-shows. They were assigned but didn't work, so Radius will never
      // have a clock-in for them — leaving them in made every no-show look
      // like an unexplained shortfall on the person's header.
      const scheduledHours = Math.round((person.totalHours - (person.noShowHours || 0)) * 100) / 100;
      // NB: diff / hasDiscrepancy are computed further down, once the
      // per-shift pass has had a chance to fold in any confirmed sign-outs.
      // Deriving them from the raw punch sum here left a person who HAD
      // confirmed their missing tap-out still reading as hours short.

      // Per-shift comparison.
      //
      // CRITICAL: when an instructor has multiple shifts on the same date
      // (e.g. Homer's in-centre 3-5pm + online 6-8pm), each scheduled
      // shift needs its OWN Radius row, not the first one on that date.
      // Previously a .find() by date returned the same Radius row for
      // every shift that day, so editing one row edited both — bug.
      //
      // Fix: per date, sort both shifts and Radius entries by start time
      // and greedily match nearest pairs. Each Radius _idx is consumed
      // once so it can't double-attribute.
      const toMinutes = (t) => {
        const v = String(t || '').trim();
        // Accept "HH:MM" or "h:mm AM/PM"
        let m = v.match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?$/);
        if (!m) return null;
        let h = parseInt(m[1], 10);
        const mins = parseInt(m[2], 10);
        const ampm = (m[3] || '').toUpperCase();
        if (ampm === 'PM' && h !== 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;
        return h * 60 + mins;
      };

      const usedRadiusIdx = new Set();
      // Nearest-timeIn matcher among the unused Radius rows on a date.
      const pickNearest = (candidates, targetMin) => {
        if (candidates.length === 0) return null;
        if (candidates.length === 1 || targetMin == null) return candidates[0];
        let best = null, bestDelta = Infinity;
        for (const c of candidates) {
          const cm = toMinutes(c.timeIn);
          if (cm == null) continue;
          const d = Math.abs(cm - targetMin);
          if (d < bestDelta) { bestDelta = d; best = c; }
        }
        return best || candidates[0];
      };

      // Group same-date shifts into contiguous BLOCKS. Two shifts join one
      // block when the next starts at (or before) the previous one's end —
      // i.e. back-to-back like Bri's Lead 11-3 + Host 3-7. A single Radius
      // clock-in that spans a block is SHARED across its shifts (each gets a
      // slice of the actual hours proportional to its scheduled hours)
      // instead of matching one shift and flagging the rest "missing".
      // Non-contiguous same-day shifts (a real gap → a separate clock-in,
      // e.g. in-centre 3-5 + online 6-8) stay in their own block and match
      // independently, so that case is unchanged.
      const withIdx = person.shifts.map((s, sIdx) => ({
        s, sIdx, startMin: toMinutes(s.startTime), endMin: toMinutes(s.endTime),
      }));
      const byShiftDate = new Map();
      for (const it of withIdx) {
        if (!byShiftDate.has(it.s.date)) byShiftDate.set(it.s.date, []);
        byShiftDate.get(it.s.date).push(it);
      }
      // Local YYYY-MM-DD for "has this day happened yet". Built from local
      // date parts rather than toISOString() so an evening in a western
      // timezone doesn't roll over to tomorrow and mark today's shifts future.
      const _now = new Date();
      const todayISO = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
      const compByIdx = new Map();
      for (const [d, items] of byShiftDate) {
        items.sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0));
        const blocks = [];
        for (const it of items) {
          const last = blocks[blocks.length - 1];
          const contiguous = last && it.startMin != null && last.endMin != null
            && it.startMin <= last.endMin + 1;
          if (contiguous) {
            last.items.push(it);
            last.endMin = Math.max(last.endMin, it.endMin ?? last.endMin);
            last.schedHours += it.s.hours;
          } else {
            blocks.push({ date: d, items: [it], startMin: it.startMin, endMin: it.endMin, schedHours: it.s.hours });
          }
        }
        for (const block of blocks) {
          const candidates = radiusRows.filter(r => r.date === block.date && !usedRadiusIdx.has(r._idx));
          const match = pickNearest(candidates, block.startMin);
          if (match) usedRadiusIdx.add(match._idx);
          const schedH = block.schedHours || block.items.reduce((sum, it) => sum + it.s.hours, 0);
          const shared = block.items.length > 1;
          for (const it of block.items) {
            const s = it.s;
            let shareHours = null, shiftDiff = null, shiftDisc = false;
            if (match) {
              const frac = (shared && schedH > 0) ? (s.hours / schedH) : 1;
              shareHours = Math.round(match.actualHours * frac * 100) / 100;
              shiftDiff = Math.round((shareHours - s.hours) * 100) / 100;
              shiftDisc = Math.abs(shiftDiff) > 0.25;
            }
            // A shift that hasn't happened yet obviously has no clock-in.
            // Flagging it "⚠ missing" in red was a false alarm on every
            // pay period that included upcoming days — it trained people
            // to ignore red, which is the one thing red must never do.
            // Future rows render neutral and are excluded from the
            // unresolved count until the day has actually passed.
            const isFuture = block.date > todayISO;

            // How the clock data actually stands for this row. Four states
            // used to collapse into one boolean, which is why "signed in but
            // never signed out" was indistinguishable from "never came in".
            const soState = signOutState({ match, shift: s, isFuture, now: new Date() });

            // An open punch contributes 0 raw hours (we don't know them).
            // Once the instructor confirms their sign-out we DO know them,
            // so the row gets real hours back — and they're added to the
            // person's total further down, since the raw punch sum missed them.
            let confirmedHours = null;
            if (soState === 'self-confirmed' && match) {
              const full = resolvedActualHours(match, s);
              if (full != null) {
                const frac = (shared && schedH > 0) ? (it.s.hours / schedH) : 1;
                confirmedHours = Math.round(full * frac * 100) / 100;
                shareHours = confirmedHours;
                shiftDiff  = Math.round((confirmedHours - s.hours) * 100) / 100;
                shiftDisc  = Math.abs(shiftDiff) > 0.25;
              }
            }

            compByIdx.set(it.sIdx, {
              ...s,
              actual: match || null,
              actualShareHours: shareHours,      // this shift's slice of a shared clock-in
              sharedClockIn: shared && !!match,  // true when a clock-in covers >1 shift
              shiftDiff,
              shiftDiscrepancy: shiftDisc && !isFuture,
              // Kept meaning exactly what it says: no Radius row at all.
              // An open punch HAS a row, so it is no longer swept in here.
              missingFromRadius: !match,
              signOutState: soState,
              signOutConfirmed: effectiveSignOut(match || {}, s),
              confirmedHours,
              isFuture,
              _shiftIdx: it.sIdx,
            });
          }
        }
      }
      // Emit in the person's original shift order so the table row order is stable.
      const shiftComparisons = person.shifts.map((s, sIdx) => compByIdx.get(sIdx));

      // Any Radius row not consumed by a shift above is genuinely unmatched
      // — these can be either an extra clock-in on a day that had a shift
      // already (e.g. came back after dinner) or a shift that never made
      // it into Ratio at all. Either way, surface them with the "Schedule
      // shift" button so the owner can fix them.
      const unmatchedRadius = radiusRows.filter(r => !usedRadiusIdx.has(r._idx));

      // Open punches summed to zero above (correctly — the hours weren't
      // known). Any that have since been confirmed do have hours now, so
      // fold them in or the period total silently under-reports.
      const confirmedExtra = shiftComparisons
        .reduce((sum, c) => sum + (c?.confirmedHours || 0), 0);
      const totalActual = Math.round((actualHours + confirmedExtra) * 100) / 100;
      const diff = Math.round((totalActual - scheduledHours) * 100) / 100;
      const hasDiscrepancy = Math.abs(diff) > 0.25; // >15 min difference flags it

      return {
        ...person,
        actualHours: totalActual,
        scheduledHours,
        diff,
        hasDiscrepancy,
        shiftComparisons,
        unmatchedRadius,
      };
    });
    // Unattributed Radius rows so far. Some of these are actually approved
    // users who didn't have a single Ratio shift in the pay period (so
    // they never appeared in payrollSummary). We promote them to synthetic
    // payroll rows here — same matcher (displayName + radiusName fuzzy) —
    // so Stella / Amarnoor / Rishi / etc. show on payroll WITH a
    // "Schedule shift" button instead of being orphaned.
    const leftover = radiusData
      .map((r, idx) => ({ ...r, _idx: idx }))
      .filter(r => !attributedIdxs.has(r._idx));

    const synthByUserId = new Map();
    // Radius rows belonging to people who are not on hourly payroll at all.
    // Volunteers clock in and out like everyone else, so their timesheet
    // entries match no payroll row and used to get promoted into payroll as
    // synthetic "unscheduled" people with 0 scheduled hours and a permanent
    // red discrepancy. Nothing was ever going to resolve them — they aren't
    // paid. Same for salaried staff and hidden-from-ops accounts.
    //
    // Their rows are still marked attributed so they don't fall through to
    // the orphan panel either; they're simply counted and set aside.
    const ignoredRadius = [];
    for (const r of leftover) {
      const user = approvedUsers.find(u =>
        namesMatch(u.displayName, r.name) ||
        (u.radiusName && namesMatch(u.radiusName, r.name))
      );
      if (!user) continue;
      const name = user.displayName;
      const offPayroll = user.isVolunteer === true
        || volunteerNames.has(name)
        || salaryStaff.has(name)
        || hiddenFromOps.has(name);
      if (offPayroll) {
        attributedIdxs.add(r._idx);
        ignoredRadius.push({ name, hours: r.actualHours, date: r.date });
        continue;
      }
      attributedIdxs.add(r._idx);
      let synth = synthByUserId.get(user.uid);
      if (!synth) {
        synth = {
          name: user.displayName,
          role: user.instructorType || 'Instructor',
          shifts: [],
          totalHours: 0,
          payHours: 0,
          sickHours: 0,
          sickCount: 0,
          noShowHours: 0,
          noShowCount: 0,
          actualHours: 0,
          scheduledHours: 0,
          diff: 0,
          hasDiscrepancy: true,        // by definition — they have hours but no schedule
          shiftComparisons: [],
          unmatchedRadius: [],
        };
        synthByUserId.set(user.uid, synth);
      }
      synth.unmatchedRadius.push(r);
      synth.actualHours = Math.round((synth.actualHours + r.actualHours) * 100) / 100;
      synth.diff        = Math.round((synth.actualHours - synth.scheduledHours) * 100) / 100;
    }
    for (const synth of synthByUserId.values()) perPerson.push(synth);

    // True orphans: still no user matched after both passes. These need a
    // manual alias — e.g. "Jieun Lee" → save radiusName on "Joanne Lee".
    const orphans = radiusData
      .map((r, idx) => ({ ...r, _idx: idx }))
      .filter(r => !attributedIdxs.has(r._idx));
    return { perPerson, orphans, ignoredRadius };
  }, [payrollSummary, radiusData, usersForCentre, approvedUsers,
      volunteerNames, salaryStaff, hiddenFromOps]);

  // Save a Radius-name alias on a staff user. Used by the orphan-mapping
  // dropdown — after this, the matcher attributes that Radius row (and
  // any future ones with the same name) to the chosen user.
  const setUserRadiusName = async (userId, radiusName) => {
    if (!userId) return;
    await updateDoc(doc(db, 'users', userId), { radiusName: radiusName || null });
    try {
      const { toast } = await import('../lib/notify');
      toast.success('Radius name saved');
    } catch { /* notify optional */ }
  };

  // Admin Panel is open to admins, owners, super-admins, and the
  // operational tier (Managers, Hosts) — full access, same as plain
  // Admin. Plain instructors get bounced (the route guard also enforces
  // this).
  if (!canManageOperations) {
    return <div className="text-center text-gray-500 py-16">Access denied. Admin / owner only.</div>;
  }

  const pendingRequestsCount = timeOffRequests.filter(r => r.status === 'pending').length;

  // Each top-level sidebar entry now scopes the page to a small group
  // of related sub-tabs. "Manage Schedule" shows weekly grid +
  // auto-scheduler + time-off requests; "Manage Staff" and "Manage
  // Payroll" are single-view pages (no sub-tab bar). Tabs that aren't
  // in the current group stay reachable by direct URL (so deep links
  // don't break) but don't appear in the tab strip.
  const TAB_GROUPS = {
    spreadsheet: ['spreadsheet', 'scheduler', 'requests'],
    scheduler:   ['spreadsheet', 'scheduler', 'requests'],
    requests:    ['spreadsheet', 'scheduler', 'requests'],
    users:       ['users'],
    payroll:     ['payroll'],
    holidays:    ['holidays'],
  };
  const TAB_DEFS = {
    spreadsheet: { label: 'Weekly Grid',    icon: Table },
    scheduler:   { label: 'Auto-Scheduler', icon: Wand2, badge: 'AI', badgeStyle: 'purple' },
    requests:    { label: 'Time Off',       icon: CalendarRange },
    users:       { label: 'Manage Users',   icon: UserCheck },
    payroll:     { label: 'Payroll',        icon: DollarSign },
    holidays:    { label: 'Holidays',       icon: CalendarX },
  };
  const visibleTabKeys = TAB_GROUPS[tab] || Object.keys(TAB_DEFS);
  const tabs = visibleTabKeys.map(k => ({ key: k, ...TAB_DEFS[k] }));

  // Friendly per-tab page header. Mirrors the sidebar labels so the
  // owner sees "Manage Schedule" / "Manage Staff" / "Manage Payroll"
  // as the page title when they navigate via the redesigned sidebar.
  const pageTitleByTab = {
    spreadsheet: { title: 'Manage Schedule', subtitle: 'Weekly grid + auto-scheduler + time-off requests', icon: CalendarRange,    bg: 'bg-blue-100 text-blue-600' },
    users:       { title: 'Manage Staff',    subtitle: 'Approve, roles, sub-roles',                     icon: Users,            bg: 'bg-emerald-100 text-emerald-600' },
    scheduler:   { title: 'Auto-Scheduler',  subtitle: 'Generate a draft schedule from availability',   icon: Wand2,            bg: 'bg-purple-100 text-purple-600' },
    payroll:     { title: 'Manage Payroll',  subtitle: 'Hourly summary + Radius timesheet compare',     icon: DollarSign,       bg: 'bg-amber-100 text-amber-600' },
    requests:    { title: 'Time Off Requests', subtitle: 'Approve or deny time off',                    icon: CalendarRange,    bg: 'bg-orange-100 text-orange-600' },
    holidays:    { title: 'Holidays',        subtitle: 'Stat holidays + centre closures',               icon: CalendarX,        bg: 'bg-purple-100 text-purple-600' },
  };
  const pageHeader = pageTitleByTab[tab] || { title: 'Admin Panel', subtitle: 'Manage instructors and shifts', icon: Settings, bg: 'bg-purple-100 text-purple-600' };
  const PageIcon = pageHeader.icon;

  return (
    <div className="mx-auto max-w-7xl">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <div className={`rounded-lg p-2 ${pageHeader.bg}`}><PageIcon size={22} /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{pageHeader.title}</h1>
          <p className="text-sm text-gray-500">{pageHeader.subtitle}</p>
        </div>
      </div>

      {/* Sub-tabs — only shown when the current section has more than one
          view. "Manage Staff" / "Manage Payroll" / "Holidays" are
          single-view pages so the bar is suppressed. */}
      {tabs.length > 1 && (
      <div className="mb-6 flex gap-1 border-b overflow-x-auto">
        {tabs.map(t => (
          <button key={t.key} onClick={() => selectTab(t.key)}
            className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors ${tab === t.key ? 'border-red-600 text-red-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            <t.icon size={16} /> {t.label}
            {t.badge && (
              <span className={`rounded-full px-1.5 py-0.5 text-xs ${t.badgeStyle === 'purple' ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700'}`}>
                {t.badge}
              </span>
            )}
            {t.key === 'requests' && pendingRequestsCount > 0 && (
              <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-xs font-bold text-white">
                {pendingRequestsCount}
              </span>
            )}
          </button>
        ))}
      </div>
      )}

      {/* ── SPREADSHEET (Weekly Calendar Grid) ──────────────────────────────── */}
      {tab === 'spreadsheet' && (
        <div className="space-y-2 schedule-print-zone">
          {/* Legend + tips. Swatches use this center's custom shift colors. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 mb-2 text-xs text-gray-500">
            <span className="font-semibold text-gray-600 mr-1">Shift:</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full bg-orange-500" /> Open Shift</span>
            {SHIFT_ASSIGNMENTS.map(a => (
              <span key={a} className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: assignmentColorHex(a, centerConfig) }} />
                {a}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-0 h-0 border-r-[8px] border-r-transparent border-t-[8px] border-t-amber-400" />
              TO Pending
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-0 h-0 border-r-[8px] border-r-transparent border-t-[8px] border-t-red-500" />
              TO Approved
            </span>
            <span className="ml-auto flex items-center gap-1 text-gray-400 italic">
              Click any cell to add a shift · Click <Plus size={10} className="inline" /> to add open shift
            </span>
          </div>

          <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
            {/* Week nav */}
            <div className="flex items-center justify-between px-4 py-3 border-b bg-white">
              <div className="flex items-center gap-2">
                <button onClick={() => setWeekStart(w => subWeeks(w, 1))}
                  className="rounded p-1 hover:bg-gray-100"><ChevronLeft size={18} /></button>
                <button onClick={() => setWeekStart(startOfWeek(new Date()))}
                  className="rounded border px-3 py-1 text-xs font-medium hover:bg-gray-50">Today</button>
                <button onClick={() => setWeekStart(w => addWeeks(w, 1))}
                  className="rounded p-1 hover:bg-gray-100"><ChevronRight size={18} /></button>
                <span className="ml-2 text-sm font-semibold text-gray-800">
                  {format(weekStart, 'MMM d')} – {format(addDays(weekStart, 6), 'MMM d, yyyy')}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-500">
                  Total assigned: <strong>{Math.round(totalAssignedHours * 10) / 10} hrs</strong>
                </span>
                {/* Volunteer and salary hours are tracked separately — still
                    visible for coverage planning, but out of the hourly
                    total so it reconciles with payroll and the staffing
                    budget, both of which exclude them too. */}
                {salaryHoursThisWeek > 0 && (
                  <span
                    title="Salary staff are scheduled for coverage but aren't paid hourly, so their hours sit outside the assigned total — same as payroll and the staffing budget."
                    className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-800"
                  >
                    <UserX size={11} />
                    {Math.round(salaryHoursThisWeek * 10) / 10} salary hrs
                  </span>
                )}
                {noAccountHoursThisWeek > 0 && (
                  <span
                    title="Shifts whose staff member has no portal account. They have no row on the grid, so their hours sit outside the total — same rule the day columns use."
                    className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600"
                  >
                    +{Math.round(noAccountHoursThisWeek * 10) / 10} no-account hrs
                  </span>
                )}
                {sickHoursThisWeek > 0 && (
                  <span
                    title="Sick hours are paid under the sick budget, not as assigned coverage — so they sit outside this total, same as payroll and the staffing budget."
                    className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800"
                  >
                    +{Math.round(sickHoursThisWeek * 10) / 10} sick hrs
                  </span>
                )}
                {trainingHoursThisWeek > 0 && (
                  <span
                    title="Training hours are paid like any other, but sit outside assigned coverage — a trainee shadows an instructor rather than covering a slot, so counting them here would overstate your staffing."
                    className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-2 py-0.5 text-[11px] font-semibold text-purple-800"
                  >
                    +{Math.round(trainingHoursThisWeek * 10) / 10} training hrs
                  </span>
                )}
                {volunteerHoursThisWeek > 0 && (
                  <span
                    title="Volunteer hours are tracked but excluded from the paid total and from payroll."
                    className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-800"
                  >
                    <HandHeart size={11} />
                    {Math.round(volunteerHoursThisWeek * 10) / 10} volunteer hrs
                  </span>
                )}
              </div>
              {/* Export Schedule — opens the browser's print dialog with
                  print CSS that hides chrome + sidebar. Owner picks
                  "Save as PDF" from the destination dropdown to get a
                  one-page snapshot of the current week. Matches the
                  "screenshot" workflow without a heavy html2canvas dep. */}
              <button
                onClick={() => window.print()}
                title="Print or save the current week as PDF"
                className="ml-2 inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50 print:hidden"
              >
                <Download size={12} /> Export Schedule
              </button>
            </div>

            {/* Publish bar — surfaces draft counts and one-click bulk actions.
                Hidden when nothing is in draft so it doesn't add noise to a
                cleanly-published view. */}
            {(() => {
              const ws = format(weekStart, 'yyyy-MM-dd');
              const we = format(addDays(weekStart, 6), 'yyyy-MM-dd');
              const draftsThisWeek = shifts.filter(s => s.status === 'draft' && s.date >= ws && s.date <= we).length;
              const draftsAll      = shifts.filter(s => s.status === 'draft').length;
              if (draftsAll === 0) return null;
              return (
                <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b bg-amber-50/60 text-xs">
                  <span className="font-semibold text-amber-800">
                    {draftsAll} draft shift{draftsAll === 1 ? '' : 's'} pending
                    {draftsThisWeek !== draftsAll && ` (${draftsThisWeek} this week)`}
                  </span>
                  <span className="text-amber-700/80">— instructors don&apos;t see drafts until you publish.</span>
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    {draftsThisWeek > 0 && (
                      <button
                        onClick={() => handlePublishWeek(ws, we)}
                        className="rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-700 transition-colors"
                      >
                        Publish this week ({draftsThisWeek})
                      </button>
                    )}
                    <button
                      onClick={handlePublishAllDrafts}
                      className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 font-semibold text-emerald-700 hover:bg-emerald-50 transition-colors"
                    >
                      Publish all drafts ({draftsAll})
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* Grid — table-fixed so columns share the width evenly and long
                shift labels can't stretch the table sideways. The wrapper is a
                scroll pane (max-height) so the day-header row can stay pinned
                via position:sticky while you scroll through instructors. */}
            <div className="overflow-auto max-h-[70vh]">
              {/* `[&_td]:border [&_th]:border [&_td]:border-gray-300 [&_th]:border-gray-300`
                  draws a clean 1px box around EVERY cell in the table so
                  the day-by-instructor grid reads as a real spreadsheet
                  rather than relying on stripes for separation. */}
              <table className="w-full text-xs border-collapse table-fixed min-w-[680px] [&_td]:border [&_th]:border [&_td]:border-gray-300 [&_th]:border-gray-300">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="sticky top-0 z-30 bg-gray-50 text-left px-4 py-2 font-semibold text-gray-600 w-32 border-r shadow-[inset_0_-1px_0_#e5e7eb]">INSTRUCTOR</th>
                    {weekDays.map(d => {
                      const isToday = isSameDay(d, new Date());
                      const ds = format(d, 'yyyy-MM-dd');
                      const holiday = holidayFor(d, centerConfig);
                      // Id-first, same as the weekly tally and the day footer. A
                      // renamed staffer's hours must still land in this day's total.
                      const portalNames = new Set(users.map(u => u.displayName));
                      const portalIds3 = new Set(users.map(u => u.uid).filter(Boolean));
                      const hasAccount3 = (sh) =>
                        (sh.userId && portalIds3.has(sh.userId)) || portalNames.has(sh.userName);
                      // Include drafts in the planned-hours header so admin sees
                      // the full scheduled picture; visual stripes on the cells
                      // already mark which ones are draft vs published.
                      // No-show shifts are excluded (they didn't happen).
                      // Volunteer, salary AND sick shifts are excluded too —
                      // none of them cost hourly wages, and each is tracked in
                      // its own chip. Keeps this figure reconcilable with
                      // payroll and the staffing budget.
                      const dayTotalHrs = shifts
                        .filter(s =>
                          s.date === ds
                          && hasAccount3(s)
                          && s.noShow !== true
                          && s.sickPay !== true
                          && !shiftIsFor(s, volunteerIdSet, volunteerNames)
                          && !shiftIsFor(s, salaryIds, salaryStaff)
                          && !shiftIsFor(s, hiddenIds, hiddenFromOps)
                        )
                        .reduce((sum, s) => sum + shiftHours(s), 0);
                      const dayHrsDisplay = isNaN(dayTotalHrs) ? 0 : Math.round(dayTotalHrs * 10) / 10;
                      // Denominator = what this weekday is budgeted for, so
                      // the header reads as a fraction of plan rather than a
                      // bare number with no reference point.
                      const dayBudget = weekdayBudgetTotal(format(d, 'EEEE'), weekdayModel);
                      const overBudget = dayBudget > 0 && dayTotalHrs > dayBudget;
                      const daySick = Math.round((sickByDate.get(ds) || 0) * 10) / 10;
                      const headerBg = holiday
                        ? 'bg-amber-50 text-amber-700'
                        : isToday
                          ? 'bg-red-50 text-red-700'
                          : 'bg-gray-50 text-gray-600';
                      return (
                        <th key={d.toISOString()} className={`sticky top-0 z-30 text-center py-2 px-1 font-medium shadow-[inset_0_-1px_0_#e5e7eb] ${headerBg}`}>
                          <div className="text-xs uppercase tracking-wide">{format(d, 'EEE')}</div>
                          <div className={`text-base font-bold ${holiday ? 'text-amber-700' : isToday ? 'text-red-600' : 'text-gray-800'}`}>{format(d, 'd')}</div>
                          {holiday ? (
                            <div className="mx-auto mt-0.5 max-w-full truncate text-[10px] font-semibold uppercase tracking-wide text-amber-700" title={`Closed — ${holiday.name}`}>
                              {holiday.name || 'Closed'}
                            </div>
                          ) : (dayHrsDisplay > 0 || dayBudget > 0) ? (
                            <div
                              className={`text-xs font-semibold mt-0.5 ${
                                overBudget ? 'text-red-600' : isToday ? 'text-red-500' : 'text-purple-600'
                              }`}
                              title={dayBudget > 0
                                ? `${dayHrsDisplay}h scheduled of ${dayBudget}h budgeted for a ${format(d, 'EEEE')} — ${
                                    overBudget ? `${Math.round((dayTotalHrs - dayBudget) * 10) / 10}h over` : `${Math.round((dayBudget - dayTotalHrs) * 10) / 10}h under`}`
                                : `${dayHrsDisplay}h scheduled`}
                            >
                              {dayBudget > 0 ? <>{dayHrsDisplay}<span className="font-normal text-gray-400"> / {dayBudget}h</span></> : `${dayHrsDisplay}h`}
                            </div>
                          ) : null}
                          {/* Sick hours sit outside the total above, but the
                              cover gap still needs to be visible on the day. */}
                          {!holiday && daySick > 0 && (
                            <div className="mx-auto mt-0.5 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800"
                              title="Sick hours — paid under the sick budget, not counted in the day's assigned hours.">
                              +{daySick}h sick
                            </div>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {/* ── Open Shifts row ── */}
                  <tr className="border-b bg-orange-50">
                    <td className="px-4 py-2 border-r">
                      <div className="flex items-center gap-1.5">
                        <div className="w-5 h-5 rounded-full bg-orange-400 flex items-center justify-center">
                          <Plus size={11} className="text-white" />
                        </div>
                        <span className="font-semibold text-orange-700 text-xs">Open Shifts</span>
                      </div>
                    </td>
                    {weekDays.map(d => {
                      const ds = format(d, 'yyyy-MM-dd');
                      const holiday = holidayFor(d, centerConfig);
                      // On holidays the centre is closed — no open shifts,
                      // no add button. Just a calm "Closed" marker.
                      if (holiday) {
                        return (
                          <td key={ds} className="bg-amber-50/40 px-1 py-2 text-center align-middle text-[10px] font-semibold uppercase tracking-wide text-amber-600">
                            Closed
                          </td>
                        );
                      }
                      const dayOpenShifts = openShiftsList.filter(s => s.date === ds);
                      return (
                        <td key={ds} className="px-1 py-1 align-top">
                          {dayOpenShifts.map(s => (
                            <div key={s.id}
                              className={`rounded px-1.5 py-1 mb-0.5 text-xs ${s.status === 'claimed' ? 'bg-green-100 border border-green-300' : 'bg-orange-100 border border-orange-300'}`}>
                              <div className="font-semibold text-orange-800">{fmtHHMM(s.startTime)}–{fmtHHMM(s.endTime)}</div>
                              {s.role && <div className="text-orange-600 uppercase tracking-wide" style={{fontSize:'10px'}}>{s.role}</div>}
                              {s.claimedByName && <div className="text-green-700" style={{fontSize:'10px'}}>→ {s.claimedByName}</div>}
                              <button
                                onClick={() => handleDeleteOpenShift(s.id)}
                                className="text-orange-300 hover:text-red-500 float-right -mt-4"
                                title="Remove"
                              >
                                <X size={10} />
                              </button>
                            </div>
                          ))}
                          {/* Add open shift button */}
                          <button
                            onClick={() => setAddOpenShiftModal({ date: ds })}
                            className="w-full rounded border border-dashed border-orange-300 py-0.5 text-orange-400 hover:bg-orange-100 hover:text-orange-600 transition-colors flex items-center justify-center gap-0.5 mt-0.5"
                            title="Add open shift"
                          >
                            <Plus size={10} />
                          </button>
                        </td>
                      );
                    })}
                  </tr>

                  {/* ── Instructor rows ── */}
                  {approvedUsers.map(u => {
                    // Per-instructor weekly hours include drafts — admin needs
                    // the full planned total when deciding fairness. Stripes on
                    // the cells already mark drafts vs published. No-show
                    // shifts are excluded (they didn't happen). Volunteers
                    // show 0 here so their row reflects that volunteer
                    // hours aren't counted toward paid coverage — actual
                    // hours worked live on the volunteer chip up top.
                    const isVolunteerRow = u.isVolunteer === true;
                    const totalHrs = isVolunteerRow ? 0 : weekDays.reduce((sum, d) => {
                      const ds = format(d, 'yyyy-MM-dd');
                      return sum + shifts.filter(s => s.userId === u.uid && s.date === ds && s.noShow !== true)
                        .reduce((s2, sh) => s2 + shiftHours(sh), 0);
                    }, 0);
                    const displayHrs = isNaN(totalHrs) ? 0 : Math.round(totalHrs * 10) / 10;
                    return (
                      <tr key={u.uid} className="border-b hover:bg-gray-50 transition-colors group">
                        <td className="px-4 py-2 border-r">
                          <button
                            type="button"
                            onClick={() => setAvailabilityModalUser(u)}
                            title={`View ${u.displayName}'s availability for this week`}
                            className="flex items-center gap-2 w-full text-left rounded-md px-1 py-0.5 -mx-1 hover:bg-blue-50 hover:ring-1 hover:ring-blue-200 transition-colors"
                          >
                            <Avatar user={u} size={28} />
                            <div>
                              <div className="font-semibold text-gray-800 text-xs">{u.displayName}</div>
                              <div className="text-gray-400" style={{fontSize:'10px'}}>{displayHrs}h · {u.instructorType || 'Instructor'}</div>
                            </div>
                          </button>
                        </td>
                        {weekDays.map(d => {
                          const ds = format(d, 'yyyy-MM-dd');
                          const holiday = holidayFor(d, centerConfig);
                          // Holiday column — empty greyed cell. The header
                          // already labels it "Closed — [holiday]", so the
                          // per-instructor cells just stay quiet.
                          if (holiday) {
                            return (
                              <td key={ds} className="bg-amber-50/40 px-1 py-2 text-center align-middle text-[10px] uppercase tracking-wide text-amber-500/70">
                                —
                              </td>
                            );
                          }
                          const dayShifts = shifts.filter(s => s.userId === u.uid && s.date === ds);
                          const dayAvail = availability.filter(a => a.userId === u.uid && a.date === ds);
                          // Time-off overlay. Approved wins over pending when
                          // both cover the same date. MUST be declared before
                          // hasAvail below, which reads it — having it after
                          // was a temporal-dead-zone crash that took out the
                          // whole Manage Staff Schedule tab in production.
                          const cellTimeOff = timeOffOn(timeOffIndex, u.uid, ds);
                          // A time-off request OVERRIDES availability for the
                          // day — see src/lib/timeOff.js. Drawing a green
                          // "available" corner next to a red "off" corner on
                          // the same cell made the grid contradict itself and
                          // left admins guessing which to believe. The hours
                          // aren't lost: they move into the time-off tooltip
                          // below, which is where you'd look to decide.
                          const hasAvail = dayAvail.length > 0 && !cellTimeOff;
                          // FAILSAFE: did we schedule them outside the hours
                          // they said they could work? Availability 4–7pm,
                          // shift 3–7pm — nothing objected before, and the
                          // first anyone knew was a no-show at 3.
                          //
                          // Skipped when a time-off request covers the day:
                          // that already paints the cell and overrides
                          // availability, so the two can't argue on one cell.
                          // Never blocks the booking — sometimes scheduling
                          // outside availability is exactly right.
                          const availClash = cellTimeOff
                            ? null
                            : availabilityConflict(dayShifts, dayAvail);
                          const timeOffColor = cellTimeOff?.status === 'approved'
                            ? 'border-t-red-500'
                            : cellTimeOff?.status === 'pending'
                              ? 'border-t-amber-400'
                              : '';
                          const timeOffBg = cellTimeOff?.status === 'approved'
                            ? 'bg-red-50/40'
                            : cellTimeOff?.status === 'pending'
                              ? 'bg-amber-50/40'
                              : '';
                          return (
                            <td
                              key={ds}
                              className={`px-1 py-1 align-top relative ${
                                // Deliberately stronger than the faint
                                // amber-50/40 used for pending time off and
                                // holidays — this is a mistake to catch, not
                                // a state to note, and the inset ring makes
                                // it unmistakable at a glance across a full
                                // week of cells.
                                availClash ? 'bg-amber-100 ring-1 ring-inset ring-amber-400'
                                : cellTimeOff && dayShifts.length === 0 ? timeOffBg
                                : hasAvail && dayShifts.length === 0 ? 'bg-green-50/40'
                                : ''
                              }`}
                            >
                              {/* Time-off triangle (top-left) — visible when
                                  the user has a request covering this date. */}
                              {cellTimeOff && (
                                <div className="group/to absolute top-0 left-0 z-10">
                                  <div className={`w-0 h-0 border-r-[14px] border-r-transparent border-t-[14px] cursor-pointer ${timeOffColor}`} />
                                  <div className="hidden group-hover/to:block absolute left-0 top-4 z-20 w-56 rounded-lg border border-gray-200 bg-white shadow-lg p-2">
                                    <p className={`text-xs font-semibold mb-1 ${cellTimeOff.status === 'approved' ? 'text-red-700' : 'text-amber-700'}`}>
                                      Time off · {cellTimeOff.status === 'approved' ? 'Approved' : 'Pending'}
                                    </p>
                                    <p className="text-xs text-gray-600">
                                      {cellTimeOff.startDate}{cellTimeOff.endDate !== cellTimeOff.startDate ? ` – ${cellTimeOff.endDate}` : ''}
                                    </p>
                                    {cellTimeOff.reason && (
                                      <p className="text-xs text-gray-500 italic mt-1">&quot;{cellTimeOff.reason}&quot;</p>
                                    )}
                                    {/* The availability this request overrode.
                                        Kept visible so the day still answers
                                        "what did they originally put in?" */}
                                    {dayAvail.length > 0 && (
                                      <p className="mt-1 text-[10px] text-gray-500">
                                        {cellTimeOff.status === 'approved' ? 'Overrides' : 'Still marked'} available{' '}
                                        {dayAvail.map(a => (
                                          a.startTime === '00:00' && (a.endTime === '23:59' || a.endTime === '24:00')
                                            ? 'all day'
                                            : `${fmtHHMM(a.startTime)}–${fmtHHMM(a.endTime)}`
                                        )).join(', ')}
                                        {cellTimeOff.status === 'pending' ? ' — approve or deny to settle it.' : ''}
                                      </p>
                                    )}
                                    {dayShifts.length > 0 && cellTimeOff.status === 'approved' && (
                                      <p className="text-[10px] text-red-600 font-semibold mt-1">⚠ Shift conflict — approve removes the shift.</p>
                                    )}
                                  </div>
                                </div>
                              )}
                              {/* Green triangle availability indicator */}
                              {hasAvail && (
                                <div className="group/avail absolute top-0 right-0 z-10">
                                  <div className="w-0 h-0 border-l-[14px] border-l-transparent border-t-[14px] border-t-green-400 cursor-pointer" />
                                  {/* Hover tooltip showing availability times */}
                                  <div className="hidden group-hover/avail:block absolute right-0 top-4 z-20 w-52 rounded-lg border border-green-200 bg-white shadow-lg p-2">
                                    <p className="text-xs font-semibold text-green-700 mb-1">Available</p>
                                    {dayAvail.map((a, i) => {
                                      const isFull = a.startTime === '00:00' && (a.endTime === '23:59' || a.endTime === '24:00');
                                      return (
                                        <div key={i}>
                                          <p className="text-xs text-gray-600">
                                            {isFull ? 'Full day' : `${fmtHHMM(a.startTime)} – ${fmtHHMM(a.endTime)}`}
                                          </p>
                                          {a.comment && <p className="text-xs text-blue-600 italic mt-0.5">&quot;{a.comment}&quot;</p>}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                              {/* Existing shifts — the whole block is filled
                                  with the shift's assignment color (editable
                                  in Super Admin → Appearance). Drafts (not
                                  yet published) get a diagonal stripe overlay
                                  + dashed border + "DRAFT" tag so admins can
                                  see what's planned vs committed. */}
                              {dayShifts.map(s => {
                                const assignment = assignmentFor(s);
                                // Colour precedence: Sick > No-Show >
                                // Volunteer > assignment palette. Sick
                                // = burgundy, No-Show = slate, Volunteer
                                // = sky blue (matches the volunteer chip
                                // in the header and the HandHeart icon
                                // used elsewhere). Any of them is
                                // mutually exclusive at rendering time
                                // even though the underlying fields are
                                // independent flags — the visual reads
                                // as the single most important thing
                                // going on with that shift.
                                const isSick      = !!s.sickPay;
                                const isNoShow    = !!s.noShow;
                                const isVolunteer = s.userName && volunteerNames.has(s.userName);
                                const isTraining  = isTrainingShift(s);
                                const isDraft     = s.status === 'draft';
                                // Flex roles (STEAM / Summer Camp) and shift
                                // states all read from the centre's editable
                                // Appearance colours (Super Admin → Appearance).
                                // LEGACY: only the 58 summer-2026 flex shifts still carry
                                // this. Nothing writes it any more — see subRoles.js.
                                const flexHex     = isFlexRole(s) ? stateColorHex(s.flexRole, centerConfig) : null;
                                const bg = isSick      ? stateColorHex('Sick Pay', centerConfig)
                                        : isNoShow    ? stateColorHex('No-Show', centerConfig)
                                        : flexHex     ? flexHex
                                        : isVolunteer ? stateColorHex('Volunteer', centerConfig)
                                        : isTraining  ? stateColorHex('Training', centerConfig)
                                        : assignmentColorHex(assignment, centerConfig);
                                const text = contrastText(bg);
                                const hrs = shiftHours(s);
                                const hrsDisplay = isNaN(hrs) || hrs <= 0 ? '' : `${Math.round(hrs * 10) / 10}h`;
                                const where = s.shiftType === 'Online' ? 'Online'
                                  : s.shiftType === 'Both' ? 'In-Centre + Online'
                                  : 'In-Centre';
                                const showWhere = where !== 'In-Centre' && assignment !== 'Online Instructor';
                                const compactLabel = isSick ? 'SICK'
                                  : isNoShow ? 'NO-SHOW'
                                  : flexHex ? s.flexRole.toUpperCase()
                                  : isVolunteer ? 'VOLUNTEER'
                                  : isTraining ? 'TRAINING'
                                  : assignmentShort(assignment);
                                // Diagonal stripes via repeating-linear-gradient.
                                // Layered on top of the base color so the assignment
                                // colour is still legible underneath.
                                const draftStripes = `repeating-linear-gradient(135deg, rgba(255,255,255,0.35) 0 6px, rgba(255,255,255,0) 6px 12px)`;
                                const styleBlock = isDraft
                                  ? { backgroundImage: `${draftStripes}, linear-gradient(${bg}, ${bg})`, color: text }
                                  : { backgroundColor: bg, color: text };
                                return (
                                  <div key={s.id}
                                    onClick={() => setEditShiftModal(s)}
                                    title={`${isDraft ? 'Draft (not published) · ' : ''}${isSick ? `Sick Pay · ${assignment}` : `${assignment} · ${where}`}`}
                                    className={`rounded px-1.5 py-1 mb-0.5 cursor-pointer hover:opacity-80 transition-opacity overflow-hidden ${isDraft ? 'border border-dashed border-white/70 ring-1 ring-gray-300' : ''}`}
                                    style={styleBlock}>
                                    <div className="font-semibold leading-tight flex items-center gap-1" style={{fontSize:'11px'}}>
                                      <span>{fmtHHMM(s.startTime)}–{fmtHHMM(s.endTime)}{hrsDisplay ? ` · ${hrsDisplay}` : ''}</span>
                                      {isDraft && (
                                        <span className="ml-auto rounded bg-white/85 text-gray-700 px-1 py-px font-bold tracking-wider" style={{fontSize:'8px'}}>DRAFT</span>
                                      )}
                                    </div>
                                    <div className="uppercase tracking-wide opacity-90 leading-tight" style={{fontSize:'10px'}}>{compactLabel}{!isSick && showWhere ? ` · ${where}` : ''}</div>
                                  </div>
                                );
                              })}
                              {/* Availability clash strip.
                                  In normal flow UNDER the shifts, not floating
                                  over them — an absolute badge sat on top of
                                  the block's label and clipped it. It's also
                                  the hover target for the explanation, which
                                  is the part that makes the amber actionable:
                                  "starts 1h early" tells you what to do, a
                                  bare coloured cell doesn't.
                                  Prints as a plain line, no hover. */}
                              {availClash && (
                                <div className="group/clash relative mt-0.5">
                                  <div className="flex cursor-help items-center gap-1 rounded bg-amber-400/90 px-1 py-px text-amber-950" style={{ fontSize: '9px' }}>
                                    <span className="font-bold">!</span>
                                    <span className="truncate font-semibold uppercase tracking-wide">
                                      Outside availability
                                    </span>
                                  </div>
                                  <div className="hidden group-hover/clash:block absolute left-0 top-5 z-30 w-64 rounded-lg border border-amber-300 bg-white p-2 text-left shadow-lg print:hidden">
                                    <p className="mb-1 text-xs font-semibold text-amber-800">
                                      Scheduled outside availability
                                    </p>
                                    {availClash.conflicts.map(({ shift: cs, fit }, i) => (
                                      <p key={cs.id || i} className="mb-1 text-[11px] leading-snug text-gray-700">
                                        {describeConflict(fit)}
                                      </p>
                                    ))}
                                    <p className="mt-1 border-t pt-1 text-[10px] text-gray-500">
                                      A warning, not a block — keep it if you meant it.
                                    </p>
                                  </div>
                                </div>
                              )}
                              {/* Add shift button */}
                              <button
                                onClick={() => setAddShiftModal({ date: ds, user: u })}
                                className="w-full rounded border border-dashed py-0.5 transition-colors flex items-center justify-center gap-0.5 border-gray-200 text-gray-300 hover:border-red-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100"
                                title={`Add shift for ${u.displayName}`}
                              >
                                <Plus size={10} />
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}

                  {/* Day Totals row */}
                  <tr className="bg-gray-50 border-t">
                    <td className="px-4 py-2 border-r text-xs font-semibold text-gray-600">Day Totals</td>
                    {weekDays.map(d => {
                      const ds = format(d, 'yyyy-MM-dd');
                      const holiday = holidayFor(d, centerConfig);
                      if (holiday) {
                        return (
                          <td key={ds} className="bg-amber-50/40 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-amber-600">
                            Closed
                          </td>
                        );
                      }
                      // Same id-first rule as the weekly tally above — a
                      // renamed staffer must not read as "no account" in the
                      // day footer while their shifts render in their row.
                      const portalNames2 = new Set(users.map(u => u.displayName));
                      const portalIds2 = new Set(users.map(u => u.uid).filter(Boolean));
                      const hasAccount2 = (sh) =>
                        (sh.userId && portalIds2.has(sh.userId)) || portalNames2.has(sh.userName);
                      // Totals include drafts (admin needs to see total planned
                      // headcount + hours) but flag how many are still in draft
                      // so they know there's work to publish.
                      const dayShiftsAll = shifts.filter(s => s.date === ds);
                      const dayShiftsPortal = dayShiftsAll.filter(s => hasAccount2(s));
                      const dayShiftsNoAccount = dayShiftsAll.filter(s => !hasAccount2(s));
                      const draftCount = dayShiftsAll.filter(s => s.status === 'draft').length;
                      const count = dayShiftsAll.length;
                      // Exclude no-show, sick, volunteer and salary shifts from
                      // the day's total hours so this footer matches the header
                      // + the weekly Total assigned. Each is tracked separately
                      // in its own chip.
                      const hrs = dayShiftsPortal
                        .filter(s =>
                          s.noShow !== true
                          && s.sickPay !== true
                          && !volunteerNames.has(s.userName)
                          && !salaryStaff.has(s.userName)
                          && !hiddenFromOps.has(s.userName)
                        )
                        .reduce((sum, s) => sum + shiftHours(s), 0);
                      const hrsDisplay = isNaN(hrs) ? 0 : Math.round(hrs * 10) / 10;
                      const footSick = Math.round((sickByDate.get(ds) || 0) * 10) / 10;
                      const footBudget = weekdayBudgetTotal(format(d, 'EEEE'), weekdayModel);
                      return (
                        <td key={ds} className="text-center py-2 text-xs text-gray-500">
                          {count > 0 ? (
                            <div className="space-y-0.5">
                              <span className="font-semibold text-gray-700">{count} staff</span>
                              <div className={`font-semibold ${footBudget > 0 && hrs > footBudget ? 'text-red-600' : 'text-purple-600'}`}>
                                {footBudget > 0
                                  ? <>{hrsDisplay}<span className="font-normal text-gray-400"> / {footBudget}h</span></>
                                  : <>{hrsDisplay}h total</>}
                              </div>
                              {footSick > 0 && (
                                <div className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800"
                                  title="Sick hours — paid under the sick budget, not counted in the day's assigned hours.">
                                  +{footSick}h sick
                                </div>
                              )}
                              {draftCount > 0 && (
                                <>
                                  <div className="text-amber-600 text-[10px] font-semibold uppercase tracking-wide">
                                    {draftCount} draft
                                  </div>
                                  <button
                                    onClick={() => handlePublishDay(ds)}
                                    className="mt-1 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-emerald-700 transition-colors"
                                    title={`Publish all ${draftCount} draft shift${draftCount === 1 ? '' : 's'} on this day`}
                                  >
                                    Publish day
                                  </button>
                                </>
                              )}
                              {dayShiftsNoAccount.length > 0 && (
                                <div className="text-gray-400 text-xs">
                                  +{dayShiftsNoAccount.length} no account
                                </div>
                              )}
                            </div>
                          ) : '–'}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Open Shifts summary below grid */}
          {openShiftsList.filter(s => {
            const ws = format(weekStart, 'yyyy-MM-dd');
            const we = format(addDays(weekStart, 6), 'yyyy-MM-dd');
            return s.date >= ws && s.date <= we;
          }).length > 0 && (
            <div className="rounded-xl border bg-orange-50 border-orange-200 p-4">
              <h4 className="text-xs font-semibold text-orange-800 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <ArrowRightLeft size={13} /> Open Shifts This Week
              </h4>
              <div className="flex flex-wrap gap-2">
                {openShiftsList
                  .filter(s => {
                    const ws = format(weekStart, 'yyyy-MM-dd');
                    const we = format(addDays(weekStart, 6), 'yyyy-MM-dd');
                    return s.date >= ws && s.date <= we;
                  })
                  .sort((a, b) => a.date.localeCompare(b.date))
                  .map(s => (
                    <div key={s.id} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs border ${s.status === 'claimed' ? 'bg-green-100 border-green-300 text-green-800' : 'bg-white border-orange-300 text-orange-800'}`}>
                      <span className="font-medium">{new Date(s.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                      <span>{fmtHHMM(s.startTime)}–{fmtHHMM(s.endTime)}</span>
                      {s.role && <span className="text-orange-500">{s.role}</span>}
                      {s.claimedByName ? <span className="text-green-700">→ {s.claimedByName}</span> : <span className="italic text-orange-400">unclaimed</span>}
                      <button onClick={() => handleDeleteOpenShift(s.id)} className="text-orange-300 hover:text-red-500 ml-1">
                        <X size={12} />
                      </button>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── MANAGE USERS ────────────────────────────────────────────────────── */}
      {tab === 'users' && (
        <div className="space-y-4">
          {/* Two halves of the same job. The first is the existing screen:
              who each person is. The second is the role registry: what a
              role is allowed to do. Editing roles needs `centre.settings`,
              so a plain Admin sees only the first. */}
          <div className="flex flex-wrap gap-1 border-b border-gray-200">
            <button onClick={() => setUsersSubtab('staff')}
              className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
                usersSubtab === 'staff'
                  ? 'border-b-2 border-red-600 text-red-600 bg-white'
                  : 'text-gray-500 hover:text-gray-800'
              }`}>
              <Users size={16} /> Edit Staff Roles, Subroles &amp; Capabilities
            </button>
            {canSeeCenterSettings && (
              <button onClick={() => setUsersSubtab('roles')}
                className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
                  usersSubtab === 'roles'
                    ? 'border-b-2 border-purple-600 text-purple-700 bg-white'
                    : 'text-gray-500 hover:text-gray-800'
                }`}>
                <Shield size={16} /> Edit Role Permissions &amp; Accessibility
              </button>
            )}
          </div>

          {usersSubtab === 'roles' && canSeeCenterSettings && (
            /* No centre picker here: the Admin panel is already scoped to
               the active centre, so an Enterprise user editing another
               centre's roles from inside it would be surprising. */
            <CentreRolesTab users={users} centers={[]} />
          )}

          {usersSubtab === 'staff' && (<>
          {/* Search + Add Staff row — mirrors Manage Roles' clean header.
              Add Staff opens the create-account modal; search filters both
              the pending and approved lists below. */}
          <div className="rounded-2xl border bg-white p-4 shadow-sm flex flex-wrap items-center gap-3">
            <Users size={18} className="text-gray-500" />
            <input
              type="text"
              value={userSearch}
              onChange={e => setUserSearch(e.target.value)}
              placeholder="Search by name or email…"
              className="flex-1 min-w-[180px] rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-red-500 focus:outline-none"
            />
            <button
              onClick={() => setAddStaffOpen(true)}
              className="ml-auto flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700"
              title="Manually add a new staff member without making them sign up"
            >
              <UserPlus size={15} /> Add Staff
            </button>
          </div>

          {/* Pending Approval — compact list. Anyone with admin-panel
              access can approve / reject pending users (Firestore rules
              prevent admins from touching elevated accounts). */}
          {(() => {
            const filtered = pendingUsers.filter(u => {
              if (!userSearch.trim()) return true;
              const q = userSearch.toLowerCase();
              return (u.displayName || '').toLowerCase().includes(q)
                  || (u.email || '').toLowerCase().includes(q);
            });
            if (filtered.length === 0) return null;
            return (
              <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b bg-yellow-50/60 flex items-center gap-2">
                  <Clock size={14} className="text-yellow-700" />
                  <h3 className="text-sm font-semibold text-yellow-800">
                    Pending Approval ({filtered.length})
                  </h3>
                </div>
                <ul className="divide-y divide-gray-100">
                  {filtered.map(u => (
                    <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-gray-50">
                      <Avatar user={u} size={32} roleColored={false} className="ring-2 ring-yellow-100" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-gray-900 truncate">{u.displayName || u.email}</p>
                        <p className="text-xs text-gray-500 truncate">{u.email}</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => handleApprove(u.uid)}
                          className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
                          <UserCheck size={13} /> Approve
                        </button>
                        <button onClick={() => handleReject(u.id)}
                          className="flex items-center gap-1 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50">
                          <UserX size={13} /> Reject
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}

          {/* Approved staff — compact list mirroring Manage Roles' layout.
              Click anywhere on the row to open the Edit modal for that
              person; all the per-user toggles (role, sub-roles,
              guaranteed, volunteer) live in there. Keeps this list
              scannable when the centre has 30+ staff. */}
          {(() => {
            const filtered = approvedUsers.filter(u => {
              if (!userSearch.trim()) return true;
              const q = userSearch.toLowerCase();
              return (u.displayName || '').toLowerCase().includes(q)
                  || (u.email || '').toLowerCase().includes(q);
            });
            return (
              <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b bg-gray-50 flex items-center gap-2">
                  <UserCheck size={14} className="text-gray-600" />
                  <h3 className="text-sm font-semibold text-gray-800">
                    Approved Staff ({filtered.length}{filtered.length !== approvedUsers.length ? ` of ${approvedUsers.length}` : ''})
                  </h3>
                </div>
                {filtered.length === 0 ? (
                  <div className="py-12 text-center">
                    <Users size={28} className="mx-auto text-gray-300 mb-2" />
                    <p className="text-sm text-gray-400 italic">
                      {approvedUsers.length === 0
                        ? 'No approved staff yet. Click Add Staff to create the first account.'
                        : 'No staff match your search.'}
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {filtered.map(u => {
                      const subs = expandSubRoles(u.subRoles);
                      // Colour comes from the same per-centre palette that
                      // paints the weekly grid (see staffTypeColorHex), so
                      // a Manager chip here is the Manager colour there,
                      // and repainting it in Appearance moves both.
                      const typeName = u.instructorType || 'Instructor';
                      const typeBg   = staffTypeColorHex(typeName, centerConfig);
                      return (
                        <li
                          key={u.id}
                          onClick={() => setEditStaffUser(u)}
                          className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer transition-colors"
                        >
                          <Avatar user={u} size={36} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium text-gray-900 truncate">{u.displayName || u.email}</p>
                              <span
                                className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                                style={{ backgroundColor: typeBg, color: contrastText(typeBg) }}
                              >
                                {typeName}
                              </span>
                              {/* The isVolunteer flag and the 'Volunteer'
                                  instructorType are separate fields that
                                  often both get set — showing both put
                                  two "Volunteer" chips in two different
                                  colours on the same row. Same word =
                                  same colour, and only once. */}
                              {u.isVolunteer && u.instructorType !== 'Volunteer' && (
                                <span
                                  className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                                  style={{
                                    backgroundColor: stateColorHex('Volunteer', centerConfig),
                                    color: contrastText(stateColorHex('Volunteer', centerConfig)),
                                  }}
                                >
                                  Volunteer
                                </span>
                              )}
                              {u.guaranteed && (
                                <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                                  Guaranteed
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
                              <span className="truncate">{u.email}</span>
                              {subs.length > 0 && (
                                <span className="flex items-center gap-1">
                                  {subs.map(sr => {
                                    const st = SUB_ROLE_STYLES[sr];
                                    return (
                                      <span
                                        key={sr}
                                        title={st ? sr : `${sr} — not a current sub-role`}
                                        className={`inline-flex items-center gap-1 rounded-full ${st?.pillBg || 'bg-gray-100'} ${st?.pillText || 'text-gray-500 italic'} px-1.5 py-px text-[10px] font-semibold`}
                                      >
                                        {subRoleShort(sr)}
                                      </span>
                                    );
                                  })}
                                </span>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); setEditStaffUser(u); }}
                            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                          >
                            Edit
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })()}

          {/* ── Multi-Center Setup (Phase 1 groundwork) ─────────────────────── */}
          <div className="rounded-xl border bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <Settings size={18} className="text-purple-600" />
              <h3 className="font-semibold text-gray-900">Multi-Center Setup</h3>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              Adds a <code className="px-1 rounded bg-gray-100 text-gray-700">centerId</code> field to every existing user, shift, availability, time-off, chat, announcement, and notification doc — so the portal can later support multiple Mathnasium locations. <span className="font-semibold">Run this once after deploying the multi-center groundwork.</span> Safe to run multiple times.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={handleRunCenterMigration}
                disabled={migrationRunning}
                className="flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-purple-700 disabled:opacity-50 transition-colors"
              >
                {migrationRunning ? (
                  <>
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Running…
                  </>
                ) : 'Run multi-center migration'}
              </button>
              {migrationResult?.ok && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 font-semibold text-emerald-700">
                    ✓ Migration complete
                  </span>
                  {Object.entries(migrationResult.stats).map(([k, v]) => (
                    <span key={k} className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">
                      {k}: <strong>{v}</strong>
                    </span>
                  ))}
                </div>
              )}
              {migrationResult?.ok === false && (
                <span className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
                  Migration failed: {migrationResult.error}
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-3 italic">
              The numbers show how many docs were updated per collection. Already-migrated docs are skipped.
            </p>
          </div>

          <OrphanedRecordsPanel />
          </>)}
        </div>
      )}

      {/* ── AUTO-SCHEDULER ──────────────────────────────────────────────────── */}
      {tab === 'scheduler' && (
        <div className="space-y-6">
          <div className="rounded-xl border bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <Wand2 size={18} className="text-purple-600" />
              <h3 className="font-semibold text-gray-900">Generate Schedule</h3>
            </div>
            <p className="text-sm text-gray-500 mb-5">
              Reads the availability your instructors have submitted and builds a draft schedule — Leads first, then whoever has the fewest shifts, within each person's max days per week.
            </p>
            {/* Range type toggle — Day / Week. Month was removed: the centre
                staffs a week at a time now. */}
            <div className="mb-3">
              <label className="mb-1 block text-sm font-medium text-gray-700">Schedule for</label>
              <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-sm">
                {[
                  { key: 'day',   label: 'Day'   },
                  { key: 'week',  label: 'Week'  },
                ].map(opt => {
                  const active = schedRangeType === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setSchedRangeType(opt.key)}
                      className={`px-3 py-1.5 transition-colors ${active
                        ? 'bg-purple-600 text-white font-semibold'
                        : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-4">
              {schedRangeType === 'week' && (
                <div className="sm:col-span-2">
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Week starting (Mon)
                  </label>
                  <input
                    type="date"
                    value={schedWeekDate}
                    onChange={e => {
                      // Snap to the Monday of the picked date so the user
                      // can't accidentally start a "week" on a Wednesday.
                      const picked = new Date(e.target.value + 'T00:00:00');
                      const mon    = startOfWeek(picked, { weekStartsOn: 1 });
                      setSchedWeekDate(format(mon, 'yyyy-MM-dd'));
                    }}
                    className="w-full rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Generates {format(new Date(schedWeekDate + 'T00:00:00'), 'MMM d')} – {format(addDays(new Date(schedWeekDate + 'T00:00:00'), 6), 'MMM d, yyyy')}
                  </p>
                </div>
              )}
              {schedRangeType === 'day' && (
                <div className="sm:col-span-2">
                  <label className="mb-1 block text-sm font-medium text-gray-700">Date</label>
                  <input
                    type="date"
                    value={schedDayDate}
                    onChange={e => setSchedDayDate(e.target.value)}
                    className="w-full rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none"
                  />
                </div>
              )}
              <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">
                      Default min/day
                    </label>
                    <input type="number" value={schedConfig.minPerDay} min={1} max={20}
                      onChange={e => setSchedConfig(c => ({ ...c, minPerDay: Number(e.target.value) }))}
                      className="w-full rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
                    <p className="mt-1 text-[10px] text-gray-500">Used for any day without its own override below.</p>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">
                      Default max/day
                    </label>
                    <input type="number" value={schedConfig.maxPerDay} min={1} max={30}
                      onChange={e => setSchedConfig(c => ({ ...c, maxPerDay: Number(e.target.value) }))}
                      className="w-full rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
                    <p className="mt-1 text-[10px] text-gray-500">Used for any day without its own override below.</p>
                  </div>
            </div>

            {/* ── Per-day operating + staffing matrix ──────────────────────
                Lets the owner say "Mondays we want 10 in-centre + 2 online,
                Saturdays we want 6 in-centre + 1 online", AND mark whole
                days closed (writes operatingDays back to centerConfig).
                Empty cells fall back to the global defaults above so the
                owner only has to fill the days that differ from the norm. */}
            <PerDayStaffingMatrix
              activeCenterId={activeCenterId}
              centerConfig={centerConfig}
              schedConfig={schedConfig}
              setSchedConfig={setSchedConfig}
              rangeDates={schedRangeDates}
              onDemandLoaded={setBookingDemand}
            />
            <div className="flex flex-wrap items-center gap-4 mb-5">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Max days/instructor/week</label>
                <input type="number" value={schedConfig.maxDaysPerWeek} min={1} max={6}
                  onChange={e => setSchedConfig(c => ({ ...c, maxDaysPerWeek: Number(e.target.value) }))}
                  className="w-24 rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer mt-4">
                <input type="checkbox" checked={schedConfig.fairDistribution}
                  onChange={e => setSchedConfig(c => ({ ...c, fairDistribution: e.target.checked }))}
                  className="accent-red-600 h-4 w-4" />
                Fair distribution (spread shifts evenly)
              </label>
            </div>
            <div className="flex gap-3">
              <button onClick={handleGenerate} disabled={generating || approvedUsers.length === 0}
                className="flex items-center gap-2 rounded-lg bg-purple-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-purple-700 disabled:opacity-50 transition-colors">
                <Wand2 size={16} />
                {generating ? 'Generating…' : 'Generate Draft Schedule'}
              </button>
              {draftSchedule && (
                <button onClick={() => setDraftSchedule(null)}
                  className="flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  <RotateCcw size={15} /> Clear Draft
                </button>
              )}
            </div>
            {approvedUsers.length === 0 && (
              <p className="mt-2 text-xs text-amber-600">⚠ No approved instructors found. Approve users first.</p>
            )}
            {schedError && (
              <div className="mt-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 border border-red-200">{schedError}</div>
            )}
          </div>

          {draftSchedule && (
            <>
              <div className="rounded-xl border bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                  <div>
                    <h3 className="font-bold text-gray-900 text-lg">Draft: {draftRangeLabel}</h3>
                    <p className="text-sm text-gray-500">Review and edit, then save. Shifts land as drafts in the weekly grid — instructors won&apos;t see them until you click Publish.</p>
                  </div>
                  <button onClick={handlePostSchedule} disabled={posting}
                    className="flex items-center gap-2 rounded-lg bg-green-600 px-5 py-2.5 text-sm font-bold text-white shadow-md hover:bg-green-700 disabled:opacity-50 transition-colors">
                    <Send size={16} />
                    {posting ? 'Saving…' : 'Save as drafts'}
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <p className="text-2xl font-bold text-purple-700">{draftSchedule.days.length}</p>
                    <p className="text-xs text-gray-500">Working Days</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <p className="text-2xl font-bold text-blue-700">
                      {draftSchedule.days.reduce((s,d) => s + d.assignedEmployees.length, 0)}
                    </p>
                    <p className="text-xs text-gray-500">Total Shifts</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <p className="text-2xl font-bold text-amber-600">{draftSchedule.warnings.length}</p>
                    <p className="text-xs text-gray-500">Warnings</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <p className="text-2xl font-bold text-orange-600">
                      {draftSchedule.days.reduce((s,d) => s + (d.openSlotsNeeded || 0), 0)}
                    </p>
                    <p className="text-xs text-gray-500">Open Shifts Needed</p>
                  </div>
                </div>
              </div>

              {draftSchedule.warnings.length > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
                  <div className="flex items-center gap-2 mb-3">
                    <AlertTriangle size={18} className="text-amber-600" />
                    <h4 className="font-semibold text-amber-800">Scheduling Warnings</h4>
                  </div>
                  <ul className="space-y-1">
                    {draftSchedule.warnings.map((w,i) => <li key={i} className="text-sm text-amber-700">• {w}</li>)}
                  </ul>
                </div>
              )}

              {/* Day-centric review — a week strip to jump between days, then
                  ONE focused day at a time. Editing still works exactly as
                  before (Edit → the same inline roster editor). */}
              <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
                <div className="border-b bg-gray-50 px-5 py-3">
                  <h4 className="font-semibold text-gray-900">Schedule review</h4>
                  <p className="text-xs text-gray-500">Pick a day to review or edit — red pills are understaffed. Changes save to the draft, not posted yet.</p>
                </div>

                {/* Day strip — the whole range at a glance, coloured by
                    coverage. Click a day to focus it below. */}
                <div className="border-b bg-white px-4 py-3 flex flex-wrap gap-1.5">
                  {draftSchedule.days.map((day, i) => {
                    const low = day.countingStaffCount < schedConfig.minPerDay;
                    const sel = i === selectedDayIndex;
                    return (
                      <button key={day.date} onClick={() => setSelectedDayIndex(i)}
                        className={`flex flex-col items-start rounded-lg border px-2.5 py-1.5 transition-colors ${sel ? 'border-purple-400 bg-purple-50 ring-1 ring-purple-300' : low ? 'border-red-200 bg-red-50 hover:border-red-300' : 'border-gray-200 bg-white hover:border-gray-300'}`}>
                        <span className={`text-[11px] font-semibold ${sel ? 'text-purple-700' : low ? 'text-red-700' : 'text-gray-700'}`}>{day.dayOfWeek.slice(0, 3)} {day.dayNumber}</span>
                        <span className={`text-[10px] ${low ? 'text-red-600 font-bold' : 'text-gray-400'}`}>{day.countingStaffCount}/{schedConfig.minPerDay}{low ? ' ⚠' : ''}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="divide-y divide-gray-100">
                  {draftSchedule.days.map((day, i) => {
                    if (i !== selectedDayIndex) return null;
                    // Compare against the rule the engine ACTUALLY used for this
                    // date, not the global default. With booking-derived
                    // staffing every date can have its own floor, and reading
                    // schedConfig.minPerDay here reported the wrong shortfall
                    // (or flagged a fully-staffed day as low).
                    const dayMin = Number.isFinite(day.effectiveRule?.min)
                      ? day.effectiveRule.min
                      : schedConfig.minPerDay;
                    const isLow = day.countingStaffCount < dayMin;
                    const isEditing = editingDay?.index === i;

                    // Sort assigned names by role priority: Instructor/Lead first,
                    // then Host, then Online, then everything else.
                    const rolePriority = (r) => {
                      if (r === 'Instructor' || r === 'Lead') return 0;
                      if (r === 'Host')                       return 1;
                      if (r === 'Online Instructor')          return 2;
                      return 3;
                    };
                    const sortedNames = [...day.assignedEmployees].sort((a, b) => {
                      const ra = day.roles?.[a] || 'Instructor';
                      const rb = day.roles?.[b] || 'Instructor';
                      const dp = rolePriority(ra) - rolePriority(rb);
                      if (dp !== 0) return dp;
                      return a.localeCompare(b);
                    });

                    return (
                      <div
                        key={day.date}
                        className={`group relative px-5 py-4 transition-colors ${isLow ? 'bg-red-50/50' : 'hover:bg-gray-50/40'}`}
                      >
                        {/* Left edge accent for low-staff days */}
                        {isLow && <span className="absolute left-0 top-0 bottom-0 w-1 bg-red-500" />}

                        {/* Day header */}
                        <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-sm font-bold ${isLow ? 'text-red-800' : 'text-gray-900'}`}>
                              {format(new Date(day.date + 'T12:00:00'), 'EEEE, MMM d')}
                            </span>
                            {isLow ? (
                              <span className="flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
                                <AlertTriangle size={11} />
                                Low staff — need {dayMin - day.countingStaffCount} more
                              </span>
                            ) : (
                              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                                Staffed
                              </span>
                            )}
                            <span className="text-xs text-gray-500">
                              {day.countingStaffCount} instructor{day.countingStaffCount === 1 ? '' : 's'} · {day.assignedEmployees.length} total
                            </span>
                            {/* Where this day's target came from, and what the
                                bookings were — so the roster below can be read
                                against the demand that produced it. */}
                            {day.effectiveRule?.source === 'bookings' && (
                              <span className="rounded-full bg-blue-50 border border-blue-200 px-2 py-0.5 text-xs text-blue-800">
                                from bookings · wants {day.effectiveRule.min}–{day.effectiveRule.max}
                                {bookingDemandPeak(day.date) != null && (
                                  <> · peak {bookingDemandPeak(day.date)} students</>
                                )}
                              </span>
                            )}
                          </div>
                          {!isEditing && (
                            <button onClick={() => handleEditDay(i)}
                              className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:border-gray-300 hover:text-gray-900 hover:bg-gray-50 transition-colors">
                              <Edit3 size={12} /> Edit
                            </button>
                          )}
                        </div>

                        {isEditing ? (
                          <div className="rounded-xl border-2 border-blue-200 bg-blue-50/40 p-4">
                            <div className="flex items-center justify-between mb-3">
                              <p className="text-xs font-bold text-blue-700 uppercase tracking-widest">Editing roster</p>
                              <p className="text-xs text-gray-500 italic">Tweak times and sub-roles below — saves to draft only.</p>
                            </div>

                            {/* Editable rows: avatar + name + start/end + sub-role */}
                            <div className="grid gap-2 mb-4 lg:grid-cols-2">
                              {editingDay.assignedEmployees.map(name => {
                                const sub = subRoleStyleFor(editingDay.subRoles?.[name]);
                                const [startTime, endTime] = parseShiftTimeStr(editingDay.shiftTimes?.[name]);
                                const userForAvatar = usersForCentre.find(uu => uu.displayName === name)
                                  || { displayName: name };
                                return (
                                  <div key={name} className="flex items-center gap-2.5 rounded-lg border border-gray-200 bg-white px-2.5 py-2 shadow-sm">
                                    <div className={`shrink-0 rounded-full ${sub?.blockBg || ''} ring-2 ring-white`} style={{ padding: '2px' }}>
                                      <Avatar user={userForAvatar} size={28} roleColored={false} />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center justify-between mb-1.5">
                                        <p className="text-xs font-semibold text-gray-900 truncate pr-1">{name}</p>
                                        <button
                                          onClick={() => handleRemoveFromDay(name)}
                                          className="shrink-0 rounded text-gray-300 hover:text-red-500 hover:bg-red-50 w-5 h-5 flex items-center justify-center transition-colors"
                                          title={`Remove ${name}`}
                                        >
                                          <X size={12} />
                                        </button>
                                      </div>
                                      <div className="flex items-center gap-1">
                                        <input
                                          type="time"
                                          value={startTime}
                                          onChange={e => handleUpdateDayShiftTime(name, 'start', e.target.value)}
                                          className="w-[88px] rounded border border-gray-200 px-1.5 py-0.5 text-xs focus:border-blue-400 focus:outline-none"
                                        />
                                        <span className="text-gray-400 text-xs">–</span>
                                        <input
                                          type="time"
                                          value={endTime}
                                          onChange={e => handleUpdateDayShiftTime(name, 'end', e.target.value)}
                                          className="w-[88px] rounded border border-gray-200 px-1.5 py-0.5 text-xs focus:border-blue-400 focus:outline-none"
                                        />
                                        <select
                                          value={editingDay.subRoles?.[name] || 'Elementary'}
                                          onChange={e => handleUpdateDaySubRole(name, e.target.value)}
                                          className="ml-auto rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs font-medium focus:border-blue-400 focus:outline-none"
                                          title="Teaching level"
                                        >
                                          {SUB_ROLES.map(sr => (
                                            <option key={sr} value={sr}>{sr}</option>
                                          ))}
                                        </select>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                              {editingDay.assignedEmployees.length === 0 && (
                                <p className="col-span-full text-sm text-gray-400 italic px-1">
                                  No one assigned — add from below
                                </p>
                              )}
                            </div>

                            <p className="mb-2 text-xs font-semibold text-gray-600">
                              Add from approved staff:
                              <span className="ml-2 text-[10px] font-normal text-gray-400 italic">
                                <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 align-middle mr-1" />available ·
                                <span className="inline-block w-2 h-2 rounded-full bg-red-400 align-middle mx-1" />time off ·
                                <span className="inline-block w-2 h-2 rounded-full bg-white border border-gray-300 align-middle mx-1" />no availability set
                              </span>
                            </p>
                            <div className="flex flex-wrap gap-1.5 mb-4">
                              {approvedUsers.filter(u => !editingDay.assignedEmployees.includes(u.displayName)).map(u => {
                                const subs = expandSubRoles(u.subRoles);
                                // Online is its own platform — check it first.
                                const primarySub = subs.includes('Online')
                                  ? 'Online'
                                  : subs.includes('Highschool') ? 'Highschool' : subs.length > 0 ? 'Elementary' : null;
                                const sub = subRoleStyleFor(primarySub);

                                // Availability + time-off status for THIS
                                // day's date. Green = submitted an
                                // available window, red = pending or
                                // approved time-off covers the date,
                                // white = no signal either way (the
                                // existing default look).
                                const dateStr = editingDay.date;
                                const userAvail = availability.find(a => a.userId === u.uid && a.date === dateStr);
                                const userTO = timeOffRequests.find(t =>
                                  t.userId === u.uid &&
                                  t.startDate && t.endDate &&
                                  dateStr >= t.startDate && dateStr <= t.endDate &&
                                  (t.status === 'pending' || t.status === 'approved'),
                                );
                                let pillCls = 'border-gray-300 bg-white text-gray-600 hover:border-gray-500 hover:bg-gray-50 hover:text-gray-900';
                                let title = 'No availability submitted';
                                if (userTO) {
                                  pillCls = 'border-red-300 bg-red-50 text-red-700 hover:border-red-500 hover:bg-red-100';
                                  title = `Time off — ${userTO.status === 'approved' ? 'approved' : 'pending'}${userTO.reason ? ` · ${userTO.reason}` : ''}`;
                                } else if (userAvail) {
                                  pillCls = 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:border-emerald-500 hover:bg-emerald-100';
                                  const isFull = userAvail.startTime === '00:00' && (userAvail.endTime === '23:59' || userAvail.endTime === '24:00');
                                  title = isFull ? 'Available — full day' : `Available ${fmtHHMM(userAvail.startTime)}–${fmtHHMM(userAvail.endTime)}`;
                                }
                                return (
                                  <button key={u.uid} onClick={() => handleAddToDay(u.displayName)}
                                    title={title}
                                    className={`flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-1 text-xs transition-colors ${pillCls}`}
                                  >
                                    <span className={`w-1.5 h-1.5 rounded-full ${sub ? sub.dot : 'bg-gray-300'}`} />
                                    + {u.displayName}
                                  </button>
                                );
                              })}
                              {approvedUsers.filter(u => !editingDay.assignedEmployees.includes(u.displayName)).length === 0 && (
                                <span className="text-xs text-gray-400 italic">All approved staff are already assigned.</span>
                              )}
                            </div>

                            <div className="flex gap-2">
                              <button onClick={handleSaveEditDay} className="flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-green-700 transition-colors">
                                <Check size={12} /> Save day
                              </button>
                              <button onClick={() => setEditingDay(null)} className="rounded-lg border border-gray-200 px-4 py-1.5 text-xs font-medium text-gray-600 hover:bg-white transition-colors">
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {day.assignedEmployees.length === 0 ? (
                              <div className="rounded-xl border-2 border-dashed border-gray-200 bg-gray-50/50 px-4 py-6 text-center">
                                <p className="text-sm text-gray-400 italic">No staff assigned for this day</p>
                              </div>
                            ) : (
                              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                {sortedNames.map(name => {
                                  const role = day.roles?.[name] || 'Instructor';
                                  const subRole = day.subRoles?.[name];
                                  const time = day.shiftTimes?.[name];
                                  const sub = subRoleStyleFor(subRole);
                                  const userForAvatar = usersForCentre.find(uu => uu.displayName === name)
                                    || { displayName: name };
                                  const isHostRow   = role === 'Host';
                                  const isOnlineRow = role === 'Online Instructor';
                                  return (
                                    <div
                                      key={name}
                                      className="flex items-center gap-2.5 rounded-lg border border-gray-200 bg-white px-2.5 py-2 hover:border-gray-300 hover:shadow-sm transition-all"
                                    >
                                      <div
                                        className={`shrink-0 rounded-full ${sub?.blockBg || ''}`}
                                        title={subRole || 'No sub-role'}
                                        style={{ padding: '2px' }}
                                      >
                                        <Avatar user={userForAvatar} size={28} roleColored={false} />
                                      </div>
                                      <div className="min-w-0 flex-1">
                                        <p className="text-xs font-semibold text-gray-900 truncate">{name}</p>
                                        <p className="text-xs text-gray-500 truncate">
                                          {time || '—'}
                                        </p>
                                      </div>
                                      <div className="shrink-0 flex flex-col items-end gap-0.5">
                                        {isHostRow && (
                                          <span className="rounded-full bg-amber-100 text-amber-800 px-1.5 py-0 text-[10px] font-bold uppercase tracking-wide">Host</span>
                                        )}
                                        {isOnlineRow && (
                                          <span className="rounded-full bg-indigo-100 text-indigo-800 px-1.5 py-0 text-[10px] font-bold uppercase tracking-wide">Online</span>
                                        )}
                                        {!isHostRow && !isOnlineRow && role !== 'Instructor' && (
                                          <span className="rounded-full bg-gray-100 text-gray-700 px-1.5 py-0 text-[10px] font-bold uppercase tracking-wide">{role}</span>
                                        )}
                                        {sub && (
                                          <span className={`rounded-full px-1.5 py-0 text-[10px] font-bold uppercase tracking-wide ${sub.pillBg} ${sub.pillText}`} title={sub.label}>
                                            {sub.label[0]}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </>
                        )}

                        {/* Coverage toggle + grid — works in both view and edit modes.
                            Lets the admin see staffing density per half-hour slot
                            so they can decide student capacity. */}
                        {day.assignedEmployees.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-gray-100">
                            <button
                              onClick={() => toggleDayExpanded(i)}
                              className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
                            >
                              {expandedDays.has(i)
                                ? <ChevronDown size={14} />
                                : <ChevronRight size={14} />}
                              <BarChart3 size={12} />
                              {expandedDays.has(i) ? 'Hide coverage' : 'Show coverage'}
                              <span className="ml-1 text-gray-400 font-normal">— half-hour density</span>
                            </button>
                            {expandedDays.has(i) && (
                              <div className="mt-3">
                                {/* In edit mode, render against editingDay so the
                                    admin sees coverage update live as they tweak times. */}
                                <CoverageGrid day={isEditing ? editingDay : day} centerConfig={centerConfig} />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-xl border bg-white p-5 shadow-sm">
                <h4 className="font-semibold text-gray-900 mb-3">Shift Distribution</h4>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {/* `|| {}` on purpose: a draft is produced by one of two
                      engines, and an engine that forgets this key should
                      not be able to take the whole admin page down with
                      Object.entries(undefined). It has happened once. */}
                  {Object.entries(draftSchedule.employeeSummary || {}).sort(([,a],[,b]) => b-a).map(([name, count]) => (
                    <div key={name} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
                      <span className="text-sm text-gray-800">{name}</span>
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${count > 0 ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-400'}`}>{count} {count === 1 ? 'shift' : 'shifts'}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end pb-4">
                <button onClick={handlePostSchedule} disabled={posting}
                  className="flex items-center gap-2 rounded-lg bg-green-600 px-6 py-3 text-sm font-bold text-white shadow-lg hover:bg-green-700 disabled:opacity-50">
                  <CheckCircle size={18} />
                  {posting ? 'Saving…' : `Save ${draftRangeLabel} as drafts`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── PAYROLL ─────────────────────────────────────────────────────── */}
      {tab === 'payroll' && (
        <div className="space-y-6">
          {/* Floating scroll-to-top — the payroll table is long; the chip
              hides itself until the user scrolls past ~400px. */}
          <ScrollTopButton />

          {/* (Removed) "Payroll tools" toolbar — the WIW import + bulk-
              delete buttons it housed are migration-era tooling we no
              longer need surfaced at the top of every payroll view. The
              ImportFromWiwButton + BulkDeleteShiftsByDate components are
              still defined in this file and can be re-mounted somewhere
              (e.g. a Settings page) if those workflows come back. */}

          {/* Sub-tabs inside Payroll. Default lands on the pay-period view
              (the existing screen). Sick Days flips to a roster view of
              year-to-date sick usage per employee, with probation status. */}
          <div className="flex gap-1 border-b border-gray-200">
            <button onClick={() => setPayrollSubtab('period')}
              className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
                payrollSubtab === 'period'
                  ? 'border-b-2 border-green-600 text-green-700 bg-white'
                  : 'text-gray-500 hover:text-gray-800'
              }`}>
              <CalendarRange size={16} /> This Period
            </button>
            <button onClick={() => setPayrollSubtab('sick')}
              className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
                payrollSubtab === 'sick'
                  ? 'border-b-2 border-amber-600 text-amber-700 bg-white'
                  : 'text-gray-500 hover:text-gray-800'
              }`}>
              <Activity size={16} /> Sick Days
              <span className="rounded-full bg-amber-100 text-amber-700 text-[10px] px-1.5 py-0.5 font-bold">
                {sickDaysSummary.reduce((s, p) => s + p.used, 0)}/{sickDaysSummary.length * SICK_DAYS_PER_YEAR}
              </span>
            </button>
            <button onClick={() => setPayrollSubtab('stat')}
              className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
                payrollSubtab === 'stat'
                  ? 'border-b-2 border-purple-600 text-purple-700 bg-white'
                  : 'text-gray-500 hover:text-gray-800'
              }`}>
              <Activity size={16} /> Stat Pay
              {statPaySummary.rows.some(r => r.qualifies) && (
                <span className="rounded-full bg-purple-100 text-purple-700 text-[10px] px-1.5 py-0.5 font-bold">
                  {statPaySummary.rows.filter(r => r.qualifies).length}
                </span>
              )}
            </button>
          </div>

          {/* ── Stat Pay sub-tab ──────────────────────────────────────── */}
          {payrollSubtab === 'stat' && (
            <StatPayTab holidays={statPaySummary.holidays} rows={statPaySummary.rows} />
          )}

          {/* ── Sick Days sub-tab ─────────────────────────────────────── */}
          {payrollSubtab === 'sick' && (
            <SickDaysTab
              rows={sickDaysSummary}
              year={new Date().getFullYear()}
              maxPerYear={SICK_DAYS_PER_YEAR}
              probationDays={PROBATION_DAYS}
              onAddExternalSickDate={handleAddExternalSickDate}
              onRemoveExternalSickDate={handleRemoveExternalSickDate}
              onSetHireDate={handleSetHireDate}
            />
          )}

          {/* ── "This Period" sub-tab — wraps the original payroll UI ── */}
          {payrollSubtab === 'period' && (<>

          {/* Stat-pay heads-up — a compact signal when the selected pay
              period includes a statutory holiday. The full per-person
              breakdown now lives on the Stat Pay sub-tab, so this just flags
              it and links across. */}
          {statDiagnostic && statDiagnostic.inPeriod.length > 0 && (
            <div className="rounded-xl border border-purple-200 bg-purple-50 p-4 flex items-center gap-3 flex-wrap">
              <div className="rounded-lg bg-purple-100 p-2 text-purple-700 shrink-0">
                <Activity size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-bold text-purple-900 text-sm">Heads up — stat pay this pay period</h4>
                <p className="text-xs text-purple-700">
                  Includes {statDiagnostic.inPeriod.map(h => `${h.name || 'a statutory holiday'} (${h.date})`).join(', ')}.
                  {' '}{statPaySummary.rows.filter(r => r.qualifies).length} of {statPaySummary.rows.length} staff qualify — open the Stat Pay tab for the breakdown.
                </p>
                {/* Closures sitting in the same period. Stating them plainly
                    so a day that stopped paying is visibly a decision rather
                    than something that quietly went missing. */}
                {statDiagnostic.closuresInPeriod?.length > 0 && (
                  <p className="mt-1 text-xs text-purple-600">
                    Also closed {statDiagnostic.closuresInPeriod.map(h => `${h.name || 'closure'} (${h.date})`).join(', ')} —
                    {' '}not {statDiagnostic.closuresInPeriod.length === 1 ? 'a statutory holiday, so it pays' : 'statutory holidays, so they pay'} no stat pay.
                  </p>
                )}
              </div>
              <button onClick={() => setPayrollSubtab('stat')}
                className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700 transition-colors">
                View Stat Pay →
              </button>
            </div>
          )}

          {/* Pay period selector */}
          <div className="rounded-xl border bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <CalendarRange size={18} className="text-green-600" />
              <h3 className="font-semibold text-gray-900">Select Pay Period</h3>
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Start Date</label>
                <input type="date" value={payStart} onChange={e => setPayStart(e.target.value)}
                  className="rounded-lg border px-3 py-2 text-sm focus:border-green-500 focus:outline-none focus:ring-2 focus:ring-green-500/20" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">End Date</label>
                <input type="date" value={payEnd} onChange={e => setPayEnd(e.target.value)}
                  className="rounded-lg border px-3 py-2 text-sm focus:border-green-500 focus:outline-none focus:ring-2 focus:ring-green-500/20" />
              </div>
              {/* Quick select buttons */}
              <div className="flex flex-wrap gap-2">
                {[
                  { label: '11th – 25th', fn: () => {
                    const y = today.getMonth() === 0 && today.getDate() < 11 ? today.getFullYear() - 1 : today.getFullYear();
                    const m = String(today.getMonth() + 1).padStart(2,'0');
                    setPayStart(`${y}-${m}-11`); setPayEnd(`${y}-${m}-25`);
                  }},
                  { label: '26th – 10th', fn: () => {
                    const start = new Date(today.getFullYear(), today.getMonth(), 26);
                    const end   = new Date(today.getFullYear(), today.getMonth() + 1, 10);
                    setPayStart(format(start, 'yyyy-MM-dd')); setPayEnd(format(end, 'yyyy-MM-dd'));
                  }},
                ].map(q => (
                  <button key={q.label} onClick={q.fn}
                    className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs font-medium text-green-700 hover:bg-green-100 transition-colors">
                    {q.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Summary bar */}
            {payrollSummary.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-gray-50 px-4 py-3">
                <div className="flex flex-wrap gap-6 text-sm">
                  <div>
                    <span className="text-gray-500">Pay period: </span>
                    <span className="font-semibold text-gray-800">{payPeriodLabel}</span>
                    {payoutLabel && (
                      <span className="ml-2 rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-[11px] font-semibold">
                        Paid {payoutLabel}
                      </span>
                    )}
                  </div>
                  <div>
                    <span className="text-gray-500">Staff: </span>
                    <span className="font-semibold text-gray-800">{payrollSummary.length}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Total shifts: </span>
                    <span className="font-semibold text-gray-800">{payrollSummary.reduce((s,p) => s + p.shifts.length, 0)}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Hours worked: </span>
                    <span className="font-bold text-gray-800"
                      title="Sum of Pay h — no-shows count 0 and per-shift overrides are honoured. Sick and stat are paid on top; see Total payable.">
                      {Math.round(totalPayrollHours * 100) / 100}h
                    </span>
                    {totalNoShowHours > 0 && (
                      <span className="ml-2 rounded bg-gray-200 px-1.5 py-0.5 text-[11px] font-semibold text-gray-500"
                        title="No-show hours excluded from the total above.">
                        −{Math.round(totalNoShowHours * 100) / 100}h no show · {totalNoShowCount} shift{totalNoShowCount !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  {/* The number that actually leaves the building. */}
                  <div>
                    <span className="text-gray-500">Total payable: </span>
                    <span className="font-bold text-green-700"
                      title="Worked + payable sick + stat. This is the Total Payable Hrs column in the export.">
                      {Math.round(totalPayableHours * 100) / 100}h
                    </span>
                    {(totalSickPaidHours > 0 || totalStatHours > 0) && (
                      <span className="ml-1.5 text-[11px] text-gray-500">
                        ({Math.round(totalPayrollHours * 100) / 100} worked
                        {totalSickPaidHours > 0 && <> + {Math.round(totalSickPaidHours * 100) / 100} sick</>}
                        {totalStatHours > 0 && <> + {Math.round(totalStatHours * 100) / 100} stat</>})
                      </span>
                    )}
                  </div>
                </div>
                {/* Unresolved counter — aggregates red rows across all
                    visible persons. Pulls from comparisonSummary (which
                    overlays Radius matches onto payrollSummary). When
                    there's no Radius import yet, comparisonSummary is
                    null and we fall back to payrollSummary, where no
                    discrepancies are computed → zero unresolved. */}
                {(() => {
                  const rows = (comparisonSummary?.perPerson) || [];
                  let unresolved = 0;
                  for (const p of rows) {
                    for (const s of (p.shiftComparisons || [])) {
                      // No-shows are explained, not outstanding — never count them.
                      // Future shifts aren't outstanding work — they just
                      // haven't happened. Counting them made the export
                      // warning fire on every mid-period run.
                      if (payrollNeedsReview(s)) unresolved++;
                    }
                  }
                  return (
                    <div className="flex items-center gap-3">
                      {unresolved > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-3 py-1 text-xs font-bold text-red-700"
                          title="Click Resolve on each red row after reviewing.">
                          ⚠ {unresolved} unresolved
                        </span>
                      ) : (
                        rows.length > 0 && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-700">
                            ✓ all resolved
                          </span>
                        )
                      )}
                      <button onClick={() => handleExportFinalPayroll(unresolved)}
                        className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-700 transition-colors">
                        <Download size={15} /> Export Final Payroll
                      </button>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Radius entries for people who aren't on hourly payroll. Stated
              plainly rather than dropped in silence, so it's clear they were
              seen and deliberately set aside. */}
          {comparisonSummary?.ignoredRadius?.length > 0 && (() => {
            const byName = new Map();
            for (const r of comparisonSummary.ignoredRadius) {
              byName.set(r.name, (byName.get(r.name) || 0) + (Number(r.hours) || 0));
            }
            return (
              <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
                <p className="text-xs font-semibold text-sky-900">
                  {comparisonSummary.ignoredRadius.length} Radius {comparisonSummary.ignoredRadius.length === 1 ? 'entry' : 'entries'} skipped — not on hourly payroll
                </p>
                <p className="mt-0.5 text-[11px] text-sky-800">
                  {[...byName.entries()].map(([n, h]) => `${n} (${Math.round(h * 100) / 100}h)`).join(' · ')}
                </p>
                <p className="mt-1 text-[10px] text-sky-600">
                  Volunteers, salaried staff and hidden accounts clock in like everyone else, but aren't paid hourly — so their timesheet entries don't create payroll rows.
                </p>
              </div>
            );
          })()}

          {/* Shifts in this period that pay nothing — the silent-failure
              catcher. A worked-but-unpublished shift used to vanish from
              payroll with no warning at all. */}
          {payrollGaps.length > 0 && (
            <div className="mt-4 rounded-xl border-2 border-amber-300 bg-amber-50 p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="text-sm font-bold text-amber-900">
                    ⚠ {payrollGaps.length} shift{payrollGaps.length === 1 ? '' : 's'} in this period will pay 0 hours
                  </h4>
                  <p className="text-xs text-amber-800">
                    These are in the pay period but contribute nothing to payroll. Check each one before exporting.
                  </p>
                </div>
                {payrollGaps.some(g => g.isDraft) && (
                  <button
                    onClick={() => handlePublishShifts(payrollGaps.filter(g => g.isDraft).map(g => g.shift))}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700"
                  >
                    Publish {payrollGaps.filter(g => g.isDraft).length} draft{payrollGaps.filter(g => g.isDraft).length === 1 ? '' : 's'}
                  </button>
                )}
              </div>
              <div className="divide-y divide-amber-200 rounded-lg border border-amber-200 bg-white">
                {payrollGaps.map(g => (
                  <div key={g.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <span className="text-xs font-semibold text-gray-900">{g.name}</span>
                      <span className="ml-2 text-[11px] text-gray-500">
                        {new Date(g.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                        {' · '}{g.label}
                        {g.hours > 0 && <> · <b>{g.hours.toFixed(2)}h</b> scheduled</>}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                        {g.reason}
                      </span>
                      {g.isDraft ? (
                        <button
                          onClick={() => handlePublishSingleShift(g.shift)}
                          className="rounded-md border border-emerald-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50"
                        >
                          Publish
                        </button>
                      ) : (
                        // Broken times — let payroll be corrected now, rather
                        // than blocking the run on a schedule edit.
                        <GapHoursInput onSave={(n) => setGapPayHours(g.id, n)} />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Radius Import — auto-collapses to a one-line chip once
              entries are loaded, so it doesn't waste vertical space on
              the working flow (reconcile rows → resolve → export).
              Click the chip to expand and re-import a different file. */}
          {payrollSummary.length > 0 && radiusData.length > 0 && !radiusExpanded && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-2.5 shadow-sm flex items-center gap-3">
              <CheckCircle size={16} className="text-blue-600 shrink-0" />
              <div className="flex-1 text-sm">
                <span className="font-semibold text-blue-900">Radius timesheet loaded:</span>{' '}
                <span className="text-blue-800">{radiusData.length} entries</span>
                {radiusFileName && <span className="text-blue-600 ml-1">· {radiusFileName}</span>}
              </div>
              <button
                onClick={() => setRadiusExpanded(true)}
                className="rounded-md border border-blue-300 bg-white px-3 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100">
                Re-import
              </button>
            </div>
          )}
          {payrollSummary.length > 0 && (radiusData.length === 0 || radiusExpanded) && (
            <div className="rounded-xl border bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-2 h-2 rounded-full bg-blue-500" />
                <h3 className="font-semibold text-gray-900">Radius Timesheet Import</h3>
                {radiusData.length > 0 && (
                  <>
                    <span className="ml-2 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700">
                      {radiusData.length} entries loaded
                    </span>
                    <button onClick={() => setRadiusExpanded(false)}
                      className="ml-auto text-xs font-semibold text-gray-500 hover:text-gray-800">
                      Collapse
                    </button>
                  </>
                )}
              </div>
              <p className="text-sm text-gray-500 mb-4">
                Upload the Radius Excel export for this pay period. The portal will compare actual sign-in/out times against scheduled shifts and flag any discrepancies.
              </p>
              <label className="flex items-center gap-3 cursor-pointer w-fit">
                <div className="flex items-center gap-2 rounded-lg border-2 border-dashed border-blue-300 bg-blue-50 px-4 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-100 transition-colors">
                  <Download size={15} className="rotate-180" />
                  {radiusFileName ? `Loaded: ${radiusFileName}` : 'Upload Radius Export (.xlsx)'}
                </div>
                <input type="file" accept=".xlsx" onChange={handleRadiusImport} className="hidden" />
              </label>
              {radiusError && <p className="mt-2 text-sm text-red-600">{radiusError}</p>}
              {radiusData.length > 0 && (
                <button onClick={() => { setRadiusData([]); setRadiusFileName(''); }}
                  className="mt-2 text-xs text-gray-400 hover:text-red-500">
                  Clear Radius data
                </button>
              )}
            </div>
          )}

          {/* Signed in, never signed out.
              Its own panel rather than a badge buried in the table: these
              are the rows a human has to chase, and they used to be
              invisible — the importer dropped them and the shift read as
              "Not in Radius", i.e. never turned up. */}
          {openSignOuts.length > 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-5 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <AlertTriangle size={16} className="text-amber-700" />
                <h3 className="font-semibold text-amber-900">
                  {openSignOuts.length} {openSignOuts.length === 1 ? 'shift has' : 'shifts have'} a sign-in but no sign-out
                </h3>
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-amber-900/80">
                Radius recorded them arriving and nothing else. They worked — we just
                don&apos;t know when they left, so these hours can&apos;t be paid from the clock
                alone. Emailing asks each person to confirm their scheduled finish time;
                whatever comes back is marked as self-reported and still shows up here for you
                to check.
              </p>

              <ul className="mt-3 divide-y divide-amber-200 rounded-lg border border-amber-200 bg-white">
                {openSignOuts.map(({ person, shift, row }) => (
                  <li key={shift.shiftId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    <span className="font-medium text-gray-900">{person}</span>
                    <span className="text-gray-500">
                      {new Date(`${shift.date}T12:00:00`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })}
                    </span>
                    <span className="tabular-nums text-gray-600">
                      in {fmt12h(normalizeTimeToHHMM(row?.timeIn))}
                    </span>
                    <span className="text-gray-400">→</span>
                    <span className="tabular-nums text-gray-600">
                      scheduled out {fmt12h(normalizeTimeToHHMM(shift.endTime))}
                    </span>
                    {shift.signOutRequestSentAt && (
                      <span className="ml-auto rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600"
                        title={`Asked on ${new Date(shift.signOutRequestSentAt).toLocaleString()}`}>
                        already asked
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              <button
                onClick={handleSendSignOutRequests}
                disabled={sendingSignOuts}
                className="mt-3 flex items-center gap-2 rounded-lg bg-amber-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Mail size={15} />
                {sendingSignOuts
                  ? 'Sending…'
                  : `Send sign-out ${openSignOuts.length === 1 ? 'request' : 'requests'} (${openSignOuts.length})`}
              </button>
              <p className="mt-2 text-xs text-amber-900/70">
                Nothing is emailed until you press this. Links work once and expire in {SIGNOUT_TTL_DAYS} days.
              </p>
            </div>
          )}

          {/* Currently-excluded salary staff. Click × on any chip to add them
              back to payroll for this period. Owner / super-admin only:
              writing to centerConfig.salaryStaff requires isOwnerAtCenter
              in the Firestore rules, so plain admins would just see the
              chips fail silently. Hide them entirely instead. */}
          {canSeeCenterSettings && Array.isArray(centerConfig?.salaryStaff) && centerConfig.salaryStaff.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                <UserX size={13} /> Excluded from hourly payroll
                <span className="text-[10px] font-normal text-amber-700">(salaried — paid outside this sheet)</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {centerConfig.salaryStaff.map(n => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => handleIncludeInPayroll(n)}
                    title={`Include ${n} on payroll again`}
                    className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-white px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                  >
                    {n}
                    <X size={11} className="text-amber-500" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Per-person breakdown — with Radius comparison if loaded */}
          {payrollSummary.length === 0 ? (
            <div className="rounded-xl border bg-white p-10 text-center shadow-sm">
              <DollarSign size={36} className="mx-auto mb-3 text-gray-300" />
              <p className="text-gray-500 font-medium">No shifts found for this pay period.</p>
              <p className="text-sm text-gray-400 mt-1">Make sure shifts are posted and the date range is correct.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {((comparisonSummary?.perPerson) || payrollSummary).map(person => {
                const hasRadius = !!comparisonSummary;
                const shiftRows = hasRadius ? person.shiftComparisons : person.shifts;
                // "Discrepancy" now means rows that still need a human, not
                // rows whose arithmetic is merely wide. A card where every
                // exception has been resolved is DONE — it shouldn't keep
                // wearing a red border and an ⚠ badge, and it certainly
                // shouldn't have said "✓ match" while a row sat unresolved.
                const openIssues = hasRadius
                  ? (person.shiftComparisons || []).filter(payrollNeedsReview).length
                  : 0;
                const isDiscrepant = openIssues > 0;
                return (
                  <div key={person.name} className={`rounded-xl border shadow-sm overflow-hidden bg-white ${isDiscrepant ? 'border-red-300' : ''}`}>
                    {/* Person header */}
                    <div className={`flex items-center justify-between px-5 py-3 border-b ${isDiscrepant ? 'bg-red-50' : 'bg-gray-50'}`}>
                      <div className="flex items-center gap-3">
                        <Avatar
                          user={usersForCentre.find(uu => uu.displayName === person.name) || { displayName: person.name }}
                          size={32}
                        />
                        <div>
                          <span className="font-semibold text-gray-900">{person.name}</span>
                          <span className="ml-2 text-xs text-gray-500">{person.role}</span>
                          {isDiscrepant && (
                            <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">⚠ Discrepancy</span>
                          )}
                          {/* Quick toggle: mark this person as salaried so they
                              drop off the hourly payroll on the next render.
                              Owner / super-admin only — writing salaryStaff
                              is gated by Firestore rules so admins would
                              just bounce here. */}
                          {canSeeCenterSettings && (
                            <button
                              type="button"
                              onClick={() => handleExcludeFromPayroll(person.name)}
                              title="Mark as salary staff and exclude from this payroll"
                              className="ml-2 inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-500 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700"
                            >
                              <UserX size={10} /> Exclude
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        {/* Payable is the number this whole screen exists to
                            produce, so it's the biggest thing on the card.
                            The old header restated Scheduled / Actual / Diff —
                            which the totals row already shows, and the small
                            green Payable badge underneath was easy to miss.
                            Those three now live in the totals row only. */}
                        {hasRadius ? (
                          <>
                            <div className="text-[11px] uppercase tracking-wide text-gray-400">Payable</div>
                            <div className="text-2xl font-semibold leading-tight text-gray-900">
                              {payableFor(person).toFixed(2)}h
                            </div>
                            {isDiscrepant && (
                              <div className="mt-0.5 text-xs font-semibold text-red-600">
                                {openIssues} to review
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <div className="text-sm font-bold text-green-700">{(person.payHours ?? person.totalHours).toFixed(2)}h worked</div>
                            <div className="text-xs text-gray-400">
                              {person.shifts.length - (person.sickCount || 0) - (person.noShowCount || 0)} worked shift{person.shifts.length - (person.sickCount || 0) - (person.noShowCount || 0) !== 1 ? 's' : ''}
                            </div>
                          </>
                        )}
                        {/* Sick + Stat badges render in BOTH views (normal AND
                            after a Radius import). They used to live only in the
                            non-Radius branch, so importing timesheets made the
                            purple Stat badge vanish even though the pay was still
                            owed. */}
                        {(person.sickCount || 0) > 0 && (
                          <div className="mt-1 flex flex-wrap items-center gap-1 text-xs font-semibold">
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700">
                              Sick: {person.sickHours.toFixed(2)}h · {person.sickCount} shift{person.sickCount !== 1 ? 's' : ''}
                            </span>
                            {/* Beyond the 5-day annual entitlement (or taken on
                                probation) — recorded, but not payable. */}
                            {(person.sickUnpaidHours || 0) > 0 && (
                              <span className="rounded bg-gray-200 px-1.5 py-0.5 text-gray-600"
                                title="Past the 5-day annual sick entitlement, or taken during probation — recorded but not paid.">
                                {person.sickUnpaidHours.toFixed(2)}h unpaid
                              </span>
                            )}
                            {person.noHireDate && (
                              <span className="rounded bg-orange-100 px-1.5 py-0.5 text-orange-700"
                                title="No hire date on file, so probation can't be checked. Sick is paid by default — set a hire date under Sick Days to be sure.">
                                no hire date
                              </span>
                            )}
                          </div>
                        )}
                        {/* Payable — worked + payable sick + stat. Without
                            this the card showed 75h worked next to a 5h sick
                            badge and never stated the 80h actually owed. */}
                        {/* In the Radius view Payable is already the hero above,
                            so this badge would just restate it. What's still
                            worth saying is the make-up when it isn't purely
                            worked hours — that shows as a quiet breakdown line
                            instead of a second green badge. */}
                        {hasRadius && (payableFor(person) > 0)
                          && ((person.sickPaidHours || 0) > 0 || (person.statHours || 0) > 0) && (
                          <div className="mt-1 text-[11px] text-gray-500">
                            {(person.payHours ?? person.totalHours ?? 0).toFixed(2)} worked
                            {(person.sickPaidHours || 0) > 0 && <> + {person.sickPaidHours.toFixed(2)} sick</>}
                            {(person.statHours || 0) > 0 && <> + {person.statHours.toFixed(2)} stat</>}
                          </div>
                        )}
                        {!hasRadius && (payableFor(person) > 0) && (
                          <div className="mt-1.5 rounded-lg bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-800">
                            Payable: {payableFor(person).toFixed(2)}h
                            {((person.sickPaidHours || 0) > 0 || (person.statHours || 0) > 0) && (
                              <span className="ml-1 font-medium text-emerald-700">
                                ({(person.payHours ?? person.totalHours ?? 0).toFixed(2)} worked
                                {(person.sickPaidHours || 0) > 0 && <> + {person.sickPaidHours.toFixed(2)} sick</>}
                                {(person.statHours || 0) > 0 && <> + {person.statHours.toFixed(2)} stat</>})
                              </span>
                            )}
                          </div>
                        )}
                        {(person.noShowCount || 0) > 0 && (
                          <div className="mt-1 text-xs font-semibold text-gray-500">
                            <span className="rounded bg-gray-200 px-1.5 py-0.5"
                              title="Scheduled but didn't come in — unpaid and excluded from the period total.">
                              No show: {person.noShowHours.toFixed(2)}h · {person.noShowCount} shift{person.noShowCount !== 1 ? 's' : ''} · unpaid
                            </span>
                          </div>
                        )}
                        {(person.statDays || 0) > 0 && (
                          <div
                            className="mt-1 text-xs font-semibold text-purple-700"
                            title={(person.statEntries || []).map(e => `${e.name} (${e.date}): ${e.hours.toFixed(2)}h · ${e.basisDays} days worked in prior 30d`).join('\n')}
                          >
                            <span className="rounded bg-purple-100 px-1.5 py-0.5">
                              Stat: {person.statHours.toFixed(2)}h · {person.statDays} day{person.statDays !== 1 ? 's' : ''}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Shift rows */}
                    <table className="w-full text-sm">
                      <thead>
                        {/* Six columns, not eight. Each time range now carries
                            its own hour total underneath it — "Scheduled
                            3:30–5:30 PM / 2.00h" is one idea, not two columns.
                            That folds away the old standalone `Sched. h` and
                            `Check In/Out Actuals` columns, and collapses the
                            confusing "Radius Actual" vs "Check In/Out Actuals"
                            split (raw times vs hours derived from those same
                            times) into a single Clocked in/out column. */}
                        <tr className="border-b bg-white">
                          <th className="text-left px-5 py-2 text-xs font-medium text-gray-500 w-36">Date</th>
                          <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Scheduled</th>
                          {hasRadius && <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Clocked in/out</th>}
                          {!hasRadius && <th className="text-right px-5 py-2 text-xs font-medium text-gray-500">Hours</th>}
                          {hasRadius && <th className="text-right px-5 py-2 text-xs font-medium text-gray-500 w-20">Diff</th>}
                          {hasRadius && (
                            <th className="text-right px-5 py-2 text-xs font-medium text-purple-600" title="Hours actually paid. Defaults to scheduled; click any cell to override. This is the value Export Final Payroll uses for QuickBooks.">
                              <div className="flex flex-col items-end leading-tight">
                                <span>Payroll h</span>
                                <span className="text-[9px] font-normal text-purple-400 italic">click to edit</span>
                              </div>
                            </th>
                          )}
                          {hasRadius && (
                            <th className="text-right px-5 py-2 text-xs font-medium text-gray-500 w-48"
                              title="Resolve = I've reviewed this. No show = they didn't come in, so it pays 0 and leaves the period total. The note icon records why.">
                              Actions
                            </th>
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {shiftRows.map((s, i) => {
                          const fmtT = (t) => {
                            if (!t) return '–';
                            const [hStr, mStr] = t.split(':');
                            let h = parseInt(hStr, 10);
                            const m = parseInt(mStr, 10);
                            const ampm = h >= 12 ? 'PM' : 'AM';
                            if (h > 12) h -= 12;
                            if (h === 0) h = 12;
                            return `${h}:${String(m).padStart(2,'0')} ${ampm}`;
                          };
                          const dateLabel = new Date(s.date + 'T00:00:00').toLocaleDateString('en-US', {
                            weekday: 'short', month: 'short', day: 'numeric',
                          });
                          // No-show — scheduled, didn't come in. Renders grey
                          // and pays 0. It never counts as a red discrepancy:
                          // "not in Radius" is expected when nobody showed up.
                          const isNoShow = !!s.noShow;
                          // Future shifts can't be discrepant — they haven't
                          // happened. They render neutral rather than red.
                          // `payrollNeedsReview` also folds in payrollResolved,
                          // which the caller below re-applies; passing a copy
                          // without it keeps the existing "resolved overrides
                          // the red flag" behaviour intact one line down.
                          const rowFlag = hasRadius
                            && payrollNeedsReview({ ...s, payrollResolved: false });
                          const hasNote = !!(s.payrollNote && s.payrollNote.trim());
                          const isEditingNote = noteEditing.shiftId === s.shiftId;
                          // Resolved overrides the red flag — once admin
                          // ✓'s a row, it goes green even if the underlying
                          // Sched/Actual diff is still mathematically wide.
                          // The Diff number still shows red text so the
                          // delta isn't hidden; the row background is the
                          // "I've acknowledged this" signal.
                          const rowResolved = rowFlag && s.payrollResolved;
                          const showRedFlag = rowFlag && !rowResolved;
                          return (
                            <Fragment key={i}>
                            <tr className={`transition-colors ${
                              isNoShow ? 'bg-gray-100 text-gray-400 hover:bg-gray-200/70'
                              : showRedFlag ? 'bg-red-50 hover:bg-red-100'
                              : rowResolved ? 'bg-emerald-50/70 hover:bg-emerald-100/70'
                              : s.sick ? 'bg-amber-50/60 hover:bg-amber-100/60'
                              : 'hover:bg-gray-50'
                            }`}>
                              <td className={`px-5 py-2.5 font-medium ${isNoShow ? 'text-gray-400' : 'text-gray-800'}`}>
                                {dateLabel}
                                {s.sick && (
                                  <span className="ml-2 rounded bg-amber-200 text-amber-900 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">Sick</span>
                                )}
                                {isNoShow && (
                                  <span className="ml-2 rounded bg-gray-300 text-gray-700 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">No Show</span>
                                )}
                              </td>
                              {/* Scheduled — time range with its own hour total
                                  directly beneath, replacing the old separate
                                  `Sched. h` column. */}
                              <td className={`px-4 py-2.5 text-xs ${isNoShow ? 'text-gray-400' : 'text-gray-600'}`}>
                                <div className={isNoShow ? 'line-through' : ''}>{fmtT(s.startTime)} – {fmtT(s.endTime)}</div>
                                {/* Only fold hours in when there's a Radius
                                    comparison. Without one, Hours keeps its own
                                    column and repeating it here would be the
                                    exact duplication this change removes. */}
                                {hasRadius && (
                                  <div className={`text-[11px] text-gray-400 ${isNoShow ? 'line-through' : ''}`}>{s.hours.toFixed(2)}h</div>
                                )}
                              </td>
                              {hasRadius && (
                                <td className="px-4 py-2.5 text-xs">
                                  {s.isFuture && s.missingFromRadius ? (
                                    // Hasn't happened yet — neutral, not an error.
                                    <span className="inline-block rounded bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                                      Upcoming
                                    </span>
                                  ) : s.missingFromRadius ? (
                                    <span className={`font-medium ${isNoShow ? 'text-gray-400' : 'text-red-500'}`}>
                                      {isNoShow ? 'No clock-in — no show' : 'Not in Radius'}
                                    </span>
                                  ) : s.signOutState === 'in-progress' ? (
                                    // Clocked in, shift not finished yet. Not a
                                    // problem and not chased — they're at work.
                                    <div>
                                      <span className="inline-flex items-center gap-1 rounded bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-800 ring-1 ring-inset ring-sky-300">
                                        On shift now
                                      </span>
                                      <div className="mt-1 text-[11px] text-gray-500 tabular-nums">
                                        in {fmt12h(normalizeTimeToHHMM(s.actual.timeIn))}
                                      </div>
                                    </div>
                                  ) : s.signOutState === 'open' ? (
                                    // Signed in, never signed out. AMBER, not red,
                                    // and worded so it can't be misread as absence:
                                    // we know they were here, we just don't know
                                    // when they left.
                                    <div>
                                      <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-300">
                                        Signed in · no sign-out
                                      </span>
                                      <div className="mt-1 flex items-center gap-1 text-[11px] text-gray-500">
                                        <span className="tabular-nums">in {fmt12h(normalizeTimeToHHMM(s.actual.timeIn))}</span>
                                        <span>· out unknown</span>
                                      </div>
                                    </div>
                                  ) : s.signOutState === 'self-confirmed' ? (
                                    // They filled in their own sign-out from the
                                    // emailed link. Purple is this table's existing
                                    // "a human typed this" colour (same as a manual
                                    // Payroll h override), so it reads consistently.
                                    <div>
                                      <span className="inline-flex items-center gap-1 rounded bg-purple-100 px-2 py-0.5 text-[11px] font-semibold text-purple-800 ring-1 ring-inset ring-purple-300"
                                        title={`Sign-out time supplied by the instructor${s.signOutConfirmedAt ? ` on ${new Date(s.signOutConfirmedAt).toLocaleString()}` : ''}. Radius has no tap-out for this shift.`}>
                                        Self-confirmed sign-out
                                      </span>
                                      <div className="mt-1 text-[11px] text-gray-500 tabular-nums">
                                        in {fmt12h(normalizeTimeToHHMM(s.actual.timeIn))} – {fmt12h(s.signOutConfirmed?.time)} (stated)
                                      </div>
                                    </div>
                                  ) : (
                                    <>
                                      <div className="flex items-center gap-1">
                                        <input type="time" value={normalizeTimeToHHMM(s.actual.timeIn)}
                                          onChange={e => updateRadiusEntry(s.actual._idx, 'timeIn', e.target.value)}
                                          className="rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-700 w-[86px] focus:border-blue-500 focus:outline-none" />
                                        <span className="text-gray-400">–</span>
                                        <input type="time" value={normalizeTimeToHHMM(s.actual.timeOut)}
                                          onChange={e => updateRadiusEntry(s.actual._idx, 'timeOut', e.target.value)}
                                          className="rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-700 w-[86px] focus:border-blue-500 focus:outline-none" />
                                        <button onClick={() => deleteRadiusEntry(s.actual._idx)}
                                          className="ml-1 text-gray-300 hover:text-red-500 transition-colors" title="Remove entry">
                                          <Trash2 size={12} />
                                        </button>
                                      </div>
                                      {/* Actual hours, folded under the times they
                                          derive from instead of a column of their own. */}
                                      <div className="mt-0.5 text-[11px] text-gray-400">
                                        {(s.actualShareHours != null ? s.actualShareHours : s.actual.actualHours).toFixed(2)}h
                                        {s.sharedClockIn && (
                                          <span className="ml-1" title="One Radius clock-in covers back-to-back shifts — hours split across them.">· shared</span>
                                        )}
                                      </div>
                                    </>
                                  )}
                                </td>
                              )}
                              {/* Without a Radius import there's no comparison to
                                  make, so hours keep their own plain column. */}
                              {!hasRadius && (
                                <td className={`px-5 py-2.5 text-right font-semibold ${isNoShow ? 'text-gray-400 line-through' : 'text-gray-800'}`}>{s.hours.toFixed(2)}h</td>
                              )}
                              {/* Payroll Hours — single click to override.
                                  Rendered as an obvious editable cell:
                                  bordered "input-style" box with a tiny
                                  pencil mark so admins at other centres
                                  can tell it's interactive without being
                                  told. Purple ring when an override is
                                  active so manual edits stand out. */}
                              {/* Diff sits immediately left of Payroll h so the
                                  gap reads next to the number you'd change in
                                  response to it. Colour means one thing only:
                                  "this needs your attention." A green +0.20h
                                  and a red +1.98h on a row already marked
                                  Resolved were both noise — the number stays
                                  visible but goes quiet once the row is
                                  handled, clean, or hasn't happened yet. Red is
                                  reserved for live, unreviewed exceptions. */}
                              {hasRadius && (
                                <td className={`px-5 py-2.5 text-right font-semibold text-xs ${
                                  showRedFlag ? 'text-red-600' : 'text-gray-400'
                                }`}>
                                  {isNoShow ? 'not paid'
                                    : (s.isFuture && s.missingFromRadius) ? '—'
                                    : s.missingFromRadius ? (showRedFlag ? '⚠ missing' : 'missing')
                                    // No sign-out means no duration to compare
                                    // against — a diff here would be fiction.
                                    : s.signOutState === 'in-progress' ? 'on shift'
                                    : s.signOutState === 'open' ? 'no sign-out'
                                    : s.shiftDiff == null ? '—'
                                    : s.shiftDiff > 0 ? `+${s.shiftDiff.toFixed(2)}h` : `${s.shiftDiff.toFixed(2)}h`}
                                </td>
                              )}
                              {hasRadius && (
                                <td className="px-5 py-2.5 text-right font-semibold">
                                  {isNoShow ? (
                                    // No-show pays 0 and isn't editable — undo
                                    // the No Show tag first if that's wrong.
                                    <span
                                      title="No show — not paid. Click the No Show button to undo."
                                      className="inline-flex items-center justify-end w-20 rounded-md border border-dashed border-gray-300 bg-gray-50 px-2 py-1 text-right text-gray-400">
                                      0.00h
                                    </span>
                                  ) : payEditing.shiftId === s.shiftId ? (
                                    <input
                                      autoFocus
                                      type="number" step="0.25" min="0"
                                      value={payEditing.draft}
                                      onChange={e => setPayEditing(p => ({ ...p, draft: e.target.value }))}
                                      onBlur={commitPayEdit}
                                      onKeyDown={e => {
                                        if (e.key === 'Enter') commitPayEdit();
                                        if (e.key === 'Escape') cancelPayEdit();
                                      }}
                                      className="w-20 rounded-md border border-purple-500 bg-white px-2 py-1 text-right text-sm text-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-300"
                                    />
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => beginPayEdit(s)}
                                      title={s.payHoursOverride != null
                                        ? `Overridden — click to edit (scheduled: ${s.hours.toFixed(2)}h)`
                                        : 'Click to override payroll hours'}
                                      className={`group inline-flex items-center justify-end gap-1 w-20 rounded-md border bg-white px-2 py-1 text-right transition-colors cursor-pointer hover:border-purple-400 hover:bg-purple-50 focus:outline-none focus:ring-2 focus:ring-purple-300 ${
                                        s.payHoursOverride != null
                                          ? 'border-purple-400 text-purple-700 ring-1 ring-purple-200'
                                          : 'border-gray-300 text-gray-700'
                                      }`}
                                    >
                                      <Edit3
                                        size={10}
                                        className={`shrink-0 transition-opacity ${
                                          s.payHoursOverride != null
                                            ? 'opacity-70 text-purple-500'
                                            : 'opacity-30 text-gray-400 group-hover:opacity-80 group-hover:text-purple-500'
                                        }`}
                                      />
                                      <span>{s.payHours.toFixed(2)}h</span>
                                    </button>
                                  )}
                                </td>
                              )}
                              {/* Resolve column — only meaningful on red
                                  rows. Unflagged rows render an empty cell
                                  so the table grid stays aligned. */}
                              {hasRadius && (
                                <td className="px-5 py-2.5">
                                  <div className="flex items-center justify-end gap-1.5">
                                    {isNoShow ? (
                                      <button
                                        onClick={() => handleToggleNoShow(s.shiftId, false)}
                                        title="Undo — restores scheduled pay for this shift and re-flags it for review."
                                        className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-gray-200 px-2 py-0.5 text-xs font-semibold text-gray-600 hover:bg-gray-300">
                                        <UserX size={11} /> No Show
                                      </button>
                                    ) : (
                                      <>
                                        {/* Mark no-show — offered on any unpaid-looking
                                            row (nothing in Radius) and, more quietly, on
                                            every other row via hover. */}
                                        <button
                                          onClick={() => handleToggleNoShow(s.shiftId, true)}
                                          title="They were scheduled but didn't come in. Pays 0 and drops out of the period total."
                                          className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors ${
                                            s.missingFromRadius
                                              ? 'border-gray-300 bg-white text-gray-600 hover:bg-gray-100'
                                              : 'border-transparent text-transparent hover:border-gray-300 hover:bg-gray-100 hover:text-gray-600'
                                          }`}>
                                          <UserX size={11} /> No show
                                        </button>
                                        {rowFlag && !rowResolved && (
                                          <button
                                            onClick={() => handleResolveWithNote(s, fmtT)}
                                            title="Mark this discrepancy as reviewed. Opens a note so the reason is on record. Pay h stays editable."
                                            className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-2 py-0.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50">
                                            ✓ Resolve
                                          </button>
                                        )}
                                        {/* Resolved is a STATUS, not a button.
                                            It used to sit in the same slot as
                                            the Resolve button and looked
                                            identical, so people clicked it and
                                            accidentally un-resolved rows.
                                            Un-resolving now needs a deliberate
                                            click on the small ✕. */}
                                        {rowResolved && (
                                          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                            ✓ Resolved
                                            <button
                                              onClick={() => handleResolveShift(s.shiftId, false)}
                                              title="Un-resolve — re-flags this row as needing review."
                                              className="ml-0.5 text-emerald-400 hover:text-emerald-800 transition-colors"
                                              aria-label="Un-resolve this shift">
                                              <X size={11} />
                                            </button>
                                          </span>
                                        )}
                                      </>
                                    )}
                                    {/* Note toggle — outlined when empty, filled
                                        and accented when a note exists. */}
                                    <button
                                      onClick={() => isEditingNote ? cancelNoteEdit() : beginNoteEdit(s, buildNoteTemplate(s, fmtT))}
                                      title={hasNote ? s.payrollNote : 'Add a note explaining this shift'}
                                      aria-label={hasNote ? 'Edit shift note' : 'Add shift note'}
                                      className={`shrink-0 rounded p-1 transition-colors ${
                                        hasNote
                                          ? 'text-blue-600 hover:bg-blue-50'
                                          : 'text-gray-300 hover:bg-gray-100 hover:text-gray-600'
                                      }`}>
                                      <StickyNote size={13} />
                                    </button>
                                  </div>
                                </td>
                              )}
                            </tr>
                            {/* Note row — renders directly beneath the shift it
                                belongs to, spanning the full table width. Only
                                present when there's something to show, so
                                clean rows keep their original height. */}
                            {hasRadius && (hasNote || isEditingNote) && (
                              <tr className={
                                isNoShow ? 'bg-gray-100'
                                : showRedFlag ? 'bg-red-50'
                                : rowResolved ? 'bg-emerald-50/70'
                                : s.sick ? 'bg-amber-50/60'
                                : 'bg-white'
                              }>
                                <td colSpan={6} className="px-5 pb-2.5 pt-0">
                                  {isEditingNote ? (
                                    <div className="flex items-start gap-2">
                                      <textarea
                                        autoFocus
                                        rows={2}
                                        value={noteEditing.draft}
                                        placeholder="Why does this shift look the way it does?"
                                        onChange={e => setNoteEditing(p => ({ ...p, draft: e.target.value }))}
                                        onKeyDown={e => {
                                          // Enter saves, Shift+Enter for a second line.
                                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitNoteEdit(); }
                                          if (e.key === 'Escape') cancelNoteEdit();
                                        }}
                                        className="flex-1 rounded-md border border-blue-300 bg-white px-2 py-1.5 text-xs text-gray-800 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                                      />
                                      <div className="flex flex-col gap-1">
                                        <button onClick={commitNoteEdit}
                                          className="rounded-md border border-blue-300 bg-white px-2 py-0.5 text-xs font-semibold text-blue-700 hover:bg-blue-50">
                                          Save
                                        </button>
                                        {/* Skippable — Resolve has already been
                                            applied by this point, so backing out
                                            here just leaves the row unexplained. */}
                                        <button onClick={cancelNoteEdit}
                                          className="rounded-md border border-gray-200 bg-white px-2 py-0.5 text-xs font-medium text-gray-500 hover:bg-gray-50">
                                          Skip
                                        </button>
                                      </div>
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => beginNoteEdit(s)}
                                      title="Click to edit this note"
                                      className="block w-full border-l-2 border-blue-300 pl-2.5 text-left text-xs text-gray-600 hover:text-gray-900">
                                      {s.payrollNote}
                                      {(s.payrollNoteBy || s.payrollNoteAt) && (
                                        <span className="ml-1.5 text-[11px] text-gray-400">
                                          · {s.payrollNoteBy || 'Admin'}
                                          {s.payrollNoteAt && `, ${new Date(s.payrollNoteAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
                                        </span>
                                      )}
                                    </button>
                                  )}
                                </td>
                              </tr>
                            )}
                            </Fragment>
                          );
                        })}
                        {hasRadius && person.unmatchedRadius?.map((r, i) => (
                          <tr key={`ur-${i}`} className="bg-amber-50 hover:bg-amber-100 transition-colors">
                            <td className="px-5 py-2.5">
                              <input type="date" value={r.date}
                                onChange={e => updateRadiusEntry(r._idx, 'date', e.target.value)}
                                className="rounded border border-amber-200 px-1.5 py-0.5 text-xs text-gray-800 font-medium focus:border-amber-500 focus:outline-none" />
                            </td>
                            <td className="px-4 py-2.5 text-xs text-amber-600 font-medium">Not scheduled</td>
                            <td className="px-4 py-2.5 text-xs">
                              <div className="flex items-center gap-1">
                                <input type="time" value={normalizeTimeToHHMM(r.timeIn)}
                                  onChange={e => updateRadiusEntry(r._idx, 'timeIn', e.target.value)}
                                  className="rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-700 w-[86px] focus:border-blue-500 focus:outline-none" />
                                <span className="text-gray-400">–</span>
                                <input type="time" value={normalizeTimeToHHMM(r.timeOut)}
                                  onChange={e => updateRadiusEntry(r._idx, 'timeOut', e.target.value)}
                                  className="rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-700 w-[86px] focus:border-blue-500 focus:outline-none" />
                                <button onClick={() => deleteRadiusEntry(r._idx)}
                                  className="ml-1 text-gray-300 hover:text-red-500 transition-colors" title="Remove entry">
                                  <Trash2 size={12} />
                                </button>
                              </div>
                              {/* Actual hours fold under the times, matching the
                                  consolidated Clocked in/out column above. */}
                              <div className="mt-0.5 text-[11px] text-gray-400">{r.actualHours.toFixed(2)}h</div>
                            </td>
                            <td className="px-5 py-2.5 text-right">
                              {/* "Schedule shift" button removed per owner
                                  request — payroll is not the right surface
                                  to be creating shifts. Owner will fix
                                  scheduling gaps from Manage Schedule
                                  before running payroll. */}
                              <span className="text-xs font-semibold text-amber-600 whitespace-nowrap">unscheduled</span>
                            </td>
                            {/* Payroll h placeholder — unscheduled rows aren't
                                payable (no scheduled basis), so we render a
                                dash to keep the grid aligned. */}
                            <td className="px-5 py-2.5 text-right text-gray-300">–</td>
                            {/* Actions placeholder — keeps the 6-column grid aligned. */}
                            <td className="px-5 py-2.5"></td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        {/* Totals sit under the columns they total: scheduled
                            hours under Scheduled, actual under Clocked in/out.
                            Previously they lived in standalone hour columns
                            that no longer exist. */}
                        <tr className="border-t bg-gray-50">
                          {/* Without Radius the table is only 3 columns wide,
                              so Total spans Date+Scheduled and the hours sit
                              right-aligned under the Hours column. */}
                          <td colSpan={hasRadius ? 1 : 2} className="px-5 py-2 text-sm font-semibold text-gray-700">Total</td>
                          {/* Sched total nets off no-show hours in the Radius
                              view so Diff (= Actual − Sched) reconciles against
                              the struck-through rows above. */}
                          <td className={`py-2 text-sm font-semibold text-gray-700 ${hasRadius ? 'px-4' : 'px-5 text-right'}`}
                            title={hasRadius && (person.noShowHours || 0) > 0
                              ? `Scheduled ${person.totalHours.toFixed(2)}h less ${person.noShowHours.toFixed(2)}h no-show`
                              : undefined}>
                            {(hasRadius ? person.scheduledHours : person.totalHours).toFixed(2)}h
                          </td>
                          {hasRadius && <td className="px-4 py-2 text-sm font-semibold text-gray-700">{person.actualHours.toFixed(2)}h</td>}
                          {hasRadius && (
                            <td className="px-5 py-2 text-right text-xs font-semibold text-gray-400">
                              {person.diff > 0 ? '+' : ''}{person.diff.toFixed(2)}h
                            </td>
                          )}
                          {hasRadius && (
                            <td className="px-5 py-2 text-right text-sm font-bold text-purple-700"
                              title="Sum of Payroll h — what we actually pay this person.">
                              {(person.payHours ?? person.totalHours).toFixed(2)}h
                            </td>
                          )}
                          {hasRadius && <td />}
                        </tr>
                      </tfoot>
                    </table>
                    {hasRadius && (
                      <div className="px-5 py-2.5 border-t bg-gray-50/50">
                        <button onClick={() => addRadiusEntry(person.name)}
                          className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors">
                          <Plus size={14} /> Add Radius Entry
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── ORPHAN RADIUS ROWS ─────────────────────────────────────────
              Radius entries whose name didn't match ANY user (e.g. "Jieun
              Lee" in Radius vs "Joanne Lee" in Ratio). Owner picks the
              real staff person from a dropdown; we save the Radius name
              as that user's `radiusName` alias, so this row — AND every
              future row with that name — auto-attribute correctly. */}
          {comparisonSummary?.orphans?.length > 0 && (
            <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
              <div className="mb-2 flex items-center gap-2">
                <AlertTriangle size={16} className="text-amber-700" />
                <h3 className="font-bold text-amber-900">
                  Unmatched Radius entries
                  <span className="ml-2 text-xs font-normal text-amber-700">
                    ({comparisonSummary.orphans.length} {comparisonSummary.orphans.length === 1 ? 'entry' : 'entries'} couldn't be linked to a staff member)
                  </span>
                </h3>
              </div>
              <p className="text-xs text-amber-800 mb-3">
                Pick the right staff person and we'll remember the Radius name on their profile permanently.
                Used when Radius shows a legal name like "Jieun Lee" but Ratio has "Joanne Lee".
              </p>
              <div className="space-y-2">
                {comparisonSummary.orphans.map(r => (
                  <div key={r._idx} className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-white px-3 py-2">
                    <span className="font-semibold text-gray-900">{r.name}</span>
                    <span className="text-xs text-gray-500">{r.date} · {normalizeTimeToHHMM(r.timeIn)}–{normalizeTimeToHHMM(r.timeOut)} ({r.actualHours.toFixed(2)}h)</span>
                    <span className="ml-auto inline-flex items-center gap-2">
                      <span className="text-xs text-gray-600">This is →</span>
                      <select
                        defaultValue=""
                        onChange={(e) => {
                          const uid = e.target.value;
                          if (!uid) return;
                          setUserRadiusName(uid, r.name);
                          e.target.value = '';
                        }}
                        className="rounded border border-amber-300 bg-white px-2 py-1 text-xs">
                        <option value="">Pick staff…</option>
                        {approvedUsers.map(u => (
                          <option key={u.uid} value={u.uid}>{u.displayName}</option>
                        ))}
                      </select>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          </>)}{/* ─── end of "This Period" sub-tab ─── */}
        </div>
      )}

      {/* ── INSTRUCTOR REQUESTS ────────────────────────────────────────── */}
      {tab === 'requests' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-gray-900">Instructor Requests</h3>
              <p className="text-sm text-gray-500">Time off requests from your team</p>
            </div>
            <div className="flex gap-2 text-xs">
              <span className="rounded-full bg-yellow-100 px-2.5 py-1 font-medium text-yellow-700">
                {timeOffRequests.filter(r => r.status === 'pending').length} pending
              </span>
              <span className="rounded-full bg-teal-100 px-2.5 py-1 font-medium text-teal-700">
                {timeOffRequests.filter(r => r.status === 'approved').length} approved
              </span>
            </div>
          </div>

          {timeOffRequests.length === 0 ? (
            <div className="rounded-xl border bg-white p-10 text-center shadow-sm">
              <CalendarRange size={36} className="mx-auto mb-3 text-gray-300" />
              <p className="text-gray-500 font-medium">No requests yet.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {timeOffRequests.map(req => {
                if (!req.startDate || !req.endDate) return null;
                const startLabel = new Date(req.startDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                const endLabel   = new Date(req.endDate   + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                const sameDay    = req.startDate === req.endDate;
                const statusColors = {
                  pending:  'bg-yellow-100 text-yellow-700',
                  approved: 'bg-teal-100 text-teal-700',
                  denied:   'bg-red-100 text-red-600',
                };
                return (
                  <div key={req.id} className={`rounded-xl border bg-white p-5 shadow-sm ${req.status === 'pending' ? 'border-yellow-200' : ''}`}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <div className="w-7 h-7 rounded-full bg-red-600 flex items-center justify-center text-xs font-bold text-white">
                            {req.userName?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2)}
                          </div>
                          <span className="font-semibold text-gray-900">{req.userName}</span>
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusColors[req.status] || statusColors.pending}`}>
                            {req.status?.charAt(0).toUpperCase() + req.status?.slice(1)}
                          </span>
                          {req.edited && (
                            <span
                              className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700"
                              title="The instructor edited this request after submitting it"
                            >
                              Edited
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 text-sm text-gray-600 mb-2">
                          <CalendarRange size={14} className="text-gray-400" />
                          <span className="font-medium">{sameDay ? startLabel : `${startLabel} – ${endLabel}`}</span>
                        </div>
                        <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
                          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Reason: </span>
                          {req.reason}
                        </div>
                        {req.createdAt?.seconds && (
                          <p className="mt-2 text-xs text-gray-400">
                            Submitted {new Date(req.createdAt.seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </p>
                        )}
                        {req.edited && req.editedAt?.seconds && (
                          <p className="text-xs text-amber-600 font-medium">
                            Edited by instructor {new Date(req.editedAt.seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </p>
                        )}
                      </div>

                      {req.status === 'pending' && (
                        <div className="flex flex-col gap-2 shrink-0">
                          <button
                            onClick={() => handleApproveTimeOff(req)}
                            className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-sm font-semibold text-white hover:bg-green-700 transition-colors">
                            <Check size={14} /> Approve
                          </button>
                          <button
                            onClick={async () => {
                              await updateDoc(doc(db, 'timeOffRequests', req.id), { status: 'denied' });
                              const recipient = approvedUsers.find(u => u.id === req.userId);
                              if (recipient?.email) {
                                notifyTimeOffDecision(req, recipient, 'denied');
                              }
                            }}
                            className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 transition-colors">
                            <X size={14} /> Deny
                          </button>
                        </div>
                      )}

                      {req.status !== 'pending' && (
                        <button
                          onClick={async () => {
                            const ok = await confirmDialog({
                              title: 'Delete this time-off request?',
                              confirmText: 'Delete',
                              danger: true,
                            });
                            if (ok) await deleteDoc(doc(db, 'timeOffRequests', req.id));
                          }}
                          className="text-gray-300 hover:text-red-400 transition-colors shrink-0">
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── HOLIDAYS ───────────────────────────────────────────────────────── */}
      {tab === 'holidays' && (
        <HolidaysEditor
          activeCenterId={activeCenterId}
          centerConfig={centerConfig}
          activeCenterName={centerConfig?.name || activeCenterId}
        />
      )}

      {/* Analytics + Center Settings are standalone pages now —
          /center-analytics and /center-settings respectively. */}

      {/* ── MODALS ──────────────────────────────────────────────────────────── */}
      {addStaffOpen && (
        <AddStaffModal
          onClose={() => setAddStaffOpen(false)}
          onSubmit={handleCreateStaff}
        />
      )}

      {editStaffUser && (
        <EditStaffModal
          user={usersForCentre.find(u => u.uid === editStaffUser.uid) || editStaffUser}
          onClose={() => setEditStaffUser(null)}
          onUpdateField={handleUpdateUserField}
          onTerminate={(target) => { setTerminateUser(target); setEditStaffUser(null); }}
          onSendReset={handleSendStaffReset}
        />
      )}

      {terminateUser && (
        <TerminateStaffModal
          user={terminateUser}
          onClose={() => setTerminateUser(null)}
          onDone={() => setTerminateUser(null)}
        />
      )}

      {availabilityModalUser && (
        <UserAvailabilityModal
          user={availabilityModalUser}
          weekDays={weekDays}
          availability={availability}
          shifts={shifts}
          timeOffIndex={timeOffIndex}
          onClose={() => setAvailabilityModalUser(null)}
        />
      )}

      {addShiftModal && (
        <AddShiftModal
          date={addShiftModal.date}
          user={addShiftModal.user}
          users={approvedUsers}
          availability={availability}
          timeOffIndex={timeOffIndex}
          centerConfig={centerConfig}
          onClose={() => setAddShiftModal(null)}
          onSave={handleAddShift}
        />
      )}

      {editShiftModal && (
        <EditShiftModal
          shift={editShiftModal}
          onClose={() => setEditShiftModal(null)}
          onSave={handleSaveEditShift}
          onDelete={handleDeleteEditShift}
          onPublish={async () => {
            await handlePublishSingleShift(editShiftModal);
            setEditShiftModal(null);
          }}
        />
      )}

      {addOpenShiftModal && (
        <AddOpenShiftModal
          date={addOpenShiftModal.date}
          centerConfig={centerConfig}
          onClose={() => setAddOpenShiftModal(null)}
          onSave={handleAddOpenShift}
        />
      )}

      {/* Print CSS — Export Schedule button calls window.print(). We hide
          everything that ISN'T the spreadsheet print zone (sidebar, top
          nav, publish bar, modals, the tab strip itself) and let the
          grid take the whole page. The owner picks "Save as PDF" in
          the destination dropdown to get a screenshot-style export. */}
      <style>{`
        @media print {
          @page { size: landscape; margin: 0.3in; }
          html, body { background: white !important; }
          /* Hide chrome that's not the schedule zone. */
          aside, header, nav,
          [data-tab-strip],
          .print\\:hidden { display: none !important; }
          /* Reset scroll containers so the grid prints in full. */
          .schedule-print-zone .overflow-auto,
          .schedule-print-zone [class*="max-h-"] {
            max-height: none !important;
            overflow: visible !important;
          }
          /* When printing, only the schedule zone matters — collapse the
             parent flex/grid layouts so nothing else takes space. */
          body * { visibility: hidden !important; }
          .schedule-print-zone, .schedule-print-zone * { visibility: visible !important; }
          .schedule-print-zone {
            position: absolute !important;
            left: 0; top: 0; right: 0;
            width: 100% !important;
          }
          /* Compact grid typography for print. */
          .schedule-print-zone table { font-size: 9px !important; line-height: 1.15 !important; }
          .schedule-print-zone th, .schedule-print-zone td { padding: 2px 3px !important; }
          /* Hide interactive bits the printout doesn't need. */
          .schedule-print-zone button,
          .schedule-print-zone input { display: none !important; }
        }
      `}</style>
    </div>
  );
}

// ─── Per-Day Staffing Matrix ────────────────────────────────────────────
// Operating days + per-day Min/Max for in-centre and online staff. Empty
// cells inherit from schedConfig.minPerDay/maxPerDay. Toggling a day
// closed writes operatingDays back to centerConfig (centre-wide
// persistent), while the staffing numbers live on schedConfig (per-run).
// Owners can edit either without touching the other.
const MATRIX_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function PerDayStaffingMatrix({ activeCenterId, centerConfig, schedConfig, setSchedConfig, rangeDates, onDemandLoaded }) {
  const operatingDays = useMemo(() => {
    return Array.isArray(centerConfig?.operatingDays) && centerConfig.operatingDays.length > 0
      ? centerConfig.operatingDays
      : MATRIX_DAYS;
  }, [centerConfig?.operatingDays]);
  const [savingDays, setSavingDays] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loadingBookings, setLoadingBookings] = useState(false);
  // Result of the last "Staff from bookings" run, so the owner can audit the
  // numbers instead of trusting a headcount that appeared from nowhere.
  const [bookingPreview, setBookingPreview] = useState(null);

  // ─── Saved staffing shapes ────────────────────────────────────────────
  // A template is this whole panel's settings under a name. Applying one
  // only seeds the form — the owner still reviews and hits Generate, so a
  // template can never quietly publish shifts on its own.
  const { profile } = useAuth();
  const [templates, setTemplates] = useState([]);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [namingTemplate, setNamingTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  useEffect(
    () => subscribeTemplates(activeCenterId, setTemplates, () => setTemplates([])),
    [activeCenterId],
  );

  const handleSaveTemplate = async () => {
    if (!templateName.trim()) return;
    setSavingTemplate(true);
    try {
      await saveTemplate(activeCenterId, templateName, schedConfig, {
        uid: profile?.uid, displayName: profile?.displayName,
      });
      toast.success(`Saved “${templateName.trim()}”.`);
      setTemplateName('');
      setNamingTemplate(false);
    } catch (err) {
      toast.error(err?.message || 'Could not save the template.');
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleApplyTemplate = (tpl) => {
    if (!tpl) return;
    setSchedConfig(c => applyTemplateConfig(c, tpl));
    toast.success(`Loaded “${tpl.name}”. Review the numbers, then Generate.`);
  };

  const handleDeleteTemplate = async (tpl) => {
    const ok = await confirmDialog({
      title: `Delete “${tpl.name}”?`,
      message: 'The saved staffing shape is removed. Schedules you already generated from it are unaffected.',
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteTemplate(activeCenterId, tpl.id);
      toast.success('Template deleted.');
    } catch (err) {
      toast.error(err?.message || 'Could not delete the template.');
    }
  };

  const perDay = schedConfig.perDay || {};

  // Load recommended min/max per weekday from saved demand snapshots.
  // Uses the last ~8 weeks of Supply & Demand data — averaged per
  // weekday, converted into instructors needed at the target ratio.
  const loadFromHistory = async () => {
    if (!activeCenterId) return;
    setLoadingHistory(true);
    try {
      const [{ computeTypicalDemand, recommendedStaffFromTypical }] = await Promise.all([
        import('../lib/demand-snapshots'),
      ]);
      const typical = await computeTypicalDemand(activeCenterId);
      // Merge suggestions into perDay for every weekday that has data.
      let touched = 0;
      setSchedConfig(c => {
        const nextPerDay = { ...(c.perDay || {}) };
        for (const day of MATRIX_DAYS) {
          const t = typical[day];
          if (!t) continue;
          const r = recommendedStaffFromTypical(t);
          if (r.recommendedMin === 0 && r.recommendedMax === 0) continue;
          nextPerDay[day] = {
            ...(nextPerDay[day] || {}),
            min: r.recommendedMin,
            max: r.recommendedMax,
          };
          touched++;
        }
        return { ...c, perDay: nextPerDay };
      });
      if (touched === 0) toast.error('No saved demand history yet — open Supply & Demand and save a few days first.');
      else toast.success(`Loaded staffing from ${touched} weekday${touched === 1 ? '' : 's'} of history`);
    } catch (err) {
      console.error('[loadFromHistory] failed:', err);
      toast.error('Could not load history');
    } finally {
      setLoadingHistory(false);
    }
  };

  // Size each DATE in the picked range from the bookings actually on the
  // calendar for that date.
  //
  // This is the difference between "Thursdays need 8" and "this Thursday has
  // 21 students booked, staff 7." `loadFromHistory` above averages saved
  // snapshots by weekday, which can't tell two Thursdays apart and needs
  // someone to have saved snapshots first. This reads Acuity directly.
  //
  // Writes schedConfig.perDate, which generateSchedule prefers over the
  // weekday rules below. Deliberately NOT part of a saved template — a
  // template is a reusable staffing shape, and demand for a specific date
  // is the opposite of reusable.
  const staffFromBookings = async () => {
    if (!activeCenterId) return;
    if (!rangeDates?.start || !rangeDates?.end) {
      toast.error('Pick a date range first.');
      return;
    }
    setLoadingBookings(true);
    try {
      const [{ buildPerDateStaffing, explainStaffing }, { DEFAULT_TARGET_RATIO }] = await Promise.all([
        import('../lib/demand-staffing'),
        import('../lib/subRoles'),
      ]);

      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Not signed in.');

      const res = await fetch(
        `/api/scheduler/appointments?centerId=${encodeURIComponent(activeCenterId)}` +
        `&start=${rangeDates.start}&end=${rangeDates.end}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || 'Could not read bookings.');
      if (payload?.warning) toast.error(payload.warning);

      // Two ratios: what the centre aims for, and the worst it will accept.
      // 1:3.5 is the aim; 1:4 is the floor, because you can't staff half a
      // person and rounding up every time would overstaff the quiet days.
      const targetRatio = Number(schedConfig.demandRatio) > 0
        ? Number(schedConfig.demandRatio)
        : DEFAULT_TARGET_RATIO;
      const acceptableRatio = Number(schedConfig.demandRatioMax) > 0
        ? Number(schedConfig.demandRatioMax)
        : 4;

      const { perDate, details: rawDetails, warnings } = buildPerDateStaffing(payload.days || [], {
        targetRatio,
        acceptableRatio,
        minShiftHours: 2,
        cushion: Number.isFinite(schedConfig.demandCushion) ? schedConfig.demandCushion : 1,
      });

      // Stamp the reasoning onto each date here, where the module is in scope,
      // so the panel can show it on hover without re-importing at render time.
      const details = rawDetails.map(d => ({
        ...d,
        explain: explainStaffing(d, targetRatio, acceptableRatio),
      }));

      const staffedDates = Object.keys(perDate);
      if (staffedDates.length === 0) {
        toast.error('No bookings found in that range — nothing to size the days from.');
        setBookingPreview({ details, warnings, targetRatio, acceptableRatio, range: rangeDates });
        return;
      }

      setSchedConfig(c => ({
        ...c,
        perDate,
        // Stamped so the panel can warn when these numbers describe a
        // different range than the one now picked, or have gone stale.
        perDateMeta: {
          builtFor: { start: rangeDates.start, end: rangeDates.end },
          builtAt: new Date().toISOString(),
          targetRatio,
          acceptableRatio,
        },
      }));
      setBookingPreview({ details, warnings, targetRatio, acceptableRatio, range: rangeDates });

      // Hand the per-date curves up so the generator can stagger shifts around
      // the rush instead of putting everyone on the full instructional window.
      onDemandLoaded?.(Object.fromEntries(
        details
          .filter(d => d.hasBookings)
          .map(d => [d.date, {
            slotKeys: d.slots.map(s => s.slot),
            required: d.slots.map(s => s.required),
            peakStudents: d.peakStudents,
          }])
      ));

      toast.success(
        `Sized ${staffedDates.length} day${staffedDates.length === 1 ? '' : 's'} from real bookings — aiming 1:${targetRatio}, floor 1:${acceptableRatio}.`
      );
    } catch (err) {
      console.error('[staffFromBookings] failed:', err);
      toast.error(err?.message || 'Could not size days from bookings.');
    } finally {
      setLoadingBookings(false);
    }
  };

  const clearBookingStaffing = () => {
    setSchedConfig(c => {
      const next = { ...c };
      delete next.perDate;
      delete next.perDateMeta;
      return next;
    });
    setBookingPreview(null);
    onDemandLoaded?.(null);
    toast.success('Cleared booking-derived staffing. Weekday rules apply again.');
  };

  // Toggle a weekday open/closed in centerConfig.operatingDays.
  // Persists immediately — there's no separate Save button — because
  // it's a small list and instant feedback is more useful than batching.
  const toggleOperating = async (day) => {
    if (!activeCenterId) return;
    const next = operatingDays.includes(day)
      ? operatingDays.filter(d => d !== day)
      : [...operatingDays, day];
    // Preserve canonical order so the array doesn't shuffle every save.
    const ordered = MATRIX_DAYS.filter(d => next.includes(d));
    try {
      setSavingDays(true);
      await setDoc(
        doc(db, 'centers', activeCenterId, 'config', 'main'),
        { operatingDays: ordered, updatedAt: serverTimestamp() },
        { merge: true },
      );
    } catch (err) {
      console.error('Failed to save operatingDays:', err);
      toast.error('Could not save operating days');
    } finally {
      setSavingDays(false);
    }
  };

  const setCell = (day, field, raw) => {
    setSchedConfig(c => {
      const cur = { ...(c.perDay || {}) };
      const dayRow = { ...(cur[day] || {}) };
      // Empty string means "fall back to default" — store as undefined so
      // the scheduler reads it as "not set" rather than as 0.
      if (raw === '' || raw == null) {
        delete dayRow[field];
      } else {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) dayRow[field] = n;
      }
      if (Object.keys(dayRow).length === 0) delete cur[day];
      else cur[day] = dayRow;
      return { ...c, perDay: cur };
    });
  };

  return (
    <div className="mb-5 rounded-xl border border-purple-200 bg-purple-50/30 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-purple-200 bg-white/60 flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h4 className="text-sm font-bold text-purple-900">Per-day operating + staffing rules</h4>
          <p className="text-xs text-purple-700/80">
            Blank cells use the defaults above. Uncheck a day to mark the centre closed.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {savingDays && <span className="text-xs text-purple-600 italic">Saving…</span>}
          {/* Saved shapes. The picker seeds the form only — nothing is
              published until the owner reviews and hits Generate. */}
          {templates.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const tpl = templates.find(t => t.id === e.target.value);
                handleApplyTemplate(tpl);
                e.target.value = '';
              }}
              title="Load a saved staffing shape into the form below"
              className="rounded-md border border-purple-300 bg-white px-2 py-1 text-xs font-semibold text-purple-700 max-w-[190px]"
            >
              <option value="">Load saved shape…</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name} · {describeTemplate(t)}</option>
              ))}
            </select>
          )}
          <button
            onClick={staffFromBookings}
            disabled={loadingBookings || !rangeDates}
            title={rangeDates
              ? `Size each date from the students actually booked in Acuity for ${rangeDates.start} → ${rangeDates.end}`
              : 'Pick a date range first'}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-400 bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {loadingBookings ? '…' : '◎'} Staff from bookings
          </button>
          <button
            onClick={loadFromHistory}
            disabled={loadingHistory}
            title="Fill Centre Min/Max from the average demand of your saved Supply & Demand snapshots"
            className="inline-flex items-center gap-1 rounded-md border border-purple-300 bg-white px-2.5 py-1 text-xs font-semibold text-purple-700 hover:bg-purple-50 disabled:opacity-50"
          >
            {loadingHistory ? '…' : '⟲'} Load from history
          </button>
          <button
            onClick={() => setNamingTemplate(v => !v)}
            title="Save the current staffing shape so you can reuse it next term"
            className="inline-flex items-center gap-1 rounded-md border border-purple-300 bg-white px-2.5 py-1 text-xs font-semibold text-purple-700 hover:bg-purple-50"
          >
            ☆ Save shape
          </button>
        </div>
      </div>

      {namingTemplate && (
        <div className="px-4 py-2.5 border-b border-purple-200 bg-white/70 flex items-center gap-2 flex-wrap">
          <input
            autoFocus
            value={templateName}
            onChange={e => setTemplateName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleSaveTemplate();
              if (e.key === 'Escape') { setNamingTemplate(false); setTemplateName(''); }
            }}
            placeholder="Name it — “Term time”, “Summer camp”…"
            className="flex-1 min-w-[180px] rounded-md border border-purple-300 px-2 py-1 text-xs focus:border-purple-500 focus:outline-none"
          />
          <button
            onClick={handleSaveTemplate}
            disabled={savingTemplate || !templateName.trim()}
            className="rounded-md bg-purple-600 px-3 py-1 text-xs font-semibold text-white hover:bg-purple-700 disabled:opacity-40"
          >
            {savingTemplate ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={() => { setNamingTemplate(false); setTemplateName(''); }}
            className="rounded-md border border-gray-300 bg-white px-3 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <span className="w-full text-[10px] text-purple-700/70 italic">
            Saves the staffing shape — the min/max numbers and per-day rules on this panel. Not the people: the auto-scheduler fills it from whoever&rsquo;s actually available that month.
          </span>
        </div>
      )}

      {/* Booking-derived staffing. Shown whenever perDate rules are active so
          the owner can audit where each day's headcount came from, and can
          see immediately if those numbers describe a different date range
          than the one now picked. */}
      {schedConfig.perDateMeta && (() => {
        const meta = schedConfig.perDateMeta;
        const dates = Object.keys(schedConfig.perDate || {}).sort();
        const rangeMatches =
          rangeDates &&
          meta.builtFor?.start === rangeDates.start &&
          meta.builtFor?.end === rangeDates.end;
        const ageHours = (Date.now() - new Date(meta.builtAt).getTime()) / 36e5;
        const stale = ageHours > 12;
        const ok = rangeMatches && !stale;

        const staffed = (bookingPreview?.details || []).filter(d => d.hasBookings);
        const empty   = (bookingPreview?.details || []).filter(d => !d.hasBookings);

        // Roll the per-date "N students couldn't be categorized" lines into one
        // sentence. Twenty near-identical warnings is not twenty pieces of
        // information, and it buries the days that genuinely need attention.
        const uncategorized = staffed.filter(d => d.unknownStudents > 0);
        const uncategorizedTotal = uncategorized.reduce((a, d) => a + d.unknownStudents, 0);

        const dow = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
        const dayNum = (d) => new Date(d + 'T12:00:00').getDate();

        return (
          <div className={`border-b ${ok ? 'border-emerald-200 bg-emerald-50/60' : 'border-amber-300 bg-amber-50'}`}>
            <div className="px-4 py-2.5">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className={`text-xs font-bold ${ok ? 'text-emerald-900' : 'text-amber-900'}`}>
                    {dates.length} day{dates.length === 1 ? '' : 's'} sized from real bookings
                    {' '}— aiming 1:{meta.targetRatio}, floor 1:{meta.acceptableRatio ?? 4}
                  </p>
                  <p className={`text-[11px] ${ok ? 'text-emerald-800/80' : 'text-amber-800'}`}>
                    {!rangeMatches
                      ? `Built for ${meta.builtFor?.start} → ${meta.builtFor?.end}, but a different range is picked now. Re-run “Staff from bookings”.`
                      : stale
                        ? `Built ${Math.round(ageHours)} hours ago — bookings may have moved since. Re-run to refresh.`
                        : `${meta.builtFor?.start} → ${meta.builtFor?.end}. These beat the weekday rules below.`}
                  </p>
                </div>
                <button
                  onClick={clearBookingStaffing}
                  className="shrink-0 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-50"
                >
                  Clear
                </button>
              </div>

              <label className="mt-2 flex items-start gap-2 text-[11px] text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={schedConfig.shapeShiftsToDemand !== false}
                  onChange={e => setSchedConfig(c => ({ ...c, shapeShiftsToDemand: e.target.checked }))}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-semibold">Stagger shifts around the rush.</span>{' '}
                  People come in for the busy stretch and leave when it clears, instead of
                  everyone working the full window. Nobody under 2 hours, nobody sent home
                  for a short dip, nobody already scheduled dropped.
                </span>
              </label>
            </div>

            {/* The answer, not the arithmetic: how many people each day wants.
                One compact chip per day beats a five-column table of
                intermediate ratio maths nobody reads. */}
            {staffed.length > 0 && (
              <div className="px-4 pb-2 flex flex-wrap gap-1">
                {staffed.map(d => (
                  <span
                    key={d.date}
                    title={`${d.date} — ${d.explain || ''}`}
                    className="inline-flex items-baseline gap-1 rounded-md border border-emerald-300/70 bg-white px-1.5 py-0.5 text-[11px] leading-none"
                  >
                    <span className="text-gray-400">{dow(d.date)}</span>
                    <span className="font-semibold text-gray-700">{dayNum(d.date)}</span>
                    <span className="text-gray-300">·</span>
                    <span className="font-bold text-emerald-800">{d.min}–{d.max}</span>
                    <span className="text-gray-400">staff</span>
                  </span>
                ))}
              </div>
            )}

            <div className="px-4 pb-2.5 space-y-1">
              {empty.length > 0 && (
                <p className="text-[10px] text-gray-500">
                  Closed or unbooked, left on the default rule:{' '}
                  {empty.map(d => `${dow(d.date)} ${dayNum(d.date)}`).join(', ')}
                </p>
              )}

              {uncategorizedTotal > 0 && (
                <p className="text-[10px] text-amber-800">
                  ⚠ {uncategorizedTotal} student{uncategorizedTotal === 1 ? '' : 's'} across{' '}
                  {uncategorized.length} day{uncategorized.length === 1 ? '' : 's'} couldn&rsquo;t be
                  categorised and were counted in demand. Fix them on the Student Scheduler so the
                  ratio is exact.
                </p>
              )}

              {staffed.length > 0 && (
                <details className="text-[10px]">
                  <summary className="cursor-pointer text-gray-500 hover:text-gray-700 select-none">
                    Show the numbers
                  </summary>
                  <div className="mt-1.5 overflow-x-auto">
                    <table className="text-[10px] border-collapse">
                      <thead>
                        <tr className="text-gray-500">
                          <th className="px-2 py-0.5 text-left font-semibold">Date</th>
                          <th className="px-2 py-0.5 text-right font-semibold">Busiest slot</th>
                          <th className="px-2 py-0.5 text-right font-semibold" title={`At the 1:${meta.acceptableRatio ?? 4} floor`}>Floor</th>
                          <th className="px-2 py-0.5 text-right font-semibold" title={`At the 1:${meta.targetRatio} aim`}>Aim</th>
                          <th className="px-2 py-0.5 text-right font-semibold">Staff</th>
                        </tr>
                      </thead>
                      <tbody>
                        {staffed.map(d => (
                          <tr key={d.date}>
                            <td className="px-2 py-0.5 whitespace-nowrap">
                              {d.date} <span className="text-gray-400">{dow(d.date)}</span>
                            </td>
                            <td className="px-2 py-0.5 text-right">{d.peakStudents} students</td>
                            <td className="px-2 py-0.5 text-right text-gray-500">{d.floorRequired}</td>
                            <td className="px-2 py-0.5 text-right text-gray-500">{d.peakRequired}</td>
                            <td className="px-2 py-0.5 text-right font-bold">{d.min}–{d.max}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}

              <p className={`text-[11px] font-semibold ${ok ? 'text-emerald-900' : 'text-amber-900'}`}>
                Next: hit Generate below — that picks who works each day and shows their shift times.
              </p>
            </div>
          </div>
        );
      })()}

      {templates.length > 0 && (
        <div className="px-4 py-2 border-b border-purple-200 bg-white/40 flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-purple-700/70 mr-1">Saved shapes</span>
          {templates.map(t => (
            <span key={t.id} className="inline-flex items-center gap-1 rounded-full border border-purple-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-purple-800">
              <button onClick={() => handleApplyTemplate(t)} title={`Load ${t.name}`} className="hover:underline">
                {t.name}
              </button>
              <button
                onClick={() => handleDeleteTemplate(t)}
                title={`Delete ${t.name}`}
                className="text-purple-400 hover:text-red-600"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-white/60 text-purple-900">
            <tr>
              <th className="text-left px-3 py-2 font-semibold">Day</th>
              <th className="text-center px-2 py-2 font-semibold">Open</th>
              <th className="text-center px-2 py-2 font-semibold" colSpan={2}>In-centre</th>
              <th className="text-center px-2 py-2 font-semibold" colSpan={2}>Online</th>
            </tr>
            <tr className="text-[10px] uppercase tracking-wide text-purple-700/70">
              <th></th>
              <th></th>
              <th className="text-center px-2 py-1 font-medium">Min</th>
              <th className="text-center px-2 py-1 font-medium">Max</th>
              <th className="text-center px-2 py-1 font-medium">Min</th>
              <th className="text-center px-2 py-1 font-medium">Max</th>
            </tr>
          </thead>
          <tbody>
            {MATRIX_DAYS.map(day => {
              const open = operatingDays.includes(day);
              const row = perDay[day] || {};
              return (
                <tr key={day} className={`border-t border-purple-100 ${open ? 'bg-white' : 'bg-gray-50 text-gray-400'}`}>
                  <td className="px-3 py-1.5 font-medium">{day}</td>
                  <td className="text-center px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={open}
                      onChange={() => toggleOperating(day)}
                      className="accent-purple-600 h-4 w-4 cursor-pointer"
                    />
                  </td>
                  {['min', 'max', 'onlineMin', 'onlineMax'].map(field => (
                    <td key={field} className="text-center px-1 py-1.5">
                      <input
                        type="number"
                        min={0}
                        max={30}
                        disabled={!open}
                        value={row[field] ?? ''}
                        placeholder={
                          field === 'min'      ? String(schedConfig.minPerDay) :
                          field === 'max'      ? String(schedConfig.maxPerDay) :
                          field === 'onlineMin'? '0' :
                                                  '—'
                        }
                        onChange={e => setCell(day, field, e.target.value)}
                        className="w-14 rounded border border-purple-200 px-1.5 py-1 text-center focus:border-purple-500 focus:outline-none disabled:bg-gray-100 disabled:cursor-not-allowed text-xs"
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 border-t border-purple-200 bg-white/40 flex items-center justify-between gap-2">
        <span className="text-[10px] text-purple-700/70 italic">
          Online Min is informational (warns if under-staffed). Online Max caps how many online instructors auto-schedule.
        </span>
        <button
          onClick={() => setSchedConfig(c => ({ ...c, perDay: {} }))}
          className="text-[10px] font-semibold text-purple-700 hover:text-purple-900 underline"
        >
          Clear per-day overrides
        </button>
      </div>
    </div>
  );
}

// ─── Draft Weekly Grid ─────────────────────────────────────────────────
// Renders the auto-scheduler's monthly draft as a person×day grid,
// chunked into weeks. Same visual grammar as the Manage Staff Schedule
// table — sticky instructor column on the left, one column per date,
// shift blocks coloured by assignment, and clear cell borders. Read-only
// here (changes are still made through the day-by-day editor below) but
// gives the owner a one-glance look at the whole month.
function DraftWeeklyGrid({ draftSchedule, centerConfig, schedConfig }) {
  if (!draftSchedule?.days?.length) return null;

  // Union of every employee scheduled at any point in the month, sorted
  // for stable row ordering. We keep them in tier order so the grid
  // matches Today's Snapshot conventions (Hosts/Mgmt → Online → In-Centre).
  const rolePri = (role, subRole) => {
    if (role === 'Online Instructor' || subRole === 'Online') return 1;
    if (role === 'Instructor' || role === 'Lead')             return 2;
    return 0;
  };
  const everyone = new Map();   // name → { role, subRole } first sighting
  for (const day of draftSchedule.days) {
    for (const name of day.assignedEmployees || []) {
      if (!everyone.has(name)) {
        everyone.set(name, { role: day.roles?.[name], subRole: day.subRoles?.[name] });
      }
    }
  }
  const names = [...everyone.entries()].sort(([na, ia], [nb, ib]) => {
    const dp = rolePri(ia.role, ia.subRole) - rolePri(ib.role, ib.subRole);
    if (dp !== 0) return dp;
    return na.localeCompare(nb);
  }).map(([n]) => n);

  // Chunk days into Monday-anchored weeks for the table rows. Each chunk
  // becomes its own small table beneath a header showing the week range
  // plus low-staff indicators per day.
  const weeks = [];
  let current = [];
  for (const day of draftSchedule.days) {
    const d = new Date(day.date + 'T00:00:00');
    const dow = d.getDay();   // 0 = Sun
    // Start a new week on Monday (or the very first day if we haven't started one yet).
    if (current.length === 0 || dow === 1) {
      if (current.length > 0) weeks.push(current);
      current = [day];
    } else {
      current.push(day);
    }
  }
  if (current.length > 0) weeks.push(current);

  const fmtDate = (iso) => {
    const d = new Date(iso + 'T00:00:00');
    return { dow: d.toLocaleDateString(undefined, { weekday: 'short' }),
             dn:  d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) };
  };

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="border-b bg-gray-50 px-5 py-3">
        <h4 className="font-semibold text-gray-900">Weekly Grid View</h4>
        <p className="text-xs text-gray-500">
          Whole-month look — same layout as Manage Staff Schedule. Only staff working each week are shown. Switch to Day-by-day to edit.
        </p>
      </div>

      <div className="space-y-4 p-4">
        {weeks.map((week, wi) => {
          // Only render rows for instructors working THIS week — drops the
          // empty rows that made the grid long and scroll-heavy.
          const weekNames = names.filter(name =>
            week.some(day => day.assignedEmployees?.includes(name)));
          return (
          <div key={wi} className="overflow-x-auto">
            <table className="w-full text-xs border-collapse table-fixed min-w-[680px] [&_td]:border [&_th]:border [&_td]:border-gray-300 [&_th]:border-gray-300">
              <thead>
                <tr className="bg-gray-50">
                  <th className="text-left px-3 py-2 font-semibold text-gray-600 w-32">INSTRUCTOR</th>
                  {week.map(day => {
                    const isLow = day.countingStaffCount < schedConfig.minPerDay;
                    const dl = fmtDate(day.date);
                    return (
                      <th key={day.date}
                        className={`text-center px-2 py-2 font-semibold ${isLow ? 'bg-red-50' : ''}`}>
                        <div className={`text-[10px] uppercase tracking-wide ${isLow ? 'text-red-700' : 'text-gray-500'}`}>{dl.dow}</div>
                        <div className={`${isLow ? 'text-red-800' : 'text-gray-800'} text-xs`}>{dl.dn}</div>
                        <div className={`text-[10px] ${isLow ? 'text-red-700 font-bold' : 'text-gray-500'} mt-0.5`}>
                          {day.countingStaffCount}/{schedConfig.minPerDay}{isLow ? ' ⚠' : ''}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {weekNames.map(name => (
                  <tr key={name}>
                    <td className="px-3 py-1.5 font-medium text-gray-800 bg-white">
                      {name}
                    </td>
                    {week.map(day => {
                      const isScheduled = day.assignedEmployees?.includes(name);
                      if (!isScheduled) {
                        return <td key={day.date} className="bg-gray-50/40 px-1 py-1" />;
                      }
                      const isSick = !!day.sickPay?.[name];
                      const assignment = assignmentFor({
                        role: day.roles?.[name],
                        subRole: day.subRoles?.[name],
                      });
                      const bg = isSick ? '#7f1d1d' : assignmentColorHex(assignment, centerConfig);
                      const text = contrastText(bg);
                      return (
                        <td key={day.date} className="p-0 align-top">
                          <div
                            className="rounded m-0.5 px-1.5 py-1 text-[10px] leading-tight"
                            style={{ backgroundColor: bg, color: text }}
                            title={`${name} · ${day.shiftTimes?.[name] || ''} · ${assignment}`}
                          >
                            <div className="font-bold truncate">{day.shiftTimes?.[name] || ''}</div>
                            <div className="opacity-90 truncate">{assignmentShort(assignment)}</div>
                            {isSick && <div className="font-bold opacity-90">SICK</div>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Small inline delta badge for week/month-over-week comparison ──────
function DeltaBadge({ delta, pct, isUp }) {
  if (delta === 0) {
    return (
      <span className="rounded-full bg-gray-100 text-gray-600 px-2 py-0.5 text-[10px] font-semibold">
        flat
      </span>
    );
  }
  const positive = isUp;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
      positive ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
    }`}>
      {positive ? '▲' : '▼'} {Math.abs(Math.round(delta * 10) / 10)}h
      {Math.abs(pct) < 999 && ` · ${Math.abs(Math.round(pct))}%`}
    </span>
  );
}

// Single row inside the Operations Snapshot — label on the left, the
// number on the right with an optional tone colour (good / warn / bad)
// and a hint underneath for context.
function SnapshotRow({ label, value, hint, tone }) {
  const toneCls =
    tone === 'good' ? 'text-emerald-700'
    : tone === 'warn' ? 'text-amber-700'
    : tone === 'bad'  ? 'text-rose-700'
    : 'text-gray-900';
  return (
    <div className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-700">{label}</p>
        {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
      </div>
      <p className={`text-base font-bold tabular-nums ${toneCls}`}>{value}</p>
    </div>
  );
}

// ─── Sub-component: Analytics tab ────────────────────────────────────────
// Owner-only dashboard. Pulls from the existing shifts + users + center
// config — no new data plumbing for Phase 1. Active student count is a
// manual entry on this page (Phase 2 will add automated enrollment import).

export function AnalyticsTab({ shifts, users, centerConfig, activeCenterId, view = 'hub' }) {
  const navigate = useNavigate();
  // Live counts that power the extra metric cards (open shifts, pending
  // time-off, etc). Pulled here rather than threaded through props
  // because the rest of Admin.jsx already subscribes to these elsewhere
  // — small duplication, but keeps the Analytics tab self-contained.
  const [openShiftsList, setOpenShiftsList] = useState([]);
  const [timeOffPending, setTimeOffPending] = useState(0);
  const [pendingSwapsCount, setPendingSwapsCount] = useState(0);
  useEffect(() => {
    if (!activeCenterId) return;
    const u1 = onSnapshot(
      query(
        collection(db, 'openShifts'),
        where('centerId', '==', activeCenterId),
      ),
      snap => setOpenShiftsList(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => {},
    );
    const u2 = onSnapshot(
      query(
        collection(db, 'timeOffRequests'),
        where('centerId', '==', activeCenterId),
        where('status', '==', 'pending'),
      ),
      snap => setTimeOffPending(snap.size),
      () => {},
    );
    // Pending shift-swap requests — they live in the `chat` collection
    // as documents tagged type: 'shift_swap' with swapStatus: 'open'.
    // We count them so the owner sees pending swaps next to open
    // shifts (both represent "schedule needs human attention").
    //
    // We additionally drop swaps whose shiftDate is in the past — a swap
    // request for a shift that already happened is dead even if nobody
    // closed the chat doc, and shouldn't inflate the badge. Matches the
    // ShiftBoard + sidebar logic (`!m.shiftDate || m.shiftDate >= today`).
    const u3 = onSnapshot(
      query(
        collection(db, 'chat'),
        where('centerId', '==', activeCenterId),
        where('type', '==', 'shift_swap'),
        where('swapStatus', '==', 'open'),
      ),
      snap => {
        const today = format(new Date(), 'yyyy-MM-dd');
        const stillPending = snap.docs.filter(d => {
          const date = d.data()?.shiftDate;
          return !date || date >= today;
        });
        setPendingSwapsCount(stillPending.length);
      },
      () => {},
    );
    return () => { u1(); u2(); u3(); };
  }, [activeCenterId]);
  const now = new Date();
  const todayStr      = format(now, 'yyyy-MM-dd');
  const weekStartStr  = format(startOfWeek(now), 'yyyy-MM-dd');
  const weekEndStr    = format(addDays(startOfWeek(now), 6), 'yyyy-MM-dd');
  // viewMonth drives the Snapshot + Leaderboard + Hours-by-Assignment +
  // Payroll Projection cards. The other cards (Today / This Week /
  // This Year / Coverage rolling-8 / Hiring forecast) intentionally
  // stay anchored to "now" — they're not monthly.
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(new Date()));
  const monthStartStr = format(startOfMonth(viewMonth), 'yyyy-MM-dd');
  const monthEndStr   = format(endOfMonth(viewMonth), 'yyyy-MM-dd');
  const isViewingCurrentMonth = format(startOfMonth(now), 'yyyy-MM') === format(viewMonth, 'yyyy-MM');
  const yearStartStr  = `${now.getFullYear()}-01-01`;
  const yearEndStr    = `${now.getFullYear()}-12-31`;

  // Only posted (non-draft) shifts count toward analytics.
  const posted = shifts.filter(s => s.status !== 'draft');
  const sumHrs = (rows) => rows.reduce((sum, s) => sum + shiftHours(s), 0);
  const round1 = (h) => Math.round((isNaN(h) ? 0 : h) * 10) / 10;

  const hoursToday  = sumHrs(posted.filter(s => s.date === todayStr));
  const hoursWeek   = sumHrs(posted.filter(s => s.date >= weekStartStr && s.date <= weekEndStr));
  const monthShifts = posted.filter(s => s.date >= monthStartStr && s.date <= monthEndStr);
  const hoursMonth  = sumHrs(monthShifts);
  const hoursYear   = sumHrs(posted.filter(s => s.date >= yearStartStr && s.date <= yearEndStr));

  // Prior-period totals for the comparison badges.
  // "Last week" is the 7-day Sun–Sat window before this one. "Last month"
  // is the prior calendar month. Used to show + / − deltas on the Hours
  // This Week / Hours This Month cards so the owner can see momentum.
  const lastWeekStartStr = format(addDays(startOfWeek(now), -7), 'yyyy-MM-dd');
  const lastWeekEndStr   = format(addDays(startOfWeek(now), -1), 'yyyy-MM-dd');
  const hoursLastWeek    = sumHrs(posted.filter(s => s.date >= lastWeekStartStr && s.date <= lastWeekEndStr));

  // "Last month" delta is relative to whatever month is being viewed.
  const lastMonthDate     = subMonths(viewMonth, 1);
  const lastMonthStartStr = format(startOfMonth(lastMonthDate), 'yyyy-MM-dd');
  const lastMonthEndStr   = format(endOfMonth(lastMonthDate),   'yyyy-MM-dd');
  const hoursLastMonth    = sumHrs(posted.filter(s => s.date >= lastMonthStartStr && s.date <= lastMonthEndStr));

  // Return { delta, pct, isUp } for a current/previous pair. Returns null
  // when there's no previous data so the UI can hide the badge.
  const deltaFor = (current, prev) => {
    if (!prev) return null;
    const delta = current - prev;
    const pct = Math.abs(prev) > 0 ? (delta / prev) * 100 : 0;
    return { delta, pct, isUp: delta >= 0 };
  };
  const weekDelta  = deltaFor(hoursWeek,  hoursLastWeek);
  const monthDelta = deltaFor(hoursMonth, hoursLastMonth);

  // ── Open shifts (future-dated, still unfilled) ──
  const openShiftsCount = openShiftsList.filter(s => s.status === 'open' && s.date >= todayStr).length;

  // ── Sick days used this month — count distinct dates with sickPay ──
  const sickDatesByName = new Map();
  for (const s of monthShifts) {
    if (!s.sickPay || !s.userName || !s.date) continue;
    if (!sickDatesByName.has(s.userName)) sickDatesByName.set(s.userName, new Set());
    sickDatesByName.get(s.userName).add(s.date);
  }
  const sickDaysThisMonth = [...sickDatesByName.values()].reduce((sum, set) => sum + set.size, 0);

  // ── Days till next stat holiday ──
  const holidaysList = Array.isArray(centerConfig?.holidays) ? centerConfig.holidays : [];
  const upcomingHolidays = holidaysList
    .filter(h => h?.date && h.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date));
  const nextHoliday = upcomingHolidays[0] || null;
  const daysTillNext = nextHoliday
    ? Math.round((new Date(nextHoliday.date + 'T00:00:00') - new Date(todayStr + 'T00:00:00')) / (24 * 3600 * 1000))
    : null;

  // ── Stat pay hours YTD (BC ESA "average day" rule) ──
  // For each holiday in the calendar year so far that's already passed,
  // sum the average-day hours for each person who had 15+ shifts in the
  // 30 days before that holiday. Gives the owner a single rolled-up
  // figure of stat-pay liability for the year.
  const allShiftsByName = {};
  for (const s of posted) {
    if (!s.userName || !s.date) continue;
    if (!allShiftsByName[s.userName]) allShiftsByName[s.userName] = [];
    allShiftsByName[s.userName].push(s);
  }
  const minusDaysStr = (dateStr, n) => {
    const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  const ytdHolidays = holidaysList.filter(h => h?.date && h.date >= yearStartStr && h.date <= todayStr);
  let statHoursYTD = 0;
  for (const h of ytdHolidays) {
    const windowStart = minusDaysStr(h.date, 30);
    for (const name of Object.keys(allShiftsByName)) {
      const relevant = allShiftsByName[name].filter(s => s.date >= windowStart && s.date < h.date);
      if (relevant.length < 15) continue;
      const total = relevant.reduce((sum, s) => sum + shiftHours(s), 0);
      statHoursYTD += total / relevant.length;
    }
  }
  statHoursYTD = Math.round(statHoursYTD * 10) / 10;

  // Active employees: approved staff at this centre, excluding super-admins.
  // Active staff split: employees = paid roster (excludes volunteers),
  // volunteers = separate tile so the owner can see unpaid headcount.
  // Combined headcount is still derivable for any future card that
  // needs it: activeEmployees + activeVolunteers.
  const activeEmployees  = users.filter(u => u.approved && u.role !== 'super_admin' && u.isVolunteer !== true).length;
  const activeVolunteers = users.filter(u => u.approved && u.role !== 'super_admin' && u.isVolunteer === true).length;

  // Avg hours per instructor working this month.
  const monthInstructors = new Set(monthShifts.map(s => s.userName).filter(Boolean));
  const avgPerInstructor = monthInstructors.size > 0 ? hoursMonth / monthInstructors.size : 0;

  // Hours by assignment (this month) — drives the horizontal-bar breakdown.
  const byAssignment = {};
  for (const s of monthShifts) {
    const a = assignmentFor(s);
    byAssignment[a] = (byAssignment[a] || 0) + shiftHours(s);
  }
  const assignmentRows = SHIFT_ASSIGNMENTS
    .map(a => ({ name: a, hours: byAssignment[a] || 0 }))
    .filter(r => r.hours > 0)
    .sort((a, b) => b.hours - a.hours);
  const maxAssign = Math.max(1, ...assignmentRows.map(r => r.hours));

  // Top instructors leaderboard (this month).
  const byInstructor = {};
  for (const s of monthShifts) {
    const key = s.userName || s.userId || '—';
    if (!byInstructor[key]) byInstructor[key] = { name: key, hours: 0, shifts: 0 };
    byInstructor[key].hours  += shiftHours(s);
    byInstructor[key].shifts += 1;
  }
  const leaderboard = Object.values(byInstructor)
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 12);
  const maxLeaderHrs = Math.max(1, ...leaderboard.map(p => p.hours));

  // ─── Coverage by day of week (rolling 8-week look-back) ────────────────
  // For each operating day, count distinct instructors scheduled that date,
  // then average across the days observed. Compares to defaultMinPerDay so
  // owners can see at a glance which weekdays are routinely under-staffed.
  const COVERAGE_WEEKS = 8;
  const coverageLookbackStart = (() => {
    const d = new Date(now);
    d.setDate(d.getDate() - COVERAGE_WEEKS * 7);
    return format(d, 'yyyy-MM-dd');
  })();
  // Distinct instructor count per date in the look-back window.
  const dateInstructors = {};
  for (const s of posted) {
    if (s.date < coverageLookbackStart || s.date > todayStr) continue;
    if (!dateInstructors[s.date]) dateInstructors[s.date] = new Set();
    if (s.userName) dateInstructors[s.date].add(s.userName);
  }
  // Bucket those counts by weekday name, skipping closed days & holidays.
  const byDow = {}; // 'Monday' -> [4, 5, 3, ...]
  for (const [date, names] of Object.entries(dateInstructors)) {
    const d = new Date(date + 'T12:00:00');
    if (!isOperatingDay(d, centerConfig)) continue;
    if (holidayFor(d, centerConfig)) continue;
    const dayName = ALL_WEEKDAYS[d.getDay()];
    if (!byDow[dayName]) byDow[dayName] = [];
    byDow[dayName].push(names.size);
  }
  const coverageTarget = Number(centerConfig?.defaultMinPerDay) || 8;
  const operatingDaysList = (Array.isArray(centerConfig?.operatingDays) && centerConfig.operatingDays.length > 0)
    ? centerConfig.operatingDays
    : DEFAULT_CENTER_CONFIG.operatingDays;
  const coverageRows = operatingDaysList.map(day => {
    const counts = byDow[day] || [];
    const samples = counts.length;
    const avg = samples > 0 ? counts.reduce((a, b) => a + b, 0) / samples : 0;
    const worst = samples > 0 ? Math.min(...counts) : 0;
    const best  = samples > 0 ? Math.max(...counts) : 0;
    const shortDays = counts.filter(c => c < coverageTarget).length;
    return {
      day, avg, worst, best, samples, shortDays,
      pct: samples > 0 ? avg / coverageTarget : 0,
    };
  });
  const coverageHasData = coverageRows.some(r => r.samples > 0);
  // Normalise bar widths against whichever is bigger — the target line or
  // the best-observed-day — so the threshold marker always stays in view.
  const coverageScale = Math.max(coverageTarget, ...coverageRows.map(r => r.best || 0));

  // ─── Hour-by-hour coverage heatmap (same look-back window) ─────────────
  // Goal: a day×hour grid showing average distinct-instructor count covering
  // each hour. "Covering hour H" means the shift's startTime <= H:00 and
  // endTime is strictly after H:00 (so 15:00–19:00 covers 15, 16, 17, 18).
  //
  // We use INSTRUCTIONAL hours (teaching window, e.g. 3pm-7pm), not
  // OPERATING hours (full open window, e.g. 10am-8pm). Owners only care
  // about coverage during teaching hours — showing 10am as "red" is
  // misleading because the centre isn't even running classes then.
  // Each centre's instructional hours are configured in Centre Settings,
  // so this auto-tailors per centre (Mathnasium Langley's 3-7p, a centre
  // with longer hours, etc.).
  const opHoursMap = centerConfig?.instructionalHours || DEFAULT_CENTER_CONFIG.instructionalHours;
  let earliestHour = 24;
  let latestHour = 0;
  for (const day of operatingDaysList) {
    const h = opHoursMap[day];
    if (!h) continue;
    earliestHour = Math.min(earliestHour, parseInt(h.start.split(':')[0], 10));
    latestHour   = Math.max(latestHour,   parseInt(h.end.split(':')[0], 10));
  }
  if (earliestHour >= latestHour) { earliestHour = 9; latestHour = 20; }
  const heatmapHours = [];
  for (let h = earliestHour; h < latestHour; h++) heatmapHours.push(h);

  const dateShiftMap = {};
  for (const s of posted) {
    if (s.date < coverageLookbackStart || s.date > todayStr) continue;
    if (!dateShiftMap[s.date]) dateShiftMap[s.date] = [];
    dateShiftMap[s.date].push(s);
  }
  const hourBuckets = {}; // dayName -> hour -> [counts per date]
  for (const [date, shiftsThisDate] of Object.entries(dateShiftMap)) {
    const d = new Date(date + 'T12:00:00');
    if (!isOperatingDay(d, centerConfig)) continue;
    if (holidayFor(d, centerConfig)) continue;
    const dayName = ALL_WEEKDAYS[d.getDay()];
    if (!hourBuckets[dayName]) hourBuckets[dayName] = {};
    for (const hour of heatmapHours) {
      const onAtHour = new Set();
      for (const s of shiftsThisDate) {
        const sh = parseInt(((s.startTime || '0').split(':')[0]), 10);
        const eh = parseInt(((s.endTime   || '0').split(':')[0]), 10);
        const em = parseInt(((s.endTime   || '0').split(':')[1]) || '0', 10);
        const startsByHour = sh <= hour;
        // Still on if their end-hour is strictly after this hour OR the end
        // is exactly this hour but with leftover minutes.
        const stillThere = eh > hour || (eh === hour && em > 0);
        if (startsByHour && stillThere && s.userName) onAtHour.add(s.userName);
      }
      if (!hourBuckets[dayName][hour]) hourBuckets[dayName][hour] = [];
      hourBuckets[dayName][hour].push(onAtHour.size);
    }
  }
  const heatmapCells = {};
  for (const day of operatingDaysList) {
    heatmapCells[day] = {};
    for (const h of heatmapHours) {
      const arr = hourBuckets[day]?.[h] || [];
      heatmapCells[day][h] = {
        avg: arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0,
        samples: arr.length,
      };
    }
  }
  const heatmapHasData = Object.keys(dateShiftMap).length > 0;

  // Lowest-coverage hour buckets (skip thinly-sampled and closed hours).
  const gapCandidates = [];
  for (const day of operatingDaysList) {
    const dayOpen = opHoursMap[day];
    if (!dayOpen) continue;
    const dayStartH = parseInt(dayOpen.start.split(':')[0], 10);
    const dayEndH   = parseInt(dayOpen.end.split(':')[0], 10);
    for (const h of heatmapHours) {
      if (h < dayStartH || h >= dayEndH) continue;
      const cell = heatmapCells[day][h];
      if (cell.samples < 2) continue;
      gapCandidates.push({ day, hour: h, avg: cell.avg, samples: cell.samples });
    }
  }
  gapCandidates.sort((a, b) => a.avg - b.avg);
  const coverageGaps = gapCandidates.slice(0, 5);

  // Manual student count + edit modal.
  const studentCount     = Number(centerConfig?.activeStudentCount ?? 0) || 0;
  const studentUpdatedAt = centerConfig?.studentCountUpdatedAt;
  const [editingStudents, setEditingStudents] = useState(false);
  const [studentInput,    setStudentInput]    = useState(studentCount);
  const [savingStudents,  setSavingStudents]  = useState(false);
  const [studentSaveError,setStudentSaveError]= useState('');

  // (Removed) Manual "emails needing response" state — the Emails-to-Reply
  // tile was retired when Active Volunteers took its slot. Re-introduce if
  // we ever build an inbox-sync connector that's worth surfacing here.

  // Re-sync input when the saved value changes (e.g. someone else updated it).
  useEffect(() => {
    if (!editingStudents) setStudentInput(studentCount);
  }, [studentCount, editingStudents]);

  const saveStudentCount = async () => {
    const n = Math.max(0, parseInt(studentInput, 10) || 0);
    setSavingStudents(true);
    setStudentSaveError('');
    try {
      await setDoc(
        doc(db, 'centers', activeCenterId, 'config', 'main'),
        { activeStudentCount: n, studentCountUpdatedAt: serverTimestamp() },
        { merge: true },
      );
      setEditingStudents(false);
    } catch (err) {
      setStudentSaveError(err?.message || 'Failed to save.');
    } finally {
      setSavingStudents(false);
    }
  };

  const studentsPerEmployee = activeEmployees > 0
    ? Math.round((studentCount / activeEmployees) * 10) / 10
    : 0;
  const updatedAtLabel = studentUpdatedAt?.seconds
    ? format(new Date(studentUpdatedAt.seconds * 1000), "MMM d, yyyy 'at' h:mm a")
    : null;

  // ─── Operations Snapshot stats (replaces the old Hours-per-Day bar
  // chart with denser, more decision-useful numbers) ──────────────────
  // Avg hours per day this month — only count days that actually had
  // shifts so a fresh month doesn't drag the average to zero.
  const monthDatesWithShifts = new Set(monthShifts.map(s => s.date).filter(Boolean));
  const avgHoursPerDay = monthDatesWithShifts.size > 0
    ? hoursMonth / monthDatesWithShifts.size : 0;
  const avgHoursPerShift = monthShifts.length > 0
    ? hoursMonth / monthShifts.length : 0;

  // Busiest / quietest weekday by avg hours (this month).
  const dowHours = {}; // dayName -> { hours, dates: Set }
  for (const s of monthShifts) {
    if (!s.date) continue;
    const d = new Date(s.date + 'T12:00:00');
    const dayName = ALL_WEEKDAYS[d.getDay()];
    if (!dowHours[dayName]) dowHours[dayName] = { hours: 0, dates: new Set() };
    dowHours[dayName].hours += shiftHours(s);
    dowHours[dayName].dates.add(s.date);
  }
  const dowRows = Object.entries(dowHours).map(([day, v]) => ({
    day, avg: v.dates.size > 0 ? v.hours / v.dates.size : 0,
  })).sort((a, b) => b.avg - a.avg);
  const busiestDay = dowRows[0] || null;
  const quietestDay = dowRows.length > 0 ? dowRows[dowRows.length - 1] : null;

  // Open shift fill rate (this month) — filled vs total slots posted.
  const monthShiftCount = monthShifts.length;
  const openShiftsMonth = openShiftsList.filter(s =>
    s.date >= monthStartStr && s.date <= monthEndStr).length;
  const fillRate = (monthShiftCount + openShiftsMonth) > 0
    ? (monthShiftCount / (monthShiftCount + openShiftsMonth)) * 100 : 0;

  // Sick day rate this month — sick days as % of all scheduled person-days.
  const personDaysThisMonth = new Set(
    monthShifts.map(s => `${s.userName}|${s.date}`),
  ).size;
  const sickRate = personDaysThisMonth > 0
    ? (sickDaysThisMonth / personDaysThisMonth) * 100 : 0;

  // Average distinct-instructor coverage across operating days (last 8 weeks).
  const coverageAvgAll = coverageRows.filter(r => r.samples > 0);
  const coverageAvg = coverageAvgAll.length > 0
    ? coverageAvgAll.reduce((sum, r) => sum + r.avg, 0) / coverageAvgAll.length : 0;
  const coverageVsTarget = coverageTarget > 0
    ? (coverageAvg / coverageTarget) * 100 : 0;

  // ─── Payroll Projection (semi-monthly) ───────────────────────────────
  // Mathnasium pays semi-monthly with a lagged window:
  //   • 15th payroll covers the 26th of the PRIOR month → 10th of this month
  //   • 30th payroll covers the 11th → 25th of this month
  // Hours worked from the 26th onward roll into NEXT month's 15th run.
  //
  // This card MUST match the Manage Payroll export's "Total Hours" column
  // so owners can reconcile the two. That means the same filters as
  // payrollSummary in Admin.jsx:
  //   – posted only (drafts excluded)
  //   – Volunteer-role shifts excluded
  //   – salaried staff, flagged volunteers, and hidden ops accounts
  //     (owner / super-admin / Admin Team / internal) excluded
  //   – sick shifts NOT added to the headline (they live in a separate
  //     Sick Pay column in the export)
  //   – no-shows count 0 (they didn't come in, they don't get paid) —
  //     this matches Staffing Budget's paidHours(); without it Analytics
  //     over-reported the period by the no-show hours.
  //   – Payroll Hours = payHoursOverride if set, else scheduled.
  const payHrsOf = (s) => {
    if (s.noShow) return 0;
    return (typeof s.payHoursOverride === 'number' && isFinite(s.payHoursOverride))
      ? s.payHoursOverride
      : shiftHours(s);
  };

  // Rebuild the same exclusion sets the payroll tab uses. AnalyticsTab
  // only receives `users` + `activeCenterId`, so we resolve per-centre
  // here (cheap; users list is small).
  const _payUsersForCentre = users.map(u => resolveUserForCenter(u, activeCenterId));
  const _paySalaryStaff = new Set(Array.isArray(centerConfig?.salaryStaff) ? centerConfig.salaryStaff : []);
  const _payVolunteerNames = new Set();
  for (const u of _payUsersForCentre) {
    if (u.isVolunteer === true && u.displayName) _payVolunteerNames.add(u.displayName);
  }
  const _payHiddenFromOps = new Set();
  for (const u of users) {
    const hidden = u.role === 'owner' || u.role === 'super_admin' || u.role === 'director'
      || u.internal === true
      || u.displayName === 'Admin Team';
    if (hidden && u.displayName) _payHiddenFromOps.add(u.displayName);
  }
  const _payEligible = (s) =>
    s.status !== 'draft'
    && s.role !== 'Volunteer'
    && !s.sickPay
    && !_paySalaryStaff.has(s.userName)
    && !_payVolunteerNames.has(s.userName)
    && !_payHiddenFromOps.has(s.userName);

  const _vmY = viewMonth.getFullYear();
  const _vmM = viewMonth.getMonth();
  const period1StartDate = new Date(_vmY, _vmM - 1, 26);
  const period1EndDate   = new Date(_vmY, _vmM,     10);
  const period2StartDate = new Date(_vmY, _vmM,     11);
  const period2EndDate   = new Date(_vmY, _vmM,     25);
  const period1StartStr = format(period1StartDate, 'yyyy-MM-dd');
  const period1EndStr   = format(period1EndDate,   'yyyy-MM-dd');
  const period2StartStr = format(period2StartDate, 'yyyy-MM-dd');
  const period2EndStr   = format(period2EndDate,   'yyyy-MM-dd');

  const period1Shifts = shifts.filter(s =>
    s.date >= period1StartStr && s.date <= period1EndStr && _payEligible(s));
  const period2Shifts = shifts.filter(s =>
    s.date >= period2StartStr && s.date <= period2EndStr && _payEligible(s));
  const period1Hours  = period1Shifts.reduce((sum, s) => sum + payHrsOf(s), 0);
  const period2Hours  = period2Shifts.reduce((sum, s) => sum + payHrsOf(s), 0);
  const period1Names  = new Set(period1Shifts.map(s => s.userName).filter(Boolean));
  const period2Names  = new Set(period2Shifts.map(s => s.userName).filter(Boolean));

  // ─── Weekly scheduled hours (Mon–Sat) ─────────────────────────────────
  // Deliberately mirrors Manage Schedule's "Total assigned" rather than the
  // payroll rule above, so a given week reads identically on both pages:
  //   • drafts DO count (planned coverage is still coverage)
  //   • no-shows, sick, volunteers, salaried and hidden-from-ops do NOT
  //   • neither does anyone without a portal account — they have no row on
  //     the grid, so Manage Schedule leaves them out too
  // Week boundaries use the same Sunday-anchored startOfWeek() the schedule
  // grid uses; the centre is closed Sundays so the span reads as Mon–Sat.
  const _schedPortalNames = new Set(users.map(u => u.displayName).filter(Boolean));
  const _schedExcluded = new Set([
    ..._paySalaryStaff, ..._payVolunteerNames, ..._payHiddenFromOps,
  ]);
  const _schedEligible = (s) =>
    s.noShow !== true
    && s.sickPay !== true
    && s.role !== 'Volunteer'
    && _schedPortalNames.has(s.userName)
    && !_schedExcluded.has(s.userName);

  const weekRows = [];
  {
    const monthEndStr = format(endOfMonth(viewMonth), 'yyyy-MM-dd');
    let w = startOfWeek(startOfMonth(viewMonth));
    while (format(w, 'yyyy-MM-dd') <= monthEndStr) {
      const wStart = format(w, 'yyyy-MM-dd');
      const wEnd   = format(addDays(w, 6), 'yyyy-MM-dd');
      let hrs = 0;
      let sick = 0;
      for (const s of shifts) {
        if (!s.date || s.date < wStart || s.date > wEnd) continue;
        if (s.sickPay === true && s.noShow !== true && _schedPortalNames.has(s.userName)
            && !_schedExcluded.has(s.userName) && s.role !== 'Volunteer') {
          sick += shiftHours(s);
          continue;
        }
        if (!_schedEligible(s)) continue;
        hrs += shiftHours(s);
      }
      weekRows.push({
        key: wStart,
        // Mon–Sat span, since Sunday is a closure.
        label: `${format(addDays(w, 1), 'MMM d')} – ${format(addDays(w, 6), 'MMM d')}`,
        hours: hrs,
        sick,
        isCurrent: isSameWeek(new Date(), w),
      });
      w = addDays(w, 7);
    }
  }
  const weeklyTotal = weekRows.reduce((n, r) => n + r.hours, 0);

  // Which pay run is "upcoming" given today's date:
  //   day 1–10  → 15th of this month is next up (period 1)
  //   day 11–25 → 30th of this month is next up (period 2)
  //   day 26+   → already accruing toward NEXT month's 15th, so neither
  //               card in the viewed month is upcoming.
  const todayDay = isViewingCurrentMonth ? now.getDate() : null;
  const currentPeriod = todayDay == null
    ? null
    : (todayDay <= 10 ? 1 : todayDay <= 25 ? 2 : null);

  // ─── Hiring forecast (Phase 2) ─────────────────────────────────────────
  // Roll up staff `careerPlan` fields into a projected headcount for each of
  // the next 4 months. "No" is treated as a definite departure on/by the
  // expected last month; "Unsure" is surfaced separately so the owner can
  // check in, but isn't deducted from the projection.
  const REASON_LABELS = {
    graduating: 'Graduating',
    moving:     'Moving away',
    career:     'Career change',
    school:     'School / workload',
    other:      'Other',
  };
  const formatPlanMonthLabel = (key) => {
    if (!key) return 'soon';
    const [y, m] = key.split('-');
    const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  };

  const activeStaff = users.filter(u => u.approved && u.role !== 'super_admin');
  const currentHeadcount = activeStaff.length;

  // Build next 4 months as { key:'YYYY-MM', label:'Aug 2026' }.
  const nextMonths = [];
  for (let i = 1; i <= 4; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    nextMonths.push({
      key:   `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
    });
  }

  const leavers = activeStaff
    .filter(u => u.careerPlan?.stayingIn4Months === 'no' && u.careerPlan?.expectedDepartureMonth)
    .map(u => ({
      name:          u.displayName || '(no name)',
      role:          u.instructorType || 'Instructor',
      monthKey:      u.careerPlan.expectedDepartureMonth,
      reason:        u.careerPlan.reason,
      reasonNotes:   u.careerPlan.reasonNotes,
      aspirations:   u.careerPlan.aspirations,
    }))
    .sort((a, b) => a.monthKey.localeCompare(b.monthKey));

  const unsureStaff = activeStaff
    .filter(u => u.careerPlan?.stayingIn4Months === 'unsure')
    .map(u => ({
      name:        u.displayName || '(no name)',
      role:        u.instructorType || 'Instructor',
      aspirations: u.careerPlan?.aspirations,
    }));

  // Staff who shared aspirations regardless of staying status — useful
  // signal for mentoring + retention conversations.
  const aspirationsList = activeStaff
    .filter(u => (u.careerPlan?.aspirations || '').trim().length > 0)
    .map(u => ({
      name:        u.displayName || '(no name)',
      aspirations: u.careerPlan.aspirations,
      staying:     u.careerPlan?.stayingIn4Months,
    }));

  const projection = nextMonths.map(m => {
    const cumDepart = leavers.filter(l => l.monthKey <= m.key).length;
    return { ...m, departures: cumDepart, projected: Math.max(0, currentHeadcount - cumDepart) };
  });
  const totalDepart   = leavers.filter(l => l.monthKey <= nextMonths[3].key).length;
  const projectedEnd  = Math.max(0, currentHeadcount - totalDepart);
  const showRiskBanner = totalDepart > 0;

  // Informational floor — roughly "you need this many staff total to fill a
  // typical week given your per-day minimum". Helps spot dangerous drops.
  const minStaffFloor = Math.max(4, (centerConfig?.defaultMinPerDay || 8) * 2);

  // Coverage of next 4 months — how many staff haven't filled out a plan.
  const noPlanCount = activeStaff.filter(u => !u.careerPlan || !u.careerPlan.updatedAt).length;

  // Job posting modal state.
  const [jobModalOpen, setJobModalOpen] = useState(false);

  // Metadata for each deep-dive module — used by the hub tiles and the
  // detail-view headers. Keeping this in one place means renaming a
  // module (or adding a 6th) only requires editing this array.
  const MODULES = [
    {
      key: 'snapshot',
      label: `${format(viewMonth, 'MMMM')} Operations Snapshot`,
      desc: 'Daily averages, busiest day, fill rate, sick rate, and projected 15th/30th payroll for the viewed month.',
      icon: Activity, accent: 'bg-purple-100 text-purple-700',
    },
    {
      key: 'intakes',
      label: 'Booking Intakes',
      desc: 'Where new students are coming from — public intake form submissions plus your Apptoto appointment feed.',
      icon: Megaphone, accent: 'bg-sky-100 text-sky-700',
    },
    {
      key: 'coverage',
      label: 'Avg Coverage by Day',
      desc: 'Rolling 8-week average of how many instructors actually show up per weekday vs. your staffing target.',
      icon: Calendar, accent: 'bg-amber-100 text-amber-700',
    },
    {
      key: 'assignments',
      label: 'Hours by Assignment',
      desc: 'Where this month\'s hours are going — by sub-role and per-instructor leaderboard.',
      icon: TrendingUp, accent: 'bg-emerald-100 text-emerald-700',
    },
    {
      key: 'hiring',
      label: 'Hiring Forecast',
      desc: 'Projected headcount over the next 4 months based on staff career-plan answers, plus draft-a-posting tool.',
      icon: Users, accent: 'bg-rose-100 text-rose-700',
    },
  ];
  const currentModule = MODULES.find(m => m.key === view);

  return (
    <div className="space-y-6">
      {/* Header — view-aware. Detail pages get a back link + module
          title; the hub stays as the generic Centre Analytics intro. */}
      {view === 'hub' ? (
        <div>
          <h2 className="text-lg font-bold text-gray-900">Centre Analytics</h2>
          <p className="text-sm text-gray-500">Headcount, hours, and what your team&apos;s been working on at a glance.</p>
        </div>
      ) : (
        <div>
          <button
            onClick={() => navigate('/center-analytics')}
            className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800"
          >
            <ArrowLeft size={12} /> Back to overview
          </button>
          <div className="flex items-center gap-2">
            {currentModule?.icon && (
              <span className={`rounded-lg p-1.5 ${currentModule.accent}`}>
                <currentModule.icon size={16} />
              </span>
            )}
            <h2 className="text-lg font-bold text-gray-900">{currentModule?.label || 'Analytics'}</h2>
          </div>
          <p className="text-sm text-gray-500 mt-0.5">{currentModule?.desc}</p>
        </div>
      )}

      {/* ── Hub: 5 module tiles ─────────────────────────────────────────
          Only renders on the overview. Each tile is a button that
          navigates to that module's dedicated detail page. Description
          text is right on the tile so a new owner doesn't have to
          click to learn what each module shows. */}
      {view === 'hub' && (
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <LayoutGrid size={14} className="text-gray-500" />
            <h3 className="text-sm font-semibold text-gray-900">Analytics modules</h3>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {MODULES.map(m => {
              const Icon = m.icon;
              return (
                <button
                  key={m.key}
                  onClick={() => navigate(`/center-analytics/${m.key}`)}
                  className="group rounded-xl border border-gray-200 bg-white p-3 text-left transition-all hover:border-purple-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-purple-300"
                >
                  <div className={`mb-2 inline-flex rounded-lg p-1.5 ${m.accent}`}>
                    <Icon size={15} />
                  </div>
                  <p className="text-sm font-semibold text-gray-900 leading-tight group-hover:text-purple-700">{m.label}</p>
                  <p className="mt-1.5 text-xs leading-snug text-gray-500">{m.desc}</p>
                  <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-purple-600 opacity-0 group-hover:opacity-100 transition-opacity">
                    Open →
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Row 1 — People & inbox.
          Only on hub view. Detail pages don't need the KPI grid. */}
      {view === 'hub' && (<>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-purple-100 text-purple-700"><Users size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Active Employees</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{activeEmployees}</p>
          <p className="mt-1 text-xs text-gray-400">approved staff at this centre</p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between">
            <div className="w-fit rounded-lg p-1.5 bg-emerald-100 text-emerald-700"><Activity size={16}/></div>
            <button
              type="button"
              onClick={() => { setStudentInput(studentCount); setEditingStudents(true); }}
              className="flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline"
            >
              <Edit3 size={11}/> Edit
            </button>
          </div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Active Students</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{studentCount}</p>
          <p className="mt-1 text-xs text-gray-400">
            {updatedAtLabel ? `Updated ${updatedAtLabel}` : 'Radius sync coming soon'}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-sky-100 text-sky-700"><HandHeart size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Active Volunteers</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{activeVolunteers}</p>
          <p className="mt-1 text-xs text-gray-400">
            {activeVolunteers === 0 ? 'no volunteers approved' : 'unpaid contributors'}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-yellow-100 text-yellow-700"><CalendarX size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Pending Time-Off</p>
          <p className={`mt-0.5 text-2xl font-bold ${timeOffPending > 0 ? 'text-yellow-700' : 'text-gray-900'}`}>
            {timeOffPending}
          </p>
          <p className="mt-1 text-xs text-gray-400">
            {timeOffPending === 0 ? 'inbox clear' : `request${timeOffPending === 1 ? '' : 's'} waiting on you`}
          </p>
        </div>
      </div>

      {/* Row 2 — Hours */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-blue-100 text-blue-700"><Clock size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Hours Today</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{round1(hoursToday)}h</p>
          <p className="mt-1 text-xs text-gray-400">{format(now, 'EEE MMM d')}</p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between">
            <div className="w-fit rounded-lg p-1.5 bg-indigo-100 text-indigo-700"><CalendarRange size={16}/></div>
            {weekDelta && <DeltaBadge {...weekDelta} />}
          </div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Hours This Week</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{round1(hoursWeek)}h</p>
          <p className="mt-1 text-xs text-gray-400">Sun–Sat · last week {round1(hoursLastWeek)}h</p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between">
            <div className="w-fit rounded-lg p-1.5 bg-amber-100 text-amber-700"><CalendarRange size={16}/></div>
            {monthDelta && <DeltaBadge {...monthDelta} />}
          </div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Hours This Month</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{round1(hoursMonth)}h</p>
          <p className="mt-1 text-xs text-gray-400">
            {format(now, 'MMMM yyyy')} · {format(lastMonthDate, 'MMM')} {round1(hoursLastMonth)}h
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-rose-100 text-rose-700"><BarChart3 size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Hours This Year</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{round1(hoursYear)}h</p>
          <p className="mt-1 text-xs text-gray-400">{now.getFullYear()} so far</p>
        </div>
      </div>

      {/* Row 3 — Operations */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-orange-100 text-orange-700"><Briefcase size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Open / Swap Shifts</p>
          <p className={`mt-0.5 text-2xl font-bold ${
            openShiftsCount + pendingSwapsCount > 0 ? 'text-orange-700' : 'text-gray-900'
          }`}>
            {openShiftsCount} <span className="text-gray-300">/</span> {pendingSwapsCount}
          </p>
          <p className="mt-1 text-xs text-gray-400">
            {openShiftsCount === 0 && pendingSwapsCount === 0
              ? 'queue is clear'
              : `${openShiftsCount} open · ${pendingSwapsCount} pending swap${pendingSwapsCount === 1 ? '' : 's'}`}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-amber-100 text-amber-700"><Activity size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Sick Days This Month</p>
          <p className={`mt-0.5 text-2xl font-bold ${sickDaysThisMonth >= 5 ? 'text-amber-700' : 'text-gray-900'}`}>
            {sickDaysThisMonth}
          </p>
          <p className="mt-1 text-xs text-gray-400">{sickDatesByName.size} staff affected</p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-pink-100 text-pink-700"><CalendarX size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Next Stat Holiday</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">
            {daysTillNext == null ? '—' : daysTillNext === 0 ? 'Today' : `${daysTillNext}d`}
          </p>
          <p className="mt-1 text-xs text-gray-400 truncate">
            {nextHoliday
              ? `${nextHoliday.name || 'Holiday'} · ${format(new Date(nextHoliday.date + 'T00:00:00'), 'MMM d')}`
              : 'none in your holidays list'}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-purple-100 text-purple-700"><DollarSign size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Stat Pay YTD</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{statHoursYTD}h</p>
          <p className="mt-1 text-xs text-gray-400">{ytdHolidays.length} stat holiday{ytdHolidays.length === 1 ? '' : 's'} paid out</p>
        </div>
      </div>
      </>)}

      {/* Student count edit modal */}
      {editingStudents && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !savingStudents && setEditingStudents(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-1">Active Student Count</h3>
            <p className="text-xs text-gray-500 mb-3">Manually update the current enrollment for this centre.</p>
            <input
              type="number"
              min={0}
              value={studentInput}
              onChange={e => setStudentInput(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none mb-3"
              autoFocus
            />
            {studentSaveError && <p className="text-xs text-red-600 mb-2">{studentSaveError}</p>}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingStudents(false)}
                disabled={savingStudents}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveStudentCount}
                disabled={savingStudents}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {savingStudents ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Emails-to-reply modal removed alongside the Emails-to-Reply
          tile (Active Volunteers now sits in that slot). The
          emailsCount / saveEmailsCount state vars remain in scope but
          unused — safe to delete in a follow-up cleanup pass. */}

      {/* ── Assignments module: Hours by Assignment + Top Instructors ──
          Originally lived in a 2-col grid alongside Operations Snapshot.
          Split into stand-alone cards so each can be view-gated to its
          own module. */}
      {view === 'assignments' && (
      <div className="grid gap-4">
        {/* Hours by assignment */}
        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">Hours by Assignment</h3>
          <p className="text-xs text-gray-500 mb-4">{format(now, 'MMMM yyyy')} · {round1(hoursMonth)}h scheduled</p>
          {assignmentRows.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">No shifts scheduled this month yet.</p>
          ) : (
            <div className="space-y-2.5">
              {assignmentRows.map(row => (
                <div key={row.name}>
                  <div className="flex items-baseline justify-between text-xs mb-0.5">
                    <span className="font-medium text-gray-700">{row.name}</span>
                    <span className="text-gray-500">
                      {round1(row.hours)}h · {hoursMonth > 0 ? Math.round((row.hours / hoursMonth) * 100) : 0}%
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${(row.hours / maxAssign) * 100}%`,
                        backgroundColor: assignmentColorHex(row.name, centerConfig),
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
      )}

      {/* ── Snapshot module: Payroll Projection + Operations Snapshot ──
          Payroll Projection leads — it's the number owners open this page
          for. Semi-monthly view: the 15th pay run covers prior-month 26th →
          this-month 10th; the 30th covers this-month 11th → 25th. Uses the
          same Payroll Hours value as Manage Payroll — override wins,
          scheduled falls back, no-shows count 0 — so a bloated upcoming run
          is visible before payroll day instead of after. */}
      {view === 'snapshot' && (
      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold text-gray-900">Payroll Projection</h3>
          <span className="text-xs text-gray-500">{format(viewMonth, 'MMMM yyyy')}</span>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Semi-monthly pay runs · Payroll Hours = override (if set) or scheduled hours
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            {
              label: '15th payroll',
              window: `${format(period1StartDate, 'MMM d')} – ${format(period1EndDate, 'MMM d')}`,
              hours: period1Hours,
              shifts: period1Shifts.length,
              instructors: period1Names.size,
              upcoming: currentPeriod === 1,
            },
            {
              label: '30th payroll',
              window: `${format(period2StartDate, 'MMM d')} – ${format(period2EndDate, 'MMM d')}`,
              hours: period2Hours,
              shifts: period2Shifts.length,
              instructors: period2Names.size,
              upcoming: currentPeriod === 2,
            },
          ].map(p => (
            <div
              key={p.label}
              className={`rounded-xl border p-4 ${
                p.upcoming
                  ? 'border-purple-300 bg-purple-50/40'
                  : 'border-gray-200 bg-gray-50/40'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">{p.label}</span>
                {p.upcoming && (
                  <span className="rounded-full bg-purple-200 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-purple-800">
                    Upcoming
                  </span>
                )}
              </div>
              <p className="text-[10px] text-gray-500 mb-2">{p.window}</p>
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-bold text-purple-700">{round1(p.hours)}</span>
                <span className="text-sm text-gray-500">hrs</span>
              </div>
              <p className="mt-1 text-[10px] text-gray-500">
                {p.shifts} shift{p.shifts === 1 ? '' : 's'} · {p.instructors} instructor{p.instructors === 1 ? '' : 's'}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
          <span className="text-xs font-medium text-gray-600">Total month projection</span>
          <span className="text-sm font-bold text-gray-900">
            {round1(period1Hours + period2Hours)} hrs
          </span>
        </div>
        {isViewingCurrentMonth && (
          <p className="mt-2 text-[10px] text-gray-400 italic">
            Matches the Manage Payroll export (Total Hours): posted shifts only, sick / volunteers / salaried / hidden accounts excluded.
          </p>
        )}
      </div>
      )}

      {/* Operations Snapshot — dense, decision-useful numbers replacing
          the old 30-day bar chart. Each row is a single KPI that maps to
          a real operating question (Are shifts getting filled? Are we
          short-staffed? Which day is our peak?). Month nav arrows let
          the owner page through prior months for comparison without
          losing the live deltas. */}
      {view === 'snapshot' && (
        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-semibold text-gray-900">Operations Snapshot</h3>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setViewMonth(m => subMonths(m, 1))}
                title="Previous month"
                className="rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-colors"
              >
                <ChevronLeft size={14} />
              </button>
              {!isViewingCurrentMonth && (
                <button
                  onClick={() => setViewMonth(startOfMonth(new Date()))}
                  title="Jump to current month"
                  className="rounded border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-50"
                >
                  Today
                </button>
              )}
              <button
                onClick={() => setViewMonth(m => addMonths(m, 1))}
                title="Next month"
                className="rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-colors"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            {format(viewMonth, 'MMMM yyyy')}{isViewingCurrentMonth ? ' · live numbers' : ''}
          </p>
          <div className="divide-y divide-gray-100">
            <SnapshotRow label="Avg hours / day"        value={`${round1(avgHoursPerDay)}h`}  hint={`${monthDatesWithShifts.size} day${monthDatesWithShifts.size === 1 ? '' : 's'} scheduled`} />
            <SnapshotRow label="Avg hours / instructor" value={`${round1(avgPerInstructor)}h`} hint={`${monthInstructors.size} working this month`} />
            <SnapshotRow label="Avg hours / shift"      value={`${round1(avgHoursPerShift)}h`} hint={`${monthShiftCount} shift${monthShiftCount === 1 ? '' : 's'} posted`} />
            <SnapshotRow label="Open-shift fill rate"   value={`${Math.round(fillRate)}%`}     hint={`${openShiftsMonth} still open`} tone={fillRate >= 90 ? 'good' : fillRate >= 75 ? 'warn' : 'bad'} />
            <SnapshotRow label="Students per employee"  value={studentsPerEmployee || '—'}     hint="workload ratio" />
            <SnapshotRow label="Busiest day"  value={busiestDay ? busiestDay.day : '—'}  hint={busiestDay ? `${round1(busiestDay.avg)}h avg` : ''} />
            <SnapshotRow label="Quietest day" value={quietestDay ? quietestDay.day : '—'} hint={quietestDay ? `${round1(quietestDay.avg)}h avg` : ''} />
            <SnapshotRow label="Sick day rate"         value={`${Math.round(sickRate * 10) / 10}%`} hint={`${sickDaysThisMonth} of ${personDaysThisMonth} scheduled days`} tone={sickRate >= 8 ? 'bad' : sickRate >= 4 ? 'warn' : 'good'} />
            <SnapshotRow label="Coverage vs target"    value={`${Math.round(coverageVsTarget)}%`}   hint={`${round1(coverageAvg)} of ${coverageTarget} target instructors / day`} tone={coverageVsTarget >= 95 ? 'good' : coverageVsTarget >= 80 ? 'warn' : 'bad'} />
          </div>

          {/* Weekly scheduled hours — same rule and same week boundaries as
              Manage Schedule's "Total assigned", so the two agree week for
              week. Sick sits outside the figure and shows beside it. */}
          <div className="mt-5 border-t border-gray-100 pt-4">
            <div className="mb-2 flex items-baseline justify-between">
              <h4 className="text-xs font-bold uppercase tracking-wide text-gray-700">Hours scheduled by week</h4>
              <span className="text-[10px] text-gray-400">Mon – Sat · matches Manage Schedule</span>
            </div>
            <div className="divide-y divide-gray-100">
              {weekRows.map(w => (
                <div key={w.key} className={`flex items-center justify-between py-1.5 ${w.isCurrent ? 'font-semibold' : ''}`}>
                  <span className={`text-xs ${w.isCurrent ? 'text-gray-900' : 'text-gray-600'}`}>
                    {w.label}
                    {w.isCurrent && (
                      <span className="ml-1.5 rounded-full bg-purple-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-purple-700">
                        This week
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    {w.sick > 0 && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800"
                        title="Sick hours — paid under the sick budget, not counted in the scheduled total.">
                        +{round1(w.sick)}h sick
                      </span>
                    )}
                    <span className="text-sm font-semibold text-gray-900 tabular-nums">{round1(w.hours)}h</span>
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
              <span className="text-xs font-medium text-gray-600">
                Total across {weekRows.length} week{weekRows.length === 1 ? '' : 's'}
              </span>
              <span className="text-sm font-bold text-gray-900">{round1(weeklyTotal)} hrs</span>
            </div>
            <p className="mt-2 text-[10px] text-gray-400 italic">
              Drafts count; no-shows, sick, volunteers, salaried and hidden accounts don't. Weeks can spill past the month edge, so this total won't equal the month projection above.
            </p>
          </div>
        </div>
      )}

      {/* ── Intakes module: Public Intake form + Apptoto appointments ── */}
      {view === 'intakes' && <IntakeAnalyticsCard />}
      {view === 'intakes' && <ApptotoAppointmentsCard />}

      {/* ── Assignments module: Top Instructors leaderboard ── */}
      {view === 'assignments' && (
      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Top Instructors</h3>
        <p className="text-xs text-gray-500 mb-4">By hours scheduled · {format(viewMonth, 'MMMM yyyy')}</p>
        {leaderboard.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-400">No instructors have hours scheduled this month.</p>
        ) : (
          <div className="space-y-2">
            {leaderboard.map((p, i) => (
              <div key={p.name} className="flex items-center gap-3">
                <div className="w-5 text-right text-xs font-bold text-gray-400">{i + 1}</div>
                <div className="w-28 truncate text-sm font-medium text-gray-800 sm:w-40">{p.name}</div>
                <div className="h-2 flex-1 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-purple-500"
                    style={{ width: `${(p.hours / maxLeaderHrs) * 100}%` }}
                  />
                </div>
                <div className="w-20 text-right text-xs text-gray-500">
                  <span className="font-semibold text-gray-800">{round1(p.hours)}h</span>
                  <span className="ml-1.5 text-gray-400">· {p.shifts}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {/* ── Coverage module: Day-of-Week + Hourly heatmap ───────────── */}
      {view === 'coverage' && (<>
      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-baseline justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Average Coverage by Day</h3>
            <p className="mt-0.5 text-xs text-gray-500">
              Last {COVERAGE_WEEKS} weeks · target of {coverageTarget} instructors per day
              {' '}(set in Center Settings).
            </p>
          </div>
        </div>

        {!coverageHasData ? (
          <p className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-4 py-8 text-center text-sm text-gray-400">
            No posted schedules in the last {COVERAGE_WEEKS} weeks yet — once you start posting, this fills in.
          </p>
        ) : (
          <div className="space-y-2.5">
            {coverageRows.map(r => {
              const filledPct = coverageScale > 0 ? Math.min(100, (r.avg / coverageScale) * 100) : 0;
              const targetPct = coverageScale > 0 ? (coverageTarget / coverageScale) * 100 : 0;
              const status = r.samples === 0
                ? 'none'
                : r.avg < coverageTarget * 0.85
                  ? 'short'
                  : r.avg < coverageTarget
                    ? 'tight'
                    : 'ok';
              const barColor = status === 'short'
                ? 'bg-rose-500'
                : status === 'tight'
                  ? 'bg-amber-500'
                  : status === 'ok'
                    ? 'bg-emerald-500'
                    : 'bg-gray-300';
              const statusLabel = r.samples === 0
                ? 'No data'
                : r.shortDays > 0
                  ? `Short on ${r.shortDays} of ${r.samples} ${r.samples === 1 ? 'day' : 'days'}`
                  : `Hit target on all ${r.samples} ${r.samples === 1 ? 'day' : 'days'}`;
              return (
                <div key={r.day}>
                  <div className="mb-0.5 flex items-baseline justify-between text-xs">
                    <span className="font-semibold text-gray-700">{r.day}</span>
                    <span className="text-gray-500">
                      <span className={`font-semibold ${status === 'short' ? 'text-rose-600' : status === 'tight' ? 'text-amber-700' : status === 'ok' ? 'text-emerald-700' : 'text-gray-500'}`}>
                        {r.samples > 0 ? r.avg.toFixed(1) : '—'}
                      </span>
                      <span className="text-gray-400"> avg · {statusLabel}</span>
                    </span>
                  </div>
                  <div className="relative h-3 rounded-full bg-gray-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${barColor}`}
                      style={{ width: `${filledPct}%` }}
                    />
                    {/* Dashed target threshold */}
                    <div
                      className="absolute top-0 bottom-0 border-l-2 border-dashed border-gray-500/60"
                      style={{ left: `${targetPct}%` }}
                      title={`Target: ${coverageTarget}`}
                    />
                  </div>
                  {r.samples > 0 && (
                    <p className="mt-1 text-[10px] text-gray-400">
                      Range {r.worst}–{r.best} over {r.samples} observed {r.samples === 1 ? 'day' : 'days'}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {coverageHasData && (
          <p className="mt-4 flex items-center gap-1.5 text-xs text-gray-500">
            <span className="inline-block h-2 w-2 rounded-full bg-rose-500" /> below target
            <span className="mx-1">·</span>
            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" /> tight
            <span className="mx-1">·</span>
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> meeting target
            <span className="mx-2 text-gray-300">|</span>
            <span className="text-gray-400">dashed line = target ({coverageTarget})</span>
          </p>
        )}
      </div>

      {/* ── Average Hourly Coverage By Day (day × hour heatmap) ─────────── */}
      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-baseline justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Average Instructional Hour Coverage</h3>
            <p className="mt-0.5 text-xs text-gray-500">
              Hour-by-hour coverage over the last {COVERAGE_WEEKS} weeks vs your daily target of {coverageTarget} instructors.
              Only your centre's <b>instructional hours</b> are shown — set them under <b>Centre Settings → Hours</b>.
            </p>
          </div>
        </div>

        {!heatmapHasData ? (
          <p className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-4 py-8 text-center text-sm text-gray-400">
            No posted schedules in the look-back window yet — once you start posting, this fills in.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[640px]">
              {/* Column header — hours */}
              <div className="flex items-center gap-px pl-24">
                {heatmapHours.map(h => (
                  <div key={h} className="flex-1 py-1 text-center text-[10px] font-medium text-gray-400">
                    {hourLabel(h)}
                  </div>
                ))}
              </div>
              {/* Rows — one per operating day */}
              {operatingDaysList.map(day => {
                const dayOpen = opHoursMap[day];
                const dayStart = dayOpen ? parseInt(dayOpen.start.split(':')[0], 10) : 0;
                const dayEnd   = dayOpen ? parseInt(dayOpen.end.split(':')[0], 10) : 24;
                return (
                  <div key={day} className="mb-px flex items-center gap-px">
                    <div className="w-24 shrink-0 truncate pr-2 text-xs font-semibold text-gray-700">{day}</div>
                    {heatmapHours.map(h => {
                      const cell = heatmapCells[day]?.[h] || { avg: 0, samples: 0 };
                      const isOpen = h >= dayStart && h < dayEnd;
                      // Match the by-day chart's red / amber / green thresholds
                      // so both panels speak the same visual language.
                      let bgClass, textClass;
                      if (!isOpen) {
                        bgClass = 'bg-gray-200/60';
                        textClass = 'text-gray-400';
                      } else if (cell.samples === 0) {
                        bgClass = 'bg-gray-50';
                        textClass = 'text-gray-300';
                      } else if (cell.avg < coverageTarget * 0.85) {
                        bgClass = 'bg-rose-500';
                        textClass = 'text-white';
                      } else if (cell.avg < coverageTarget) {
                        bgClass = 'bg-amber-500';
                        textClass = 'text-white';
                      } else {
                        bgClass = 'bg-emerald-500';
                        textClass = 'text-white';
                      }
                      const label = !isOpen
                        ? '—'
                        : cell.samples === 0
                          ? '·'
                          : cell.avg.toFixed(1).replace(/\.0$/, '');
                      const tip = !isOpen
                        ? `${day} ${hourLabel(h)}–${hourLabel(h + 1)} · closed`
                        : cell.samples === 0
                          ? `${day} ${hourLabel(h)}–${hourLabel(h + 1)} · no data`
                          : `${day} ${hourLabel(h)}–${hourLabel(h + 1)} · ${cell.avg.toFixed(1)} avg over ${cell.samples} ${cell.samples === 1 ? 'day' : 'days'}`;
                      return (
                        <div
                          key={h}
                          title={tip}
                          className={`flex h-8 flex-1 items-center justify-center rounded-sm text-[10px] font-semibold transition-colors ${bgClass} ${textClass}`}
                        >
                          {label}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {/* Legend — same colour grammar as the by-day chart above. */}
              <div className="mt-3 flex flex-wrap items-center gap-3 pl-24 text-[10px] text-gray-500">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-3 w-3 rounded-sm bg-rose-500" /> below target
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-3 w-3 rounded-sm bg-amber-500" /> tight
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-3 w-3 rounded-sm bg-emerald-500" /> meeting target
                </span>
                <span className="text-gray-400">· grey = closed at that hour</span>
              </div>
            </div>
          </div>
        )}

        {/* Lowest-coverage hour buckets */}
        {coverageGaps.length > 0 && (
          <div className="mt-5 border-t border-gray-100 pt-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Lowest-coverage hour buckets
            </p>
            <div className="space-y-1.5">
              {coverageGaps.map((g, i) => (
                <div key={`${g.day}-${g.hour}`} className="flex items-center gap-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                  <span className="w-4 text-right text-xs font-bold text-gray-400">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-800">
                      {g.day} · {hourLabel(g.hour)}–{hourLabel(g.hour + 1)}
                    </p>
                    <p className="text-xs text-gray-500">
                      Avg <span className={`font-semibold ${g.avg < coverageTarget * 0.5 ? 'text-rose-600' : 'text-amber-700'}`}>{g.avg.toFixed(1)}</span> instructors over {g.samples} observed {g.samples === 1 ? 'day' : 'days'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-400">
              These are your thinnest hours — investigate whether they're real shortages (lots of students that hour) or natural slack (lunchtime, mid-morning weekdays).
            </p>
          </div>
        )}
      </div>
      </>)}

      {/* ── Hiring module: 4-month forecast + job posting tools ─────── */}
      {view === 'hiring' && (
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-bold text-gray-900">Hiring Forecast</h3>
          <p className="text-xs text-gray-500">
            Projected headcount over the next 4 months, based on each staff
            member's plan. {noPlanCount > 0 && (
              <span className="text-amber-700">
                {noPlanCount} {noPlanCount === 1 ? 'person hasn\'t' : 'people haven\'t'} filled in their plan yet.
              </span>
            )}
          </p>
        </div>

        {/* Risk banner */}
        {showRiskBanner && (
          <div className="rounded-xl border-2 border-amber-200 bg-amber-50 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-600" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-amber-900">
                  {totalDepart} {totalDepart === 1 ? 'departure' : 'departures'} expected in the next 4 months — projected headcount {projectedEnd}
                </p>
                <p className="mt-0.5 text-xs text-amber-800">
                  Tutoring hires typically take 4–6 weeks from listing to onboarded. Posting now gives you runway and avoids burning out the staff who stay.
                </p>
                <button
                  type="button"
                  onClick={() => setJobModalOpen(true)}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-700 transition-colors"
                >
                  <Briefcase size={14} /> Draft a job posting
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Projection bars */}
        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-baseline justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Projected headcount</p>
            <p className="text-xs text-gray-400">Starting from {currentHeadcount} today</p>
          </div>
          <div className="grid grid-cols-4 gap-3">
            {projection.map(m => {
              const isBelowFloor = m.projected < minStaffFloor;
              const heightPct = currentHeadcount > 0
                ? Math.max(8, (m.projected / currentHeadcount) * 100)
                : 8;
              const barColor = isBelowFloor
                ? 'bg-rose-500'
                : m.departures > 0
                  ? 'bg-amber-500'
                  : 'bg-emerald-500';
              return (
                <div key={m.key} className="flex flex-col items-center">
                  <p className="mb-1 text-xs font-medium text-gray-500">{m.label}</p>
                  <div className="flex h-24 w-full items-end overflow-hidden rounded-lg bg-gray-100">
                    <div className={`w-full rounded-lg transition-all ${barColor}`} style={{ height: `${heightPct}%` }} />
                  </div>
                  <p className="mt-1 text-lg font-bold text-gray-900">{m.projected}</p>
                  <p className="text-xs text-gray-500">
                    {m.departures > 0 ? <span className="text-rose-600 font-semibold">−{m.departures}</span> : '—'}
                  </p>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-xs text-gray-400">
            Floor of ~{minStaffFloor} staff (your auto-scheduler's min/day × 2). Red months are below the floor.
            {unsureStaff.length > 0 && ` ${unsureStaff.length} staff marked "unsure" — not deducted, but worth a check-in.`}
          </p>
        </div>

        {/* Staff to plan for */}
        {(leavers.length > 0 || unsureStaff.length > 0) && (
          <div className="rounded-2xl border bg-white p-5 shadow-sm">
            <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-gray-500">Staff to plan for</p>
            <div className="space-y-2.5">
              {leavers.map(l => (
                <div key={`l-${l.name}`} className="flex items-start gap-3 rounded-lg border border-rose-100 bg-rose-50/40 p-3">
                  <span className="shrink-0 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-bold text-rose-700">Leaving</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900">{l.name}</p>
                    <p className="text-xs text-gray-600">
                      {l.role} · expected last month <strong>{formatPlanMonthLabel(l.monthKey)}</strong>
                      {l.reason && ` · ${REASON_LABELS[l.reason] || l.reason}`}
                    </p>
                    {l.reasonNotes && <p className="mt-1 text-xs italic text-gray-500">"{l.reasonNotes}"</p>}
                    {l.aspirations && (
                      <p className="mt-1 text-xs text-purple-700">
                        <span className="font-semibold">Goals:</span> {l.aspirations}
                      </p>
                    )}
                  </div>
                </div>
              ))}
              {unsureStaff.map(u => (
                <div key={`u-${u.name}`} className="flex items-start gap-3 rounded-lg border border-amber-100 bg-amber-50/40 p-3">
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">Unsure</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900">{u.name}</p>
                    <p className="text-xs text-gray-600">{u.role}</p>
                    {u.aspirations && (
                      <p className="mt-1 text-xs text-purple-700">
                        <span className="font-semibold">Goals:</span> {u.aspirations}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {leavers.length === 0 && (
              <button
                type="button"
                onClick={() => setJobModalOpen(true)}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                <Briefcase size={13} /> Draft a job posting anyway
              </button>
            )}
          </div>
        )}

        {/* No-risk state: still let owners draft a posting on demand */}
        {leavers.length === 0 && unsureStaff.length === 0 && (
          <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-5">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-gray-700">
              <CheckCircle size={13} className="text-emerald-500" /> No planned departures right now
            </p>
            <p className="text-xs text-gray-500">
              {noPlanCount > 0
                ? `${noPlanCount} ${noPlanCount === 1 ? 'person hasn\'t' : 'people haven\'t'} filled in their 4-month plan yet — projection assumes they're staying.`
                : 'Every active staff member has confirmed they\'re staying. Still want to grow? Draft a listing below.'}
            </p>
            <button
              type="button"
              onClick={() => setJobModalOpen(true)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <Briefcase size={13} /> Draft a job posting
            </button>
          </div>
        )}

        {/* Aspirations roundup (only shown if someone shared) */}
        {aspirationsList.length > 0 && (
          <div className="rounded-2xl border bg-white p-5 shadow-sm">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Team aspirations</p>
            <p className="mb-3 text-xs text-gray-400">School, programs, dream jobs — useful for mentoring and timing transitions.</p>
            <div className="space-y-2">
              {aspirationsList.map(a => (
                <div key={a.name} className="rounded-lg bg-gray-50 px-3 py-2">
                  <p className="text-xs font-semibold text-gray-800">
                    {a.name}
                    {a.staying === 'no' && <span className="ml-2 rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-700">Leaving</span>}
                    {a.staying === 'unsure' && <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">Unsure</span>}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-600">{a.aspirations}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      )}

      {/* Job posting template modal — only relevant to the hiring view,
          but we leave it mounted at any view since opening state lives
          higher up. Safe: it just renders nothing while jobModalOpen is
          false. */}
      {jobModalOpen && (
        <JobPostingModal
          centerConfig={centerConfig}
          defaultRole={leavers[0]?.role}
          defaultStartMonth={leavers[0]?.monthKey || nextMonths[0]?.key}
          onClose={() => setJobModalOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Sub-component: Job-posting template modal ───────────────────────────

function JobPostingModal({ centerConfig, defaultRole, defaultStartMonth, onClose }) {
  const [role, setRole]     = useState(SHIFT_ASSIGNMENTS.includes(defaultRole) ? defaultRole : 'Elementary Instructor');
  const [startMonth, setStartMonth] = useState(defaultStartMonth || '');
  const [hoursRange, setHoursRange] = useState('10–15');
  const [contactEmail, setContactEmail] = useState('');
  const [copied, setCopied] = useState(false);

  const monthOptions = [];
  const dd = new Date(); dd.setDate(1);
  for (let i = 0; i < 9; i++) {
    const key = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}`;
    monthOptions.push({ key, label: dd.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) });
    dd.setMonth(dd.getMonth() + 1);
  }
  const startLabel = (() => {
    if (!startMonth) return 'soon';
    const [y, m] = startMonth.split('-');
    return new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  })();

  const centerName = centerConfig?.name || 'Mathnasium';
  const locationLine = [centerConfig?.city, centerConfig?.province].filter(Boolean).join(', ');

  const template = `${centerName} is hiring a ${role}!

About us
${centerName}${locationLine ? ` (${locationLine})` : ''} helps K–12 students build math confidence and skill. We're a small, close-knit team that plans staffing 4 months ahead so nobody gets overworked.

The role
• Position: ${role}
• Start: ${startLabel}
• Hours: ~${hoursRange} hours/week
• Location: In-centre${role === 'Online Instructor' ? '' : ' (online sessions also available)'}

What we're looking for
• Strong math skills — comfortable up through Algebra II${role.includes('Highschool') ? ' / Pre-Calc' : ''}
• Patience and clarity with students of all ages
• Reliable, on-time, takes ownership
• Bonus: previous tutoring or coaching experience

What you'll get
• Flexible schedule built around your school/work commitments
• Real mentorship and career coaching — we want you to grow
• A team that has your back

How to apply
Send a resume and a short note about why this role suits you to ${contactEmail || '[your email]'}.

#hiring #tutoring #mathjobs`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(template);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: do nothing; user can select+copy manually.
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-2xl max-h-[90vh] flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 bg-gradient-to-r from-amber-50 to-white px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-amber-100 p-2 text-amber-600"><Briefcase size={18} /></div>
            <div>
              <h3 className="text-base font-bold text-gray-900">Draft a job posting</h3>
              <p className="mt-0.5 text-xs text-gray-500">Fill in the role and dates — we'll generate a posting you can drop straight into Indeed, Handshake, or social.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100">
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <div className="overflow-y-auto px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-gray-500">Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-amber-500 focus:outline-none">
                {SHIFT_ASSIGNMENTS.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-gray-500">Start month</label>
              <select value={startMonth} onChange={(e) => setStartMonth(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-amber-500 focus:outline-none">
                <option value="">— Pick a month —</option>
                {monthOptions.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-gray-500">Hours / week</label>
              <input value={hoursRange} onChange={(e) => setHoursRange(e.target.value)}
                placeholder="10–15"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-gray-500">Contact email</label>
              <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none" />
            </div>
          </div>

          {/* Preview */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-bold uppercase tracking-wide text-gray-500">Posting preview</label>
              <button type="button" onClick={handleCopy}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50">
                {copied ? <><CheckCircle size={12} className="text-emerald-600" /> Copied</> : <><Copy size={12} /> Copy</>}
              </button>
            </div>
            <textarea
              readOnly
              value={template}
              rows={14}
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs font-mono text-gray-800 focus:outline-none"
              onFocus={(e) => e.target.select()}
            />
            <p className="mt-1 text-xs text-gray-400">Edit the fields above and the preview regenerates.</p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3">
          <button type="button" onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100">Close</button>
          <button type="button" onClick={handleCopy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-700">
            {copied ? <><CheckCircle size={14} /> Copied!</> : <><Copy size={14} /> Copy posting</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Scroll-to-top button ───────────────────────────────────────────────
// Floating ↑ button anchored bottom-right. Appears only after the user
// has scrolled past ~400px so it doesn't clutter the top of the page.
// Click → smooth-scrolls back to the top of the scrollable container
// (the <main> in Layout.jsx — fall back to document scrolling if that
// element isn't found, e.g. when the page is opened standalone).
function ScrollTopButton() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    // The page lives inside Layout's <main className="overflow-y-auto">,
    // so window.scrollY won't catch its scroll. Walk up from any element
    // we can find to locate the actual scrolling container.
    const scrollEl = document.querySelector('main') || document.scrollingElement || document.documentElement;
    const onScroll = () => setShow((scrollEl.scrollTop || window.scrollY) > 400);
    scrollEl.addEventListener('scroll', onScroll);
    window.addEventListener('scroll', onScroll);
    onScroll();
    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);
  const handleClick = () => {
    const scrollEl = document.querySelector('main') || document.scrollingElement || document.documentElement;
    try { scrollEl.scrollTo({ top: 0, behavior: 'smooth' }); }
    catch { scrollEl.scrollTop = 0; }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  if (!show) return null;
  return (
    <button
      onClick={handleClick}
      aria-label="Scroll to top"
      title="Back to top"
      className="fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-gray-900 text-white shadow-lg hover:bg-gray-700 transition-colors print:hidden"
    >
      <ArrowUp size={18} />
    </button>
  );
}
