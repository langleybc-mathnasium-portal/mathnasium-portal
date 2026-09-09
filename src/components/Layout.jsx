import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { collection, onSnapshot, query, where, orderBy, limit } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import Logo from './Logo';
import RatioLogo from './RatioLogo';
import MigrationBanner from './MigrationBanner';
import CenterSwitcher from './CenterSwitcher';
import {
  House, Megaphone, CalendarDays, MessageSquare, Settings, LogOut, Menu, X, Bell,
  Briefcase, Shield, BarChart3, DollarSign, Headphones, Building2, FileClock, UserCog,
  CalendarRange, Users, Wallet, ClipboardList, Plug, MessagesSquare, Sparkles, CalendarCheck,
  UserPlus, FileBarChart, Activity, Package, History, LayoutGrid,
} from 'lucide-react';

// Eligibility logic mirrors ShiftBoard.canTake — kept here so the badge count
// stays in sync without a circular import. Users with zero sub-roles cannot
// take anything; legacy shifts (no subRole) are takeable by anyone *with* a
// sub-role; otherwise the user must have the matching sub-role.
function canTake(shiftSubRole, userSubRoles) {
  const subs = userSubRoles || [];
  if (subs.length === 0) return false;
  if (!shiftSubRole) return true;
  return subs.includes(shiftSubRole);
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Role labels for user-visible surfaces. The underlying Firestore role string
// stays 'super_admin' (so security rules + audit codes don't churn) but every
// place a human sees the role, we render it as "Enterprise".
const ROLE_LABEL = {
  super_admin: 'Enterprise',
  owner:       'Owner',
  admin:       'Admin',
  instructor:  'Instructor',
};

export default function Layout({ children }) {
  const { profile, mySubRoles, logout, activeCenterId, isSuperAdmin, isOwner, isDirector, isAdminAssistant, isAdmin, isLead, isVolunteer, canTakeShifts, canSeeAdminPanel, canManageOperations } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [openShifts, setOpenShifts] = useState([]);
  const [chatDocs, setChatDocs] = useState([]);

  // Subscribe to data needed for the Shift Board badge counter — scoped to
  // the active center. Both queries are also used by the ShiftBoard page
  // itself; Firebase dedupes identical subscriptions.
  useEffect(() => onSnapshot(
    query(
      collection(db, 'openShifts'),
      where('centerId', '==', activeCenterId),
      orderBy('date', 'asc'),
    ),
    snap => setOpenShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), [activeCenterId]);

  useEffect(() => onSnapshot(
    query(
      collection(db, 'chat'),
      where('centerId', '==', activeCenterId),
      orderBy('createdAt', 'desc'),
      limit(200),
    ),
    snap => setChatDocs(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), [activeCenterId]);

  // Eligible-for-this-user count for the sidebar badge.
  const boardCount = useMemo(() => {
    const today = todayStr();
    const subs = mySubRoles || [];

    const openCount = openShifts.filter(s =>
      s.status === 'open' &&
      s.date >= today &&
      canTake(s.subRole, subs)
    ).length;

    const swapCount = chatDocs.filter(m =>
      m.type === 'shift_swap' &&
      m.swapStatus === 'open' &&
      (!m.shiftDate || m.shiftDate >= today) &&
      m.userId !== profile?.uid &&
      canTake(m.shiftSubRole, subs)
    ).length;

    return openCount + swapCount;
  }, [openShifts, chatDocs, profile, mySubRoles]);

  // Build nav based on role.
  //
  // Two distinct layouts:
  //
  // (A) OWNER / ADMIN-ASSISTANT layout (the business operator) — uses a
  //     supply / demand mental model that mirrors the actual economics
  //     of a tutoring centre. The owner's whole job is matching demand
  //     (students) against supply (staff hours), so the sidebar is
  //     literally shaped like the P&L:
  //
  //       GENERAL  → home, chats — daily start point
  //       GROWTH   → the funnel (leads → assessments → enrolled)
  //       DEMAND   → active students + today's room
  //       SUPPLY   → staff: schedule, roster, payroll
  //       INTELLIGENCE → analytics, the answers
  //       CENTRE   → settings + configuration
  //
  // (B) EVERYONE ELSE — instructor / plain admin / super-admin — uses
  //     the original verb-named groupings (General / Manage / Insights /
  //     Communicate / Enterprise / Settings) because the supply/demand
  //     frame is for the business owner, not the people running shifts
  //     in the room or the platform operator.
  //
  // Role guide unchanged:
  //   instructor  → GENERAL + personal Scheduling / Shift Board / Chat.
  //   admin       → GENERAL + MANAGE + COMMUNICATE.
  //   admin_asst. → owner-style layout (they ARE owner-equivalent for ops).
  //   owner       → owner-style layout.
  //   super_admin → original layout + ENTERPRISE.
  // Directors get the full owner-style sidebar (Growth, Supply,
  // Intelligence, Centre) — they run the centre and need the same
  // navigation as an owner, just with a different label.
  const useOwnerLayout = isOwner || isAdminAssistant || isDirector;

  // ─── GENERAL (both layouts share this) ─────────────────────────────
  const general = [
    { to: '/', label: 'Home', icon: House },
  ];
  // Owners get a single "Chats" entry in General that goes to a hub
  // page (/chats) collecting Centre Chat, Management Chat, and Owner
  // Chat in one place. Cuts the sidebar down significantly.
  if (isOwner) {
    general.push({ to: '/chats', label: 'Chats', icon: MessagesSquare });
  }
  // Personal scheduling surfaces. Enterprise users skip these entirely —
  // they're the platform operator and shouldn't be claiming shifts at
  // someone else's centre. Owners skip Schedule (the personal-availability
  // page) since they run the business rather than take individual shifts,
  // but AA gets it back (they ARE scheduled like staff).
  if (!isSuperAdmin && !isOwner) {
    general.push({ to: '/schedule', label: 'My Schedule', icon: CalendarDays });
  }
  // Shift Board is for instructors and AA (anyone who can claim shifts).
  // Owners see open shifts inside Manage Schedule and don't need a
  // separate sidebar item.
  // Volunteers don't pick up open shifts or swap — they work the shifts
  // they're given and ask to cancel if something comes up. Trainees
  // shadow an instructor rather than covering a slot, so the same
  // applies. The Shift Board is entirely about claiming and swapping,
  // so it's not theirs — see canTakeShifts in AuthContext.
  if (!isSuperAdmin && !isOwner && canTakeShifts) {
    general.push({ to: '/shift-board', label: 'Shift Board', icon: Briefcase, badge: boardCount });
  }

  // ─── OWNER LAYOUT ──────────────────────────────────────────────────
  // Built only when useOwnerLayout is true. Empty arrays otherwise so
  // the section-assembly below stays uniform.
  //
  // GROWTH — the lead → student funnel. Leads sits above Intakes
  // because it's the wider top of the funnel (anyone interested),
  // while Intakes is the narrower next step (a scheduled assessment).
  // Owners scan the sidebar top-to-bottom — putting them in funnel
  // order reinforces the mental model every time.
  const growth = [];
  if (useOwnerLayout) {
    growth.push(
      { to: '/leads',   label: 'Leads',   icon: UserPlus },
      { to: '/intakes', label: 'Intakes', icon: CalendarCheck },
    );
  }

  // DEMAND — active students + today's room. The daily ops tool sits
  // here, not under Manage, because students ARE the demand. Renamed
  // "Scheduler Creation" → "Student Scheduler" to match how owners
  // actually describe it (and to underline that it's about students,
  // not about building schedulers).
  const demand = [];
  if (useOwnerLayout) {
    demand.push({ to: '/scheduler-creation', label: 'Student Scheduler', icon: ClipboardList });
    demand.push({ to: '/staffing-board', label: 'Staffing Board', icon: LayoutGrid });
  }

  // SUPPLY — staff. Schedule + roster + pay = supply being allocated,
  // maintained, settled. Same three Admin sub-tabs as before, just
  // re-framed under the right mental bucket.
  const supply = [];
  if (useOwnerLayout && canSeeAdminPanel) {
    supply.push(
      { to: '/admin?tab=spreadsheet', label: 'Manage Staff Schedule', icon: CalendarRange },
      { to: '/admin?tab=users',       label: 'Manage Staff',          icon: Users },
      { to: '/admin?tab=payroll',     label: 'Manage Payroll',        icon: Wallet },
      // Availability history sits with the staff tools, not with Centre
      // config: you open it while looking at a schedule dispute, which
      // is exactly when Manage Staff Schedule is the tab next door.
      { to: '/availability-log',      label: 'Availability Log',      icon: History },
    );
  }

  // INTELLIGENCE — the answers. Centre Analytics belongs here, not
  // mixed with the verbs above. Case Study is the slide-ready numbers
  // used for sales pitches (Owner-only conceptually, but admin_assistant
  // who runs operations should see them too).
  const intelligence = [];
  if (useOwnerLayout) {
    intelligence.push({ to: '/center-analytics', label: 'Centre Analytics', icon: BarChart3 });
    intelligence.push({ to: '/supply-demand',    label: 'Supply & Demand',  icon: Activity });
    intelligence.push({ to: '/staffing-budget',  label: 'Staffing Budget',  icon: Wallet });
    intelligence.push({ to: '/case-study',       label: 'Case Study',       icon: FileBarChart });
  }

  // CENTRE — configuration. Sits at the bottom because owners touch it
  // rarely. Connectors and Holidays already live inside Centre Settings
  // as sub-tabs.
  const centre = [];
  if (useOwnerLayout) {
    // Inventory sits above Centre Settings: supplies get touched weekly,
    // settings get touched twice a year. Admin-and-above only — the route
    // and the Firestore rules enforce it too, this just hides the link.
    if (canSeeAdminPanel) {
      centre.push({ to: '/inventory', label: 'Inventory', icon: Package });
    }
    centre.push({ to: '/center-settings', label: 'Centre Settings', icon: Settings });
  }

  // ─── NON-OWNER LAYOUT (original Manage / Insights / Communicate) ──
  // Built only when useOwnerLayout is false (instructor, plain admin,
  // super_admin). Owners / AA reach all of this via Growth / Demand /
  // Supply / Intelligence / Centre above.

  const manage = [];
  if (!useOwnerLayout && canManageOperations) {
    // Plain Admin, Manager, and Host all land here — same "operational
    // admin" tier, full list. (Owner / AA / Director reach the same
    // pages via Growth / Demand / Supply / Intelligence above instead.)
    manage.push(
      { to: '/admin?tab=spreadsheet', label: 'Manage Staff Schedule', icon: CalendarRange },
      { to: '/scheduler-creation',    label: 'Student Scheduler',    icon: ClipboardList },
      { to: '/admin?tab=users',       label: 'Manage Staff',          icon: Users },
      { to: '/admin?tab=payroll',     label: 'Manage Payroll',        icon: Wallet },
      { to: '/inventory',             label: 'Inventory',             icon: Package },
      { to: '/availability-log',      label: 'Availability Log',      icon: History },
    );
  } else if (!useOwnerLayout && isLead) {
    // Lead instructors get Student Scheduler — but NOT the broader
    // admin pages (Manage Staff / Payroll stay owner-side). They run
    // the floor; they don't run HR.
    manage.push(
      { to: '/scheduler-creation',    label: 'Student Scheduler',     icon: ClipboardList },
    );
  }

  const insights = [];
  if (!useOwnerLayout && isSuperAdmin) {
    insights.push({ to: '/center-analytics', label: 'Centre Analytics', icon: BarChart3 });
    insights.push({ to: '/intakes',          label: 'Intakes',          icon: CalendarCheck });
  }

  // COMMUNICATE — chat, announcements, personal notification prefs.
  // Owners skip this entirely (consolidated under General → Chats).
  const communicate = [];
  // Volunteers get a bare-bones portal — no team messaging. The route
  // guard enforces it; this just keeps the sidebar honest.
  if (!isSuperAdmin && !isOwner && !isVolunteer) {
    communicate.push({ to: '/chat', label: 'Chat', icon: MessageSquare });
  }
  if ((isAdmin || isAdminAssistant) && !isSuperAdmin && !isVolunteer) {
    communicate.push({ to: '/platform-chat', label: 'Management Chat', icon: Headphones });
  }
  // Volunteers get the latest announcement on their Home page, which is
  // the whole of what they need from it.
  if (!isOwner && !isVolunteer) {
    communicate.push({ to: '/announcements', label: 'Announcements', icon: Megaphone });
  }
  if (!isOwner) {
    communicate.push({ to: '/notifications', label: 'Notifications', icon: Bell });
  }

  // ENTERPRISE — platform-operator only. Sits between COMMUNICATE and
  // SETTINGS so super-admin tools are grouped together.
  const enterprise = [];
  if (isSuperAdmin) {
    enterprise.push(
      { to: '/super-admin',      label: 'Manage Centres',   icon: Building2 },
      { to: '/manage-roles',     label: 'Manage Roles',     icon: UserCog },
      { to: '/platform-revenue', label: 'Platform Revenue', icon: DollarSign },
      { to: '/platform-chat',              label: 'Management Chat', icon: Headphones },
      { to: '/platform-chat?view=owners',  label: 'Owner Chat',      icon: Sparkles },
      { to: '/audit-logs',                 label: 'Audit Logs',      icon: FileClock },
    );
  }

  // SETTINGS — non-owner fallback for those who didn't get a Centre
  // section above. Super-admin lands here.
  const settingsSection = [];
  if (!useOwnerLayout && isSuperAdmin) {
    settingsSection.push({ to: '/center-settings', label: 'Centre Settings', icon: Settings });
  }

  const navSections = useOwnerLayout
    ? [
        { label: 'General',      items: general      },
        { label: 'Growth',       items: growth       },
        { label: 'Demand',       items: demand       },
        { label: 'Supply',       items: supply       },
        { label: 'Intelligence', items: intelligence },
        { label: 'Centre',       items: centre       },
      ].filter(s => s.items.length > 0)
    : [
        { label: 'General',     items: general     },
        { label: 'Manage',      items: manage      },
        { label: 'Insights',    items: insights    },
        { label: 'Communicate', items: communicate },
        { label: 'Enterprise',  items: enterprise  },
        { label: 'Settings',    items: settingsSection },
      ].filter(s => s.items.length > 0);

  // Path equality + (when the link carries a ?tab= query string)
  // also matches the active tab. This keeps Manage Schedule /
  // Manage Staff / Manage Payroll distinct in the sidebar even
  // though they all point at /admin underneath.
  const currentTab = new URLSearchParams(location.search).get('tab') || 'spreadsheet';
  const isActive = (item) => {
    const [path, queryStr] = item.to.split('?');
    if (location.pathname !== path) return false;
    if (!queryStr) {
      // Item has no ?tab=, so it's only active when no tab is selected
      // (the default landing). Avoids /admin matching /admin?tab=users.
      if (path === '/admin') return currentTab === 'spreadsheet';
      return true;
    }
    const itemTab = new URLSearchParams(queryStr).get('tab');
    return itemTab === currentTab;
  };

  // Role badge for the bottom user card
  // Volunteer is a per-centre flag rather than a role, so it has to be
  // checked before the role map — otherwise every volunteer reads as
  // "Instructor", which is what they are in the data and not what they
  // are to the team.
  const roleLabel = isVolunteer
    ? 'Volunteer'
    : (ROLE_LABEL[profile?.role] || (isAdmin ? 'Admin' : 'Instructor'));

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Multi-center migration gate — covers the whole UI until the one-time
          migration has been run. After that, this renders nothing. */}
      <MigrationBanner />
      {open && <div className="fixed inset-0 z-20 bg-black/50 lg:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-30 w-64 flex flex-col transform bg-gradient-to-b from-gray-900 to-gray-800 text-white transition-transform duration-200 ease-in-out lg:relative lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="shrink-0 flex items-center gap-3 border-b border-gray-700 px-5 py-5">
          <Logo size={40} />
          <div>
            <h1 className="text-lg font-bold leading-tight text-white">Mathnasium</h1>
            <p className="text-xs text-gray-400">Instructor Portal</p>
          </div>
          <button className="ml-auto lg:hidden" onClick={() => setOpen(false)}>
            <X size={20} />
          </button>
        </div>

        {/* Center switcher (shown if user has multiple centers or is super-admin) */}
        <div className="shrink-0 px-3 pt-3">
          <CenterSwitcher />
        </div>

        <nav className="mt-3 flex-1 min-h-0 overflow-y-auto flex flex-col gap-1 px-3 pb-4">
          {navSections.map((section, idx) => (
            <div key={section.label || `sec-${idx}`} className={idx > 0 ? 'mt-4' : ''}>
              {section.label && (
                <p className="mb-1 px-3 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                  {section.label}
                </p>
              )}
              {section.items.map(item => {
                const active = isActive(item);
                return (
                  <Link
                    key={item.to + (item.label || '')}
                    to={item.to}
                    onClick={() => setOpen(false)}
                    className={`mb-1 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${active ? 'bg-red-600 text-white shadow-md' : 'text-gray-300 hover:bg-gray-700 hover:text-white'}`}
                  >
                    <item.icon size={18} />
                    <span className="flex-1">{item.label}</span>
                    {item.badge > 0 && (
                      <span className={`min-w-[20px] text-center rounded-full px-1.5 py-0.5 text-xs font-bold ${active ? 'bg-white text-red-600' : 'bg-orange-500 text-white'}`}>
                        {item.badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="shrink-0 border-t border-gray-700 p-4">
          {/* User card — clickable. Goes to /account for self-service
              profile + email + password management. Enterprise accounts
              keep the Ratio brand mark; everyone else shows their
              uploaded photoURL (if set) or a coloured initials circle.
              Title attribute makes the click target discoverable. */}
          <Link
            to="/account"
            onClick={() => setOpen(false)}
            title="Account Details"
            className="mb-3 -mx-1 flex items-center gap-3 rounded-lg px-1 py-1 transition-colors hover:bg-gray-700/60"
          >
            {isSuperAdmin ? (
              <div className="shrink-0">
                <RatioLogo size={32} alt={profile?.displayName || 'Ratio'} />
              </div>
            ) : profile?.photoURL ? (
              <img
                src={profile.photoURL}
                alt={profile?.displayName || 'Profile picture'}
                className="h-8 w-8 shrink-0 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold bg-red-600">
                {profile?.displayName?.charAt(0)?.toUpperCase() || '?'}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{profile?.displayName || 'User'}</p>
              <p className="truncate text-xs text-gray-400">{roleLabel}</p>
            </div>
          </Link>
          <button onClick={logout} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-gray-700 hover:text-white">
            <LogOut size={16} /> Sign Out
          </button>
          {/* Ratio wordmark + brand mark — small, muted, sits below the
              user card and Sign Out so the platform brand has a quiet
              presence without competing with the centre's identity in
              the header. */}
          <div className="mt-3 flex items-center justify-center gap-1.5" title="More time with students. More time with family. Less time on everything else.">
            <RatioLogo size={14} alt="Ratio" />
            <span className="text-[10px] uppercase tracking-[0.25em] text-gray-500">
              Ratio
            </span>
          </div>
        </div>
      </aside>
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center gap-3 border-b bg-white px-4 py-3 shadow-sm lg:hidden">
          <button onClick={() => setOpen(true)}>
            <Menu size={24} className="text-gray-700" />
          </button>
          <div className="flex items-center gap-2">
            <Logo size={28} />
            <span className="font-bold text-gray-900">Mathnasium Portal</span>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
