import assert from 'node:assert/strict';
import test from 'node:test';
import { MarbleClient } from '../src/marble.ts';

test('MarbleClient generateWorld is a stub that returns a null URL', async () => {
  const client = new MarbleClient();
  const result = await client.generateWorld({ prompt: 'a cube world' });
  assert.equal(result.worldUrl, null);
  assert.ok(result.status.includes('stub'));
  assert.ok(result.metadata['note']);
});
