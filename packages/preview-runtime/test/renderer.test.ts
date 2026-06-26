import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { createRenderer } from '../src/renderer-factory.ts';
import { validateShader, resetShaderValidationCache } from '../src/inspect.ts';

// Node 24 ships a read-only global `navigator` (no `gpu`) and no `document`.
// Save the environment so each test can mutate it and restore afterwards.
const savedNavigator = globalThis.navigator;
const savedDocument = (globalThis as { document?: unknown }).document;

function defineNavigatorGpu(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...savedNavigator, gpu: value },
    configurable: true,
    writable: true,
  });
}

function restoreGlobals(): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: savedNavigator,
    configurable: true,
    writable: true,
  });
  if (savedDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = savedDocument;
}

beforeEach(() => {
  // Start each test from a clean (no-DOM, no-gpu) baseline.
  delete (globalThis as { document?: unknown }).document;
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node' },
    configurable: true,
    writable: true,
  });
  resetShaderValidationCache();
});

afterEach(restoreGlobals);

test('createRenderer attempts WebGPU when navigator.gpu is present', () => {
  defineNavigatorGpu({ requestAdapter: async () => ({ requestDevice: async () => ({}) }) });
  (globalThis as { document: unknown }).document = {
    createElement: () => ({ getContext: () => null, style: {} }),
  };
  const canvas = { style: {} } as unknown as HTMLCanvasElement;
  const result = createRenderer(canvas, { antialias: true });
  // The renderer is constructed synchronously; backend is decided before init.
  assert.equal(result.backend, 'webgpu');
  assert.ok(result.ready instanceof Promise);
  // init() will reject (no real GPU); swallow so it doesn't crash the process.
  result.ready.catch(() => {});
});

test('createRenderer falls back to WebGL when navigator.gpu is absent', () => {
  // No navigator.gpu -> the factory must take the WebGL path. Constructing a
  // real WebGLRenderer needs a GL context, which Node cannot provide, so we
  // assert it attempts that path by catching the WebGL context error.
  (globalThis as { document: unknown }).document = {
    createElement: () => ({ getContext: () => null, style: {} }),
  };
  const canvas = {
    style: {},
    addEventListener: () => {},
    removeEventListener: () => {},
    getContext: () => null,
  } as unknown as HTMLCanvasElement;
  assert.throws(
    () => createRenderer(canvas, { antialias: true }),
    /Error creating WebGL context/i,
    'factory should attempt WebGLRenderer construction when WebGPU is unavailable',
  );
});

test('validateShader returns an unavailable result when no WebGL2 context can be created', () => {
  // No document at all -> getValidationContext() returns null.
  const result = validateShader('vertex', 'void main(){}');
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'vertex');
  assert.equal(result.dialect, 'unavailable');
  assert.ok(result.diagnostics.length > 0);
  assert.equal(result.diagnostics[0].severity, 'error');
});

test('validateShader compiles a valid shader and reports ok:true', () => {
  const stub = makeStubGl({ compileOk: true, log: '' });
  (globalThis as { document: unknown }).document = {
    createElement: () => ({ getContext: () => stub }),
  };
  const result = validateShader('fragment', 'void main(){ gl_FragColor = vec4(1.0); }');
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'fragment');
  assert.equal(result.dialect, 'WebGL2 (GLSL ES 3.00)');
  assert.deepEqual(result.diagnostics, []);
});

test('validateShader parses diagnostics for a failing shader', () => {
  const stub = makeStubGl({
    compileOk: false,
    log: "ERROR: 0:5: 'undefinedVar' : undeclared identifier\nWARNING: 0:6: '' :  overflow",
  });
  (globalThis as { document: unknown }).document = {
    createElement: () => ({ getContext: () => stub }),
  };
  const result = validateShader('vertex', 'void main(){}');
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.length, 2);
  assert.equal(result.diagnostics[0].severity, 'error');
  assert.equal(result.diagnostics[0].line, 5);
  assert.match(result.diagnostics[0].message, /undefinedVar/);
  assert.equal(result.diagnostics[1].severity, 'warning');
  assert.equal(result.diagnostics[1].line, 6);
});

/** Build a minimal WebGL2RenderingContext stub for shader compilation. */
function makeStubGl(opts: { compileOk: boolean; log: string }): WebGL2RenderingContext {
  const shaders: { source: string }[] = [];
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    createShader: () => ({ source: '' }) as unknown as WebGLShader,
    shaderSource: (s: { source: string }, src: string) => {
      s.source = src;
      shaders.push(s);
    },
    compileShader: () => {},
    getShaderParameter: () => opts.compileOk as unknown as number,
    getShaderInfoLog: () => opts.log,
    deleteShader: () => {},
  };
  return gl as unknown as WebGL2RenderingContext;
}
