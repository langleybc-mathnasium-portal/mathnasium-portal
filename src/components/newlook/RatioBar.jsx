import { ratioOf, ratioHealth, unitDots } from '../../lib/ratioShape';

/**
 * RatioBar — the one recurring mark in the new look.
 *
 * ● an instructor, ○ a student, dashed ○ a student nobody is covering.
 *
 * WHY IT EXISTS
 *   1:3.5 is the number the whole centre turns on, and it currently shows
 *   up as text on some pages and not at all on others. Making it a single
 *   drawn object means the host checking the floor, the director planning
 *   the week and the owner reading the month are all looking at the same
 *   shape — so a conversation between them is about the same thing.
 *
 * IT DRAWS THE UNIT RATIO, NOT THE HEADCOUNT
 *   Four instructors and fourteen students is eighteen dots, which is a
 *   crowd, not a glance. So it draws what one instructor's share of the
 *   room looks like — ●○○○ — which is the thing a person actually feels
 *   when they walk in. The exact numbers sit beside it as text.
 */
export default function RatioBar({
  instructors,
  students,
  size = 9,
  className = '',
  showLabel = false,
}) {
  const ratio = ratioOf(instructors, students);
  const health = ratioHealth(ratio);
  const { covered, uncovered } = unitDots(instructors, students);

  const tone = health === 'ok' ? 'var(--nl-ok)'
             : health === 'warn' ? 'var(--nl-warn)'
             : health === 'over' ? 'var(--nl-brand)'
             : 'var(--nl-muted)';

  return (
    <span className={`inline-flex items-center gap-[3px] ${className}`}
      style={{ color: tone }}
      title={ratio == null
        ? 'No ratio yet'
        : `${instructors} on the floor, ${students} students — 1:${ratio.toFixed(1)}`}>
      {instructors > 0 && <i className="nl-dot nl-dot--t" style={{ '--d': `${size}px` }} />}
      {Array.from({ length: covered }, (_, i) => (
        <i key={`c${i}`} className="nl-dot" style={{ '--d': `${size}px` }} />
      ))}
      {Array.from({ length: uncovered }, (_, i) => (
        <i key={`u${i}`} className="nl-dot nl-dot--gap" style={{ '--d': `${size}px` }} />
      ))}
      {showLabel && (
        <b className="ml-2 text-[13px] font-bold" style={{ color: tone }}>
          {ratio == null ? '—' : `1:${ratio.toFixed(1)}`}
        </b>
      )}
    </span>
  );
}
