# Triangle Roadmap

Condensed from the PRD (v1.0). Each stage produces usable value and enables the next.

| Stage | Theme | Status |
| ----- | ----- | ------ |
| 0 | Foundations & Architecture | ✅ Done (this monorepo + ADRs + tool schema) |
| 1 | Core Shell & Live Preview | ✅ Done |
| 2 | Editor + Basic Agent Orchestration | ✅ Done |
| 2.5 | Visual & Layout Overhaul (Trifecta design + dockview) | ✅ Done |
| 3 | Three.js Domain Tooling & Visual Feedback Loop | ⬜ Next |
| 4 | Rich Agent Capabilities & Protocol Support (ACP/MCP) | ⬜ |
| 5 | Polish, Rich Features & Internal Prototype | ⬜ |
| 6 | Post-Prototype Hardening & Web Path | ⬜ Future |

## Stage 0 — Foundations & Architecture

- [x] Electron monorepo (pnpm workspaces) + project scaffolding.
- [x] Architecture decision records (`docs/adr/`).
- [x] Initial agent tool-surface schema (`packages/shared/src/tools.ts`).

## Stage 1 — Core Shell & Live Preview

- [x] Electron app with three-panel layout skeleton.
- [x] Functional Three.js preview canvas with hot-reload from local files + orbit controls.
- [x] Left-side file tree + read-only code viewer.
- [x] Right-side chat UI (mock agent responses).

See [`STAGE-1.md`](STAGE-1.md).

## Stage 2 — Editor + Basic Agent Orchestration

- [x] Monaco editor (GLSL/JS/TS) replacing the read-only viewer.
- [x] Claude Agent SDK integration (spawn + chat loop).
- [x] Codex CLI integration (launch + basic delegation).
- [x] File read/write tools exposed to agents (the schemas already live in `@triangle/shared`).

See [`STAGE-2.md`](STAGE-2.md).

## Stage 2.5 — Visual & Layout Overhaul

- [x] Reskin to the Trifecta desktop design language (dark, indigo, DM Sans / SF Mono),
      centralized in `styles.css` tokens; Monaco theme kept consistent.
- [x] Real dockable/movable split-pane workspace via dockview (resize, rearrange,
      float, collapse/restore) with persisted layout.
- [x] `lucide-react` iconography across all components.
- [x] Trifecta-style agent harness picker.

See [`STAGE-2.5-visual-overhaul.md`](STAGE-2.5-visual-overhaul.md) and
[ADR 0006](adr/0006-visual-design-and-dock-layout.md).

## Stages 3–6

See the PRD for full detail. Highlights: shader compilation feedback + screenshot/scene
context pipeline (Stage 3), ACP compatibility + MCP server + live scene manipulation +
diff/approval workflow (Stage 4), templates/export/session history/polish (Stage 5),
hardening + web build (Stage 6).
