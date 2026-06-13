// FIX B3-hide-stub-tools — pure not-implemented stub tools (tts_speak,
// sql_query, ha_call_service, ha_get_state) are advertised to the model via
// listToolSchemas, so agents keep calling them and burn round-trips on
// guaranteed failures. They are flagged `unavailable: true` and
// listToolSchemas now skips them — while keeping them registered/inspectable
// so ALL_TOOLS / toolset / runTool references stay intact.
//
// image_generate is NOT a stub: its OPENAI_API_KEY path makes a real
// images/generations call, so it must stay advertised (only the FAL path is
// unimplemented). It is asserted present to guard against re-hiding it.
//
// Pre-fix: listToolSchemas would include every stub it was asked for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listToolSchemas } from '../mas/tool_runner.mjs';
import * as registry from '../mas/tools/registry.mjs';

const STUBS = ['tts_speak', 'sql_query', 'ha_get_state', 'ha_call_service'];

test('listToolSchemas hides unavailable stub tools but keeps real ones', () => {
  const out = listToolSchemas(['tts_speak', 'image_generate', 'sql_query', 'ha_get_state', 'bash']);
  const names = out.map(t => t.name);
  assert.ok(names.includes('bash'), 'bash (a real tool) must still be advertised');
  assert.ok(names.includes('image_generate'), 'image_generate is a working tool, must stay advertised');
  for (const stub of STUBS) {
    assert.ok(!names.includes(stub), `stub "${stub}" must be hidden from tool schemas`);
  }
});

test('stub tools stay registered and inspectable (not unregistered)', () => {
  for (const stub of STUBS) {
    const t = registry.lookup(stub);
    assert.notEqual(t, null, `registry.lookup("${stub}") must still return the tool`);
    assert.equal(t.unavailable, true, `${stub} must be flagged unavailable:true`);
  }
});

test('image_generate is registered without the unavailable flag', () => {
  const t = registry.lookup('image_generate');
  assert.notEqual(t, null, 'image_generate must be registered');
  assert.notEqual(t.unavailable, true, 'image_generate must NOT be flagged unavailable');
});
