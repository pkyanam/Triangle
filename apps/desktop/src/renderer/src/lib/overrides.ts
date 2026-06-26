import type { SceneEdit } from '@triangle/shared';

/**
 * The Inspector persists live edits by maintaining an auto-managed block at the
 * end of the entry module that exports a `__triangleOverrides` array. The preview
 * runtime re-applies these as SceneEdits after each hot-reload, so "Apply to
 * source" survives reloads without trying to rewrite hand-authored code.
 */
const START = '// <triangle:overrides>';
const END = '// </triangle:overrides>';

function editKey(edit: SceneEdit): string {
  return `${edit.op}:${edit.target}`;
}

/** Parse the existing overrides array from a source string (best-effort). */
function parseExisting(source: string): SceneEdit[] {
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start === -1 || end === -1 || end < start) return [];
  const block = source.slice(start, end);
  const match = block.match(/\[([\s\S]*)\]\s*;/);
  if (!match) return [];
  try {
    return JSON.parse(`[${match[1]}]`) as SceneEdit[];
  } catch {
    return [];
  }
}

/** Remove the managed block (and surrounding blank lines) from a source string. */
function stripBlock(source: string): string {
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start === -1 || end === -1 || end < start) return source;
  return `${source.slice(0, start)}${source.slice(end + END.length)}`.replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * Upsert `edits` into the managed overrides block of `source`, keyed by op+target
 * so re-applying the same field replaces (rather than duplicates) it. Returns the
 * new source text.
 */
export function upsertOverridesBlock(source: string, edits: SceneEdit[]): string {
  const merged = new Map<string, SceneEdit>();
  for (const e of parseExisting(source)) merged.set(editKey(e), e);
  for (const e of edits) merged.set(editKey(e), e);

  const list = [...merged.values()];
  const body = list.map((e) => `  ${JSON.stringify(e)}`).join(',\n');
  const block = `${START} Inspector-managed; edit transforms in-app and click Apply.\nexport const __triangleOverrides = [\n${body}\n];\n${END}`;

  const base = stripBlock(source);
  return `${base}\n\n${block}\n`;
}
