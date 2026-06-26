# ADR 0025 — Robotics URDF importer and live joint control

- **Status:** Accepted
- **Date:** 2026-06-26

## Context

`@triangle/robotics` shipped URDF-ish types (`Robot`/`Link`/`Joint`), joint
control types, and a Rapier snippet generator — but nothing surfaced them. The
ROS2 story was a promise with no user-visible path.

## Decision

1. **URDF importer dialog** (`RobotImporter`) opened from the Integrations hub
   Robotics card. It accepts a URDF via paste or open-from-disk (a renderer
   `<input type=file>` reads text directly — no new IPC), parses it with a small
   DOMParser-based `parseUrdf` into the `@triangle/robotics` `Robot` type, and
   shows the link/joint tree with masses, geometry, axes, and limits.
2. **Build the robot directly in the live scene** so the user sees it
   immediately. A new `buildRobot` (in `@triangle/preview-runtime`) turns links
   into primitive-mesh Groups parented per the joint tree; joint handles
   remember each child's base transform. The build is transient (a hot-reload
   clears it, like an imported model). The importer also surfaces the existing
   `generatePhysicsSnippet` output (copyable) for source persistence.
3. **Live joint control** via a runtime joint registry: `loadRobot` returns
   joint metadata, `setJointState(name, value)` drives revolute/continuous
   (rotation) and prismatic (translation) joints, and `getRobotInfo` exposes the
   root uuid + joints. Surfaced through renderer-local bridge helpers
   (`loadActiveRobot`, `setActiveJointState`, `getActiveRobotInfo`).
4. **JointInspector** renders as an Inspector sub-section when the selected
   object is the robot root, with a slider per joint (bounded by its limits)
   that drives `JointCommand` values into the live scene.
5. **ROS2 Bridge card** (ADR 0023) carries the rosbridge/Foxglove WebSocket
   endpoint + reachability probe; this importer is the robot-building half.

### Why not a `set_joint_state` SceneEdit op?

Joint state targets the runtime's robot registry, not the generic scene graph
that `applySceneEdit`/`mutate` operate on. Folding it into the `SceneEdit` union
would pollute the agent-facing scene-edit surface and the `mutate` exhaustive
switch. Instead joint control is a dedicated runtime op exposed via the bridge,
mirroring the transform-gizmo and view-mode helpers.

## Consequences

- The ROS2 story is now demonstrable: import a URDF, see the robot, drive its
  joints live.
- `@triangle/preview-runtime` now depends on `@triangle/robotics` (types +
  snippet generator).

## Out of scope

- Real Rapier physics simulation (the snippet is provided for source use).
- Live ROS2 pub/sub over the bridge endpoint (the card stores + probes it).
- Mesh-geometry links (rendered as primitive placeholders).
