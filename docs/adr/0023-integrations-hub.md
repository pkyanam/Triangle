# ADR 0023 — Integrations hub and settings split

- **Status:** Accepted
- **Date:** 2026-06-26

## Context

`ProviderInstancesSettings` had grown into a catch-all: agent provider instances
plus a Hugging Face OAuth card plus the MCP endpoint card. There was no single
"integrations" home that told the powerful-integrations story (HF, World Labs,
ROS2, MCP), and the integrations were buried inside the agent settings.

## Decision

1. **Add an `IntegrationsHub` modal** opened from Edit → Preferences (and the
   command palette) via the `triangle:open-settings` event. It carries a
   left-rail category nav: Agents · Hugging Face · World Labs · Robotics ·
   MCP Endpoint · About — built to scale past six categories.
2. **Move the Hugging Face and MCP cards out of `ProviderInstancesSettings`**
   into the hub. `ProviderInstancesSettings` now owns only the agent
   provider-instance grid + add-instance row and is rendered as the hub's
   "Agents" section (and still inline in the Agent panel's settings).
3. **Status cards with an "Open" affordance.** Each integration shows a
   connection dot + subtitle: HF (connect/disconnect, OAuth setup link), World
   Labs Marble (honest "Coming soon" + request-access link), MCP (tool count +
   copy-client-config), ROS2 Bridge (WebSocket endpoint + live reachability
   probe). The MCP card links to the HF section.
4. **Add a `rosBridgeUrl` setting** (shared `AgentSettings` + main config,
   camelCase + snake_case aliases) so the ROS2 bridge endpoint persists. A
   lightweight WebSocket probe drives the status dot.

## Consequences

- Triangle has a real integrations home; the "powerful integrations" story is
  visible and anticipated rather than buried.
- Agent settings are now focused on provider instances only.
- The hub is a modal, so it costs no dock space and reuses the existing
  modal-overlay chrome.

## Out of scope

- Full ROS2 pub/sub streaming (the endpoint config + probe is the deliverable).
- Live Marble generation (reserved stub).
