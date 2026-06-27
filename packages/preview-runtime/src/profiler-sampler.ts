import type { ProfilerFrame, ProfilerTrace } from '@triangle/shared';
import type { RendererBackend } from './renderer-type.js';

/**
 * Vision Stage 6 (ADR 0033) — a fixed-capacity ring buffer of
 * {@link ProfilerFrame} samples fed by the runtime's stats loop.
 *
 * The buffer is bounded (default 240 samples ≈ 1 minute at the 4 Hz stats
 * cadence) so the profiler timeline stays cheap regardless of how long the
 * preview has been running. The runtime pushes a frame each time it samples
 * stats; the panel reads the snapshot via `snapshot()`.
 */
export class ProfilerSampler {
  private readonly buffer: ProfilerFrame[];
  private head = 0;
  private filled = 0;
  private readonly capacity: number;
  private readonly backend: RendererBackend;

  constructor(backend: RendererBackend, capacity = 240) {
    this.capacity = capacity;
    this.buffer = new Array<ProfilerFrame>(capacity);
    this.backend = backend;
  }

  /** Push a new frame into the ring buffer (overwriting the oldest). */
  push(frame: ProfilerFrame): void {
    this.buffer[this.head] = frame;
    this.head = (this.head + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
  }

  /** Number of frames currently retained. */
  size(): number {
    return this.filled;
  }

  /** Read the current trace (frames oldest-first). */
  snapshot(): ProfilerTrace {
    const frames: ProfilerFrame[] = [];
    if (this.filled < this.capacity) {
      for (let i = 0; i < this.filled; i++) frames.push(this.buffer[i]);
    } else {
      // Ring wrapped: oldest is at `head`, newest is at `head - 1`.
      for (let i = 0; i < this.capacity; i++) {
        frames.push(this.buffer[(this.head + i) % this.capacity]);
      }
    }
    return { capturedAt: Date.now(), backend: this.backend, frames };
  }

  /** Clear the buffer (e.g. on hot-reload so the timeline restarts cleanly). */
  reset(): void {
    this.head = 0;
    this.filled = 0;
  }
}
