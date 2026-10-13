/** Engine acceptance to answer text; this does not measure screen paint or
 * provider-internal token generation. Hidden summaries and setup notices are
 * deliberately excluded from the first-text marker. */
export class ResponseTiming {
  private readonly started: number;
  private last = 0;
  firstTextMs?: number;
  constructor(private readonly now: () => number = () => performance.now()) { this.started = now(); }
  elapsed(): number {
    this.last = Math.max(this.last, Math.round(this.now() - this.started));
    return this.last;
  }
  text(value: string): void { if (this.firstTextMs === undefined && value.trim()) this.firstTextMs = this.elapsed(); }
}
