/**
 * V1 — Scoped approval and guardrails (ADR 0028).
 *
 * A `Scope` constrains which project paths an agent run may write to. The
 * `ApprovalGate` enforces it before any tool write reaches disk: writes inside
 * the scope follow the existing approval policy (auto-approve or human gate);
 * writes outside the scope are rejected outright with a structured log event so
 * the agent can self-correct. This preserves Triangle's aggressive auto-approve
 * ergonomics (the default project-wide scope auto-approves everything) while
 * giving users a dial to narrow the blast radius when desired.
 */

/**
 * A path-matching scope that constrains agent writes. A path is in-scope when:
 * - `mode === 'project'` — always (the default; preserves autoApproveWrites).
 * - `mode === 'allow'` — it matches any glob in `paths`.
 * - `mode === 'deny'` — it does NOT match any glob in `paths`.
 * - `mode === 'readonly'` — never (all writes rejected).
 *
 * Globs are project-relative (e.g. `"src/**"`, `"assets/**"`, `"*.glsl"`). A
 * bare directory name matches everything under it (`"src"` is equivalent to
 * `"src/**"`). `*` matches within a path segment; `**` matches across segments.
 */
export type Scope =
  | { mode: 'project' }
  | { mode: 'readonly' }
  | { mode: 'allow'; paths: string[] }
  | { mode: 'deny'; paths: string[] };

/**
 * A policy tier bundles a scope with a label for the UI dropdown. The
 * `project` tier is the default and preserves the existing autoApproveWrites
 * behavior (aggressive, project-wide). `readonly` rejects all writes. `allow`
 * / `deny` narrow or widen the scope with a custom path list.
 */
export type PolicyTier = 'project' | 'source' | 'assets' | 'readonly' | 'custom';

/** The canonical scope for each named policy tier. */
export const TIER_SCOPES: Record<PolicyTier, Scope> = {
  project: { mode: 'project' },
  source: { mode: 'allow', paths: ['src/**', '*.js', '*.ts', '*.glsl', '*.wgsl', '*.json'] },
  assets: { mode: 'allow', paths: ['assets/**', '*.glb', '*.gltf', '*.obj', '*.usdz', '*.hdr'] },
  readonly: { mode: 'readonly' },
  custom: { mode: 'allow', paths: [] },
};

/** Human-readable labels for the policy tier dropdown. */
export const TIER_LABELS: Record<PolicyTier, string> = {
  project: 'Project-wide',
  source: 'Source only',
  assets: 'Assets only',
  readonly: 'Read-only',
  custom: 'Custom',
};

/**
 * Check whether a project-relative path is in-scope for the given scope. Pure
 * and side-effect-free so it is unit-testable without a ProjectManager.
 */
export function isPathInScope(path: string, scope: Scope): boolean {
  switch (scope.mode) {
    case 'project':
      return true;
    case 'readonly':
      return false;
    case 'allow':
      return scope.paths.some((p) => globMatch(p, path));
    case 'deny':
      return !scope.paths.some((p) => globMatch(p, path));
  }
}

/**
 * Minimal glob matcher supporting `*` (within a segment) and `**` (across
 * segments). A pattern with no wildcard matches exactly (or as a directory
 * prefix — `"src"` matches `"src/main.js"`). Project-relative; leading `./` is
 * stripped. Case-sensitive (project paths are).
 */
export function globMatch(pattern: string, path: string): boolean {
  const norm = (s: string) => s.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
  const pat = norm(pattern);
  const p = norm(path);
  // A bare name with no slash and no wildcard is a directory prefix match.
  if (!pat.includes('*') && !pat.includes('/')) {
    return p === pat || p.startsWith(pat + '/');
  }
  // A pattern ending with `/**` matches everything under that dir.
  if (pat.endsWith('/**')) {
    const dir = pat.slice(0, -3);
    return p === dir || p.startsWith(dir + '/');
  }
  return globToRegex(pat).test(p);
}

/** Convert a glob pattern (with `*` and `**`) to a RegExp. */
function globToRegex(glob: string): RegExp {
  // Split on `/` to handle `**` segment-by-segment. `**` matches any number
  // of path segments (including zero); `*` matches within one segment.
  const segments = glob.split('/');
  let re = '^';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === '**') {
      // `**` matches zero or more path segments. Insert `(.*/)?` but avoid
      // double slashes. If it's the last segment, match to the end.
      re += '.*';
      // Skip the next separator (the `/` after `**` is consumed by `.*`).
      continue;
    }
    if (i > 0) re += '/';
    // Escape regex special chars in the segment, then replace `\*` with `[^/]*`.
    re += seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  }
  re += '$';
  return new RegExp(re);
}
