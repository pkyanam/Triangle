import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AutomationEngine,
  type AutomationAgentStarter,
  type AutomationStartRequest,
  type TriggerInput,
  compareValues,
  cronMatch,
  evaluateCondition,
  flattenPreviewEvent,
  matchTrigger,
  summarisePreviewEvent,
} from '../src/automation.ts';
import type {
  Automation,
  AutomationTriggeredEvent,
  PreviewEvent,
  Scope,
} from '@triangle/shared';

// --- Test fixtures ---------------------------------------------------------

const shaderError: PreviewEvent = {
  type: 'shader-error',
  message: 'ERROR: 0:5: undeclared identifier foo',
  sourcePath: 'src/shaders/frag.glsl',
};

const perfThresholdFps: PreviewEvent = {
  type: 'perf-threshold',
  metric: 'fps',
  op: '<',
  value: 22,
  threshold: 30,
  baseline: 58,
};

/** A recording fake starter: captures the last request and returns accepted. */
function recordingStarter(): AutomationAgentStarter & {
  calls: AutomationStartRequest[];
} {
  const calls: AutomationStartRequest[] = [];
  return {
    calls,
    start: (req) => {
      calls.push(req);
      return Promise.resolve({ runId: `run_${calls.length}`, accepted: true });
    },
  };
}

function makeAutomation(over: Partial<Automation> & Pick<Automation, 'trigger'>): Automation {
  return {
    id: 'a1',
    name: 'Test',
    description: 'test',
    plan: 'do the thing',
    scope: { mode: 'allow', paths: ['src/**'] },
    policyTier: 'source',
    enabled: true,
    ...over,
  };
}

// --- matchTrigger ----------------------------------------------------------

test('command trigger matches only command input', () => {
  const t = { kind: 'command', name: 'run' } as const;
  assert.equal(matchTrigger(t, { kind: 'command' }), true);
  assert.equal(matchTrigger(t, { kind: 'preview-event', event: shaderError }), false);
});

test('file-change trigger matches globs', () => {
  const t = { kind: 'file-change', globs: ['src/**'] } as const;
  assert.equal(
    matchTrigger(t, { kind: 'file-change', event: { type: 'change', path: 'src/main.js' } }),
    true,
  );
  assert.equal(
    matchTrigger(t, { kind: 'file-change', event: { type: 'change', path: 'assets/x.glb' } }),
    false,
  );
  assert.equal(matchTrigger(t, { kind: 'preview-event', event: shaderError }), false);
});

test('preview-event trigger matches the event type', () => {
  const t = { kind: 'preview-event', eventType: 'shader-error' } as const;
  assert.equal(matchTrigger(t, { kind: 'preview-event', event: shaderError }), true);
  assert.equal(matchTrigger(t, { kind: 'preview-event', event: perfThresholdFps }), false);
});

test('preview-event trigger with a predicate evaluates the flattened event', () => {
  const t = {
    kind: 'preview-event',
    eventType: 'shader-error',
    predicate: [{ field: 'sourcePath', op: 'contains', value: 'frag.glsl' }],
  } as const;
  assert.equal(matchTrigger(t, { kind: 'preview-event', event: shaderError }), true);
  const other: PreviewEvent = { type: 'shader-error', message: 'boom', sourcePath: 'src/vert.glsl' };
  assert.equal(matchTrigger(t, { kind: 'preview-event', event: other }), false);
});

test('perf-threshold trigger matches metric/op/value', () => {
  const t = { kind: 'perf-threshold', metric: 'fps', op: '<', value: 30 } as const;
  assert.equal(matchTrigger(t, { kind: 'preview-event', event: perfThresholdFps }), true);
  // Non-perf event doesn't match.
  assert.equal(matchTrigger(t, { kind: 'preview-event', event: shaderError }), false);
  // Wrong metric doesn't match.
  const drawCalls: PreviewEvent = {
    type: 'perf-threshold',
    metric: 'drawCalls',
    op: '>',
    value: 1000,
    threshold: 500,
  };
  assert.equal(matchTrigger(t, { kind: 'preview-event', event: drawCalls }), false);
  // Value not below the trigger threshold (25 < 30 is true; 35 is not).
  const notBelow: PreviewEvent = {
    type: 'perf-threshold',
    metric: 'fps',
    op: '<',
    value: 35,
    threshold: 30,
  };
  assert.equal(matchTrigger(t, { kind: 'preview-event', event: notBelow }), false);
});

test('webhook trigger matches the secret', () => {
  const t = { kind: 'webhook', secret: 's3cr3t' } as const;
  assert.equal(matchTrigger(t, { kind: 'webhook', secret: 's3cr3t' }), true);
  assert.equal(matchTrigger(t, { kind: 'webhook', secret: 'wrong' }), false);
});

test('schedule trigger never matches event inputs', () => {
  const t = { kind: 'schedule', cron: '* * * * *' } as const;
  assert.equal(matchTrigger(t, { kind: 'preview-event', event: shaderError }), false);
  assert.equal(matchTrigger(t, { kind: 'command' }), false);
});

// --- flattenPreviewEvent + evaluateCondition -------------------------------

test('flattenPreviewEvent exposes scalar payload fields', () => {
  const ctx = flattenPreviewEvent(perfThresholdFps);
  assert.equal(ctx['type'], 'perf-threshold');
  assert.equal(ctx['metric'], 'fps');
  assert.equal(ctx['value'], 22);
  assert.equal(ctx['threshold'], 30);
});

test('evaluateCondition: empty/absent condition is always true', () => {
  assert.equal(evaluateCondition(undefined, {}), true);
  assert.equal(evaluateCondition([], {}), true);
});

test('evaluateCondition: AND of predicates', () => {
  const cond = [
    { field: 'metric', op: '==' as const, value: 'fps' },
    { field: 'value', op: '<' as const, value: 30 },
  ];
  assert.equal(evaluateCondition(cond, { metric: 'fps', value: 22 }), true);
  assert.equal(evaluateCondition(cond, { metric: 'fps', value: 40 }), false);
  assert.equal(evaluateCondition(cond, { metric: 'drawCalls', value: 22 }), false);
});

test('compareValues covers all operators', () => {
  assert.equal(compareValues(5, '==', 5), true);
  assert.equal(compareValues(5, '!=', 6), true);
  assert.equal(compareValues(5, '<', 6), true);
  assert.equal(compareValues(6, '<=', 6), true);
  assert.equal(compareValues(7, '>', 6), true);
  assert.equal(compareValues(7, '>=', 7), true);
  assert.equal(compareValues('hello world', 'contains', 'world'), true);
  assert.equal(compareValues('hello', 'contains', 'world'), false);
  assert.equal(compareValues(undefined, '==', 5), false);
  // Type mismatch on numeric ops is false.
  assert.equal(compareValues('x', '<', 5), false);
});

// --- cronMatch -------------------------------------------------------------

test('cronMatch: every minute', () => {
  const expr = '* * * * *';
  for (const m of [0, 15, 30, 59]) {
    assert.equal(cronMatch(expr, new Date(Date.UTC(2026, 0, 1, 12, m))), true);
  }
});

test('cronMatch: specific minute and hour', () => {
  const expr = '30 9 * * *';
  assert.equal(cronMatch(expr, new Date(Date.UTC(2026, 5, 26, 9, 30))), true);
  assert.equal(cronMatch(expr, new Date(Date.UTC(2026, 5, 26, 9, 31))), false);
  assert.equal(cronMatch(expr, new Date(Date.UTC(2026, 5, 26, 10, 30))), false);
});

test('cronMatch: step value (every 5 minutes)', () => {
  const expr = '*/5 * * * *';
  for (const m of [0, 5, 10, 55]) {
    assert.equal(cronMatch(expr, new Date(Date.UTC(2026, 5, 26, 12, m))), true);
  }
  assert.equal(cronMatch(expr, new Date(Date.UTC(2026, 5, 26, 12, 3))), false);
});

test('cronMatch: list and range', () => {
  const expr = '0,15,30-45 * * * *';
  assert.equal(cronMatch(expr, new Date(Date.UTC(2026, 5, 26, 12, 0))), true);
  assert.equal(cronMatch(expr, new Date(Date.UTC(2026, 5, 26, 12, 15))), true);
  assert.equal(cronMatch(expr, new Date(Date.UTC(2026, 5, 26, 12, 35))), true);
  assert.equal(cronMatch(expr, new Date(Date.UTC(2026, 5, 26, 12, 46))), false);
});

test('cronMatch: day-of-week 7 normalises to Sunday (0)', () => {
  // 2026-06-28 is a Sunday.
  const sunday = new Date(Date.UTC(2026, 5, 28, 0, 0));
  assert.equal(sunday.getUTCDay(), 0);
  assert.equal(cronMatch('0 0 * * 7', sunday), true);
  assert.equal(cronMatch('0 0 * * 0', sunday), true);
  // Saturday (2026-06-27) does not match.
  assert.equal(cronMatch('0 0 * * 7', new Date(Date.UTC(2026, 5, 27, 0, 0))), false);
});

test('cronMatch: rejects expressions without 5 fields', () => {
  assert.throws(() => cronMatch('* * *', new Date()));
  assert.throws(() => cronMatch('* * * * * *', new Date()));
});

// --- AutomationEngine: event-driven firing + scope integration -------------

test('engine fires an enabled automation on a matching preview event and forwards scope/policyTier', async () => {
  const starter = recordingStarter();
  const emitted: AutomationTriggeredEvent[] = [];
  const engine = new AutomationEngine({ starter, emit: (e) => emitted.push(e) });
  const scope: Scope = { mode: 'allow', paths: ['src/**', '*.glsl'] };
  engine.setAutomations([
    makeAutomation({
      id: 'fixer',
      name: 'Shader Fixer',
      trigger: { kind: 'preview-event', eventType: 'shader-error' },
      scope,
      policyTier: 'source',
      plan: 'fix the shader',
    }),
  ]);

  engine.onPreviewEvent(shaderError);

  // The fire is async; let it settle.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(starter.calls.length, 1);
  const req = starter.calls[0]!;
  assert.equal(req.automationId, 'fixer');
  assert.equal(req.prompt, 'fix the shader');
  assert.deepEqual(req.scope, scope);
  assert.equal(req.policyTier, 'source');
  assert.deepEqual(req.trigger, { kind: 'automation', automationId: 'fixer' });
  assert.equal(req.contextBundle.summary.includes('shader-error'), true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.automationId, 'fixer');
  assert.equal(emitted[0]!.triggerKind, 'preview-event');
});

test('engine does not fire a disabled automation', async () => {
  const starter = recordingStarter();
  const engine = new AutomationEngine({ starter, emit: () => undefined });
  engine.setAutomations([
    makeAutomation({
      id: 'fixer',
      trigger: { kind: 'preview-event', eventType: 'shader-error' },
      enabled: false,
    }),
  ]);
  engine.onPreviewEvent(shaderError);
  await Promise.resolve();
  assert.equal(starter.calls.length, 0);
});

test('engine evaluates the condition before firing', async () => {
  const starter = recordingStarter();
  const engine = new AutomationEngine({ starter, emit: () => undefined });
  engine.setAutomations([
    makeAutomation({
      id: 'fixer',
      trigger: { kind: 'preview-event', eventType: 'perf-threshold' },
      condition: [{ field: 'value', op: '<', value: 25 }],
    }),
  ]);
  // value 22 < 25 → fires.
  engine.onPreviewEvent(perfThresholdFps);
  await Promise.resolve();
  assert.equal(starter.calls.length, 1);
  // value 28 < 25 is false → does not fire.
  starter.calls.length = 0;
  const notBelow: PreviewEvent = {
    type: 'perf-threshold',
    metric: 'fps',
    op: '<',
    value: 28,
    threshold: 30,
  };
  engine.onPreviewEvent(notBelow);
  await Promise.resolve();
  assert.equal(starter.calls.length, 0);
});

test('engine fires on a matching file-change event', async () => {
  const starter = recordingStarter();
  const engine = new AutomationEngine({ starter, emit: () => undefined });
  engine.setAutomations([
    makeAutomation({
      id: 'watcher',
      trigger: { kind: 'file-change', globs: ['src/**'] },
    }),
  ]);
  engine.onFileChange({ type: 'change', path: 'src/main.js' });
  await Promise.resolve();
  assert.equal(starter.calls.length, 1);
  // Non-matching path does not fire.
  engine.onFileChange({ type: 'change', path: 'assets/x.glb' });
  await Promise.resolve();
  assert.equal(starter.calls.length, 1);
});

test('engine.run manually fires a command automation', async () => {
  const starter = recordingStarter();
  const engine = new AutomationEngine({ starter, emit: () => undefined });
  engine.setAutomations([
    makeAutomation({
      id: 'clean',
      trigger: { kind: 'command', name: 'clean-unused' },
      plan: 'clean up',
    }),
  ]);
  const res = await engine.run('clean');
  assert.equal(res.ok, true);
  assert.equal(res.runId, 'run_1');
  assert.equal(starter.calls[0]!.prompt, 'clean up');
});

test('engine.run returns ok:false for a missing automation', async () => {
  const starter = recordingStarter();
  const engine = new AutomationEngine({ starter, emit: () => undefined });
  const res = await engine.run('nope');
  assert.equal(res.ok, false);
});

test('engine forwards a rejected run as ok:false', async () => {
  const starter: AutomationAgentStarter = {
    start: () => Promise.resolve({ runId: 'r', accepted: false, reason: 'no harness' }),
  };
  const engine = new AutomationEngine({ starter, emit: () => undefined });
  engine.setAutomations([makeAutomation({ id: 'x', trigger: { kind: 'command', name: 'x' } })]);
  const res = await engine.run('x');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no harness');
});

// --- AutomationEngine: CRUD + enable/disable + built-in guards -------------

test('engine CRUD creates, updates, deletes user automations', () => {
  const engine = new AutomationEngine({
    starter: recordingStarter(),
    emit: () => undefined,
  });
  const created = engine.create({
    name: 'My Auto',
    description: 'd',
    trigger: { kind: 'command', name: 'mine' },
    plan: 'p',
    scope: { mode: 'project' },
    policyTier: 'project',
  });
  assert.equal(created.enabled, true);
  assert.equal(created.builtIn, false);
  assert.ok(created.id.startsWith('auto_'));

  const updated = engine.update(created.id, { plan: 'p2' });
  assert.equal(updated?.plan, 'p2');

  assert.equal(engine.delete(created.id), true);
  assert.equal(engine.get(created.id), undefined);
});

test('engine enable/disable toggles the enabled flag', () => {
  const engine = new AutomationEngine({
    starter: recordingStarter(),
    emit: () => undefined,
  });
  engine.setAutomations([makeAutomation({ id: 'a', trigger: { kind: 'command', name: 'a' } })]);
  const off = engine.enable('a', false);
  assert.equal(off?.enabled, false);
  const on = engine.enable('a', true);
  assert.equal(on?.enabled, true);
});

test('engine built-ins reject deletion and plan/scope edits but allow enable/disable', () => {
  const engine = new AutomationEngine({
    starter: recordingStarter(),
    emit: () => undefined,
  });
  engine.setAutomations([
    makeAutomation({
      id: 'builtin',
      trigger: { kind: 'command', name: 'b' },
      builtIn: true,
      plan: 'original',
      scope: { mode: 'allow', paths: ['src/**'] },
    }),
  ]);
  assert.equal(engine.delete('builtin'), false);
  // Plan/scope edits are silently ignored for built-ins.
  const updated = engine.update('builtin', { plan: 'hacked', scope: { mode: 'project' } });
  assert.equal(updated?.plan, 'original');
  assert.equal(updated?.scope.mode, 'allow');
  // Enable/disable is allowed.
  assert.equal(engine.enable('builtin', false)?.enabled, false);
});

// --- summarisePreviewEvent -------------------------------------------------

test('summarisePreviewEvent covers every event kind', () => {
  assert.equal(
    summarisePreviewEvent({ type: 'shader-error', message: 'boom', sourcePath: 'a.glsl' }),
    'shader-error in a.glsl: boom',
  );
  assert.equal(
    summarisePreviewEvent({ type: 'runtime-exception', message: 'x' }),
    'runtime-exception: x',
  );
  assert.equal(
    summarisePreviewEvent({ type: 'perf-threshold', metric: 'fps', op: '<', value: 22, threshold: 30 }),
    'perf-threshold: fps < 22 (threshold 30)',
  );
  assert.equal(
    summarisePreviewEvent({ type: 'scene-mutated', editKind: 'set_uniform', objectId: 'cube' }),
    'scene-mutated: set_uniform on cube',
  );
  assert.equal(
    summarisePreviewEvent({ type: 'load-status', phase: 'error', message: 'bad' }),
    'load-status: error — bad',
  );
  assert.equal(
    summarisePreviewEvent({ type: 'interaction', kind: 'select', target: 'cube' }),
    'interaction: select on cube',
  );
});
