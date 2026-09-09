import { Component, Suspense, lazy } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { canUseNewLook, isNewLookOn, setNewLook } from '../lib/newLook';
import Home from './Home';

const InstructorHome = lazy(() => import('./homes/InstructorHome'));

/**
 * HomeSwitch — classic Home, or the phone-first one for floor staff, with a
 * floor under it.
 *
 * WHY THE LOCAL BOUNDARY MATTERS MORE THAN IT LOOKS
 *   The app-wide ErrorBoundary (App.jsx) replaces the ENTIRE UI with an
 *   error card — sidebar included. So a render error here would take the
 *   "back to classic" toggle down with it, and the only way out would be a
 *   deploy. That is precisely what this feature must be immune to.
 *
 *   It has already earned its keep once: the first version of this shipped
 *   with a crash in the (since removed) director board, and this is what
 *   put people back on the classic Home instead of stranding them.
 *
 *   If it throws: the classic Home renders in its place, the opt-in is
 *   switched back off so a reload doesn't loop into the same crash, and a
 *   quiet line explains what happened.
 */
class NewHomeBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error('[InstructorHome] fell back to the classic home:', error, info);
    try { setNewLook(this.props.uid, false); } catch { /* storage blocked */ }
  }

  render() {
    if (this.state.failed) {
      return (
        <>
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            The new home page hit an error, so you&apos;re back on the classic one.
            Nothing else is affected — and nothing was lost.
          </div>
          <Home />
        </>
      );
    }
    return this.props.children;
  }
}

export default function HomeSwitch() {
  const auth = useAuth();
  const uid = auth.profile?.uid;

  // Leadership never gets it, whatever their stored preference says.
  if (!canUseNewLook(auth) || !isNewLookOn(uid)) return <Home />;

  return (
    <NewHomeBoundary uid={uid}>
      <Suspense fallback={<div className="p-6 text-sm text-gray-500">Loading…</div>}>
        <InstructorHome />
      </Suspense>
    </NewHomeBoundary>
  );
}
