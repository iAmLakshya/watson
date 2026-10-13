import type { Row } from '../core.ts';

export interface ConnectorOptions {
  /** 32-byte base64 key; supplied by the server operator, separate from SQLite. */
  encryptionKey?: string;
  google?: { clientId: string; clientSecret?: string; redirectUri?: string; authorizationUrl?: string; tokenUrl?: string; revokeUrl?: string; calendarBaseUrl?: string };
  merge?: { apiKey: string; baseUrl?: string };
  /** Deliberately not configurable over HTTP or environment. Local protocol fixtures only. */
  testNetworkOrigins?: string[];
  clock?: () => number;
}
export interface Connection {
  id: string; user_id: string; provider: 'google'|'merge'|'url'; category: string;
  org_id: string|null; team_id: string|null; label: string; status: string;
  settings: Row; last_sync: string|null; last_error: string|null; created_at: string;
}
export interface Credential { accessToken?: string; refreshToken?: string; expiresAt?: number; accountToken?: string; }
export interface ProviderReply { status: number; headers: Headers; data: Row; }
