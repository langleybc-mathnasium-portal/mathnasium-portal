/**
 * scheduler.js
 * JavaScript port of the Python scheduling engine (scheduler.py + sheets_reader.py logic).
 * Reads availability from Firestore instead of Google Sheets.
 *
 * Usage:
 *   import { generateSchedule } from './scheduler';
 *   const result = generateSchedule({ instructors, availability, month, year, config, staffConfig });
 */

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MONTH_NAME_TO_NUMBER = {
  january: 1, february: 2, march: 3, april: 4,
  may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
};

const ROLE_DISPLAY_ORDER = {
  'Center Director': 0,
  'Dir. of Education': 1,
  'Manager': 2,
  'Lead': 3,
  'Host': 4,
  'Admin': 5,
  'Instructor': 6,
};

// ─── Date helpers ────────────────────────────────────────────────────────────

function getWeekOfMonth(date) {
  return Math.floor((date.getDate() - 1) / 7) + 1;
}

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function getDaysInMonth(year, monthNumber) {
  // monthNumber is 1-based
  const days = [];
  const date = new Date(year, monthNumber - 1, 1);
  while (date.getMonth() === monthNumber - 1) {
    const dayOfWeek = date.getDay(); // 0=Sun,1=Mon,...,6=Sat
    // Convert JS day (Sun=0) to Python weekday (Mon=0)
    const pythonWeekday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    days.push({
      date: new Date(date),
      dateStr: date.toISOString().split('T')[0],
      dayNumber: date.getDate(),
      dayName: DAY_NAMES[pythonWeekday] || null,
      pythonWeekday,
      weekOfMonth: getWeekOfMonth(date),
      isoWeek: getISOWeek(date),
    });
    date.setDate(date.getDate() + 1);
  }
  // Filter to working days: Mon(0) - Sat(5)
  return days.filter(d => d.pythonWeekday >= 0 && d.pythonWeekday <= 5);
}

// ─── Availability resolver ────────────────────────────────────────────────────

/**
 * Firestore availability docs look like:
 * {
 *   userId, userName,
 *   date: 'yyyy-MM-dd',         // specific date OR null for week-based
 *   week: 'All Weeks' | 'Week 1' ... 'Week 5',
 *   startTime: '15:00',
 *   endTime: '20:00',
 *   month: 'March',
 *   year: 2026,
 * }
 *
 * We need to resolve: for a given (userId, dayName, weekOfMonth), is the person available?
 *
 * Strategy:
 *   - If availability.date matches the specific date → use that
 *   - Else if availability.week matches → use that
 *   - Else if availability.week === 'All Weeks' → use that
 */
function resolveAvailability(availabilityRecords, userId, dateStr, dayName, weekOfMonth) {
  const userRecords = availabilityRecords.filter(a => a.userId === userId);

  // 1. Exact date match (highest priority)
  const dateMatch = userRecords.find(a => a.date === dateStr);
  if (dateMatch) {
    return { available: true, startTime: dateMatch.startTime, endTime: dateMatch.endTime };
  }

  // 2. Week-specific match
  const weekLabel = `Week ${weekOfMonth}`;
  const weekMatch = userRecords.find(a => a.week === weekLabel);
  if (weekMatch) {
    // Check if this record covers this day
    if (weekMatch.dayName && weekMatch.dayName !== dayName) return { available: false };
    return { available: true, startTime: weekMatch.startTime, endTime: weekMatch.endTime };
  }

  // 3. "All Weeks" fallback — find a record for this day name
  const allWeeksForDay = userRecords.filter(
    a => (a.week === 'All Weeks' || !a.week) && (!a.dayName || a.dayName === dayName)
  );
  if (allWeeksForDay.length > 0) {
    const rec = allWeeksForDay[0];
    return { available: true, startTime: rec.startTime, endTime: rec.endTime };
  }

  return { available: false };
}

// ─── Fixed-schedule staff helpers ────────────────────────────────────────────

const FIXED_SCHEDULES = {
  'Jasper Wu': {
    role: 'Center Director',
    Monday: '11:00 AM - 7:00 PM', Tuesday: '11:00 AM - 7:00 PM',
    Wednesday: '11:00 AM - 7:00 PM', Thursday: '11:00 AM - 7:00 PM',
    Friday: '11:00 AM - 7:00 PM', Saturday: 'Off',
  },
  'Neeru Gill': {
    role: 'Dir. of Education',
    Monday: '11:00 AM - 7:00 PM', Tuesday: '11:00 AM - 7:00 PM',
    Wednesday: '11:00 AM - 7:00 PM', Thursday: '11:00 AM - 7:00 PM',
    Friday: '11:00 AM - 7:00 PM', Saturday: '9:30 AM - 3:00 PM',
  },
  'Sabrina Kedzior': {
    role: 'Manager',
    Monday: '11:00 AM - 7:00 PM', Tuesday: '11:00 AM - 7:00 PM',
    Wednesday: '11:00 AM - 7:00 PM', Thursday: '11:00 AM - 7:00 PM',
    Friday: '11:00 AM - 7:00 PM', Saturday: 'Off',
  },
  'Vinod Bandla': {
    role: 'Manager',
    Monday: '11:00 AM - 7:00 PM', Tuesday: '11:00 AM - 7:00 PM',
    Wednesday: '11:00 AM - 7:00 PM', Thursday: '11:00 AM - 7:00 PM',
    Friday: '11:00 AM - 7:00 PM', Saturday: 'Off',
  },
  'Dev Prasad': {
    role: 'Lead',
    Monday: '2:00 PM - 7:00 PM', Tuesday: 'Off',
    Wednesday: '3:00 PM - 7:00 PM', Thursday: 'Off',
    Friday: '2:00 PM - 7:00 PM', Saturday: '9:30 AM - 3:00 PM',
  },
  'Bri MacDonald': {
    role: 'Lead',
    Monday: 'Off', Tuesday: '11:00 AM - 7:00 PM',
    Wednesday: 'Off', Thursday: 'Off',
    Friday: '2:00 PM - 7:00 PM', Saturday: '9:30 AM - 3:00 PM',
    saturday_weeks: [1, 3, 5],
  },
  'Rahul Parmar': {
    role: 'Host',
    Monday: 'Off', Tuesday: 'Off',
    Wednesday: 'Off', Thursday: 'Off',
    Friday: 'Off', Saturday: 'Off',
  },
  'Rachel Rozelle': {
    role: 'Admin',
    Monday: 'Off', Tuesday: 'Off',
    Wednesday: 'Off', Thursday: 'Off',
    Friday: 'Off', Saturday: 'Off',
  },
};

const ROLE_ASSIGNMENTS = {};

const STAFFING_COUNT_ROLES = new Set(['Instructor', 'Lead']);

function getFixedStaffForDay(dayName, weekOfMonth) {
  const result = [];
  for (const [name, sched] of Object.entries(FIXED_SCHEDULES)) {
    const shift = sched[dayName];
    if (!shift || shift.toLowerCase() === 'off') continue;
    if (dayName === 'Saturday' && sched.saturday_weeks) {
      if (!sched.saturday_weeks.includes(weekOfMonth)) continue;
    }
    result.push({ name, role: sched.role, shift });
  }
  result.sort((a, b) => (ROLE_DISPLAY_ORDER[a.role] ?? 99) - (ROLE_DISPLAY_ORDER[b.role] ?? 99));
  return result;
}

// ─── Main scheduling engine ───────────────────────────────────────────────────

/**
 * generateSchedule
 *
 * @param {Object} params
 * @param {Array}  params.instructors   - Array of user profile objects from Firestore users collection
 *                                        Each: { uid, displayName, role, instructorType, priority, maxHoursPerWeek, ... }
 * @param {Array}  params.availability  - Array of availability docs from Firestore availability collection
 *                                        Each: { userId, date, dayName, startTime, endTime, week, month, year }
 * @param {string} params.month         - e.g. 'March'
 * @param {number} params.year          - e.g. 2026
 * @param {Object} params.config        - Scheduling config
 *                                        { minPerDay, maxPerDay, maxDaysPerWeek, fairDistribution }
 * @returns {Object} schedule
 */
export function generateSchedule({ instructors, availability, month, year, config = {} }) {
  const {
    minPerDay = 8,
    maxPerDay = 11,
    maxDaysPerWeek = 5,
    fairDistribution = true,
  } = config;

  const monthNumber = MONTH_NAME_TO_NUMBER[month.toLowerCase()];
  if (!monthNumber) throw new Error(`Invalid month: ${month}`);

  const workingDays = getDaysInMonth(year, monthNumber);
  const fixedStaffNames = new Set(Object.keys(FIXED_SCHEDULES));

  // Build instructor map (only approved, non-owner, non-fixed instructors)
  const formInstructors = instructors.filter(
    u => u.approved && u.role !== 'owner' && !fixedStaffNames.has(u.displayName)
  );

  // Priority map: from profile field (1=highest, 2=medium, 3=lowest). Default 2.
  const getPriority = (instructor) => instructor.priority ?? 2;

  // Role for each form instructor
  const getRole = (instructor) => {
    if (ROLE_ASSIGNMENTS[instructor.displayName]) return ROLE_ASSIGNMENTS[instructor.displayName];
    return instructor.instructorType || 'Instructor';
  };

  // Tracking
  const totalAssignments = {};
  const weeklyAssignments = {}; // uid -> { isoWeek -> count }

  for (const inst of formInstructors) {
    totalAssignments[inst.uid] = 0;
    weeklyAssignments[inst.uid] = {};
  }

  const scheduleDays = [];
  const warnings = [];

  for (const day of workingDays) {
    const { dateStr, dayName, dayNumber, weekOfMonth, isoWeek } = day;

    // 1. Fixed staff
    const fixedToday = getFixedStaffForDay(dayName, weekOfMonth);
    const assignedNames = [];
    const shiftTimes = {};
    const roles = {};

    let fixedCountingCount = 0;
    for (const { name, role, shift } of fixedToday) {
      assignedNames.push(name);
      shiftTimes[name] = shift;
      roles[name] = role;
      if (STAFFING_COUNT_ROLES.has(role)) fixedCountingCount++;
    }

    // 2. Find available form instructors for this day
    const availableForm = [];
    for (const inst of formInstructors) {
      const avail = resolveAvailability(availability, inst.uid, dateStr, dayName, weekOfMonth);
      if (avail.available) {
        availableForm.push({
          inst,
          startTime: avail.startTime,
          endTime: avail.endTime,
          shiftStr: avail.startTime && avail.endTime ? `${avail.startTime} - ${avail.endTime}` : '',
        });
      }
    }

    // 3. Separate counting vs non-counting
    const formCounting = availableForm.filter(a => STAFFING_COUNT_ROLES.has(getRole(a.inst)));
    const formNonCounting = availableForm.filter(a => !STAFFING_COUNT_ROLES.has(getRole(a.inst)));

    // 4. Auto-assign non-counting (Host, Admin)
    for (const { inst, shiftStr } of formNonCounting) {
      const role = getRole(inst);
      assignedNames.push(inst.displayName);
      roles[inst.displayName] = role;
      if (shiftStr) shiftTimes[inst.displayName] = shiftStr;
      totalAssignments[inst.uid] = (totalAssignments[inst.uid] || 0) + 1;
      if (!weeklyAssignments[inst.uid]) weeklyAssignments[inst.uid] = {};
      weeklyAssignments[inst.uid][isoWeek] = (weeklyAssignments[inst.uid][isoWeek] || 0) + 1;
    }

    // 5. Assign counting instructors up to max, respecting priority + fairness
    let eligible = formCounting.filter(({ inst }) => {
      const weekCount = (weeklyAssignments[inst.uid] || {})[isoWeek] || 0;
      return weekCount < maxDaysPerWeek;
    });

    if (eligible.length === 0 && formCounting.length > 0) {
      warnings.push(
        `WARNING: All available instructors on ${dayName}, ${month} ${dayNumber} have reached their weekly max. Assigning anyway.`
      );
      eligible = [...formCounting];
    }

    if (fairDistribution) {
      eligible.sort((a, b) => {
        const pa = getPriority(a.inst), pb = getPriority(b.inst);
        if (pa !== pb) return pa - pb;
        return (totalAssignments[a.inst.uid] || 0) - (totalAssignments[b.inst.uid] || 0);
      });
    } else {
      eligible.sort((a, b) => getPriority(a.inst) - getPriority(b.inst));
    }

    const remainingSlots = Math.max(0, maxPerDay - fixedCountingCount);
    const needed = Math.max(0, minPerDay - fixedCountingCount);
    let numToAssign = Math.min(remainingSlots, eligible.length);
    numToAssign = Math.max(numToAssign, Math.min(needed, eligible.length));

    const assignedInstructors = eligible.slice(0, numToAssign);

    for (const { inst, shiftStr } of assignedInstructors) {
      assignedNames.push(inst.displayName);
      roles[inst.displayName] = getRole(inst);
      if (shiftStr) shiftTimes[inst.displayName] = shiftStr;
      totalAssignments[inst.uid] = (totalAssignments[inst.uid] || 0) + 1;
      if (!weeklyAssignments[inst.uid]) weeklyAssignments[inst.uid] = {};
      weeklyAssignments[inst.uid][isoWeek] = (weeklyAssignments[inst.uid][isoWeek] || 0) + 1;
    }

    const countingTotal = fixedCountingCount + assignedInstructors.length;

    // 6. Warnings
    if (availableForm.length === 0 && fixedToday.length === 0) {
      warnings.push(`WARNING: No staff available on ${dayName}, ${month} ${dayNumber}`);
    } else if (countingTotal < minPerDay) {
      warnings.push(
        `WARNING: Only ${countingTotal} instructor(s)/lead(s) on ${dayName}, ${month} ${dayNumber} (min ${minPerDay}). LOW STAFF.`
      );
    }

    scheduleDays.push({
      date: dateStr,
      dayOfWeek: dayName,
      dayNumber,
      assignedEmployees: assignedNames,
      availableEmployees: availableForm.map(a => a.inst.displayName),
      shiftTimes,
      roles,
      countingStaffCount: countingTotal,
    });
  }

  // Build employee summary
  const employeeSummary = {};
  for (const inst of formInstructors) {
    employeeSummary[inst.displayName] = totalAssignments[inst.uid] || 0;
  }
  for (const name of Object.keys(FIXED_SCHEDULES)) {
    const count = scheduleDays.reduce(
      (sum, d) => sum + (d.assignedEmployees.includes(name) ? 1 : 0), 0
    );
    employeeSummary[name] = count;
  }

  return {
    month,
    year,
    days: scheduleDays,
    employeeSummary,
    warnings,
    status: 'draft',
  };
}

export { FIXED_SCHEDULES, ROLE_ASSIGNMENTS, STAFFING_COUNT_ROLES, ROLE_DISPLAY_ORDER };
