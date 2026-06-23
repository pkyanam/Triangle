/// <reference types="vite/client" />
import type { TriangleApi } from '@triangle/shared';

declare global {
  interface Window {
    triangle: TriangleApi;
  }
}

export {};
