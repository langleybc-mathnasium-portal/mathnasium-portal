import { Component, Suspense, lazy } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { isNewLookOn, setNewLook } from '../lib/newLook';
import Home from './Home';

const NewHome = lazy(() => import('./NewHome'));

/**
 * HomeSwitch — classic Home, or the opt-in role-shaped one, with a floor
 * under it.
 *
 * WHY THE LOCAL BOUNDARY MATTERS MORE THAN IT LOOKS
 *   The app-wide ErrorBoundary (App.jsx) replaces the ENTIRE UI with an
 *   error card — sidebar included. So a render error in a new home page
 *   would take the "Back to classic" toggle down with it, and the only way
 *   out would be a deploy. That is precisely the situation this feature is
 *   supposed to be immune to.
 *
 *   So the new home gets its own boundary. If it throws: the classic Home
 *   renders in its place, the opt-in is switched back off so a reload
 *   doesn't loop straight back into the broken page, and a quiet line
 *   explains what happened. The portal keeps working.
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
    console.error('[NewHome] fell back to the classic home:', error, info);
    // Disarm the opt-in so the next load isn't the same crash again.
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
  const { profile } = useAuth();
  const uid = profile?.uid;

  if (!isNewLookOn(uid)) return <Home />;

  return (
    <NewHomeBoundary uid={uid}>
      <Suspense fallback={<div className="p-6 text-sm text-gray-500">Loading…</div>}>
        <NewHome />
      </Suspense>
    </NewHomeBoundary>
  );
}
