# Stage 6: Post-Prototype Hardening & Web Path

Stage 6 ships the last high-leverage items from the prototype-to-product bridge:

- **WS-1** — Web build export: a Vite-powered static site that runs a Triangle project in the browser using the same `@triangle/preview-runtime` that powers the desktop preview.
- **WS-2** — Hugging Face 3D asset generation: three agent tools (`hf_generate_3d_asset`, `download_3d_asset`, `triangle_import_3d_asset`) that let an agent generate, download, and import GLB/OBJ/USDZ models.
- **WS-3** — (Optional) World Labs Marble integration stub: not implemented in this stage; reserved for a future follow-up if the Marble API is released.
- **WS-4** — Robotics simulation prep: a new `@triangle/robotics` package with URDF-like types, joint control, and sensor visualization, plus a `triangle_robotics_snippet` agent tool that generates a Three.js + Rapier entry-module template.
- **WS-5** — Hardening: React error boundaries around the new engine panels, binary file read/write helpers, additional tests, and this documentation.

## Quick commands

```bash
pnpm typecheck        # all workspace packages
pnpm -r test          # all tests
pnpm build            # desktop production build
pnpm build:web        # export the starter project to a static web build
```

## WS-1: Web build path

`apps/web` is a new workspace package. It:

- creates a `PreviewRuntime` on a full-screen canvas,
- fetches the project entry source from `/project/src/main.js`,
- calls `runtime.loadModule(source)` to run the same `setup`/`update`/`dispose` hooks used in the desktop app.

Export a project:

```bash
pnpm --filter @triangle/web export ./path/to/project
pnpm --filter @triangle/web build
```

The root shortcut `pnpm build:web` exports `templates/starter` and builds the site into `apps/web/dist`.

## WS-2: Hugging Face OAuth + Spaces integration

The desktop app now supports authenticating with Hugging Face via OAuth and calling Spaces on the user's behalf:

- **OAuth device-code flow**: `Settings → Configure providers → Hugging Face` lets you enter an OAuth client id and click "Connect with Hugging Face". Main starts the device-code flow, opens the browser, polls for the access token, and persists it in the user config. The token is used for all HF API calls and falls back to `HF_TOKEN` / `hfToken` when absent or expired.
- **New `hf_call_space` agent tool**: call any HF Space API (e.g. `user/space`) with an arbitrary payload. This is surfaced in Claude, MCP, ACP, and the manual tool runner.
- **Existing 3D asset pipeline** (`hf_generate_3d_asset`, `download_3d_asset`, `triangle_import_3d_asset`) now prefers the OAuth token when connected, so private/gated Spaces and Inference Providers can be used.

OAuth configuration:
- Set `HF_OAUTH_CLIENT_ID` / `TRIANGLE_HF_OAUTH_CLIENT_ID` in the environment, or configure `hfOAuthClientId` in settings.
- Requested scopes default to `openid profile inference-api`.

The token is read from `HF_TOKEN` / `TRIANGLE_HF_TOKEN` env vars, or from the `hfToken` field in the agent settings / `config.json`, as a fallback. A token is only required when the tool uses the public HF API; an explicit `endpoint` bypasses the token check.

For manual testing there is a "Run integration tool" panel in the Agent panel (wrench icon). It bypasses the agent harness and auto-approves downloads, so you can try the HF pipeline or the robotics snippet directly.

The shared model loader is implemented in `packages/preview-runtime/src/loaders.ts` and uses Three.js `GLTFLoader` / `OBJLoader`, supports GLB/OBJ/USDZ, and auto-centers + normalizes imported models.

## WS-4: Robotics simulation prep

`packages/robotics` contains:

- `src/urdf.ts` — `Robot`, `Link`, `Joint`, `Vector3`, `Quaternion`, `Inertia` types.
- `src/joints.ts` — `JointState`, `JointCommand`, `JointControlUpdate`.
- `src/sensors.ts` — `LidarSensor`, `CameraSensor`, `ImuSensor`, `ContactSensor`, `OdometrySensor`, and their union `Sensor`.
- `src/snippets.ts` — `generatePhysicsSnippet(options)` returns a Triangle entry-module template that imports `@dimforge/rapier3d`, creates a `World`, builds bodies/colliders for links, and drives revolute/prismatic joints with a simple per-frame controller.

The agent tool `triangle_robotics_snippet` exposes this generator in the Claude/MCP/ACP harnesses.

## WS-5: Hardening

- `ProjectManager` gained `readBinaryFile` and `writeBinaryFile` so 3D asset downloads and imports do not corrupt binary data.
- `apps/desktop/src/renderer/src/components/ErrorBoundary.tsx` isolates panel crashes in Explorer, Editor, Preview, Agent, Outliner, Inspector, and Console.
- `packages/shared/src/tools.ts` JSON schema now supports nested `properties` and `required` on object/array nodes, enabling richer tool definitions.
- New tests:
  - `packages/integrations/test/hf.test.ts` — mocks the HF 3D asset API.
  - `packages/integrations/test/hf-oauth.test.ts` — device-code OAuth flow.
  - `packages/integrations/test/hf-spaces.test.ts` — generic Space API client.
  - `packages/robotics/test/robotics.test.ts` — snippet generation.
  - `apps/desktop/test/tool-bridge.test.ts` — end-to-end tool dispatch over the loopback bridge, including the Stage 6 tools.

## Files added or changed

- `packages/shared/src/agent.ts`, `preview.ts`, `tools.ts` — Stage 6 types and tool definitions.
- `packages/preview-runtime/src/loaders.ts`, `runtime.ts`, `index.ts` — model loader.
- `apps/desktop/src/main/agent/tools.ts`, `preview-bridge.ts`, `tool-bridge.ts`, `agent/manager.ts`, `config.ts`, `agent/claude.ts`, `hf-oauth.ts`, `mcp-endpoint.ts` — tool integration + OAuth lifecycle.
- `apps/desktop/src/renderer/src/preview/bridge.ts` — `load_model` request handling.
- `apps/desktop/src/main/project.ts` — binary file helpers.
- `apps/web/**` — new web build package.
- `packages/robotics/**` — new robotics simulation prep package.
- `apps/desktop/src/renderer/src/components/ErrorBoundary.tsx` — error boundaries.
- `apps/desktop/src/renderer/src/workspace/Workspace.tsx`, `App.tsx`, `styles.css` — panel isolation.
- `apps/desktop/src/renderer/src/components/HarnessConfig.tsx` — HF OAuth UI.
- `packages/integrations/src/hf-oauth.ts`, `hf-spaces.ts` — OAuth + Spaces clients.
- `docs/STAGE-6.md` (this file).
