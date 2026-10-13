import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { benchmarkWords, latencyDistribution, scoreBenchmark, wordErrors } from '../electron/benchmark';
import type { Session } from '../shared/types';
import { usageAnalytics, analyticsCsv } from '../electron/analytics';
const run = promisify(execFile);
const session = (text = 'alpha beta'): Session => ({ id: 'fixture', title: 'Fixture source stays private', modeId: 'general', startedAt: '2026-10-12T12:00:00Z', demo: false, pinned: false, transcript: [{ id: 'final', source: 'microphone', text, timestamp: '2026-10-12T12:00:00Z', final: true }], answers: [], notes: '', actions: [], followupDraft: '' });
test('word scoring counts substitutions deletions and insertions with fixed ground truth', () => {
  assert.deepEqual(wordErrors('alpha beta gamma', 'alpha theta gamma'), { referenceWords: 3, hypothesisWords: 3, substitutions: 1, deletions: 0, insertions: 0, errors: 1, wer: 1 / 3 });
  assert.equal(wordErrors('alpha beta gamma', 'alpha gamma').deletions, 1);
  assert.equal(wordErrors('alpha beta gamma', 'alpha vivid beta gamma').insertions, 1);
  assert.equal(wordErrors('alpha', 'alpha extra extra').wer, 2);
  assert.equal(wordErrors('alpha beta', '').deletions, 2);
  assert.throws(() => wordErrors('?!', 'speech'), /reference/);
});
test('Unicode/case/punctuation normalization is explicit and preserves meaning-changing words', () => {
  assert.deepEqual(benchmarkWords('CAFE\u0301, don’t! नमस्ते 世界'), ['café', "don't", 'नमस्ते', '世界']);
  assert.equal(wordErrors('Café, don’t wait.', 'café don’t wait').wer, 0);
  assert.equal(wordErrors('do not ship', 'do ship').deletions, 1);
  assert.throws(() => wordErrors('word '.repeat(10001), 'word'), /large/);
});
test('percentiles use measured nearest-rank samples and empty data stays null', () => {
  assert.deepEqual(latencyDistribution([]), { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null });
  assert.deepEqual(latencyDistribution([20, 0, 10, NaN, -1, Infinity]), { samples: 3, p50Ms: 10, p95Ms: 20, p99Ms: 20 });
});
test('corpus WER is word-weighted and ignores provisional speech and unselected sources', () => {
  const first = session('wrong'); first.transcript.push({ id: 'interim', source: 'microphone', text: 'alpha', final: false, timestamp: first.startedAt }, { id: 'remote', source: 'system', text: 'irrelevant', final: true, timestamp: first.startedAt });
  const second = session('one two three four five six seven eight nine');
  const report = scoreBenchmark([{ id: 'short', reference: 'alpha', source: 'microphone', session: first }, { id: 'long', reference: 'one two three four five six seven eight nine', source: 'microphone', session: second }], 'fixture');
  assert.equal(report.summary.wer, 0.1); assert.equal(report.summary.referenceWords, 10); assert.equal(report.cases[0].finalizedSegments, 1); assert.equal(JSON.stringify(report).includes('irrelevant'), false);
});
test('partial errors refusals missing scope and impossible timing never inflate successful first-text samples', () => {
  const sample = session(); const base = { id: 'one', kind: 'chat' as const, question: '', text: 'Answer', createdAt: sample.startedAt, status: 'complete' as const, sources: [], latencyScope: 'application-request' as const, firstTextLatencyMs: 50, latencyMs: 200 };
  sample.answers = [base, { ...base, id: 'refused', refused: true }, { ...base, id: 'partial', status: 'error' }, { ...base, id: 'legacy', latencyScope: undefined }, { ...base, id: 'bad', firstTextLatencyMs: 300 }];
  const report = scoreBenchmark([{ id: 'timings', reference: 'alpha beta', source: 'microphone', session: sample }], 'fixture');
  assert.equal(report.summary.firstText.samples, 1); assert.equal(report.summary.completion.samples, 2); assert.equal(report.summary.failedAnswers, 1); assert.equal(report.summary.refusedAnswers, 1); assert.equal(report.summary.legacyOrMissingTimingAnswers, 1); assert.equal(report.summary.missingFirstTextAnswers, 1);
  sample.demo = true; assert.throws(() => scoreBenchmark([{ id: 'demo', reference: 'alpha beta', source: 'all', session: sample }], 'live'), /non-demo/);
});
test('local analytics separates first text from completion and leaves legacy timing out of standardized means', () => {
  const sample = session(); sample.answers = [
    { id: 'new', kind: 'chat', question: '', text: 'New answer', createdAt: sample.startedAt, status: 'complete', sources: [], latencyScope: 'application-request', firstTextLatencyMs: 40, latencyMs: 200 },
    { id: 'old', kind: 'chat', question: '', text: 'Old unknown timing', createdAt: sample.startedAt, status: 'complete', sources: [], latencyMs: 1 },
    { id: 'refused', kind: 'chat', question: '', text: 'Refused', createdAt: sample.startedAt, status: 'complete', sources: [], latencyScope: 'application-request', firstTextLatencyMs: 0, latencyMs: 1, refused: true },
  ];
  const report = usageAnalytics([sample]); assert.equal(report.summary.averageFirstTextLatencyMs, 40); assert.equal(report.summary.averageCompletionLatencyMs, 200); assert.equal(report.summary.firstTextSamples, 1); assert.equal(report.summary.completionLatencySamples, 1); assert.match(analyticsCsv(report), /averageFirstTextLatencyMs,averageCompletionLatencyMs/);
});
test('actual CLI hashes exports and reports counts without echoing dialogue or overwriting inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watson-benchmark-'));
  try {
    const exportPath = join(directory, 'session with spaces.json'), corpus = join(directory, 'corpus.json'), output = join(directory, 'report.json');
    const data = JSON.stringify(session('PRIVATE_FIXTURE_DIALOGUE')); await writeFile(exportPath, data);
    await writeFile(corpus, JSON.stringify({ schemaVersion: 1, measurementClass: 'fixture', description: 'Generated fixture, no physical audio/provider.', cases: [{ id: 'private_case', reference: 'PRIVATE_FIXTURE_DIALOGUE', source: 'microphone', export: 'session with spaces.json' }] }));
    const result = await run(process.execPath, ['--import', 'tsx', resolve('tools/benchmark-sessions.ts'), corpus, output]); const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.summary.wer, 0); assert.equal(report.exportSha256.length, 1); assert.equal(report.rawTranscriptOrAnswerTextIncluded, false);
    assert.equal(JSON.stringify(report).includes('PRIVATE_FIXTURE_DIALOGUE'), false); assert.equal(result.stdout.includes('PRIVATE_FIXTURE_DIALOGUE'), false);
    assert.equal(await readFile(exportPath, 'utf8'), data);
    await assert.rejects(run(process.execPath, ['--import', 'tsx', resolve('tools/benchmark-sessions.ts'), corpus, output]));
    const alias = join(directory, 'alias.json'); await symlink(exportPath, alias);
    await assert.rejects(run(process.execPath, ['--import', 'tsx', resolve('tools/benchmark-sessions.ts'), corpus, alias])); assert.equal(await readFile(exportPath, 'utf8'), data);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
