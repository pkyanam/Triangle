# Triangle

**An agentic development engine for Three.js.**

Triangle is a desktop-first (Electron) environment purpose-built to make AI coding
and creative agents reliably effective at shader-heavy, interactive 3D web work. It
pairs a focused three-panel UI with a high-fidelity live Three.js preview and a
harness-agnostic agent layer.

```
┌──────────┬──────────────┬───────────────────────┬──────────────┐
│          │              │                       │              │
│ Explorer │  Mini-editor │  Three.js live preview │  AI agent    │
│  (tree)  │  (Monaco)    │  (hot-reload, orbit,   │  panel       │
│          │              │   screenshot, stats)   │  (chat +     │
│          │              │                        │   harness)   │
└──────────┴──────────────┴───────────────────────┴──────────────┘
   resizable · movable · dockable · collapsible (dockview)
```

## Status

**Stage 2.5 — Visual & Layout Overhaul** (current): a focused reskin to the Trifecta
desktop design language (dark, indigo, DM Sans / SF Mono) and a real dockable/movable
split-pane workspace (dockview) with persisted layout, plus a Trifecta-style agent
harness picker. No new agent/editor capabilities. See
[`docs/STAGE-2.5-visual-overhaul.md`](docs/STAGE-2.5-visual-overhaul.md) and
[ADR 0006](docs/adr/0006-visual-design-and-dock-layout.md).

**Stage 2 — Editor + Basic Agent Orchestration**: a Monaco editor (JS/TS/GLSL)
with live save → hot-reload, plus a real agent layer (Claude Agent SDK + Codex CLI) that
can read and edit the project behind a human-approval gate. See
[`docs/STAGE-2.md`](docs/STAGE-2.md). Stage 1 (core shell & live preview) is documented in
[`docs/STAGE-1.md`](docs/STAGE-1.md).

The full roadmap lives in [`docs/ROADMAP.md`](docs/ROADMAP.md).

### Agent credentials

Triangle reads agent credentials from the environment or a gitignored config — never
committed. The Claude harness needs `ANTHROPIC_API_KEY`; the Codex harness needs the
`codex` CLI on PATH. See [`docs/STAGE-2.md`](docs/STAGE-2.md#configuration-credentials).

## Repository layout

This is a [pnpm](https://pnpm.io) workspace monorepo.

```
triangle/
├── apps/
│   └── desktop/            # Electron app (main + preload + React renderer)
├── packages/
│   ├── shared/             # Shared TS types: IPC contract + agent tool schemas
│   └── preview-runtime/    # Framework-agnostic Three.js preview engine
├── templates/
│   └── starter/            # Default Three.js project loaded by the preview
└── docs/                   # Architecture decision records, roadmap, stage notes
```

## Prerequisites

- **Node.js** ≥ 20 (developed on Node 24)
- **pnpm** ≥ 9 (`npm i -g pnpm`)

## Quick start

```bash
pnpm install          # install all workspace deps
pnpm dev              # launch the Electron app in dev mode (HMR)
```

Other useful scripts:

```bash
pnpm build            # typecheck + build all packages and the desktop app
pnpm typecheck        # typecheck every workspace package
pnpm package          # produce a distributable desktop build (electron-builder)
```

## License

MIT — see [`LICENSE`](LICENSE).
