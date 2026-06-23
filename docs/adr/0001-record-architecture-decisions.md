# ADR 0001 — Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-06-23

## Context

Triangle is being built in clearly-gated stages with multiple consequential
technology choices (UI framework, build tooling, agent integration strategy).
We want a durable, low-ceremony record of *why* decisions were made so future
contributors (human or agent) don't relitigate settled questions.

## Decision

We keep lightweight Architecture Decision Records in `docs/adr/`, numbered
sequentially. Each ADR captures context, the decision, and consequences. ADRs are
immutable once accepted; we supersede rather than edit.

## Consequences

- New significant decisions get a new ADR.
- Agents working in this repo can read `docs/adr/` to load architectural context.
