import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guards against the one mistake that takes a whole page down and that
 * NOTHING else in this project catches.
 *
 * A hook's dependency array is evaluated during render, immediately. So a
 * dep that names a `const` declared further down the component is a
 * guaranteed "Cannot access 'X' before initialization" — a const sits in
 * the temporal dead zone until its own line runs, and unlike a function
 * declaration it is not hoisted.
 *
 * It shipped once: `openSignOuts = useMemo(..., [comparisonSummary])` was
 * inserted ~100 lines ABOVE `const comparisonSummary = useMemo(...)`, and
 * Manage Payroll died on open. `vite build` succeeded, eslint was clean and
 * all 658 unit tests passed, because the fault only exists while React is
 * rendering — which no test here does.
 *
 * `no-use-before-define` would flag it, but it also flags 19 pre-existing
 * and entirely safe deferred references (a callback naming something
 * defined below it runs later, so it's fine). This check is narrow on
 * purpose: only dependency arrays, which always run now.
 */

const SRC = path.resolve(import.meta.dirname, '..');

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...sourceFiles(full)); continue; }
    if (!/\.jsx?$/.test(entry.name)) continue;
    if (/\.test\.jsx?$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

/** Identifiers in a dep array, ignoring property names in `a.b` / `a?.b`. */
function depIdentifiers(depSource) {
  // Drop the property half of every member access first, so `centerConfig
  // ?.holidays` contributes `centerConfig` and NOT `holidays` — otherwise a
  // later `const holidays` reads as a false hazard.
  const withoutProps = depSource.replace(/(\?\.|\.)\s*[A-Za-z_$][\w$]*/g, '');
  return [...new Set(withoutProps.match(/[A-Za-z_$][\w$]*/g) || [])];
}

/** Byte offset of the matching close paren for the `(` at `open`. */
function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Offsets where each top-level function starts.
 *
 * Admin.jsx holds a couple of dozen components in one file, all of whose
 * bodies sit at the same indentation — so depth alone would happily pair a
 * hook in one component with a const in another 4,000 lines away. A dep can
 * only resolve to a binding in the SAME function body.
 */
function topLevelStarts(src) {
  const starts = [0];
  for (const m of src.matchAll(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*|^(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(/gm)) {
    starts.push(m.index);
  }
  return starts;
}

/** Which top-level function contains `offset`. */
function segmentOf(starts, offset) {
  let seg = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= offset) seg = i; else break;
  }
  return seg;
}

/** Leading-whitespace width of the line containing `offset`. */
function indentAt(src, offset) {
  const lineStart = src.lastIndexOf('\n', offset - 1) + 1;
  const m = /^[ \t]*/.exec(src.slice(lineStart, offset + 200));
  return m ? m[0].length : 0;
}

export function findRenderOrderHazards(src) {
  // Indentation stands in for scope. A hook and the const it depends on are
  // only in the same function body if they sit at the same depth; a name
  // declared deeper is a different scope and cannot be the binding the dep
  // array resolves to. Crude, but it removes every false positive across
  // this codebase while still catching the real thing, and it needs no
  // parser. A proper scope analysis would be the upgrade if this ever
  // misses something.
  const starts = topLevelStarts(src);
  const declaredAt = new Map();          // name -> [{ offset, indent, seg }]
  for (const m of src.matchAll(/^([ \t]*)(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm)) {
    const list = declaredAt.get(m[2]) || [];
    list.push({ offset: m.index, indent: m[1].length, seg: segmentOf(starts, m.index) });
    declaredAt.set(m[2], list);
  }

  const hazards = [];
  for (const m of src.matchAll(/\b(useMemo|useEffect|useCallback|useLayoutEffect)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close < 0) continue;
    const call = src.slice(open, close);
    const deps = call.match(/,\s*\[([\s\S]*?)\]\s*$/);
    if (!deps) continue;
    // The hook call may be assigned (`  const x = useMemo(`), so measure the
    // statement's own indentation, not the identifier's column.
    const hookIndent = indentAt(src, m.index);
    const hookSeg = segmentOf(starts, m.index);
    for (const ident of depIdentifiers(deps[1])) {
      const sameScope = (declaredAt.get(ident) || [])
        .filter(d => d.indent === hookIndent && d.seg === hookSeg);
      // Only a hazard when EVERY same-scope declaration comes later — if one
      // sits above the hook, that is the binding being referenced.
      if (sameScope.length === 0) continue;
      if (sameScope.some(d => d.offset < m.index)) continue;
      hazards.push({
        hook: m[1], ident,
        usedLine: src.slice(0, m.index).split('\n').length,
        declaredLine: src.slice(0, sameScope[0].offset).split('\n').length,
      });
    }
  }
  return hazards;
}

describe('findRenderOrderHazards', () => {
  it('catches the exact bug that broke Manage Payroll', () => {
    const broken = `
      const openSignOuts = useMemo(() => {
        if (!comparisonSummary) return [];
        return [];
      }, [comparisonSummary]);

      const comparisonSummary = useMemo(() => ({}), [radiusData]);
    `;
    const found = findRenderOrderHazards(broken);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ hook: 'useMemo', ident: 'comparisonSummary' });
  });

  it('accepts the same code once the order is right', () => {
    const fixed = `
      const comparisonSummary = useMemo(() => ({}), [radiusData]);

      const openSignOuts = useMemo(() => {
        if (!comparisonSummary) return [];
        return [];
      }, [comparisonSummary]);
    `;
    expect(findRenderOrderHazards(fixed)).toEqual([]);
  });

  it('does not trip over a property that shares a name with a later const', () => {
    const fine = `
      useEffect(() => { sync(); }, [centerConfig?.holidays]);
      const holidays = localHolidays;
    `;
    expect(findRenderOrderHazards(fine)).toEqual([]);
  });
});

describe('every source file', () => {
  const files = sourceFiles(SRC);

  it('has something to check', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('never names a later-declared binding in a hook dependency array', () => {
    const problems = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const h of findRenderOrderHazards(src)) {
        problems.push(
          `${path.relative(SRC, file)}:${h.usedLine} — ${h.hook} depends on `
          + `"${h.ident}", declared later at line ${h.declaredLine}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});
