import type { AudioLevel, AudioLevels } from '../shared/types';
export function emptyAudioLevels(): AudioLevels { return { microphone: { rms: 0, peak: 0, dbFS: -120, clipping: false }, system: { rms: 0, peak: 0, dbFS: -120, clipping: false } }; }
export function pcm16Level(audio: Buffer, now = new Date().toISOString()): AudioLevel {
  if (audio.length % 2) throw new Error('PCM16 audio must contain complete signed 16-bit samples');
  let squares = 0; let peak = 0; let clipping = false; const samples = audio.length / 2;
  for (let offset = 0; offset < audio.length; offset += 2) { const sample = audio.readInt16LE(offset); const normalized = Math.abs(sample / 32768); squares += normalized * normalized; peak = Math.max(peak, normalized); if (sample === -32768 || sample === 32767) clipping = true; }
  const rms = samples ? Math.sqrt(squares / samples) : 0;
  return { rms, peak, clipping, dbFS: rms > 0 ? Math.max(-120, 20 * Math.log10(rms)) : -120, updatedAt: now };
}
export function currentAudioLevels(levels: AudioLevels, now = Date.now()): AudioLevels { return Object.fromEntries(Object.entries(levels).map(([source, level]) => [source, level.updatedAt && now - new Date(level.updatedAt).getTime() > 1000 ? { ...level, rms: 0, peak: 0, dbFS: -120, clipping: false } : level])) as AudioLevels; }
