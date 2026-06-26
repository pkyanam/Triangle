# ADR 0022 — Menu bar and engine-first default layout

- **Status:** Accepted
- **Date:** 2026-06-26

## Context

The TopBar exposed three loose buttons (Panels, Tabs, Reset) — adequate for a
prototype but not how a mature engine presents its commands. The default dock
layout also led with the Agent panel fronting the right rail, which read as
"AI tool with a viewport" rather than "engine with an agent". Triangle needs to
reposition as engine-first.

## Decision

1. **Add a real menu bar** (`MenuBar`) to the TopBar with File / Edit / View /
   Window / Help. It replaces the loose Panels/Tabs/Reset buttons. Transport
   (Play) and a quick view-mode toggle stay as inline toolbar buttons.
   - File: New/Open project, Import Asset, Import/Export project, Export HTML,
     Create Snapshot, Snapshots.
   - Edit: Undo/Redo (placeholders), Preferences.
   - View: panel toggles, view-mode selection, HUD/Gizmo/Grid toggles, command
     palette.
   - Window: tab orientation, reset layout.
   - Help: documentation, report issue (open externally via the existing
     `setWindowOpenHandler` → `shell.openExternal`).
2. **Decouple cross-component actions with window CustomEvents.** File →
   New/Open/Snapshots dispatch `triangle:project-menu`; Preferences dispatches
   `triangle:open-settings`. The existing `ProjectMenu` and `AgentPanel` listen,
   so the menu bar stays thin and no new prop-drilling spans the tree.
3. **Lift HUD/Gizmo/Grid into a shared `viewportPrefs` store** so both the
   preview toolbar and the View menu/command palette toggle the same state
   (grid mirrors onto the persistent runtime).
4. **Add a VS Code-style command palette** (`CommandPalette`) over the menu
   actions, opened with Cmd/Ctrl+P (and Shift+P). Cmd/Ctrl+B toggles the left
   rail (Explorer), Cmd/Ctrl+J toggles the Agent panel. Shortcuts are shown in
   the menu items via the existing `.kbd` style.
5. **Swap the right rail in `buildDefaultLayout`:** Inspector + Agent become
   tabs in one right-rail group with the **Inspector fronted**, so the viewport
   is the undisputed hero. Bump the layout key to `v4` so existing users adopt
   the new default.

## Consequences

- Triangle presents as engine-first: real menus, an opt-in command palette,
  and a viewport-hero layout with the Inspector (not the chat) fronting the
  right rail.
- The `v4` layout key invalidates saved `v3` arrangements, falling back to the
  new default rather than a stale one.
- Window CustomEvents are a lightweight, typed-by-convention bus; they are only
  used for a handful of menu→component actions and remain easy to trace.

## Out of scope

- Real undo/redo (the Edit items are honest placeholders).
- Nested submenus (the View menu lists panels/modes inline).
- Per-OS native application menus (this is an in-window menu bar).
