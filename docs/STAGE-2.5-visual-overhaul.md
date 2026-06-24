# Stage 2.5 — Visual & Layout Overhaul

**Status: complete.** A focused visual + layout pass over the existing app — no new
agent/editor capabilities. Triangle is reskinned to the Trifecta desktop "master"
design language (dark-mode interpretation) and the hand-rolled splitter is replaced
with a real dockable/movable split-pane workspace. All Stage 1/2 functionality and
the typed IPC contract are preserved. See [ADR 0006](adr/0006-visual-design-and-dock-layout.md).

## What changed

### Design system (centralized tokens)

`renderer/src/styles.css` now carries a token system mirroring Trifecta's resolved
dark theme — nothing is hardcoded per-component:

- **Surfaces** built from `color-mix` + alpha-white layers: `--background` (near-black
  neutral-950 lifted 5% toward white), `--card`, `--popover`, and `--muted/--accent`
  (4–8% white). Borders are `--border` (6% white) / `--border-strong` (12%).
- **Primary** = indigo `oklch(0.588 0.217 264)` (replaces the old coral accent).
- **Radius scale** (`--radius` 10px → `--radius-2xl` 18px), **semantic colors**
  (`--info/--success/--warning/--destructive` + foregrounds), a `--bevel-top`
  "lit-from-above" inset highlight, **DM Sans / SF Mono** type, a faint fractal-noise
  grain over the window, and 4–8px alpha-white scrollbars.
- A semantic **z-index scale** and a `:focus-visible` ring built from the primary.
- Legacy token names (`--bg`, `--text-dim`, …) are aliased to the new ones so nothing
  breaks.

The Monaco `triangle-dark` theme (`monaco/setup.ts`) was re-tuned to the same palette
(indigo cursor/selection, neutral-950 surfaces) so the editor stays visually
consistent.

### Dockable, movable workspace (dockview)

The bespoke `Splitter` is gone. The workspace is now [dockview](https://dockview.dev)
(`dockview-react@6.6.1`), themed through its `--dv-*` variables on top of
`dockview-theme-dark`:

- Four panels — **Explorer · Editor · Preview · Agent** — that are **resizable**
  (drag the sashes), **movable / re-dockable** (drag tabs to rearrange or stack),
  **floatable**, and **collapsible/restorable**.
- Default arrangement is built on first run; the layout is **persisted** to
  `localStorage` and **restored** on launch. The TopBar has **Reset layout** plus
  Explorer/Agent toggles.
- Panels read live app state from a `WorkspaceContext` (dockview renders panel
  components inside the React tree), so hot-reload, save/dirty, and the file watcher
  keep working untouched.

### Component reskin + iconography

Every component was restyled to the new chrome (cards, bevels, badges, the composer
frame, tool traces, the approval gate) and all emoji/unicode glyphs were replaced with
[`lucide-react@1.18.0`](https://lucide.dev) stroke icons (TopBar, StatusBar, FileTree,
Editor, Preview toolbar, AgentPanel).

### Harness picker (Trifecta model-picker port)

The agent panel's native `<select>` is now a **`HarnessPicker`** popover modeled on
Trifecta's model picker: a trigger showing the active harness (icon + name + chevron)
and a searchable list of icon / name / subtitle rows with availability, hover +
selected states, a 4px thin scrollbar, and a check on the active harness.

## What did NOT change

- Main process, preload bridge, and the `@triangle/shared` IPC/agent contracts.
- Agent orchestration (Claude SDK / Codex CLI / Mock), the approval gate, and
  auto-approve behaviour.
- Editor save/dirty + `suppressWatch` hot-reload path, GLSL language support, the
  preview runtime, and credential handling.

## Verification performed

- `pnpm typecheck` — clean across all workspace packages.
- `pnpm build` — main, preload, and renderer bundles (incl. Monaco workers, dockview,
  lucide) build successfully.
- Boot smoke test — app launches, main initializes the project + `AgentManager`, the
  renderer mounts the dockview workspace and queries harness availability, no console
  errors.

## Known limitations

- Moving / closing / restoring a panel remounts its component, so the Preview re-inits
  its Three.js runtime and the editor resets undo history on such moves (same
  single-model trade-off as ADR 0004).
- Screenshot-based visual verification wasn't possible in the build environment
  (no display capture); verification was typecheck + build + a clean boot.
- The accent brand shifted coral → indigo to match the master faithfully; reverting is
  a one-token change (`--primary`/`--ring` + the matching Monaco hex).
