# ADR 0003 — Process model, security, and IPC contract

- **Status:** Accepted
- **Date:** 2026-06-23

## Context

Electron apps that load and execute arbitrary project code (here: user/agent-authored
Three.js) must be careful about the renderer's privileges. We also want a single,
typed surface that both the UI and (later) agents drive — the same operations the
agent tool schema describes should map onto real IPC calls.

## Decision

- **Context isolation ON, `nodeIntegration` OFF.** The renderer is a normal web
  context with no direct Node access.
- A **preload** script exposes a narrow, typed API on `window.triangle` via
  `contextBridge`. Every method is a thin wrapper over `ipcRenderer.invoke` (request/
  response) or an event subscription (`ipcRenderer.on`).
- The **IPC contract is defined once** in `@triangle/shared` (`ipc.ts`) as channel
  names + request/response types, and imported by main, preload, and renderer. This is
  the single source of truth.
- **User project code is treated as untrusted.** In Stage 1 it runs inside the
  renderer's preview runtime; the roadmap moves it toward a more isolated context
  (iframe/worker) as capabilities grow.
- **Agent tool schemas mirror IPC operations.** The schema in `tools.ts` is the
  agent-facing description of the same capabilities surfaced over IPC, so wiring an
  agent (Stage 2+) is a mapping exercise rather than new plumbing.

## Consequences

- Adding a capability = add a channel + types in `@triangle/shared`, a handler in
  main, and a binding in preload. The renderer gets it fully typed.
- Human approval gates for file writes (a non-functional requirement) live in the main
  process, the one place that performs side effects.
