import { createPreviewRuntime } from '@triangle/preview-runtime';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const errEl = document.getElementById('error');

function showError(prefix: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (errEl) {
    errEl.textContent = `${prefix}: ${message}`;
    errEl.style.display = 'block';
  }
  console.error(err);
}

const runtime = createPreviewRuntime(canvas, {
  onStatus: (status) => {
    if (status.phase === 'error') showError('Runtime error', status.message);
  },
});

runtime.start();

async function loadEntry(): Promise<void> {
  const res = await fetch('/project/src/main.js');
  if (!res.ok) {
    showError('Failed to load project entry', `HTTP ${res.status}`);
    return;
  }
  const source = await res.text();
  await runtime.loadModule(source);
}

loadEntry().catch((err) => showError('Failed to load entry', err));

window.addEventListener('resize', () => runtime.syncSize());

window.addEventListener('beforeunload', () => {
  runtime.dispose();
});
