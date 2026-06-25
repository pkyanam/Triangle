<div align="center">

<img src="triangleLogo.jpg" alt="Triangle" width="96" height="96" />

# Triangle

### An agentic development engine for Three.js

Triangle is a desktop-first environment purpose-built to make AI coding and creative
agents reliably effective at shader-heavy, interactive 3D web work — pairing a
high-fidelity live Three.js preview with a harness-agnostic agent layer.

<br />

[![Stage](https://img.shields.io/badge/stage-5%20%C2%B7%20templates%2C%20export%2C%20history%20%26%20packaging-6366f1)](docs/ROADMAP.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)
[![Built with Electron](https://img.shields.io/badge/Electron-37-47848f?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Three.js](https://img.shields.io/badge/three.js-0.184-000000?logo=three.js&logoColor=white)](https://threejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-6366f1)](#contributing)

<br />

<img src="triangleScreenshot.jpg" alt="Triangle — Three.js live preview with editor and agent panel" width="860" />

</div>

---

> [!NOTE]
> **Building in public.** Triangle is an early-stage work in progress, shipped in
> incremental stages that each produce usable value. Follow along, open issues, and
> send PRs — the roadmap is public and the architecture decisions are documented as
> ADRs.

## Highlights

- 🔺 **Live Three.js preview** — hot-reloads from local files, with orbit controls,
  pause/grid toggles, screenshots, and an FPS / draw-call / triangle-count HUD.
- ✍️ **Monaco editor** — JS / TS / GLSL with syntax highlighting, a dirty/save model,
  and a `suppressWatch` save path that hot-reloads without churn.
- 🤖 **Harness-agnostic agents** — Claude Agent SDK, Codex (via the Codex App Server),
  an external **ACP agent**, and a zero-setup Mock agent, all reading and editing the
  project behind one **human-approval gate**.
- 🧠 **Three.js domain tools** — agents capture screenshots, summarize the live scene
  graph, validate GLSL shaders, and read performance counters for real **visual feedback**
  — reachable by Claude in-process, by Codex via a bundled MCP server, and by any MCP
  client via the **standalone MCP endpoint**.
- 🎛️ **Live scene manipulation** — agents set uniforms, material colors, transforms,
  visibility, and lights on the running scene with **immediate visual reflection**
  (transient, persisted via a source write); the preview runtime survives dock moves.
- 🔍 **Unified diff & approval** — every harness's writes (and Codex/ACP file-change
  and command approvals) flow through one **diff view** with Approve / Approve-all /
  Reject; a gear-toggled **harness config** sets per-harness models, the ACP agent,
  and the MCP endpoint.
- 🗂️ **Projects, templates & history** — create projects from a template gallery,
  switch between them, export/import as zips, and review **persistent session
  history** that survives restarts — all from the title bar.
- 🧱 **Dockable workspace** — resizable, movable, dockable, floatable, collapsible
  panes (powered by [dockview](https://dockview.dev)) with a persisted layout.
- 🎨 **Centralized theming** — a single CSS-variable design system; the Monaco theme
  tracks the same palette.
- 🔒 **Security-conscious** — the renderer never touches Node directly; all privileged
  work crosses a typed IPC bridge in the main process.

## Layout

```
┌──────────┬──────────────┬────────────────────────┬──────────────┐
│          │              │                        │              │
│ Explorer │  Mini-editor │  Three.js live preview │  AI agent    │
│  (tree)  │  (Monaco)    │  (hot-reload, orbit,   │  panel       │
│          │              │   screenshot, stats)   │  (chat +     │
│          │              │                        │   harness)   │
└──────────┴──────────────┴────────────────────────┴──────────────┘
       resizable · movable · dockable · collapsible (dockview)
```

## Quick start

> **Prerequisites:** Node.js ≥ 20 (developed on 24) and pnpm ≥ 9 (`npm i -g pnpm`).

```bash
pnpm install          # install all workspace deps
pnpm dev              # launch the Electron app in dev mode (HMR)
```

Try the loop: open `src/main.js` in the explorer, edit + save (`Cmd/Ctrl+S`) → the
preview hot-reloads. In the agent panel, pick a harness, ask for a change, and approve
the write when prompted.

Other useful scripts:

```bash
pnpm build            # build all packages + the desktop app
pnpm typecheck        # typecheck every workspace package
pnpm package          # produce a distributable build (electron-builder, Stage 5)
```

### Agent credentials

Credentials are read from the environment or a gitignored config — **never committed**.
The **Devin CLI** harness is the preferred default when `devin` is on `PATH` and
authenticated — driven over ACP (`devin acp`); authenticate with `WINDSURF_API_KEY` or
`devin auth login` (see [Stage 4.5](docs/STAGE-4.5-devin-acp.md) / [ADR
0014](docs/adr/0014-devin-acp-harness.md)). The Claude harness needs `ANTHROPIC_API_KEY`;
the Codex harness needs the `codex` CLI on `PATH` (and a signed-in account, since it now
drives the [Codex App Server](docs/adr/0008-codex-app-server-and-mcp-bridge.md)); the
generic ACP harness needs an external ACP agent configured via `acpAgentCommand` (in-app
harness config or the config file). Non-secret settings (per-harness models, Devin/ACP
paths) are editable in-app and persist to the user config. See
[`docs/STAGE-2.md`](docs/STAGE-2.md#configuration-credentials) for the full precedence and
key list.

## Status & roadmap

| Stage | Theme | Status |
| :---- | :---- | :----: |
| 0 | Foundations & architecture | ✅ |
| 1 | Core shell & live preview | ✅ |
| 2 | Editor + basic agent orchestration | ✅ |
| 2.5 | Visual & layout overhaul (design system + dockview) | ✅ |
| 3 | Three.js domain tooling & visual feedback loop | ✅ |
| 4 | Rich agent capabilities & protocol support (ACP / MCP) | ✅ |
| 4.5 | Devin CLI (ACP) as the preferred harness | ✅ |
| 5 | Polish, rich features & internal prototype | ✅ |
| 5.5 | Share, snapshot & scope (standalone HTML, snapshots, per-project layout) | ✅ |
| 6 | Post-prototype hardening & web path | ⬜ |

The full roadmap lives in [`docs/ROADMAP.md`](docs/ROADMAP.md). Stage write-ups:
[Stage 1](docs/STAGE-1.md) · [Stage 2](docs/STAGE-2.md) ·
[Stage 2.5](docs/STAGE-2.5-visual-overhaul.md) · [Stage 3](docs/STAGE-3.md) ·
[Stage 4](docs/STAGE-4.md) · [Stage 4.5](docs/STAGE-4.5-devin-acp.md) ·
[Stage 5](docs/STAGE-5.md) · [Stage 5.5](docs/STAGE-5.5.md).
For effective prompting, see [`docs/PROMPTING.md`](docs/PROMPTING.md).

## Architecture

This is a [pnpm](https://pnpm.io) workspace monorepo.

```
triangle/
├── apps/
│   └── desktop/            # Electron app (main + preload + React renderer)
├── packages/
│   ├── shared/             # Shared TS types: IPC contract + agent tool schemas
│   └── preview-runtime/    # Framework-agnostic Three.js preview engine
├── templates/              # Project template gallery (new-project sources)
│   ├── starter/            # Fresnel torus-knot + instanced particles
│   └── raymarch/           # Full-screen ray-marched SDF (shader-focused)
└── docs/                   # ADRs, roadmap, and stage notes
```

Key decisions are recorded as Architecture Decision Records in
[`docs/adr/`](docs/adr/) — covering the [tech stack](docs/adr/0002-tech-stack.md), the
[process model & IPC](docs/adr/0003-process-model-and-ipc.md), the
[editor & GLSL](docs/adr/0004-editor-and-glsl.md), [agent orchestration](docs/adr/0005-agent-orchestration.md),
the [design system & dock layout](docs/adr/0006-visual-design-and-dock-layout.md), the
[preview bridge & domain tooling](docs/adr/0007-preview-bridge-and-domain-tooling.md), the
[Codex App Server & MCP bridge](docs/adr/0008-codex-app-server-and-mcp-bridge.md),
[live scene manipulation](docs/adr/0010-live-scene-manipulation.md), the
[persistent preview canvas](docs/adr/0011-persistent-preview-canvas.md), the
[unified approval gate & diff view](docs/adr/0012-unified-approval-and-diff.md), the
[standalone MCP endpoint & ACP client](docs/adr/0013-standalone-mcp-and-acp.md), the
[Devin CLI (ACP) harness](docs/adr/0014-devin-acp-harness.md),
[project templates & lifecycle](docs/adr/0015-project-templates-and-lifecycle.md),
[session history](docs/adr/0016-session-history.md),
[packaging & distribution](docs/adr/0017-packaging-and-distribution.md), and
[share, snapshot & scope](docs/adr/0018-share-snapshot-scope.md).

## Contributing

Issues and pull requests are welcome. A good flow:

1. Open an issue to discuss non-trivial changes first.
2. Keep diffs focused; match the existing code style.
3. Run `pnpm typecheck` and `pnpm build` before submitting.
4. Add or update an ADR for any significant architectural decision.

## License

[MIT](LICENSE) © Triangle contributors.
