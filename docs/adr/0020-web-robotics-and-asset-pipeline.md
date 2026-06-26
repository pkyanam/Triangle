# ADR 0020: Web Export, HF Asset Pipeline, and Robotics Scaffolding

## Status

Accepted — Stage 6.

## Context

Triangle reached the end of the prototype-to-product bridge. The desktop editor was functional, but three gaps prevented it from being a credible product:

1. **No web output.** Users can only preview inside Electron; there is no shareable, static build.
2. **No asset pipeline.** The editor can only author procedural scenes; importing external 3D assets requires manual file work.
3. **No robotics/physics path.** Simulation-heavy use cases (robotics, embodied agents) need a structured path toward a physics engine, even if the full integration is later.

This ADR records how Stage 6 addresses each gap while keeping the architecture consistent with earlier stages.

## Decision

### 1. Web build path (`apps/web`)

We added a dedicated workspace package `apps/web`. It is a static Vite site that uses the same `@triangle/preview-runtime` as the desktop app. This preserves the invariant that a Triangle project is a single, framework-agnostic module contract: `setup`/`update`/`dispose` with an injected Three.js context.

- The project source is loaded at runtime via `fetch('/project/src/main.js')` and `runtime.loadModule(source)`.
- An export script copies an arbitrary project into `public/project` before building.
- The default `pnpm build:web` shortcut exports `templates/starter` and produces `apps/web/dist`.

### 2. Hugging Face OAuth + Spaces integration

We introduced OAuth support so Triangle can act on behalf of a Hugging Face user when calling Spaces and the Inference API. The flow uses the HF device-code OAuth flow, which is well suited to a desktop app without a web-hosted redirect URL.

- `HuggingFaceOAuth` in `packages/integrations/src/hf-oauth.ts` implements the device-code flow, opens the browser, and polls for the access token.
- The access token is persisted as `hfOAuthToken` / `hfOAuthExpiresAt` in the user config; `hfOAuthClientId` can be set via `HF_OAUTH_CLIENT_ID`, in the UI, or baked into `apps/desktop/src/main/config.ts` as `DEFAULT_HF_OAUTH_CLIENT_ID`.
- `HuggingFaceSpacesClient` in `packages/integrations/src/hf-spaces.ts` calls arbitrary Space APIs (`/api/predict` or `/api/run/{route}`) with the token.
- We use a **public OAuth app** (no client secret). A client id is safe to embed in a desktop binary; a client secret is not.
- A new agent tool `hf_call_space` exposes the Spaces client to agents.
- The existing three-tool workflow now prefers the OAuth token and falls back to API tokens:
  - `hf_generate_3d_asset` — calls a Hugging Face Space or Inference Endpoint and returns a model URL.
  - `download_3d_asset` — downloads the model and saves it as a binary file in the active project.
  - `triangle_import_3d_asset` — loads the binary file into the live preview via a new `load_model` preview request.

The model loader lives in `packages/preview-runtime/src/loaders.ts` and uses Three.js `GLTFLoader`/`OBJLoader` for GLB/OBJ/USDZ. It is intentionally shared between desktop and web, so assets imported in the desktop app also work in the web build.

Auth tokens are resolved from `HF_TOKEN` / `TRIANGLE_HF_TOKEN` env vars or the `hfToken` field in `config.json` / agent settings as a fallback. OAuth takes precedence when connected and not expired. A token is only required for the public HF API; an explicit `endpoint` bypasses the check.

### 3. Robotics scaffolding (`packages/robotics`)

We created a new package with no external physics dependency. It provides:

- URDF-like types (`Robot`, `Link`, `Joint`) in `src/urdf.ts`.
- Joint control types (`JointState`, `JointCommand`) in `src/joints.ts`.
- Sensor visualization types (`LidarSensor`, `CameraSensor`, `ImuSensor`, etc.) in `src/sensors.ts`.
- A snippet generator in `src/snippets.ts` that emits a Three.js + Rapier entry module.

The agent tool `triangle_robotics_snippet` exposes the generator. This is scaffolding, not a full physics integration: the emitted code depends on `@dimforge/rapier3d`, but the Triangle runtime itself does not.

### 4. Hardening

- Binary file helpers (`readBinaryFile`, `writeBinaryFile`) were added to `ProjectManager` so downloaded assets are not corrupted by string encoding.
- React error boundaries isolate the new engine panels (Explorer, Editor, Preview, Agent, Outliner, Inspector, Console) from crashing the entire app.
- The shared tool schema was extended to support nested `properties` and `required` on object/array nodes.
- Tests cover the HF client, the OAuth flow, the Spaces client, the snippet generator, and tool-bridge dispatch.

## Consequences

- The web build is a credible shareable output. It does not yet include the editor UI; it is a "player" for a Triangle project.
- The HF pipeline is additive and does not affect the existing procedural workflow. Users can mix generated assets with hand-written code.
- OAuth uses a public app (client-id-only) so the client id can be baked into the binary, but a client secret cannot. Users who need organization-bound apps or extra scopes can override `hfOAuthClientId` in settings.
- Robotics remains a scaffold: the types and snippets are ready, but actual physics simulation requires a later integration with Rapier.
- Error boundaries improve resilience but do not log to a backend. The `onError` prop is available for future telemetry.

## Alternatives considered

- **Web build as Next.js app.** Rejected: Vite is simpler, keeps the package self-contained, and aligns with the existing Vite-based desktop renderer build.
- **Inline HF generation in the toolset.** Rejected: keeping the client in `packages/integrations` allows reuse by other future targets (web, CLI).
- **Add Rapier as a real dependency now.** Rejected: it would expand the bundle and test surface before the simulation contract is proven. The snippet generator is enough to validate the API shape.

## Related

- `docs/STAGE-6.md`
- `packages/preview-runtime/src/loaders.ts`
- `packages/integrations/src/hf.ts`
- `packages/integrations/src/hf-oauth.ts`
- `packages/integrations/src/hf-spaces.ts`
- `packages/robotics/src/snippets.ts`
- `apps/web/**`
