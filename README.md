# Triangle

**An agentic development engine for Three.js.**

Triangle is a desktop-first (Electron) environment purpose-built to make AI coding
and creative agents reliably effective at shader-heavy, interactive 3D web work. It
pairs a focused three-panel UI with a high-fidelity live Three.js preview and a
harness-agnostic agent layer.

```
┌──────────────┬───────────────────────────┬──────────────┐
│              │                           │              │
│  Mini-editor │   Three.js live preview   │  AI agent    │
│  + file tree │   (hot-reload, orbit,     │  panel       │
│              │    screenshot, stats)     │  (chat +     │
│              │                           │   harness)   │
└──────────────┴───────────────────────────┴──────────────┘
```

## Status

**Stage 1 — Core Shell & Live Preview** (current). See
[`docs/STAGE-1.md`](docs/STAGE-1.md) for what's delivered and how to run it.

The full roadmap lives in [`docs/ROADMAP.md`](docs/ROADMAP.md).

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
