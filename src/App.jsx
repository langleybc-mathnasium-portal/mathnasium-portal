import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Link, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import HomeSwitch from './pages/HomeSwitch';
import ErrorBoundary from './components/ErrorBoundary';
import Layout from './components/Layout';
import NotifyHost from './components/NotifyHost';
import OwnerAssistant from './components/OwnerAssistant';
// Entry-path routes stay eager — every first visit hits one of these and we
// don't want a Suspense flash on the front door.
import Login from './pages/Login';
import Signup from './pages/Signup';
import Home from './pages/Home';
import Landing from './pages/Landing';
import { useAuth } from './contexts/AuthContext';

// All other routes are code-split. They're behind ProtectedRoute or only
// reached after the user navigates, so paying their JS cost on first paint
// is wasted bytes. Each lazy() call becomes its own chunk in the build.
const Announcements             = lazy(() => import('./pages/Announcements'));
const Schedule                  = lazy(() => import('./pages/Schedule'));
const ShiftBoard                = lazy(() => import('./pages/ShiftBoard'));
const Chat                      = lazy(() => import('./pages/Chat'));
const Admin                     = lazy(() => import('./pages/Admin'));
const SuperAdmin                = lazy(() => import('./pages/SuperAdmin'));
const ManageRoles               = lazy(() => import('./pages/ManageRoles'));
const NotificationPreferences   = lazy(() => import('./pages/NotificationPreferences'));
const PlatformRevenue           = lazy(() => import('./pages/PlatformRevenue'));
const PlatformChat              = lazy(() => import('./pages/PlatformChat'));
const CenterAnalytics           = lazy(() => import('./pages/CenterAnalytics'));
const ConfirmSignOut            = lazy(() => import('./pages/ConfirmSignOut'));
const SupplyDemand              = lazy(() => import('./pages/SupplyDemand'));
const StaffingBoard             = lazy(() => import('./pages/StaffingBoard'));
const StaffingBudget            = lazy(() => import('./pages/StaffingBudget'));
const CenterSettings            = lazy(() => import('./pages/CenterSettings'));
const AuditLogs                 = lazy(() => import('./pages/AuditLogs'));
const AccountDetails            = lazy(() => import('./pages/AccountDetails'));
const SchedulerCreation         = lazy(() => import('./pages/SchedulerCreation'));
const Connectors                = lazy(() => import('./pages/Connectors'));
const ChatsHub                  = lazy(() => import('./pages/Chats'));
const ApptotoSchedule           = lazy(() => import('./pages/ApptotoSchedule'));
const PublicBook                = lazy(() => import('./pages/PublicBook'));
const IntakeManagement          = lazy(() => import('./pages/IntakeManagement'));
const Leads                     = lazy(() => import('./pages/Leads'));
const CaseStudy                 = lazy(() => import('./pages/CaseStudy'));
const Onboarding                = lazy(() => import('./pages/Onboarding'));
const Inventory                 = lazy(() => import('./pages/Inventory'));
const AvailabilityLog           = lazy(() => import('./pages/AvailabilityLog'));

// Root URL ("/") is dual-purpose:
//   - Unauthenticated visitor → public marketing Landing page
//   - Signed-in user → their centre's Home dashboard (existing behaviour)
// This keeps the existing app surface unchanged for current owners while
// the same URL doubles as the front door for prospective franchisees.
function RootGate() {
  const auth = useAuth();
  const { user, loading, isOwner, isAdminAssistant, isSuperAdmin, centerConfig } = auth;
  if (loading) return null;
  if (!user) return <Landing />;
  // Owners (and AA) of a centre that hasn't completed onboarding get
  // bounced to the setup wizard.
  //
  // We check FALSY (covers both `false` AND `undefined`) so that every
  // new centre triggers onboarding by default — owners don't have to
  // remember to set the field. Pre-existing operational centres (Langley)
  // are exempted by a one-time backfill that sets the field to `true`
  // explicitly, NOT by leaving the field undefined.
  //
  // super_admins are exempt: they jump between centres for support and
  // shouldn't be force-routed into someone else's wizard.
  const ownerLike = isOwner || isAdminAssistant;
  if (ownerLike && !isSuperAdmin && !centerConfig?.completedOnboarding) {
    return <Navigate to="/onboarding" replace />;
  }
  // HomeSwitch serves the classic Home unless this person opted in to the
  // role-shaped one, and carries its own error boundary so a failure there
  // can never take the sidebar (and its "back to classic" toggle) with it.
  return <ProtectedRoute><Layout><HomeSwitch /></Layout></ProtectedRoute>;
}

function NotFound() {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-50 px-4">
      <div className="mx-auto max-w-md rounded-xl bg-white p-8 shadow-sm text-center">
        <p className="text-6xl mb-2">🤔</p>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Page not found</h1>
        <p className="text-sm text-gray-500 mb-4">The page you're looking for doesn't exist.</p>
        <Link to="/" className="inline-block rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
          Back to Home
        </Link>
      </div>
    </div>
  );
}

// Fallback shown while a lazy-loaded route chunk is fetched. Intentionally
// minimal — a brief, brand-coloured spinner is less jarring than a blank
// flash, and most chunks load in under 200ms on a warm cache.
function RouteFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div
        className="h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-red-600"
        role="status"
        aria-label="Loading"
      />
    </div>
  );
}

function AppRoutes() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/" element={<RootGate />} />
        <Route path="/announcements" element={<ProtectedRoute><Layout><Announcements /></Layout></ProtectedRoute>} />
        <Route path="/schedule" element={<ProtectedRoute><Layout><Schedule /></Layout></ProtectedRoute>} />
        {/* requireShiftTaking covers volunteers AND trainees — neither
            claims or swaps, which is all this page does. */}
        <Route path="/shift-board" element={<ProtectedRoute requireShiftTaking><Layout><ShiftBoard /></Layout></ProtectedRoute>} />
        <Route path="/chat" element={<ProtectedRoute blockVolunteers><Layout><Chat /></Layout></ProtectedRoute>} />
        {/* allowOps: Manager- and Host-titled users also get in here, with
            full admin-panel access — same "operational admin" tier as
            /inventory and /availability-log below. */}
        <Route path="/admin" element={<ProtectedRoute requireOwner allowOps><Layout><Admin /></Layout></ProtectedRoute>} />
        <Route path="/super-admin" element={<ProtectedRoute><Layout><SuperAdmin /></Layout></ProtectedRoute>} />
        {/* Platform roles only, Enterprise-only. The CENTRE role editor
            moved to Admin → Manage Staff, where it sits beside the
            per-person editor it's used with. */}
        <Route path="/manage-roles" element={<ProtectedRoute requireSuperAdmin><Layout><ManageRoles /></Layout></ProtectedRoute>} />
        <Route path="/platform-revenue" element={<ProtectedRoute><Layout><PlatformRevenue /></Layout></ProtectedRoute>} />
        <Route path="/platform-chat" element={<ProtectedRoute blockVolunteers><Layout><PlatformChat /></Layout></ProtectedRoute>} />
        <Route path="/center-analytics" element={<ProtectedRoute><Layout><CenterAnalytics /></Layout></ProtectedRoute>} />
        <Route path="/center-analytics/:section" element={<ProtectedRoute><Layout><CenterAnalytics /></Layout></ProtectedRoute>} />
        {/* Reads walk-ins and per-day check-ins (student names), so it
            carries the admin-panel gate. Previously any signed-in user
            who knew the URL could open it. */}
        <Route path="/supply-demand" element={<ProtectedRoute requireOwner><Layout><SupplyDemand /></Layout></ProtectedRoute>} />
        {/* Builds the shifts real bookings call for, then the owner assigns
            instructors to them. allowOps so Managers/Hosts can staff a day. */}
        <Route path="/staffing-board" element={<ProtectedRoute requireOwner allowOps><Layout><StaffingBoard /></Layout></ProtectedRoute>} />
        <Route path="/staffing-budget" element={<ProtectedRoute><Layout><StaffingBudget /></Layout></ProtectedRoute>} />
        <Route path="/center-settings" element={<ProtectedRoute><Layout><CenterSettings /></Layout></ProtectedRoute>} />
        <Route path="/audit-logs" element={<ProtectedRoute><Layout><AuditLogs /></Layout></ProtectedRoute>} />
        {/* Centre supply inventory. `requireOwner` on ProtectedRoute means
            "has admin-panel access" — admin, admin_assistant, director,
            owner, super_admin — plus Managers/Hosts via allowOps.
            Instructors get Not Authorized. */}
        <Route path="/inventory" element={<ProtectedRoute requireOwner allowOps><Layout><Inventory /></Layout></ProtectedRoute>} />
        {/* Availability change history. Same admin-panel gate as
            /inventory — admin, admin_assistant, director, owner,
            super_admin, plus Managers/Hosts via allowOps. Instructors
            can't see who changed what. */}
        <Route path="/availability-log" element={<ProtectedRoute requireOwner allowOps><Layout><AvailabilityLog /></Layout></ProtectedRoute>} />
        <Route path="/notifications" element={<ProtectedRoute><Layout><NotificationPreferences /></Layout></ProtectedRoute>} />
        <Route path="/account" element={<ProtectedRoute><Layout><AccountDetails /></Layout></ProtectedRoute>} />
        <Route path="/scheduler-creation" element={<ProtectedRoute><Layout><SchedulerCreation /></Layout></ProtectedRoute>} />
        <Route path="/connectors" element={<ProtectedRoute><Layout><Connectors /></Layout></ProtectedRoute>} />
        <Route path="/chats" element={<ProtectedRoute blockVolunteers><Layout><ChatsHub /></Layout></ProtectedRoute>} />
        {/* Reads the centre's connector config — admin-and-above. */}
        <Route path="/apptoto" element={<ProtectedRoute requireOwner><Layout><ApptotoSchedule /></Layout></ProtectedRoute>} />
        {/* Public, NO auth — parents land here from marketing links. */}
        <Route path="/book/:centerId" element={<PublicBook />} />
        {/* Sign-out confirmation from the payroll email. PUBLIC on purpose:
            the one-time token in the link is the authorisation, because the
            person opening it is on a phone and not logged in. The token
            grants exactly one write on one shift — see
            api/send-password-reset.js. */}
        <Route path="/confirm-signout" element={<ConfirmSignOut />} />
        <Route path="/intakes" element={<ProtectedRoute><Layout><IntakeManagement /></Layout></ProtectedRoute>} />
        {/* Parent contact info — name, email, phone. The page has no
            internal role check, so the gate has to be here. Until the
            rules were tightened, any signed-in instructor who knew this
            URL could read the whole lead list. */}
        <Route path="/leads"        element={<ProtectedRoute requireOwner><Layout><Leads /></Layout></ProtectedRoute>} />
        {/* Pulls student counts out of the Student Scheduler data. */}
        <Route path="/case-study"   element={<ProtectedRoute requireOwner><Layout><CaseStudy /></Layout></ProtectedRoute>} />
        {/* Onboarding runs full-screen (no sidebar) until the owner finishes setup. */}
        <Route path="/onboarding"   element={<ProtectedRoute><Onboarding /></ProtectedRoute>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
          {/* Single global host for toasts + confirm dialogs. Mounted once
              here so any code path can call toast.success / confirmDialog
              from src/lib/notify.js without prop drilling. */}
          <NotifyHost />
          {/* Floating "Jarvis" chat widget — internally gates to owners
              only via useAuth(), so it's safe to mount globally here. */}
          <OwnerAssistant />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
