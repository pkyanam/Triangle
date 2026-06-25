/**
 * Tiny, dependency-free line diff for the approval gate's diff view (ADR 0012).
 *
 * Two entry points feed the same row model:
 *  - {@link lineDiff} computes an LCS-based diff between two text blobs (used for
 *    Triangle tool writes, where main hands us the old + new file contents).
 *  - {@link parseUnifiedDiff} parses a precomputed unified diff string (used for
 *    Codex `fileChange` items, which already carry one).
 *
 * Inputs are already clipped to a few KB in main, so the O(n·m) LCS is fine.
 */

export type DiffRowKind = 'add' | 'del' | 'context' | 'hunk';

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  /** 1-based line number on the old side (absent for additions / hunk headers). */
  oldNo?: number;
  /** 1-based line number on the new side (absent for deletions / hunk headers). */
  newNo?: number;
}

export interface DiffStats {
  additions: number;
  deletions: number;
}

/** Split into lines without a trailing empty element for a final newline. */
function toLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Longest-common-subsequence line diff. */
export function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = toLines(oldText);
  const b = toLines(newText);
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'context', text: a[i], oldNo: oldNo++, newNo: newNo++ });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ kind: 'del', text: a[i], oldNo: oldNo++ });
      i++;
    } else {
      rows.push({ kind: 'add', text: b[j], newNo: newNo++ });
      j++;
    }
  }
  while (i < n) rows.push({ kind: 'del', text: a[i++], oldNo: oldNo++ });
  while (j < m) rows.push({ kind: 'add', text: b[j++], newNo: newNo++ });
  return rows;
}

/** Parse a unified diff string (Codex `fileChange.diff`) into rows. */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of diff.split('\n')) {
    // Skip file headers; they aren't useful inline.
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — ignore.
    } else {
      const text = line.startsWith(' ') ? line.slice(1) : line;
      rows.push({ kind: 'context', text, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return rows;
}

/** Count additions / deletions in a set of rows. */
export function diffStats(rows: DiffRow[]): DiffStats {
  let additions = 0;
  let deletions = 0;
  for (const r of rows) {
    if (r.kind === 'add') additions++;
    else if (r.kind === 'del') deletions++;
  }
  return { additions, deletions };
}
