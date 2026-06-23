# ADR 0002 — Core technology stack

- **Status:** Accepted
- **Date:** 2026-06-23

## Context

Triangle is a desktop-first agentic engine for Three.js. We need a stack that gives
us: a native desktop shell with filesystem + process control, fast iteration on UI,
first-class TypeScript, an ecosystem with strong Three.js / editor / agent-SDK
support, and a clean path to packaging.

## Decision

- **Shell:** Electron (desktop-first, cross-platform). Main process owns filesystem,
  process spawning, and (later) agent orchestration; the renderer hosts UI + preview.
- **Build tooling:** `electron-vite` — fast HMR across main / preload / renderer with
  a TypeScript-first config.
- **UI:** React + TypeScript in the renderer. Largest ecosystem for Monaco, Three.js
  (incl. R3F patterns later), and agent-SDK examples.
- **Package management:** pnpm workspaces monorepo. Apps in `apps/*`, libraries in
  `packages/*`.
- **3D:** Three.js, isolated behind a framework-agnostic `@triangle/preview-runtime`
  package so the preview engine never hard-couples to React or Electron.

## Consequences

- We accept Electron's footprint in exchange for native capabilities now, with a
  documented Stage 6 path to a lighter web build (Tauri / File System Access API).
- The renderer must never touch Node APIs directly: all privileged operations cross a
  typed IPC bridge (see ADR 0003).
- Keeping the preview engine framework-agnostic means it can later run in an iframe,
  a worker, or a web build with minimal change.
