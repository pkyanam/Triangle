# Triangle Roadmap

Condensed from the PRD (v1.0). Each stage produces usable value and enables the next.

| Stage | Theme | Status |
| ----- | ----- | ------ |
| 0 | Foundations & Architecture | ✅ Done (this monorepo + ADRs + tool schema) |
| 1 | Core Shell & Live Preview | ✅ Done |
| 2 | Editor + Basic Agent Orchestration | ✅ Done |
| 2.5 | Visual & Layout Overhaul (Trifecta design + dockview) | ✅ Done |
| 3 | Three.js Domain Tooling & Visual Feedback Loop | ✅ Done |
| 4 | Rich Agent Capabilities & Protocol Support (ACP/MCP) | ✅ Done |
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

## Stage 3 — Three.js Domain Tooling & Visual Feedback Loop

- [x] `triangle_validate_shader` — live GLSL compile diagnostics (tool + Monaco markers).
- [x] `triangle_capture_screenshot` — framebuffer PNG saved to the project for grounding.
- [x] `triangle_describe_scene` — structured scene-graph summary.
- [x] `triangle_performance_snapshot` — FPS / draw calls / triangles / GPU-memory estimate.
- [x] Works in Codex too — Codex App Server harness + a Triangle MCP server over a
      token-guarded loopback bridge.
- [x] Harness-agnostic AgentPanel quick-actions + tool-trace surfacing.

See [`STAGE-3.md`](STAGE-3.md) and [ADR 0007](adr/0007-preview-bridge-and-domain-tooling.md),
[ADR 0008](adr/0008-codex-app-server-and-mcp-bridge.md),
[ADR 0009](adr/0009-preview-persistence-across-dock-remounts.md).

## Stage 4 — Rich Agent Capabilities & Protocol Support

- [x] Persistent preview runtime — canvas reparented across dock remounts so live
      state survives (ADR 0011, implements the deferred ADR 0009 Option 1).
- [x] Live scene manipulation (ADR 0010): `triangle_set_uniform`,
      `triangle_set_material_color`, `triangle_set_transform`,
      `triangle_set_visibility`, `triangle_set_light` — transient edits with
      immediate visual reflection, available to every harness.
- [x] Diff view + unified approval workflow (ADR 0012): one `ApprovalRequest` with
      diffs for Claude/MCP writes and Codex file-change/command approvals; gated
      Codex (read-only + on-request); Approve / Approve-all (session) / Reject.
- [x] Standalone MCP endpoint + ACP compatibility (ADR 0013): `McpEndpoint`
      publishes a launcher descriptor any MCP client can use; a real ACP *client*
      harness drives external ACP agents and gates their fs/permission requests.
- [x] Harness configuration UI: per-harness model selection, ACP agent setup, and
      the MCP endpoint surface; persisted via `config:get` / `config:set`.

See [`STAGE-4.md`](STAGE-4.md) and [ADR 0010](adr/0010-live-scene-manipulation.md),
[ADR 0011](adr/0011-persistent-preview-canvas.md),
[ADR 0012](adr/0012-unified-approval-and-diff.md),
[ADR 0013](adr/0013-standalone-mcp-and-acp.md).

## Stages 4–6

See the PRD for full detail. Highlights: shader compilation feedback + screenshot/scene
context pipeline (Stage 3), ACP compatibility + MCP server + live scene manipulation +
diff/approval workflow (Stage 4), templates/export/session history/polish (Stage 5),
hardening + web build (Stage 6).
