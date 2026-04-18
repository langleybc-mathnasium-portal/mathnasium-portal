import { useState, useEffect, useMemo } from 'react';
import {
  collection, onSnapshot, doc, updateDoc, deleteDoc,
  addDoc, query, orderBy, writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  Settings, UserCheck, UserX, Trash2, Clock, Tag,
  ChevronLeft, ChevronRight, Table, Wand2, CheckCircle,
  AlertTriangle, Send, RotateCcw, User, Edit3, ArrowRightLeft, Plus, X,
} from 'lucide-react';
import {
  format, startOfWeek, endOfWeek, addWeeks, subWeeks, addDays, isSameDay,
  addMonths, subMonths,
} from 'date-fns';
import { generateSchedule, FIXED_SCHEDULES } from '../lib/scheduler';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const ROLE_OPTIONS = [
  'Instructor', 'Lead', 'Host', 'Admin',
  'Manager', 'Center Director', 'Dir. of Education',
];

const ROLE_COLORS = {
  'Instructor':        { bg: '#16a34a', text: '#fff' },  // green
  'Lead':              { bg: '#ea580c', text: '#fff' },  // orange
  'Host':              { bg: '#2563eb', text: '#fff' },  // blue
  'Admin':             { bg: '#dc2626', text: '#fff' },  // red
  'Manager':           { bg: '#ca8a04', text: '#fff' },  // yellow
  'Dir. of Education': { bg: '#db2777', text: '#fff' },  // pink
  'Center Director':   { bg: '#92400e', text: '#fff' },  // brown
  'Tutor':             { bg: '#7c3aed', text: '#fff' },  // purple fallback
  'default':           { bg: '#16a34a', text: '#fff' },
};

// Parse "3:00 PM - 7:00 PM" or "11:30 AM - 7:30 PM" into decimal hours
function parseFixedShiftHours(shiftStr) {
  if (!shiftStr || shiftStr.toLowerCase() === 'off') return 0;
  const parts = shiftStr.split(' - ');
  if (parts.length !== 2) return 0;
  const parseTime = (s) => {
    const m = s.trim().match(/^(\d+):(\d+)\s*(AM|PM)$/i);
    if (!m) return 0;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ampm = m[3].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return h + min / 60;
  };
  const diff = parseTime(parts[1]) - parseTime(parts[0]);
  return diff > 0 ? diff : 0;
}

// Get total hours from fixed staff on a given day name + week of month
function fixedStaffHoursForDay(dayName, weekOfMonth) {
  let total = 0;
  for (const [, sched] of Object.entries(FIXED_SCHEDULES)) {
    const shift = sched[dayName];
    if (!shift || shift.toLowerCase() === 'off') continue;
    if (dayName === 'Saturday' && sched.saturday_weeks) {
      if (!sched.saturday_weeks.includes(weekOfMonth)) continue;
    }
    total += parseFixedShiftHours(shift);
  }
  return total;
}

function roleColor(role) {
  return ROLE_COLORS[role] || ROLE_COLORS['default'];
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

function shiftHours(s) {
  if (!s.startTime || !s.endTime) return 0;
  const [sh, sm] = s.startTime.split(':').map(Number);
  const [eh, em] = s.endTime.split(':').map(Number);
  const result = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
  return isNaN(result) || result < 0 ? 0 : result;
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

// ── Add Shift Modal ────────────────────────────────────────────────────────────
function AddShiftModal({ date, user, users, availability, onClose, onSave }) {
  const [selectedUser, setSelectedUser] = useState(user?.uid || '');
  const [startTime, setStartTime] = useState('15:00');
  const [endTime, setEndTime] = useState('20:00');
  const [role, setRole] = useState(user?.instructorType || '');

  const selectedProfile = users.find(u => u.uid === selectedUser);
  const avail = availability.filter(a => a.userId === selectedUser && a.date === date);

  const handleSubmit = async () => {
    if (!selectedUser || !date) return;
    const profile = users.find(u => u.uid === selectedUser);
    await onSave({
      userId: profile.uid,
      userName: profile.displayName,
      date,
      startTime,
      endTime,
      role,
      status: 'live',
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
              onChange={e => setSelectedUser(e.target.value)}
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
            <div className="w-7 h-7 rounded-full bg-red-100 flex items-center justify-center text-xs font-bold text-red-700">
              {user.displayName?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2)}
            </div>
            <span className="text-sm font-medium text-gray-800">{user.displayName}</span>
            {user.instructorType && <span className="text-xs text-gray-400">· {user.instructorType}</span>}
          </div>
        )}

        {/* Availability hint */}
        {selectedUser && (
          <div className={`rounded-lg px-3 py-2 text-xs ${avail.length > 0 ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
            {avail.length > 0
              ? <>✓ Available: {avail.map(a => `${a.startTime}–${a.endTime}`).join(', ')}</>
              : '⚠ No availability submitted for this date'}
          </div>
        )}

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

        <div>
          <label className="block text-xs text-gray-500 mb-1">Role</label>
          <select
            value={role}
            onChange={e => setRole(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
          >
            <option value="">No role</option>
            {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

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
function EditShiftModal({ shift, onClose, onSave, onDelete }) {
  const [startTime, setStartTime] = useState(shift.startTime || '15:00');
  const [endTime, setEndTime] = useState(shift.endTime || '20:00');
  const [role, setRole] = useState(shift.role || '');

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
        <div>
          <label className="block text-xs text-gray-500 mb-1">Role</label>
          <select value={role} onChange={e => setRole(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none">
            <option value="">No role</option>
            {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={() => onSave({ startTime, endTime, role })}
            className="flex-1 rounded-lg bg-red-600 py-2 text-sm font-medium text-white hover:bg-red-700">
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

// ── Add Open Shift Modal ───────────────────────────────────────────────────────
function AddOpenShiftModal({ date, onClose, onSave }) {
  const [startTime, setStartTime] = useState('15:00');
  const [endTime, setEndTime] = useState('20:00');
  const [role, setRole] = useState('');

  const handleSubmit = async () => {
    await onSave({ date, startTime, endTime, role });
    onClose();
  };

  return (
    <Modal
      title={`Add Open Shift — ${new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`}
      onClose={onClose}
    >
      <div className="space-y-3">
        <p className="text-xs text-gray-500">An open shift can be claimed by any available instructor.</p>
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
        <div>
          <label className="block text-xs text-gray-500 mb-1">Role / Tag (optional)</label>
          <select value={role} onChange={e => setRole(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none">
            <option value="">Any role</option>
            {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <button onClick={handleSubmit}
          className="w-full rounded-lg bg-orange-500 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 transition-colors mt-1">
          Post Open Shift
        </button>
      </div>
    </Modal>
  );
}

// ── Main Admin Component ───────────────────────────────────────────────────────
export default function Admin() {
  const { profile } = useAuth();
  const [users, setUsers]               = useState([]);
  const [availability, setAvailability] = useState([]);
  const [shifts, setShifts]             = useState([]);
  const [openShiftsList, setOpenShiftsList] = useState([]);
  const [tab, setTab]                   = useState('spreadsheet');

  // Spreadsheet state
  const [weekStart, setWeekStart]       = useState(startOfWeek(new Date()));

  // Modals
  const [addShiftModal, setAddShiftModal]       = useState(null); // { date, user }
  const [editShiftModal, setEditShiftModal]     = useState(null); // shift object
  const [addOpenShiftModal, setAddOpenShiftModal] = useState(null); // { date }

  // Auto-scheduler state
  const [schedMonth, setSchedMonth]   = useState(MONTHS[new Date().getMonth()]);
  const [schedYear, setSchedYear]     = useState(new Date().getFullYear());
  const [draftSchedule, setDraftSchedule] = useState(null);
  const [generating, setGenerating]   = useState(false);
  const [posting, setPosting]         = useState(false);
  const [schedConfig, setSchedConfig] = useState({
    minPerDay: 8, maxPerDay: 11, maxDaysPerWeek: 5, fairDistribution: true,
  });
  const [editingDay, setEditingDay]   = useState(null);
  const [schedError, setSchedError]   = useState('');

  // Firestore subscriptions
  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'users'), snap =>
      setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    const u2 = onSnapshot(query(collection(db, 'availability'), orderBy('date')), snap =>
      setAvailability(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    const u3 = onSnapshot(query(collection(db, 'shifts'), orderBy('date')), snap =>
      setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    const u4 = onSnapshot(query(collection(db, 'openShifts'), orderBy('date')), snap =>
      setOpenShiftsList(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    return () => { u1(); u2(); u3(); u4(); };
  }, []);

  const approvedUsers = users.filter(u => u.approved && u.role !== 'owner');
  const pendingUsers  = users.filter(u => !u.approved);

  // User management
  const handleApprove = uid => updateDoc(doc(db, 'users', uid), { approved: true });
  const handleReject  = uid => deleteDoc(doc(db, 'users', uid));
  const handleUpdateUserField = (uid, field, value) =>
    updateDoc(doc(db, 'users', uid), { [field]: value });

  // Shift CRUD
  const handleAddShift = async (shiftData) => {
    await addDoc(collection(db, 'shifts'), shiftData);
  };

  const handleSaveEditShift = async ({ startTime, endTime, role }) => {
    await updateDoc(doc(db, 'shifts', editShiftModal.id), { startTime, endTime, role });
    setEditShiftModal(null);
  };

  const handleDeleteEditShift = async () => {
    await deleteDoc(doc(db, 'shifts', editShiftModal.id));
    setEditShiftModal(null);
  };

  // Open Shifts
  const handleAddOpenShift = async ({ date, startTime, endTime, role }) => {
    await addDoc(collection(db, 'openShifts'), {
      date, startTime, endTime, role,
      status: 'open', claimedBy: null, claimedByName: null,
      postedAt: new Date().toISOString(),
    });
  };

  const handleDeleteOpenShift = id => deleteDoc(doc(db, 'openShifts', id));

  // Calendar grid
  const weekDays = useMemo(() =>
    Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
  [weekStart]);

  const totalAssignedHours = useMemo(() => {
    const ws = format(weekStart, 'yyyy-MM-dd');
    const we = format(addDays(weekStart, 6), 'yyyy-MM-dd');
    return shifts
      .filter(s => s.date >= ws && s.date <= we && s.status !== 'draft')
      .reduce((sum, s) => sum + shiftHours(s), 0);
  }, [shifts, weekStart]);

  // Auto-scheduler
  const handleGenerate = async () => {
    setGenerating(true); setSchedError(''); setDraftSchedule(null);
    try {
      const result = generateSchedule({
        instructors: approvedUsers, availability,
        month: schedMonth, year: schedYear, config: schedConfig,
      });
      setDraftSchedule(result);
    } catch (err) {
      setSchedError(`Scheduler error: ${err.message}`);
    } finally {
      setGenerating(false);
    }
  };

  const handleEditDay = (i) => setEditingDay({ index: i, ...draftSchedule.days[i] });
  const handleSaveEditDay = () => {
    if (!editingDay) return;
    const newDays = [...draftSchedule.days];
    newDays[editingDay.index] = {
      date: editingDay.date, dayOfWeek: editingDay.dayOfWeek,
      dayNumber: editingDay.dayNumber,
      assignedEmployees: editingDay.assignedEmployees,
      availableEmployees: editingDay.availableEmployees,
      shiftTimes: editingDay.shiftTimes, roles: editingDay.roles,
      countingStaffCount: editingDay.assignedEmployees.filter(
        n => ['Instructor','Lead'].includes(editingDay.roles?.[n] || 'Instructor')
      ).length,
    };
    setDraftSchedule({ ...draftSchedule, days: newDays });
    setEditingDay(null);
  };

  const handleRemoveFromDay = name =>
    setEditingDay(p => ({ ...p, assignedEmployees: p.assignedEmployees.filter(n => n !== name) }));
  const handleAddToDay = name => {
    if (editingDay.assignedEmployees.includes(name)) return;
    setEditingDay(p => ({ ...p, assignedEmployees: [...p.assignedEmployees, name] }));
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

  // Write fixed staff shifts for a set of date strings to Firestore
  const seedFixedShiftsForDates = async (dates) => {
    const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const batch = writeBatch(db);
    for (const dateStr of dates) {
      const d = new Date(dateStr + 'T00:00:00');
      const jsDay = d.getDay();
      const pythonWeekday = jsDay === 0 ? 6 : jsDay - 1;
      const dayName = DAY_NAMES[pythonWeekday];
      if (!dayName) continue;
      const weekOfMonth = Math.floor((d.getDate() - 1) / 7) + 1;
      for (const [name, sched] of Object.entries(FIXED_SCHEDULES)) {
        const shiftStr = sched[dayName];
        if (!shiftStr || shiftStr.toLowerCase() === 'off') continue;
        if (dayName === 'Saturday' && sched.saturday_weeks) {
          if (!sched.saturday_weeks.includes(weekOfMonth)) continue;
        }
        const parts = shiftStr.split(' - ');
        if (parts.length !== 2) continue;
        const user = users.find(u => u.displayName?.trim().toLowerCase() === name.toLowerCase());
        const ref = doc(collection(db, 'shifts'));
        batch.set(ref, {
          userId: user?.uid || name,
          userName: name,
          date: dateStr,
          startTime: toHHMM(parts[0]),
          endTime: toHHMM(parts[1]),
          role: sched.role,
          status: 'live',
          autoScheduled: true,
          fixedStaff: true,
        });
      }
    }
    await batch.commit();
  };

  // Seed fixed staff shifts for the currently viewed week
  const handleSeedFixedStaffWeek = async () => {
    const dates = weekDays.map(d => format(d, 'yyyy-MM-dd'));
    await seedFixedShiftsForDates(dates);
    alert('✅ Fixed staff shifts added for this week.');
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
            date: day.date, startTime, endTime,
            role: day.roles?.[name] || 'Instructor', status: 'live', autoScheduled: true,
          });
        }
      }
      await batch.commit();

      const allDates = draftSchedule.days.map(d => d.date);
      await seedFixedShiftsForDates(allDates);

      const totalShifts = draftSchedule.days.reduce((s, d) => s + d.assignedEmployees.length, 0);

      await addDoc(collection(db, 'chat'), {
        text: `📅 The ${draftSchedule.month} ${draftSchedule.year} schedule has been posted!\n\n${totalShifts} shifts across ${draftSchedule.days.length} working days. Check your schedule on the Schedule page.`,
        userId: 'system', userName: 'Mathnasium Langley', userRole: 'system',
        createdAt: serverTimestamp(), type: 'schedule_posted',
      });

      const staffEmails = approvedUsers.filter(u => u.email).map(u => ({ email: u.email, displayName: u.displayName }));
      await notifySchedulePosted(draftSchedule, staffEmails);

      setDraftSchedule(null);
      alert(`✅ Schedule posted! ${totalShifts} instructor shifts + fixed staff created. Staff notified.`);
    } catch (err) {
      setSchedError(`Failed to post: ${err.message}`);
    } finally {
      setPosting(false);
    }
  };

  // Open shifts grouped by date for display
  const openShiftsByDate = useMemo(() => {
    const grouped = {};
    openShiftsList.forEach(s => {
      if (!grouped[s.date]) grouped[s.date] = [];
      grouped[s.date].push(s);
    });
    return grouped;
  }, [openShiftsList]);

  if (profile?.role !== 'owner') {
    return <div className="text-center text-gray-500 py-16">Access denied. Owner only.</div>;
  }

  const openCount = openShiftsList.filter(s => s.status === 'open').length;

  const tabs = [
    { key: 'spreadsheet',  label: 'Scheduler',      icon: Table },
    { key: 'users',        label: 'Manage Users',   icon: UserCheck },
    { key: 'scheduler',    label: 'Auto-Scheduler', icon: Wand2, badge: 'AI', badgeStyle: 'purple' },
  ];

  return (
    <div className="mx-auto max-w-7xl">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <div className="rounded-lg bg-purple-100 p-2 text-purple-600"><Settings size={22} /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Admin Panel</h1>
          <p className="text-sm text-gray-500">Manage instructors and shifts</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex gap-1 border-b overflow-x-auto">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors ${tab === t.key ? 'border-red-600 text-red-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            <t.icon size={16} /> {t.label}
            {t.badge && (
              <span className={`rounded-full px-1.5 py-0.5 text-xs ${t.badgeStyle === 'purple' ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700'}`}>
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── SPREADSHEET (Weekly Calendar Grid) ──────────────────────────────── */}
      {tab === 'spreadsheet' && (
        <div className="space-y-2">
          {/* Legend + tips */}
          <div className="flex flex-wrap items-center gap-4 px-1 mb-2 text-xs text-gray-500">
            <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full bg-orange-500" /> Open Shift</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full" style={{backgroundColor:'#16a34a'}} /> Instructor</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full" style={{backgroundColor:'#ea580c'}} /> Lead</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full" style={{backgroundColor:'#2563eb'}} /> Host</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full" style={{backgroundColor:'#dc2626'}} /> Admin</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full" style={{backgroundColor:'#ca8a04'}} /> Manager</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full" style={{backgroundColor:'#db2777'}} /> Dir. of Ed.</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full" style={{backgroundColor:'#92400e'}} /> Center Director</span>
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
              <span className="text-xs text-gray-500">
                Total assigned: <strong>{Math.round(totalAssignedHours * 10) / 10} hrs</strong>
              </span>
              <button onClick={handleSeedFixedStaffWeek}
                className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 transition-colors">
                <Plus size={12} /> Seed Fixed Staff
              </button>
            </div>

            {/* Grid */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse min-w-[900px]">
                <thead>
                  <tr className="bg-gray-50 border-b">
                    <th className="text-left px-4 py-2 font-semibold text-gray-600 w-36 border-r">INSTRUCTOR</th>
                    {weekDays.map(d => {
                      const isToday = isSameDay(d, new Date());
                      const ds = format(d, 'yyyy-MM-dd');
                      const dayName = format(d, 'EEEE'); // 'Monday', 'Tuesday' etc
                      const weekOfMonth = Math.floor((d.getDate() - 1) / 7) + 1;
                      const firestoreHrs = shifts
                        .filter(s => s.date === ds && s.status !== 'draft')
                        .reduce((sum, s) => sum + shiftHours(s), 0);
                      const fixedHrs = fixedStaffHoursForDay(dayName, weekOfMonth);
                      const dayTotalHrs = firestoreHrs + fixedHrs;
                      const dayHrsDisplay = isNaN(dayTotalHrs) ? 0 : Math.round(dayTotalHrs * 10) / 10;
                      return (
                        <th key={d.toISOString()} className={`text-center py-2 px-1 font-medium w-[13%] ${isToday ? 'bg-red-50 text-red-700' : 'text-gray-600'}`}>
                          <div className="text-xs uppercase tracking-wide">{format(d, 'EEE')}</div>
                          <div className={`text-base font-bold ${isToday ? 'text-red-600' : 'text-gray-800'}`}>{format(d, 'd')}</div>
                          {dayHrsDisplay > 0 && (
                            <div className={`text-xs font-semibold mt-0.5 ${isToday ? 'text-red-500' : 'text-purple-600'}`}>
                              {dayHrsDisplay}h
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
                    const totalHrs = weekDays.reduce((sum, d) => {
                      const ds = format(d, 'yyyy-MM-dd');
                      return sum + shifts.filter(s => s.userId === u.uid && s.date === ds && s.status !== 'draft')
                        .reduce((s2, sh) => s2 + shiftHours(sh), 0);
                    }, 0);
                    const displayHrs = isNaN(totalHrs) ? 0 : Math.round(totalHrs * 10) / 10;
                    const initials = u.displayName?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);
                    return (
                      <tr key={u.uid} className="border-b hover:bg-gray-50 transition-colors group">
                        <td className="px-4 py-2 border-r">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-red-100 flex items-center justify-center text-xs font-bold text-red-700 shrink-0">{initials}</div>
                            <div>
                              <div className="font-semibold text-gray-800 text-xs">{u.displayName}</div>
                              <div className="text-gray-400" style={{fontSize:'10px'}}>{displayHrs}h · {u.instructorType || 'Instructor'}</div>
                            </div>
                          </div>
                        </td>
                        {weekDays.map(d => {
                          const ds = format(d, 'yyyy-MM-dd');
                          const dayShifts = shifts.filter(s => s.userId === u.uid && s.date === ds);
                          // Check availability for visual indicator
                          const hasAvail = availability.some(a => a.userId === u.uid && a.date === ds);
                          return (
                            <td
                              key={ds}
                              className={`px-1 py-1 align-top relative ${hasAvail && dayShifts.length === 0 ? 'bg-green-50/40' : ''}`}
                            >
                              {/* Existing shifts */}
                              {dayShifts.map(s => {
                                const { bg, text } = roleColor(s.role);
                                const hrs = shiftHours(s);
                                const hrsDisplay = isNaN(hrs) || hrs <= 0 ? '' : `${Math.round(hrs * 10) / 10}h`;
                                return (
                                  <div key={s.id}
                                    onClick={() => setEditShiftModal(s)}
                                    className="rounded px-1.5 py-1 mb-0.5 cursor-pointer hover:opacity-80 transition-opacity"
                                    style={{ backgroundColor: bg, color: text }}>
                                    <div className="font-semibold" style={{fontSize:'11px'}}>{fmtHHMM(s.startTime)}–{fmtHHMM(s.endTime)}{hrsDisplay ? ` · ${hrsDisplay}` : ''}</div>
                                    {s.role && <div className="uppercase tracking-wide opacity-90" style={{fontSize:'10px'}}>{s.role}</div>}
                                  </div>
                                );
                              })}
                              {/* Add shift button — always visible on hover, or when no shift */}
                              <button
                                onClick={() => setAddShiftModal({ date: ds, user: u })}
                                className={`w-full rounded border border-dashed py-0.5 transition-colors flex items-center justify-center gap-0.5
                                  ${dayShifts.length === 0
                                    ? 'border-gray-200 text-gray-300 hover:border-red-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100'
                                    : 'border-gray-200 text-gray-300 hover:border-red-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100'
                                  }`}
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
                      const dayName = format(d, 'EEEE');
                      const weekOfMonth = Math.floor((d.getDate() - 1) / 7) + 1;
                      const dayShiftsAll = shifts.filter(s => s.date === ds && s.status !== 'draft');
                      const count = dayShiftsAll.length;
                      const firestoreHrs = dayShiftsAll.reduce((sum, s) => sum + shiftHours(s), 0);
                      const fixedHrs = fixedStaffHoursForDay(dayName, weekOfMonth);
                      const hrs = firestoreHrs + fixedHrs;
                      const hrsDisplay = isNaN(hrs) ? 0 : Math.round(hrs * 10) / 10;
                      return (
                        <td key={ds} className="text-center py-2 text-xs text-gray-500">
                          {count > 0 || fixedHrs > 0 ? (
                            <div>
                              <span className="font-semibold text-gray-700">{count} staff</span>
                              <div className="text-purple-600 font-semibold">{hrsDisplay}h total</div>
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
        <div className="space-y-6">
          {pendingUsers.length > 0 && (
            <div className="rounded-xl border bg-white p-5 shadow-sm">
              <h3 className="mb-4 font-semibold text-yellow-700">⏳ Pending Approval ({pendingUsers.length})</h3>
              <div className="space-y-3">
                {pendingUsers.map(u => (
                  <div key={u.id} className="flex items-center justify-between rounded-lg bg-yellow-50 px-4 py-3">
                    <div>
                      <p className="font-medium text-gray-900">{u.displayName}</p>
                      <p className="text-sm text-gray-500">{u.email}</p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => handleApprove(u.uid)}
                        className="flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700">
                        <UserCheck size={14} /> Approve
                      </button>
                      <button onClick={() => handleReject(u.id)}
                        className="flex items-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700">
                        <UserX size={14} /> Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl border bg-white p-5 shadow-sm">
            <h3 className="mb-4 font-semibold text-gray-900">Approved Instructors ({approvedUsers.length})</h3>
            {approvedUsers.length === 0 ? (
              <p className="text-sm text-gray-400">No approved instructors yet.</p>
            ) : (
              <div className="space-y-3">
                {approvedUsers.map(u => (
                  <div key={u.id} className="rounded-lg border bg-gray-50 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-red-100 text-sm font-bold text-red-700">
                          {u.displayName?.charAt(0)?.toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">{u.displayName}</p>
                          <p className="text-xs text-gray-500">{u.email}</p>
                        </div>
                      </div>
                      <button onClick={() => handleReject(u.id)} className="rounded p-1 text-gray-400 hover:text-red-500">
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="mb-1 block text-xs text-gray-500">Role / Type</label>
                        <select value={u.instructorType || 'Instructor'}
                          onChange={e => handleUpdateUserField(u.uid, 'instructorType', e.target.value)}
                          className="w-full rounded border px-2 py-1.5 text-xs focus:border-red-500 focus:outline-none">
                          {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-gray-500">Priority</label>
                        <select value={u.priority || 2}
                          onChange={e => handleUpdateUserField(u.uid, 'priority', Number(e.target.value))}
                          className="w-full rounded border px-2 py-1.5 text-xs focus:border-red-500 focus:outline-none">
                          <option value={1}>1 – High</option>
                          <option value={2}>2 – Medium</option>
                          <option value={3}>3 – Low</option>
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-gray-500">Max Days/Week</label>
                        <input type="number" min={1} max={6} value={u.maxDaysPerWeek || 5}
                          onChange={e => handleUpdateUserField(u.uid, 'maxDaysPerWeek', Number(e.target.value))}
                          className="w-full rounded border px-2 py-1.5 text-xs focus:border-red-500 focus:outline-none" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
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
              Reads instructor availability from Firestore and builds an optimized schedule respecting priorities, max days/week, and fair distribution.
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Month</label>
                <select value={schedMonth} onChange={e => setSchedMonth(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none">
                  {MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Year</label>
                <input type="number" value={schedYear} min={2025} max={2030}
                  onChange={e => setSchedYear(Number(e.target.value))}
                  className="w-full rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Min staff/day</label>
                <input type="number" value={schedConfig.minPerDay} min={1} max={20}
                  onChange={e => setSchedConfig(c => ({ ...c, minPerDay: Number(e.target.value) }))}
                  className="w-full rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Max staff/day</label>
                <input type="number" value={schedConfig.maxPerDay} min={1} max={30}
                  onChange={e => setSchedConfig(c => ({ ...c, maxPerDay: Number(e.target.value) }))}
                  className="w-full rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
              </div>
            </div>
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
                    <h3 className="font-bold text-gray-900 text-lg">Draft: {draftSchedule.month} {draftSchedule.year}</h3>
                    <p className="text-sm text-gray-500">Review and edit before posting. Instructors won't see this until you post.</p>
                  </div>
                  <button onClick={handlePostSchedule} disabled={posting}
                    className="flex items-center gap-2 rounded-lg bg-green-600 px-5 py-2.5 text-sm font-bold text-white shadow-md hover:bg-green-700 disabled:opacity-50 transition-colors">
                    <Send size={16} />
                    {posting ? 'Posting…' : 'Post Schedule'}
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

              <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
                <div className="border-b bg-gray-50 px-5 py-3">
                  <h4 className="font-semibold text-gray-900">Day-by-Day Schedule</h4>
                  <p className="text-xs text-gray-500">Click Edit on any day to adjust the roster</p>
                </div>
                <div className="divide-y">
                  {draftSchedule.days.map((day, i) => {
                    const isLow = day.countingStaffCount < schedConfig.minPerDay;
                    const isEditing = editingDay?.index === i;
                    return (
                      <div key={day.date} className={`p-4 ${isLow ? 'bg-red-50' : ''}`}>
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <span className={`text-sm font-bold ${isLow ? 'text-red-700' : 'text-gray-900'}`}>
                              {day.dayOfWeek}, {draftSchedule.month} {day.dayNumber}
                            </span>
                            {isLow && <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700">LOW STAFF</span>}
                            <span className="ml-2 text-xs text-gray-500">{day.countingStaffCount} instructors / {day.assignedEmployees.length} total</span>
                          </div>
                          {!isEditing && (
                            <button onClick={() => handleEditDay(i)}
                              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800">
                              <Edit3 size={12} /> Edit
                            </button>
                          )}
                        </div>
                        {isEditing ? (
                          <div className="mt-2 rounded-lg border bg-white p-3">
                            <p className="mb-2 text-xs font-semibold text-gray-700 uppercase tracking-wide">Editing roster</p>
                            <div className="flex flex-wrap gap-2 mb-3">
                              {editingDay.assignedEmployees.map(name => (
                                <span key={name} className="flex items-center gap-1 rounded-full bg-blue-100 px-3 py-1 text-xs text-blue-800">
                                  {name}
                                  <button onClick={() => handleRemoveFromDay(name)} className="text-blue-500 hover:text-red-500 ml-1">×</button>
                                </span>
                              ))}
                            </div>
                            <p className="mb-1 text-xs text-gray-500">Add from available:</p>
                            <div className="flex flex-wrap gap-1 mb-3">
                              {approvedUsers.filter(u => !editingDay.assignedEmployees.includes(u.displayName)).map(u => (
                                <button key={u.uid} onClick={() => handleAddToDay(u.displayName)}
                                  className="rounded-full border border-dashed border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:border-blue-400 hover:text-blue-700">
                                  + {u.displayName}
                                </button>
                              ))}
                            </div>
                            <div className="flex gap-2">
                              <button onClick={handleSaveEditDay} className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700">Save</button>
                              <button onClick={() => setEditingDay(null)} className="rounded border px-3 py-1 text-xs text-gray-500 hover:bg-gray-50">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {day.assignedEmployees.map(name => (
                              <span key={name} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${['Instructor','Lead'].includes(day.roles?.[name] || 'Instructor') ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-700'}`}>
                                <User size={10} /> {name}
                                {day.shiftTimes?.[name] && <span className="text-gray-500 ml-0.5">· {day.shiftTimes[name]}</span>}
                              </span>
                            ))}
                            {day.assignedEmployees.length === 0 && <span className="text-sm text-gray-400 italic">No staff assigned</span>}
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
                  {Object.entries(draftSchedule.employeeSummary).sort(([,a],[,b]) => b-a).map(([name, count]) => (
                    <div key={name} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
                      <span className="text-sm text-gray-800">{name}</span>
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${count > 0 ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-400'}`}>{count} shifts</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end pb-4">
                <button onClick={handlePostSchedule} disabled={posting}
                  className="flex items-center gap-2 rounded-lg bg-green-600 px-6 py-3 text-sm font-bold text-white shadow-lg hover:bg-green-700 disabled:opacity-50">
                  <CheckCircle size={18} />
                  {posting ? 'Posting…' : `Post Schedule for ${draftSchedule.month} ${draftSchedule.year}`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── MODALS ──────────────────────────────────────────────────────────── */}
      {addShiftModal && (
        <AddShiftModal
          date={addShiftModal.date}
          user={addShiftModal.user}
          users={approvedUsers}
          availability={availability}
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
        />
      )}

      {addOpenShiftModal && (
        <AddOpenShiftModal
          date={addOpenShiftModal.date}
          onClose={() => setAddOpenShiftModal(null)}
          onSave={handleAddOpenShift}
        />
      )}
    </div>
  );
}
