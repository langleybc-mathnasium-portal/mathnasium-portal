import { Link } from 'react-router-dom';

/**
 * The small shared vocabulary the four doors are built from.
 *
 * Kept deliberately short. Border, fill, radius and shadow each say
 * "separate object", and the classic portal spends all four on every block,
 * which flattens the hierarchy until nothing looks more important than
 * anything else. Here a Card is quiet by default and only the one thing
 * that needs attention gets to be loud.
 */

export function Lbl({ children, className = '' }) {
  return (
    <div className={`text-[10px] font-bold uppercase tracking-[0.14em] ${className}`}
      style={{ color: 'var(--nl-muted)' }}>
      {children}
    </div>
  );
}

export function Card({ children, className = '', tone = 'plain', ...rest }) {
  const tones = {
    plain: { background: 'var(--nl-card)', borderColor: 'var(--nl-rule)' },
    warn:  { background: 'var(--nl-warnw)', borderColor: 'var(--nl-warn)' },
    note:  { background: 'var(--nl-notew)', borderColor: 'var(--nl-note)' },
    ok:    { background: 'var(--nl-okw)', borderColor: 'var(--nl-ok)' },
  };
  return (
    <div className={`rounded-xl border p-4 ${className}`} style={tones[tone] || tones.plain} {...rest}>
      {children}
    </div>
  );
}

export function Pill({ children, tone = 'flat', className = '' }) {
  const tones = {
    flat:  { background: 'var(--nl-raised)', color: 'var(--nl-muted)' },
    ok:    { background: 'var(--nl-okw)',    color: 'var(--nl-ok)' },
    warn:  { background: 'var(--nl-warnw)',  color: 'var(--nl-warn)' },
    note:  { background: 'var(--nl-notew)',  color: 'var(--nl-note)' },
    brand: { background: 'var(--nl-brandw)', color: 'var(--nl-brand)' },
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px] font-bold ${className}`}
      style={tones[tone] || tones.flat}>
      {children}
    </span>
  );
}

/** One action. Filled means "this is the thing to do". */
export function Btn({ children, to, onClick, variant = 'solid', size = 'md', className = '', ...rest }) {
  const sizes = {
    md: 'px-4 py-2.5 text-sm rounded-xl',
    sm: 'px-3 py-1.5 text-[13px] rounded-lg',
  };
  const variants = {
    solid: { background: 'var(--nl-brand)', color: '#fff', border: '1.5px solid var(--nl-brand)' },
    ghost: { background: 'transparent', color: 'var(--nl-brand)', border: '1.5px solid var(--nl-brand)' },
    quiet: { background: 'var(--nl-raised)', color: 'var(--nl-ink2)', border: '1.5px solid transparent' },
  };
  const cls = `inline-flex items-center justify-center gap-2 font-bold transition-opacity hover:opacity-90 ${sizes[size]} ${className}`;
  if (to) return <Link to={to} className={cls} style={variants[variant]} {...rest}>{children}</Link>;
  return <button type="button" onClick={onClick} className={cls} style={variants[variant]} {...rest}>{children}</button>;
}

/** A figure with its name under it. Used sparingly — not every number is a tile. */
export function Stat({ n, k, tone, sub }) {
  return (
    <Card>
      <div className="nl-display text-[26px] font-bold leading-none"
        style={{ color: tone || 'var(--nl-ink)' }}>{n}</div>
      <div className="mt-1.5 text-[12px]" style={{ color: 'var(--nl-muted)' }}>{k}</div>
      {sub && <div className="mt-0.5 text-[11px]" style={{ color: 'var(--nl-muted)' }}>{sub}</div>}
    </Card>
  );
}

export function Meter({ value, max, tone }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: 'var(--nl-raised)' }}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: tone || 'var(--nl-ok)' }} />
    </div>
  );
}

/**
 * The healthy state, said out loud.
 *
 * An empty region leaves a reader wondering whether it's empty or broken.
 * A page whose good state is "nothing here" should say that it is good.
 */
export function AllClear({ title, note }) {
  return (
    <div className="rounded-xl border border-dashed p-6 text-center"
      style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }}>
      <div className="nl-display text-[17px] font-semibold">{title}</div>
      {note && <div className="mt-1 text-[13px]" style={{ color: 'var(--nl-muted)' }}>{note}</div>}
    </div>
  );
}

/** Shown while a door's data is still arriving, so nothing renders a fake zero. */
export function Loading({ label = 'Loading…' }) {
  return (
    <div className="rounded-xl border p-6 text-center text-[13px]"
      style={{ borderColor: 'var(--nl-rule)', color: 'var(--nl-muted)', background: 'var(--nl-card)' }}>
      {label}
    </div>
  );
}
