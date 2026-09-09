import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  doorsFor, resolveDoor, readPreferredDoor, setPreferredDoor,
  setNewLook, DOOR_LABELS,
} from '../lib/newLook';
import InstructorHome from './homes/InstructorHome';
import HostHome from './homes/HostHome';
import DirectorHome from './homes/DirectorHome';
import OwnerHome from './homes/OwnerHome';

/**
 * NewHome — picks which of the four front doors a person lands on.
 *
 * The portal has one Home today, shaped like an owner's tool, which every
 * other role receives with most of it hidden. This replaces it with four
 * homes, one per job, and nothing else about the app changes: every
 * existing page is reachable and unmodified.
 *
 * ENTITLEMENT IS NOT INVENTED HERE. `doorsFor` reads the same permission
 * booleans the rest of the app enforces (see src/lib/newLook.js), so this
 * grants nobody anything they could not already see — and a centre role
 * created in Manage Roles reaches the right door without a code change.
 *
 * Anyone holding more than one door gets a switcher, because the roles
 * genuinely overlap: Rahul hosts AND teaches, and Vin is a director who
 * still works shifts.
 */
export default function NewHome() {
  const auth = useAuth();
  const uid = auth.profile?.uid;
  const allowed = doorsFor(auth);
  const [door, setDoor] = useState(() => resolveDoor(auth, readPreferredDoor(uid)));

  const active = allowed.includes(door) ? door : allowed[0];

  const choose = (d) => {
    setDoor(d);
    setPreferredDoor(uid, d);
  };

  return (
    <div className="nl">
      {allowed.length > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {allowed.map(d => (
            <button key={d} type="button" onClick={() => choose(d)}
              className="rounded-full px-3.5 py-1.5 text-[12.5px] font-bold transition-colors"
              style={active === d
                ? { background: 'var(--nl-brand)', color: '#fff' }
                : { background: 'var(--nl-raised)', color: 'var(--nl-muted)' }}>
              {DOOR_LABELS[d]}
            </button>
          ))}
          <span className="ml-auto text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>
            Preview ·{' '}
            <button type="button"
              onClick={() => { setNewLook(uid, false); window.location.reload(); }}
              className="font-bold underline underline-offset-2"
              style={{ color: 'var(--nl-brand)' }}>
              back to classic
            </button>
          </span>
        </div>
      )}

      {allowed.length === 1 && (
        <div className="mb-4 text-right text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>
          Preview ·{' '}
          <button type="button"
            onClick={() => { setNewLook(uid, false); window.location.reload(); }}
            className="font-bold underline underline-offset-2"
            style={{ color: 'var(--nl-brand)' }}>
            back to classic
          </button>
        </div>
      )}

      {active === 'owner' && <OwnerHome />}
      {active === 'director' && <DirectorHome />}
      {active === 'host' && <HostHome />}
      {active === 'instructor' && <InstructorHome />}
    </div>
  );
}
