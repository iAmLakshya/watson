import test from 'node:test';
import assert from 'node:assert/strict';
import { personalModelOptions, validateSmartConfiguration } from '../electron/smart';
import { validateSettings } from '../electron/validation';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { streamResponse } from '../electron/providers';

test('normal model remains explicit; Smart selects separate model, configured effort and independent web toggle', () => {
  assert.deepEqual(personalModelOptions({ ...DEFAULT_SETTINGS, model: 'user-normal-model', smartMode: false }), { model: 'user-normal-model' });
  assert.deepEqual(personalModelOptions({ ...DEFAULT_SETTINGS, model: 'user-normal-model', smartMode: true }), { model: 'gpt-5.4-mini', reasoningEffort: 'medium', smart: true, maxOutputTokens: 25000 });
  assert.deepEqual(personalModelOptions({ ...DEFAULT_SETTINGS, smartMode: true, smartModel: 'user-custom-reasoning-model', smartReasoningEffort: 'high', smartWebSearch: false, smartMaxOutputTokens: 32000 }), { model: 'user-custom-reasoning-model', reasoningEffort: 'high', smart: false, maxOutputTokens: 32000 });
  assert.equal(personalModelOptions({ ...DEFAULT_SETTINGS, smartMode: true }, false).smart, false);
});
test('known unsupported models/efforts fail explicitly; unknown chosen model is never replaced', () => {
  assert.throws(() => validateSmartConfiguration({ smartModel: 'gpt-4.1-mini', smartReasoningEffort: 'none' }), /does not support reasoning/);
  assert.throws(() => validateSmartConfiguration({ smartModel: 'gpt-5.4-mini', smartReasoningEffort: 'max' }), /supports reasoning efforts/);
  assert.doesNotThrow(() => validateSmartConfiguration({ smartModel: 'gpt-5.4-mini-2026-03-17', smartReasoningEffort: 'xhigh' }));
  assert.equal(personalModelOptions({ ...DEFAULT_SETTINGS, smartMode: true, smartModel: 'custom-provider-model' }).model, 'custom-provider-model');
});
test('new settings have bounded type validation and retain explicit independent models', () => {
  const patch = validateSettings({ smartModel: 'chosen', smartReasoningEffort: 'high', smartWebSearch: false, smartMaxOutputTokens: 25000, meetingDetectionEnabled: true, meetingStartAction: 'start', meetingEndAction: 'alert', meetingAppBundleIds: ['us.zoom.xos', 'exe:teams.exe'], onboardingCompleted: true, preparationLeadMinutes: 15 }); assert.equal(patch.smartModel, 'chosen');
  for (const value of [0, 1000, 128001, 25000.5, NaN]) assert.throws(() => validateSettings({ smartMaxOutputTokens: value }));
  assert.throws(() => validateSettings({ meetingAppBundleIds: ['../../process'] })); assert.throws(() => validateSettings({ meetingEndDelaySeconds: 1 })); assert.throws(() => validateSettings({ meetingDetectionEnabled: 'true' }));
});
test('real Responses schema carries reasoning effort and full token budget; API rejection makes one request only', async () => {
  const original = globalThis.fetch; let body: any; let calls = 0;
  globalThis.fetch = (async (_url: unknown, options?: RequestInit) => { calls++; body = JSON.parse(String(options?.body)); return new Response('data: {"type":"response.output_text.delta","delta":"Fixture output"}\n\ndata: {"type":"response.completed"}\n\n'); }) as typeof fetch;
  try { await streamResponse('fixture-not-a-key', { ...personalModelOptions({ ...DEFAULT_SETTINGS, smartMode: true, smartWebSearch: false }), instructions: 'Concise answer', text: 'Fixture question', signal: new AbortController().signal }, () => {}); assert.deepEqual(body.reasoning, { effort: 'medium' }); assert.equal(body.model, 'gpt-5.4-mini'); assert.equal(body.max_output_tokens, 25000); assert.equal(body.tools, undefined); assert.equal(calls, 1);
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ error: { message: 'Configured model does not support reasoning' } }), { status: 400 }); }) as typeof fetch; await assert.rejects(streamResponse('fixture', { model: 'chosen-incompatible-model', reasoningEffort: 'high', text: '', instructions: '', signal: new AbortController().signal }, () => {}), /does not support reasoning/); assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
