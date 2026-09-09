# Ratio — Mathnasium Instructor Portal

Multi-centre staff portal: scheduling, payroll, students, leads, inventory.
Live at **ratiosolved.com**. Primary centre id is `langley`.

## Stack

| Thing | What |
|---|---|
| Frontend | React 19 + Vite 8, React Router 7, Tailwind 4, `lucide-react` icons, `date-fns` |
| Backend | Firebase — Firestore + Auth. Project `mathnasium-langley` |
| Serverless | Vercel functions in `api/` |
| Email | Resend (`RESEND_API_KEY`, `RESEND_FROM`) |
| Payments | Stripe (`api/stripe/`) |
| AI assistant | Gemini (`GEMINI_API_KEY`, `api/assistant/`) |
| Bookings | Acuity iCal feeds, parsed server-side |
| Tests | Vitest |

## Deploy

**Push to `main` on GitHub → Vercel auto-deploys.** There is no deploy command.
The user works in VS Code — give them copy-paste `git` commands, one command per
fenced ```bash block, never a `$` prefix.

```
cd "/Users/wulfe/Desktop/Ratio Company/Ratio Website"
git add -A
git commit -m "..."
git push
```

Firebase is a **backend, not a deploy target**. Pushing code doesn't touch it.
Only `firebase deploy --only firestore:rules` when `firestore.rules`,
`storage.rules` or `firestore.indexes.json` change.

### Terminating staff

`api/users/reject-user.js` serves **three modes** on one route (the 12-function
cap is why): `reject` (unchanged), `preview` (collect and return, delete
nothing) and `terminate` (collect, return, then erase). Preview is a separate
round trip on purpose — the export must be in the admin's hands before
anything is deleted.

Termination erases the Auth account, `users/{uid}`, and every document in
`OWNED_COLLECTIONS` (shifts, availability, openShifts, timeOffRequests, chat,
availabilityLog, notificationPreferences, auditLog). Field names there were
verified against live data — availabilityLog uses `targetUid`/`actorUid`,
auditLog uses `actorUid`/`targetUserId`, openShifts uses
`claimedBy`/`originalUserId`. A uid-only scan misses legacy docs, so shifts /
availability / timeOffRequests also sweep by `userName`.

Gated on owner-level roles (`super_admin`/`owner`/`director`/`admin_assistant`),
tighter than reject. The UI forces a JSON download of everything first, then
requires typing the person's full name. A `staff.terminated` audit entry is the
only trace left.

`mode: 'orphans'` lists names with records but NO user account, and
`mode: 'orphan-purge'` exports and clears one. Surfaced in Admin → Manage
Staff → **Orphaned records**. This exists because deleting a user's PROFILE
used to be all "Remove staff" did — 189 documents across ten people had
built up with no account attached, invisible to the app. Cleared 2026-09-02;
`Kaitlyn` (22 availability rows, uid `cSb7xnHq…`, distinct from the live
Kaitlyn MacDonald) was left deliberately pending a decision.

Purge re-derives the orphan list server-side and only acts on a name that
scan produced, so a caller can't hand over arbitrary uids. Docs whose uid is
`system` are excluded — those are the app's own chat messages, not a person.

**What it cannot remove:** chat messages *other people* wrote that mention the
name (someone else's content), and anything in Resend — Ratio only sends
through Resend and never creates contacts or audiences, so there is nothing
stored there to delete.

### Hard constraint: 12 serverless functions

Vercel Hobby caps the project at 12, and `api/` is **exactly at 12**. Do not add
a new file under `api/`. Multiplex onto an existing handler with a query param —
see `api/scheduler/appointments.js`, which serves both a single day and a date
range, and also handles a student-sync POST. Files prefixed `_` (`api/_lib/`,
`api/assistant/_tools.js`) aren't routed and don't count.

## Before you change anything

```
npx eslint src/ api/        # must be clean
npx vitest run src/lib/     # must all pass
npx vite build              # must succeed
npm run test:rules          # firestore.rules, in the emulator (needs Java)
```

`eslint` here **exempts unused vars matching `/^[A-Z_]/`**, so dead
module-level SCREAMING_CASE constants are never flagged. Check by hand.

Project imports are extensionless (Vite resolves them); plain `node` cannot run
these files directly.

## Firestore shape

Top-level: `users`, `shifts`, `availability`, `openShifts`, `timeOffRequests`,
`centers`, `announcements`, `chat`, `auditLog`, `leads`-adjacent collections.

Per centre: `centers/{centerId}/config/main` (operatingDays, holidays,
instructionalHours, fixedStaff, salaryStaff, staffingBudget, autoHostNames,
staffRoles + staffRolePermissions),
plus `schedulerStudents`, `schedulerAliases`, `schedulerSettings/main`,
`schedulerTemplates`, `demandSnapshots`, `walkIns`, `inventory`.

### The single biggest gotcha: resolve per-centre fields

`instructorType`, `subRoles`, `approved`, `isVolunteer`, `maxDaysPerWeek` and
`guaranteed` live under `centerMemberships[centerId]`, with the top-level value
only as a fallback (`PER_CENTRE_FIELDS` in `src/lib/centerMembership.js`).

**Always `resolveUserForCenter(u, activeCenterId)` before reading them.**
Admin.jsx does this as `usersForCentre`. Reading raw fails *silently*: Rahul's
top-level `subRoles` is `['Elementary']` while his Langley membership is
`['Elementary','Host']`, so a raw read once made zero of 51 users host-capable
and locked the designated host out of the host desk.

## Scheduling domain

Two engines, sharing libraries:

- **`src/lib/scheduler.js`** → `generateSchedule()`. Availability-driven. Called
  from one place: `src/pages/Admin.jsx`. Pure, unit-tested.
- **`src/pages/StaffingBoard.jsx`** (`/staffing-board`) → demand-driven. Reads
  real bookings, emits shift slots, human assigns people.

Supporting pure libs, all tested: `demand-staffing.js` (bookings → per-date
min/max), `shift-shaping.js` (demand curve → contiguous shift blocks),
`board-budget.js` (placements → budget buckets), `budgetBuckets.js`,
`subRoles.js`, `centerMembership.js`, `timeOff.js`, `statPay.js`.

### Rules that are settled — do not re-litigate

- **Ratio: aim 1:3.5, floor 1:4.** `min = ceil(peak/4)`, `max = ceil(peak/3.5) + cushion`.
- **Who COUNTS toward the ratio is a per-shift field, not a role guess.**
  `includedInRatio` on the shift doc, read only through `countsInRatio()` in
  `src/lib/ratioCount.js`. Set from the "Included in Ratio" toggle on
  Add/Edit/Open Shift, seeded from the role (Instructor/Lead/Manager on,
  everything else off) and then owned by whoever moves it. Every creation
  path stamps it; the role-derived default is the fallback for pre-existing
  docs only. **Do not add a seventh place that decides this from the role** —
  that was the bug. `STAFFING_COUNT_ROLES`, `countsTowardCoverage()`,
  `ON_FLOOR_ROLES`, `countsAsFloorSupply()` and `TEACHING_ROLES` are all gone.
- **Order: Leads outrank Instructors, then fewest shifts.** Nothing else.
- **The per-person priority tier (1/2/3) was DELETED** — "broken and doesn't work
  properly". Gone from the engine, Manage Staff, membership fields and auth
  defaults. Old docs may still carry a `priority` field; it's ignored and a
  regression test pins that. **Do not reintroduce it.** (`rolePriority` /
  `subPriorityInTier` in `CoverageGrid.jsx` are display sorting — unrelated.)
- **Month-at-a-time was removed.** A week is the maximum planning horizon.
- **Over-staffing is cheap** — idle instructors do training modules. Err high.
- **Trainees and volunteers never fill a ratio slot.**
- **STEAM / Summer Camp (`flexRole`) was REMOVED.** The picker is gone and
  nothing writes the field. Custom centre roles replaced it — make a role
  with "Counts toward the ratio" off. What survives is read-only support for
  58 shift docs dated 2026-07-13 → 2026-08-31 (none current), so August
  payroll bucketing and past coverage don't change; every survivor is marked
  `LEGACY`. **Don't add a new writer.**
- Headcount precedence: `config.perDate['YYYY-MM-DD']` > `config.perDay['Monday']`
  > `minPerDay`/`maxPerDay`.

### Fixed staff and the two desks

- **Host = a CAPABILITY in `subRoles`**, checked with `hasCapability(u.subRoles,
  'Host')`. NOT `instructorType === 'Host'`. Rahul Parmar is the designated host
  (`autoHostNames`).
- **Admin assistant = `instructorType === 'Admin'`** — there is no 'Admin'
  capability. Rachel Rozelle, the only one, works 10:00–14:00 Mon–Fri (never
  Saturday — there's no Saturday `adminAssistant` budget). Never takes a floor
  shift.
- **Management** (Vinod, Neeru, Sabrina) comes from `centerConfig.fixedStaff`,
  which is **empty `{}`** at Langley, so it falls back to `FIXED_SCHEDULES` in
  `scheduler.js`. Vinod is Off Mondays; Neeru is Off Fridays.
- **Salaried staff** (`centerConfig.salaryStaff` = Neeru, Vinod) are shown as
  plain working hours and **excluded from the hourly budget**, same as the
  Staffing Budget page. Counting them makes every day read as over budget.

### Missed sign-outs (signed in, never signed out)

An instructor taps in on Radius and leaves without tapping out. Radius
exports that row with a Time In and a blank Time Out.

**The bug:** the importer computed `actualHours` from the times (or the
Duration column), got `NaN`, and `continue`d — so the row never entered
`radiusData`. The shift then matched nothing, got `missingFromRadius:
true`, and the payroll table said **"Not in Radius"**, which reads as *they
never came in*. Someone who worked a full Saturday looked like a no-show.

`src/lib/signOut.js` (pure, tested) now models six states instead of one
boolean — `upcoming` / `absent` / `in-progress` / `open` / `self-confirmed`
/ `complete` via `signOutState()`. Open punches are kept at parse time with
`openPunch: true` and `actualHours: 0` — **zero, not a guess**: a Duration
without a tap-out isn't evidence, and inventing hours here would put a
fabricated number into payroll.

**An open punch is not automatically a missed sign-out.** Most of the time
it means the person is STILL AT WORK. A real export taken mid-afternoon on
8 Sept 2026 held 17 open punches and **14 were staff currently on the
floor** — emailing them would have asked people at their desks to confirm
they'd gone home. `signOutState()` therefore returns `'in-progress'` until
the shift's scheduled end plus `SIGNOUT_GRACE_MINUTES` (30) has passed;
only then does it become `'open'` and eligible for an email. The grace also
covers someone who finishes at 7:00 and taps out at 7:06.

Parsing lives in `src/lib/radiusTimesheet.js` (`parseRadiusRows`), not
inline in the import handler, and is tested against a real export saved at
`src/lib/__fixtures__/radius-export-2026-09-08.json`. The export's shape:
a leading blank column, a per-person section header row ("Aarav Agarkar
(I)"), one row per punch, and a "Total: 1354" subtotal — **only punch rows
carry a numeric Employee Attendance Id**, which is what separates the
three. Dates are DD/MM/YYYY, times 12-hour. Open punches have Time Out as
an empty string and BOTH Duration columns empty, but they do have an
attendance id, so they are real rows. Two employees have parentheses in
their actual names ("Jieun (Joanne) Lee", "Darshveer (Diya) Brar") — don't
use parens to detect section headers.

Flow:
1. Import flags them. An amber panel above the payroll table lists every
   open punch **whose shift has ended** with its clock-in and scheduled
   finish. Staff still on shift show a sky-blue "On shift now" chip in the
   table and are never listed or emailed.
2. Admin presses **Send sign-out requests**. Deliberately manual — the
   same period gets imported more than once (partial exports, corrections),
   and auto-sending would email staff about shifts still being checked.
3. Each person gets one email with a one-tap link. A token doc is written
   to `signOutRequests/{token}` FIRST; the email only goes if that
   succeeded, so no un-redeemable link ever reaches an inbox.
4. They confirm at `/confirm-signout?t=…` — **public route, no login**.
5. The shift gets `signOutConfirmedTime` / `signOutConfirmedBy:
   'instructor'` / `signOutConfirmedAt`, and renders purple
   "Self-confirmed sign-out".

**It is never marked `payrollResolved`.** Confirming is an answer, not a
sign-off — `payrollNeedsReview()` keeps self-confirmed rows in the
unresolved count until an admin clears them. That is the whole point of
labelling them.

**Token security.** 256 bits, document-id-as-token (a wrong guess simply
doesn't exist), single use, 14-day expiry, and it authorises exactly one
write: the sign-out time on the one shift it names, to the time the ADMIN
proposed. The redeemer supplies no time of their own, so a forwarded link
cannot be used to claim arbitrary hours. Redemption is a Firestore
transaction, so a double-tap can't apply twice. Rules give clients
**create only** on `signOutRequests` — no read (the id IS the secret, and
listing would hand over every live token), no update/delete (a client that
could edit `usedAt` could replay one).

**Where the endpoint lives.** `api/send-password-reset.js?action=confirm-signout`.
The 12-function cap left no room for a new file, and that host was chosen
because its security posture already matches — public by design, with no
privileged capability next door for a bug in the new branch to reach.
Multiplexing onto an authenticated endpoint would have put a public code
path beside privileged ones.

**Person totals.** Open punches sum to zero, so confirmed hours are folded
back in (`confirmedExtra`) and `diff` / `hasDiscrepancy` are computed
*after* that pass — deriving them from the raw punch sum left a person who
HAD confirmed still reading as hours short.

**Not yet possible:** detection only happens when an admin uploads the
XLSX, because the Radius API in `Ratio_Radius_API_Request_Brief.docx` is
still pending Mathnasium's approval. Item 2 in that brief is this feature;
a webhook would let the email go out the same evening instead.

### Availability failsafe on the weekly grid

`src/lib/availabilityFit.js` answers "did we schedule someone outside the
hours they said they could work?" — availability 4–7pm, shift 3–7pm. The
Manage Staff Schedule cell goes amber (`bg-amber-100` + inset ring, stronger
than the amber-50/40 used for holidays and pending time off) with an
"Outside availability" strip under the shift and a tooltip saying which shift
and by how much.

**It never blocks.** Scheduling outside availability is sometimes right.

Two deliberate exclusions:
- **No availability submitted → not flagged.** Live data: 960 shifts fit
  inside availability, 49 fall outside, **839 have none on file**. Colouring
  that third group would turn nearly half the grid amber and bury the 49 that
  matter. The absence of a green corner already says "they didn't tell us".
- **Time off wins.** An approved day off already paints the cell and overrides
  availability, so the clash check is skipped when `cellTimeOff` is set and
  the two can't argue on one cell.

Impact on real data: 49 of 1837 person-day cells (2.7%), worst week 7 cells.

### Student Scheduler — notes and highlights

Per-student, PER-DAY, stored on the same check-in entry as status/tag/desk
(`centers/{id}/schedulerCheckIns/{date}` → `{ studentId: { note, highlight } }`).
Per-day is deliberate: these describe a session, not the child, and a note
carried forward for months would be worse than none.

- `setStudentNote` / `setStudentHighlight` in `scheduler-data.js`.
- Four fixed colours in `src/lib/scheduler-highlights.js`. The COLOURS are
  fixed (the sheet gets printed and carried around — it must mean the same
  thing every day); the LABELS are the centre's, editable, saved to
  `schedulerSettings.highlightLegend`.
- `highlightStyle()` carries `print-color-adjust: exact` **and** the WebKit
  prefix. Without them browsers strip the background when printing and every
  highlight silently vanishes on paper — the surface the feature is for.
- Writes: Leads / Managers / Hosts can set notes and highlights
  (`schedulerCheckIns` allows them). The LEGEND is a centre setting, so
  editing it is gated on `canSeeAdminPanel` to match the
  `schedulerSettings` rule.

### Roles and permissions

Three different things are called "role". Confusing them breaks access:

1. **`user.role`** — the PLATFORM role (`super_admin` / `owner` / `director` /
   `admin_assistant` / `admin` / `instructor`). Six fixed values, the security
   boundary, read by `firestore.rules`. Edited at **`/manage-roles`**,
   Enterprise-only. Not extensible.
2. **`centerMemberships[id].instructorType`** — the CENTRE role / job title.
   Created and edited in **Admin → Manage Staff → "Edit Role Permissions &
   Accessibility"** (the second sub-tab, needs `centre.settings`), stored as
   `staffRoles` on the centre config. Every user already has one.
3. **`subRoles`** — teaching capabilities. Unrelated to permissions.

`src/lib/roles.js` resolves a permission set from (1) + (2). Rules:

- **Permissions are ADDITIVE.** A centre role can only grant, never revoke —
  otherwise a bad edit locks an owner out of their own centre with no way
  back. To give someone less, lower their platform role.
- **Employment state is applied LAST.** Volunteer (no shifts, no chat) and
  Training (no shifts) beat every grant. Ordering is load-bearing; the
  equivalence suite caught it.
- **`roles.manage` can never be granted by a centre role** (`PLATFORM_ONLY_PERMISSIONS`).
  The editor is open to Centre Directors, so without that they could mint
  themselves Enterprise. Stripped on read, on write, and at resolution.
- **Built-in roles can't be deleted** — user records and past shifts name them.
- **A role's colour is the real one.** `assignmentColorHex()` and
  `staffTypeColorHex()` check `staffRoles` before the `assignmentColors` /
  `stateColors` palettes, so recolouring a role repaints the weekly grid.
  Centre Settings → Appearance keeps only what ISN'T a role: the three
  teaching levels (a shift's sub-role — one Instructor works all three) and
  the two shift states (Sick Pay, No-Show).
- The registry is stored **twice**: `staffRoles` (rich array, for the UI) and
  `staffRolePermissions` (flat `{name: [perm]}` map, for the rules — the rules
  language cannot search a list of maps). `permissionLookup()` derives the
  second. **Never write one without the other.**
- `AuthContext` derives `canSeeAdminPanel` / `canRunScheduler` /
  `canManageOperations` / `canSeeCenterSettings` / `canTakeShifts` from the
  permission set, and `ProtectedRoute` uses the same set. Prefer `can('x')`
  in new code. `roles.test.js` pins every
  (platform role x title x volunteer) combination against the original
  formulas, so that refactor granted and removed nothing.

Rules tests run against the emulator: `npm run test:rules` (needs Java).

### Budget

**The day model is the source of truth for the whole budget.** It lives at
`centerConfig.staffingBudget.weekdayModel`, is edited from Staffing Budget →
*Default day budget* (needs `centre.settings`), and falls back to
`WEEKDAY_DEFAULTS` in `budgetBuckets.js`. Always read it via
`resolveWeekdayModel(centerConfig)` and pass it down — `weekdayBudgetTotal(day,
model)` takes it as a second argument.

Defaults after STEAM was retired: Mon/Wed 48h, Tue/Thu 39h, Fri 36.5h, Sat
35.5h → **492h per fortnight**.

Everything derives from it:
- Manage Staff Schedule — each day header's denominator.
- Staffing Board — the same, plus which desks are budgeted.
- Staffing Budget — a pay period's target is `budgetForDates()`, the sum of the
  period's real days, holidays dropped. No 14-day-cycle arithmetic and no
  extra-day top-up: a 15- or 16-day period simply has more days in it.

**The bug this replaced:** the day model was a hardcoded constant only Manage
Schedule read, while the Staffing Budget page edited a separate per-period
number. Editing the budget moved one page and not the other, and the two had
drifted to 538h vs 688h for the same fortnight.

`staffingBudget.byPeriod['<period start>']` still holds **per-period
overrides**, and a period on/before `LEGACY_TARGETS_THROUGH` (2026-07-11) uses
the old global set. Those are the only cases where the two pages can differ;
the page labels which is in play and offers a one-click reset to the model.
Don't remove them — reviewed fortnights must keep the line they were judged on.

`bucketHoursForShift` splits a floor shift at the instructional window (inside →
Instructional, outside → Admin Hours); Host and Admin shifts are whole-shift
buckets. The Staffing Board measures against `instructional + host +
adminAssistant + adminHours` only — Online is budgeted the same day but
scheduled elsewhere. The `steam` / `summerCamp` buckets are **retired**
(`ACTIVE_BUCKETS` excludes them) but the keys survive so past periods and the 58
historical flex shifts still report.

## The new look (opt-in phone-first home for floor staff)

One alternative Home for the people who work shifts — instructors, leads,
trainees, volunteers. Their question is "am I on today, and does anyone
need anything from me?", they ask it on a phone, and the classic Home
answers it through a sidebar built for an owner's eighteen links behind a
hamburger.

**It started as four doors** — owner, director, host, instructor — and the
other three were **removed after review**: their figures depend on live
Radius reads and cross-collection maths this app cannot yet do quickly or
completely, so the numbers they showed were not trustworthy. A dashboard
that is confidently wrong is worse than no dashboard, and leadership
already has pages whose numbers are known-good. Only the instructor door
survived, because every figure on it is a direct read of that person's own
shifts, the open-shift board, or announcements.

If the Radius API in `Ratio_Radius_API_Request_Brief.docx` is ever
approved, the other three become worth revisiting — with real data.

### Who gets it

`canUseNewLook()` in `src/lib/newLook.js` reads as **"not leadership"**
rather than a list of job titles, so a custom centre role invented in
Manage Roles lands on the right side without a code change. `isOwnerLike`
(owner / admin-assistant / super-admin / director) and plain `admin` are
excluded; everyone else is floor staff. `newLookActive()` is the check
callers want: eligible AND opted in — a leftover localStorage value from
when the other doors existed cannot resurrect anything.

**OFF by default, per uid.** Nobody meets a redesigned portal because a
deploy landed, and signing out of one account into another does not carry
the setting across.

### Three ways back

1. **The toggle** at the bottom of the sidebar, and a **"Classic view"**
   link on the page itself — needed because on a phone the sidebar is
   behind a hamburger.
2. **It reverts itself.** `src/pages/HomeSwitch.jsx` wraps it in its OWN
   error boundary. This matters: the app-wide ErrorBoundary in App.jsx
   replaces the entire UI — sidebar included — so a crash here would take
   the toggle down with it and strand the user. It has already earned its
   keep once, when the director board crashed in production. On failure
   the classic Home renders, the opt-in is switched back off so a reload
   doesn't loop, and a line explains what happened.
3. **`git revert`** of the commit.

### Mobile

`MobileTabs` in `Layout.jsx` renders a bottom tab bar — Today / Schedule /
Shifts / Chat — on phones only (`lg:hidden`, where the sidebar returns),
and only when the new look is on. Shifts is hidden without `canTakeShifts`;
Chat is hidden for volunteers, who get no team messaging. Targets are
`min-h-[56px]`, past the 44px minimum. `.nl-tabbar` carries
`env(safe-area-inset-bottom)` for the iOS home indicator, and the page ends
in `pb-28` so nothing hides behind the bar.

### Shape of the change

Only four existing files are touched: `index.html` (the Outfit webfont),
`App.jsx` (route through `HomeSwitch`), `Layout.jsx` (toggle + tabs), and
`index.css` (tokens). `Home.jsx`, `Schedule.jsx`, `Admin.jsx` and
`ShiftBoard.jsx` are unmodified. All new CSS is scoped under `.nl`, so a
classic page renders identically whether the block exists or not. Muted
text is 5.1:1 on paper — the classic `text-gray-400` is 2.54:1, which
fails WCAG AA.

### Which side am I on, and when do I move

Neeru assigns instructors to a side — High School or Elementary — for each
half hour, in the Student Scheduler, before the day. Until now the only
copies were her screen and the printed sheet, so instructors walked in
asking out loud. The floor-staff home now shows it under their shift.

`centers/{id}/schedulerInstructorAssignments/{YYYY-MM-DD}` is a flat map
keyed `"<side>|<HH:MM>"` holding **display names**:

```
{ "EM|15:00": ["Kaitlyn MacDonald", "Jason Soo"],
  "HS|17:00": ["Luke Huang", "Jason Soo"] }
```

Verified against all 73 live documents: sides are only ever `HS` / `EM`,
slots are half-hourly 10:00–18:30, no other keys appear, and slots are
sparse (an unassigned half hour has no entry).

`src/lib/sideAssignments.js` collapses consecutive same-side slots into
blocks, so eight half hours read as "3:00–5:00 Elementary, 5:00–6:30 High
School". Its tests run against a **real day copied out of Firestore**.

Three rules that are easy to get wrong, all pinned by tests:

- **A gap does not merge.** Unassigned 4:00–4:30 with Elementary either
  side is two blocks, and is NOT a switch — "you move to Elementary at
  4:30" when they never left would be nonsense.
- **Before the first block, nothing is a "move".** Somebody on one side all
  day was being told "you move to High School at 5:00" while still at home.
  `nextSwitch` returns null before the day starts; a gap mid-day still
  points somewhere, because that IS useful.
- **A wrong side is worse than no side.** Matching is exact display name,
  which covers every current member of staff. A bare first name ("Bri",
  "Sofie" appear historically) matches ONLY when one person at the centre
  has it; ambiguous entries are ignored rather than guessed, because
  someone told the wrong side walks to the wrong end of the room and
  trusts it.

The roster needed for that disambiguation is fetched **only** when the
exact pass finds nothing, keeping ~50 user reads off the common path.

**Rules change:** `schedulerInstructorAssignments` read widened from
`canRunFloor` to `canRunFloor || isMemberAt(centerId)` — any staff member
of that centre. It is the least sensitive document in the scheduler (staff
names and a side; no students, contacts or pay), and every signed-in user
can already read all of `users` and `shifts`, so it exposes strictly less
than what is already open. Writes are unchanged. `isMemberAt` is a new
helper meaning "you work here", deliberately broader than any title.
Covered by five tests in `tests/rules/shifts.rules.test.js`, including that
another centre's manager is still refused and that instructors cannot
write.

### Render tests exist now, and why

`src/pages/homes/InstructorHome.render.test.jsx` renders the page in jsdom
with auth and Firestore stubbed. It was added after the SECOND render-time
crash to reach production in a row — the Manage Payroll TDZ bug, then the
director board — because `vite build`, eslint and 700 unit tests all
inspect code and **none of them run React**. The only thing that catches a
component which throws while rendering is rendering it.

Two traps it caught immediately, both of which had shipped:

- `availabilityConflict(dayShifts, dayAvail)` takes **every** availability
  row for that person on that day, not one document. Rows are one per
  person per day and a person can have several; `availabilityWindows`
  iterates the argument, so a single document threw
  `(dayAvail || []) is not iterable`. Merging matters on its own too:
  10–2 plus 2–6 is 10–6 continuously, and judging rows separately invents
  a clash at the seam.
- `describeConflict(fit)` takes a **fit**, not the `{conflicts, windows,
  worst}` wrapper `availabilityConflict` returns.

Note `esbuild: { jsx: 'automatic' }` in `vite.config.js`: components rely
on the automatic JSX runtime, the react plugin supplies it for the app
build, but vitest transforms through esbuild, which defaults to the classic
runtime — so every component rendered in a test died with "React is not
defined" until both pipelines agreed.

Also mock Firestore **by collection**. A mock handing every listener the
same rows let the availability listener receive shift documents, and a test
passed for the wrong reason.

## Server-side dates: never use UTC

Vercel Lambdas run UTC; the centre runs Pacific. From ~5pm local the
server's own calendar date is already **tomorrow**, and `shift.date` is
centre-local wall clock — so `new Date().toISOString().slice(0,10)` as
"today" was a day ahead every evening. It hid tonight's open shifts from
the Owner Assistant (`_tools.js` filters `date >= today`) and told the
model the wrong date outright.

Use `api/_lib/centreDate.js` — `centreToday()`, `centreYMD(d)`,
`centreOffsetYMD(n)`, honouring `CENTER_TZ` and DST. `_lib/` isn't routed,
so it costs nothing against the 12-function cap.

## Inspecting live data (read-only)

Service account at `../Pricing and Codes/mathnasium-langley-firebase-adminsdk-*.json`.
Run scripts **from inside `Ratio Website/`** so `firebase-admin` resolves. Some
queries need composite indexes — drop `orderBy` and sort in JS instead.

## Working style the user expects

- **Verify, never assume.** Read the real code and the real data before building.
  The thing very likely already exists. State what exists and what the actual gap
  is *before* writing anything.
- Deliverables get lint + tests + build run, and UI changes get looked at.
  The Admin and Staffing Board pages are behind Firebase auth, so verify visuals
  by rendering the component's markup against `dist/assets/*.css` on a scratch
  static server.
- Say plainly what was and wasn't verified. Don't claim a UI works if you
  couldn't sign in to see it.

## Known issue

`scheduler-app/.git/config` (the sibling standalone Acuity dashboard, a separate
repo) has a **live GitHub PAT committed in its remote URL**. It needs revoking.
