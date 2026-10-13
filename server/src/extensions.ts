import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal, Row, Store } from './core.ts';
/** Route modules receive the real store and lazy authentication; they must return true only after responding. */
export interface ExtensionContext {
  req: IncomingMessage; res: ServerResponse; url: URL; segments: string[]; path: string;
  store: Store; publicOrigin: string; apiBase: string;
  readJson(): Promise<Row>; readRaw(): Promise<Buffer>;
  authenticate(): Principal;
  /** Only trusted validated routes may extend the absolute body deadline. */
  setBodyTimeout?(milliseconds:number):void;
  send(status: number, data: unknown): void;
}
export type RouteExtension = (context: ExtensionContext) => Promise<boolean>;
