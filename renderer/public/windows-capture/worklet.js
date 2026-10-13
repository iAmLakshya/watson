import { BoundedPCMQueue, PCM16Resampler } from './pcm-core.js';

class WatsonPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.resampler = new PCM16Resampler(sampleRate); this.stopped = false;
    this.queue = new BoundedPCMQueue((data, sequence) => this.port.postMessage({ type: 'audio', data, sequence }, [data.buffer]));
    this.port.onmessage = ({ data }) => { if (data?.type === 'ack') this.queue.acknowledge(); if (data?.type === 'stop') { this.stopped = true; this.queue.clear(); } };
    this.lastReported = 0;
  }
  process(inputs, outputs) {
    // A connected silent output keeps the graph rendering without audible feedback.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.stopped) return false;
    this.resampler.push(inputs[0] || [], frame => this.queue.push(frame));
    if (this.queue.dropped > this.lastReported && currentTime % 1 < 128 / sampleRate) {
      this.port.postMessage({ type: 'overrun', dropped: this.queue.dropped - this.lastReported }); this.lastReported = this.queue.dropped;
    }
    return true;
  }
}
registerProcessor('watson-pcm16', WatsonPCMProcessor);
