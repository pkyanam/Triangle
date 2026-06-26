import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runAcpSession } from '../src/main/agent/acp-session.ts';
import type { RunContext } from '../src/main/agent/harness.ts';
import type { ImageAttachment, ToolCallTrace } from '@triangle/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Build a minimal RunContext for ACP tests. */
function fakeContext(overrides?: Partial<RunContext>): RunContext {
  return {
    prompt: 'hello',
    projectRoot: '/tmp',
    config: {},
    toolset: {
      projectTree: async () => '',
      readFile: async () => '',
      writeFile: async () => '',
      captureScreenshot: async () => '',
      describeScene: async () => '',
      validateShader: async () => '',
      performanceSnapshot: async () => '',
      setUniform: async () => '',
      setMaterialColor: async () => '',
      setTransform: async () => '',
      setVisibility: async () => '',
      setLight: async () => '',
      hfGenerate3dAsset: async () => '',
      download3dAsset: async () => '',
      import3dAsset: async () => '',
      roboticsSnippet: async () => '',
    } as unknown as RunContext['toolset'],
    toolBridge: { port: 0, token: 'x', serverScriptPath: '' },
    mcpEndpoint: null,
    autoApproveWrites: false,
    requestApproval: async () => ({ approved: false, scope: 'once' }),
    signal: new AbortController().signal,
    emit: () => {},
    ...overrides,
  };
}

/** Helper that waits for runAcpSession against a fake agent script. */
async function runFakeAgent(script: string, ctx: RunContext): Promise<{
  events: Array<{ type: string; messageId?: string; text?: string; trace?: ToolCallTrace; level?: string }>;
  error?: Error;
}> {
  const events: Array<{ type: string; messageId?: string; text?: string; trace?: ToolCallTrace; level?: string }> = [];
  const emit = (e: { type: string; messageId?: string; text?: string; trace?: ToolCallTrace; level?: string }) => {
    events.push(e);
  };
  const finalCtx = { ...ctx, emit };
  const error = await runAcpSession(finalCtx, {
    command: process.execPath,
    args: [path.join(__dirname, 'fixtures', script)],
    label: 'fake-agent',
  }).catch((e: Error) => e);
  return { events, error };
}

describe('runAcpSession', () => {
  it('deduplicates tool_call and tool_call_update by toolCallId', async () => {
    const { events } = await runFakeAgent('fake-agent-tool-dedup.mjs', fakeContext());

    const toolEvents = events.filter((e) => e.type === 'tool');
    // The runner emits each update so the UI can stream state, but every update
    // for a given toolCallId shares the same trace id.
    assert.equal(toolEvents.length, 4, 'should emit two initial + two update tool events');

    const ids = new Set(toolEvents.map((e) => e.trace?.id));
    assert.equal(ids.size, 2, 'tool events should have distinct trace ids');

    const first = toolEvents.findLast((e) => e.trace?.id === 'acp-call-001')?.trace;
    const second = toolEvents.findLast((e) => e.trace?.id === 'acp-call-002')?.trace;
    assert.equal(first?.status, 'ok', 'first tool call should complete as ok');
    assert.equal(second?.status, 'error', 'second tool call should fail as error');
    assert.equal(first?.tool, 'Read file', 'first tool label should come from title');
    assert.equal(second?.kind, 'execute', 'second tool kind should be execute');
    assert.equal(first?.result, 'Read src/main.js', 'first tool result should be extracted');
  });

  it('buffers assistant messages by messageId', async () => {
    const { events } = await runFakeAgent('fake-agent-messages.mjs', fakeContext());

    const assistantEvents = events.filter((e) => e.type === 'assistant');
    // The runner emits each chunk, so there are three events but only two messages.
    assert.equal(assistantEvents.length, 3, 'should emit one event per chunk');

    const ids = new Set(assistantEvents.map((e) => e.messageId));
    assert.equal(ids.size, 2, 'assistant events should have distinct messageIds');

    const first = assistantEvents.findLast((e) => e.messageId === 'msg-1');
    const second = assistantEvents.findLast((e) => e.messageId === 'msg-2');
    assert.equal(first?.text, 'Hello there', 'first message should accumulate all chunks');
    assert.equal(second?.text, 'world', 'second message should be buffered correctly');
  });

  it('sends image attachments as ACP content blocks', async () => {
    const attachment: ImageAttachment = {
      id: 'img-1',
      name: 'test.png',
      mimeType: 'image/png',
      sizeBytes: 8,
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    };
    const { events } = await runFakeAgent(
      'fake-agent-prompt-inspector.mjs',
      fakeContext({ prompt: 'look at this', attachments: [attachment] }),
    );

    const assistantEvents = events.filter((e) => e.type === 'assistant');
    const promptLog = assistantEvents.find((e) => e.text?.startsWith('PROMPT:'));
    assert.ok(promptLog, 'agent should have received the prompt');
    assert.ok(promptLog?.text?.includes('"type":"image"'), 'prompt should contain an image block');
    assert.ok(promptLog?.text?.includes('"mimeType":"image/png"'), 'image block should have the right mime type');
    assert.ok(promptLog?.text?.includes('iVBORw0KGgo='), 'image block should contain the base64 data');
  });

  it('forwards fs/read_text_file and fs/write_text_file to the toolset', async () => {
    let readPath: string | undefined;
    let wrote = false;
    const ctx = fakeContext({
      toolset: {
        ...fakeContext().toolset,
        readFile: async (p: string) => {
          readPath = p;
          return 'file content';
        },
        writeFile: async () => {
          wrote = true;
          return 'done';
        },
      } as unknown as RunContext['toolset'],
    });
    const { error } = await runFakeAgent('fake-agent-fs-requests.mjs', ctx);

    assert.equal(error, undefined, 'run should not error');
    assert.equal(readPath, 'src/main.js', 'should read the project-relative path');
    assert.equal(wrote, true, 'should write through the toolset');
  });
});
