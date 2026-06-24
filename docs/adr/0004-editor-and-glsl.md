# ADR 0004 — Editor (Monaco) and GLSL language support

- **Status:** Accepted
- **Date:** 2026-06-24

## Context

Stage 2 replaces the Stage 1 read-only code viewer with a real editor. Triangle
projects are JS/TS plus GLSL shaders, so we need solid editing, syntax highlighting,
and a path to richer language services later (Stage 3 shader diagnostics). The app is
an offline-first Electron desktop app with a strict-ish CSP, so editor assets must be
bundled locally rather than fetched from a CDN.

## Decision

- **Use Monaco** (`monaco-editor`) via the `@monaco-editor/react` wrapper. Monaco is the
  VS Code editor core — the strongest fit for JS/TS in the React ecosystem and what the
  tech-stack ADR (0002) anticipated.
- **Bundle Monaco and its workers locally.** Vite `?worker` imports produce self-hosted
  language workers, and `loader.config({ monaco })` points the React wrapper at the
  bundled instance so it never reaches out to jsdelivr. This satisfies the offline
  requirement and the `worker-src 'self' blob:` CSP.
- **Register GLSL ourselves.** Monaco ships no GLSL language, so we add a Monarch
  tokenizer + language configuration (`monaco/glsl.ts`) with keyword/type/builtin lists
  derived from the GLSL ES 3.0 spec (the dialect three.js shaders target). This keeps
  shader highlighting dependency-free; a TextMate grammar / shader validation can
  supersede it in Stage 3.
- **Single managed model, imperative content sync.** The editor manages one model and
  reconciles external (disk/agent) updates dirty-aware: unsaved edits are never
  clobbered. Saving is explicit (Cmd/Ctrl+S or the Save button).

## Consequences

- Bundling all Monaco languages inflates the renderer bundle (~9 MB). Acceptable for a
  desktop app; can be trimmed later by importing only the needed languages.
- Switching files resets undo history (single-model trade-off). Fine for Stage 2.
- Our GLSL grammar is highlighting-only — no semantic checks until Stage 3.
