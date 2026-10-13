/** Streaming, channel-averaged, anti-aliased resampling. Output is signed PCM16 LE. */
export class PCM16Resampler {
  constructor(inputRate, outputRate = 16000, frameSamples = 320) {
    if (!Number.isFinite(inputRate) || inputRate < 8000 || inputRate > 192000 || outputRate !== 16000) throw new Error('Unsupported PCM sample rate');
    this.inputRate = inputRate; this.outputRate = outputRate; this.frameSamples = frameSamples;
    this.ratio = inputRate / outputRate; this.cutoff = Math.min(1, 1 / this.ratio) * 0.9;
    this.half = 32; this.ring = new Float32Array(256); this.inputCount = 0; this.outputPosition = 0;
    this.frame = new Uint8Array(frameSamples * 2); this.frameOffset = 0;
  }
  push(channels, emit) {
    if (!channels.length || !channels[0]?.length) return;
    const count = channels[0].length;
    for (const channel of channels) if (channel.length !== count) throw new Error('Audio channel length mismatch');
    for (let i = 0; i < count; i++) {
      let mono = 0;
      for (const channel of channels) { const sample = channel[i]; mono += Number.isFinite(sample) ? sample : 0; }
      this.ring[this.inputCount % this.ring.length] = mono / channels.length; this.inputCount++;
      while (this.outputPosition + this.half < this.inputCount) {
        const first = Math.ceil(this.outputPosition - this.half); const last = Math.floor(this.outputPosition + this.half);
        let weighted = 0; let weights = 0;
        for (let index = first; index <= last; index++) {
          const distance = index - this.outputPosition;
          const scaled = Math.PI * distance * this.cutoff;
          const sinc = Math.abs(scaled) < 1e-9 ? 1 : Math.sin(scaled) / scaled;
          const weight = this.cutoff * sinc * (0.5 + 0.5 * Math.cos(Math.PI * distance / this.half));
          const sample = index < 0 ? 0 : this.ring[index % this.ring.length];
          weighted += sample * weight; weights += weight;
        }
        this.write(weighted / weights, emit); this.outputPosition += this.ratio;
      }
    }
  }
  write(value, emit) {
    const clipped = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
    const pcm = Math.round(clipped * (clipped < 0 ? 32768 : 32767));
    this.frame[this.frameOffset++] = pcm & 255; this.frame[this.frameOffset++] = (pcm >> 8) & 255;
    if (this.frameOffset === this.frame.length) { const frame = this.frame; this.frame = new Uint8Array(this.frameSamples * 2); this.frameOffset = 0; emit(frame); }
  }
}

/** Retain at most 160 ms of audio while the renderer/main consumer is stalled. */
export class BoundedPCMQueue {
  constructor(send, capacity = 8) { this.send = send; this.capacity = capacity; this.pending = []; this.inFlight = false; this.sequence = 0; this.dropped = 0; }
  push(frame) {
    if (this.pending.length === this.capacity) { this.pending.shift(); this.dropped++; }
    this.pending.push(frame); this.drain();
  }
  acknowledge() { this.inFlight = false; this.drain(); }
  drain() {
    if (this.inFlight || !this.pending.length) return;
    const frame = this.pending.shift(); this.inFlight = true; this.send(frame, this.sequence++);
  }
  clear() { this.pending = []; }
}
