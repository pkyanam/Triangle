# ADR 0006 — Visual design system & dockable pane layout

- **Status:** Accepted
- **Date:** 2026-06-24

## Context

Stages 1–2 shipped a functional three-panel shell with a hand-rolled CSS palette
(`--accent: #ff5533` coral) and a bespoke `Splitter` that supported horizontal
resize + double-click collapse only — panels could not be moved, re-docked, or
rearranged. Stage 2.5 is a focused visual + layout overhaul (no new agent/editor
capabilities): adopt a proven "master" design language and give the workspace
real, movable split-pane behaviour, while keeping all Stage 1/2 functionality and
the typed IPC contract (ADR 0003) intact.

The reference "master" design is the Trifecta desktop web UI — a React + Tailwind 4
app whose dark theme is a low-contrast surface system built from alpha-white layers,
a vivid indigo primary, soft "lit-from-above" bevel highlights, DM Sans / SF Mono
type, a faint fractal-noise grain, 4–6px scrollbars, and 150–200ms motion.

## Decision

- **Adopt the Trifecta design language as a dark-mode interpretation**, expressed
  through the existing centralized CSS-variable approach in `styles.css`. Tokens
  mirror Trifecta's resolved values: surfaces via `color-mix`/alpha-white
  (`--background`, `--card`, `--popover`, `--muted`, `--accent`), a radius scale
  (`--radius*`), semantic colors (`--info/--success/--warning/--destructive`), and a
  `--bevel-top` highlight. **The primary accent is Trifecta's indigo**
  (`oklch(0.588 0.217 264)`), replacing the coral brand — a deliberate choice to
  match the master faithfully (the operator's call); the Monaco `triangle-dark` theme
  (ADR 0004) was re-tuned to the same palette so the editor stays consistent. Legacy
  token names are kept as aliases so no stray reference breaks.
- **Replace the hand-rolled `Splitter` with [dockview](https://dockview.dev)**
  (`dockview-react`) for the workspace. dockview gives resizable sashes **plus**
  drag-to-rearrange, dockable/stacked tab groups, floating panels, and
  collapse/restore — the behaviours the brief requires and the bespoke splitter
  could never provide. We pinned `dockview-react@6.6.1` (a release ≥7 days old) and
  theme it entirely through its `--dv-*` CSS variables on top of `dockview-theme-dark`,
  so it folds into the Triangle palette with no forked CSS.
- **Feed panels via React context, not panel params.** dockview renders its panel
  components inside the React tree, so the four panels (Explorer, Editor, Preview,
  Agent) read live state (entry source, selected file, handlers) from a
  `WorkspaceContext` rather than imperative `updateParameters`. Layout is persisted to
  `localStorage` (`api.toJSON`/`fromJSON`) and a TopBar action resets it; the TopBar
  also toggles the Explorer/Agent panels.
- **Iconography → `lucide-react`** (pinned `1.18.0`), replacing the emoji/unicode
  glyphs across every component for a consistent stroke-icon set.
- **Port Trifecta's model picker as the `HarnessPicker`** — a popover trigger that
  shows the active harness and a searchable list of icon/name/subtitle rows with
  availability, hover/selected states, and a check on the active one — replacing the
  native `<select>` in the agent panel.

## Consequences

- The renderer gains two UI dependencies (`dockview-react`, `lucide-react`). Both are
  renderer-only; the main process, preload bridge, and IPC contract are untouched, so
  Stage 1/2 behaviour (hot-reload, save/dirty, agent harnesses, approval gate) is
  preserved.
- Panels are now movable/floatable/stackable. Because dockview owns mounting, a panel
  that is dragged, closed, or restored remounts its component — so Preview re-inits its
  Three.js runtime and the editor resets undo history on such moves (acceptable; the
  same single-model trade-off as ADR 0004).
- The brand accent shifted coral → indigo. The Triangle logo asset is unchanged; if the
  coral brand is wanted back, only the `--primary`/`--ring` tokens (and the matching
  Monaco hex) need to change.
- Persisted layouts are versioned (`triangle.layout.v2`); bumping the key invalidates
  stale layouts after structural changes.
