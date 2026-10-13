import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { scoreBenchmark, type BenchmarkCase } from '../electron/benchmark';
import type { Session } from '../shared/types';

async function main() {
  const [manifestArg, outputArg, ...extra] = process.argv.slice(2);
  if (!manifestArg || !outputArg || extra.length) throw new Error('Usage: node --import tsx tools/benchmark-sessions.ts corpus.json report.json');
  const manifestPath = await realpath(manifestArg), root = dirname(manifestPath), output = resolve(outputArg);
  if (manifestPath === output) throw new Error('Choose an output separate from your benchmark inputs.');
  const limited = async (path: string) => { if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error('Benchmark input exceeds32MiB.'); return readFile(path); };
  const manifestBytes = await limited(manifestPath);
  let manifest: any; try { manifest = JSON.parse(manifestBytes.toString()); } catch { throw new Error('Invalid corpus JSON.'); }
  if (manifest.schemaVersion !== 1 || !['live', 'fixture'].includes(manifest.measurementClass) || !Array.isArray(manifest.cases) || manifest.cases.length < 1 || manifest.cases.length > 200) throw new Error('Supply schemaVersion1, explicit live/fixture class and one to200 cases.');
  if (typeof manifest.description !== 'string' || manifest.description.length > 2000) throw new Error('State the corpus and recording conditions in description.');
  const cases: BenchmarkCase[] = [], hashes: { id: string; sha256: string }[] = [];
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  for (const input of manifest.cases) {
    if (!input || typeof input.export !== 'string' || typeof input.reference !== 'string' || input.reference.length > 100000 || typeof input.id !== 'string') throw new Error('Each case needs an ID, reference, audio source and relative session export.');
    const candidate = await realpath(resolve(root, input.export)), rel = relative(root, candidate);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || candidate === manifestPath || candidate === output) throw new Error('Keep session exports inside the corpus directory and separate from output.');
    const bytes = await limited(candidate); let session: Session;
    try { session = JSON.parse(bytes.toString()); } catch { throw new Error('Invalid session-export JSON.'); }
    if (!session || !Array.isArray(session.transcript) || !Array.isArray(session.answers) || session.transcript.some(line => !line || typeof line.text !== 'string' || typeof line.timestamp !== 'string') || session.answers.some(answer => !answer || typeof answer.text !== 'string')) throw new Error('Use a Watson session JSON export.');
    cases.push({ id: input.id, reference: input.reference, source: input.source, session }); hashes.push({ id: input.id, sha256: hash(bytes) });
  }
  const report = scoreBenchmark(cases, manifest.measurementClass);
  await writeFile(output, JSON.stringify({ ...report, corpusManifestSha256: hash(manifestBytes), exportSha256: hashes, contextDescriptionStoredInInput: true, rawTranscriptOrAnswerTextIncluded: false }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ measurementClass: report.measurementClass, cases: report.summary.cases, referenceWords: report.summary.referenceWords, wer: report.summary.wer, firstTextSamples: report.summary.firstText.samples, outputWritten: true }));
}
main().catch(() => { console.error('Benchmark failed. Check the documented input schema, relative paths, bounds and non-demo requirement. No report is written on invalid input.'); process.exitCode = 1; });
