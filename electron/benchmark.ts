import type { Session } from '../shared/types';

export function benchmarkWords(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}\p{N}]+)*/gu) ?? [];
}
/** Unit-cost word alignment. Deliberately bounded; no inferred transcript or
 * semantic/number equivalence is substituted for the supplied reference. */
export function wordErrors(reference: string, hypothesis: string) {
  const ref = benchmarkWords(reference), hyp = benchmarkWords(hypothesis);
  if (!ref.length) throw new Error('The reference must contain scorable words.');
  if (ref.length > 10000 || hyp.length > 10000 || ref.length * hyp.length > 25000000) throw new Error('Split large recordings into smaller benchmark cases.');
  let previous = Array.from({ length: hyp.length + 1 }, (_, insertions) => ({ substitutions: 0, deletions: 0, insertions }));
  const cost = (v: typeof previous[number]) => v.substitutions + v.deletions + v.insertions;
  for (let r = 1; r <= ref.length; r++) {
    const current: typeof previous = [{ substitutions: 0, deletions: r, insertions: 0 }];
    for (let h = 1; h <= hyp.length; h++) {
      const diagonal = { ...previous[h - 1], substitutions: previous[h - 1].substitutions + Number(ref[r - 1] !== hyp[h - 1]) };
      const deletion = { ...previous[h], deletions: previous[h].deletions + 1 };
      const insertion = { ...current[h - 1], insertions: current[h - 1].insertions + 1 };
      let best = diagonal;
      if (cost(deletion) < cost(best)) best = deletion;
      if (cost(insertion) < cost(best)) best = insertion;
      current.push(best);
    }
    previous = current;
  }
  const counts = previous[hyp.length];
  return { referenceWords: ref.length, hypothesisWords: hyp.length, ...counts, errors: cost(counts), wer: cost(counts) / ref.length };
}
export function latencyDistribution(values: number[]) {
  const valid = values.filter(value => Number.isFinite(value) && value >= 0 && value <= 86400000).sort((a, b) => a - b);
  const percentile = (p: number) => valid.length ? valid[Math.ceil(p * valid.length) - 1] : null;
  return { samples: valid.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99) };
}
export interface BenchmarkCase { id: string; reference: string; source: 'microphone' | 'system' | 'all'; session: Session; }
export function scoreBenchmark(cases: BenchmarkCase[], measurementClass: 'live' | 'fixture') {
  if (!cases.length || cases.length > 200) throw new Error('Supply one to200 benchmark cases.');
  const seen = new Set<string>();
  const rows = cases.map(sample => {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(sample.id) || seen.has(sample.id)) throw new Error('Benchmark IDs must be unique bounded identifiers.');
    seen.add(sample.id);
    if (!['microphone', 'system', 'all'].includes(sample.source)) throw new Error('Choose each case’s audio source explicitly.');
    if (measurementClass === 'live' && sample.session.demo !== false) throw new Error('Live benchmark inputs must be explicitly non-demo sessions.');
    const lines = sample.session.transcript.filter(line => line.final === true && (sample.source === 'all' || sample.source === line.source));
    if (lines.some(line => !Number.isFinite(Date.parse(line.timestamp)))) throw new Error('Benchmark transcript timestamps must be valid.');
    lines.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const errors = wordErrors(sample.reference, lines.map(line => line.text).join(' '));
    const successful = sample.session.answers.filter(answer => answer.status === 'complete' && answer.refused !== true && !!answer.text.trim());
    const timings = successful.filter(answer => answer.latencyScope === 'application-request');
    const duration = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 86400000;
    const completion = timings.flatMap(answer => duration(answer.latencyMs) ? [answer.latencyMs] : []);
    const first = timings.flatMap(answer => duration(answer.firstTextLatencyMs) && duration(answer.latencyMs) && answer.firstTextLatencyMs <= answer.latencyMs ? [answer.firstTextLatencyMs] : []);
    return { id: sample.id, source: sample.source, finalizedSegments: lines.length, ...errors,
      firstText: latencyDistribution(first), completion: latencyDistribution(completion),
      failedAnswers: sample.session.answers.filter(answer => answer.status === 'error').length,
      refusedAnswers: sample.session.answers.filter(answer => answer.refused === true).length,
      legacyOrMissingTimingAnswers: successful.length - timings.length,
      missingFirstTextAnswers: timings.length - first.length,
      missingCompletionAnswers: timings.length - completion.length,
      timings: { first, completion },
    };
  });
  const total = (key: 'referenceWords' | 'errors' | 'substitutions' | 'deletions' | 'insertions') => rows.reduce((sum, row) => sum + row[key], 0);
  const referenceWords = total('referenceWords'), errors = total('errors');
  return { schemaVersion: 1, measurementClass,
    origin: 'Provided session exports; live origin and model configuration require separate operator evidence.',
    latencyScope: 'application-request', latencyDefinition: 'Application acceptance to first answer text available for publication or completed answer; includes context/screen preparation. Excludes screen paint, OS audio input delay and provider-internal token timing.',
    normalization: 'NFKC, Unicode lowercase, apostrophe normalization, punctuation token boundaries; no number expansion or semantic substitutions. Unit-cost alignment; deterministic diagonal/deletion/insertion tie order.',
    percentileMethod: 'Nearest rank, measured samples only; no value is inferred for missing timing.',
    summary: { cases: rows.length, referenceWords, errors, substitutions: total('substitutions'), deletions: total('deletions'), insertions: total('insertions'), wer: errors / referenceWords,
      firstText: latencyDistribution(rows.flatMap(row => row.timings.first)), completion: latencyDistribution(rows.flatMap(row => row.timings.completion)),
      failedAnswers: rows.reduce((sum, row) => sum + row.failedAnswers, 0), refusedAnswers: rows.reduce((sum, row) => sum + row.refusedAnswers, 0),
      legacyOrMissingTimingAnswers: rows.reduce((sum, row) => sum + row.legacyOrMissingTimingAnswers, 0),
      missingFirstTextAnswers: rows.reduce((sum, row) => sum + row.missingFirstTextAnswers, 0), missingCompletionAnswers: rows.reduce((sum, row) => sum + row.missingCompletionAnswers, 0),
    },
    cases: rows.map(({ timings, ...row }) => row),
  };
}
