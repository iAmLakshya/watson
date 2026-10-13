import type {} from './types';
export type UpdateCommand = 'updates:status' | 'updates:check' | 'updates:stage' | 'updates:clear' | 'updates:install';
declare module './types' {
  interface AppState { updates?: UpdateStatus; }
  interface IpcCommands {
    'updates:status': { input: undefined; output: UpdateStatus };
    'updates:check': { input: undefined; output: UpdateStatus };
    'updates:stage': { input: undefined; output: UpdateStatus };
    'updates:clear': { input: undefined; output: UpdateStatus };
    'updates:install': { input: undefined; output: UpdateStatus };
  }
}
export interface UpdateStatus {
  phase: 'unconfigured' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'verifying' | 'staged' | 'preparing-install' | 'error';
  configured: boolean;
  currentVersion: string;
  platform: string;
  architecture: string;
  availableVersion?: string;
  stagedVersion?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  lastCheckedAt?: string;
  stagedAt?: string;
  message: string;
  configurationGates: string[];
  readyToInstall: boolean;
}
export interface ReleaseSigning {
  type: 'developer-id' | 'authenticode';
  teamId?: string;
  certificateThumbprint?: string;
  executable?: string;
}
export interface UpdateArtifact {
  platform: 'darwin' | 'win32';
  architecture: 'arm64' | 'x64';
  format: 'zip';
  url: string;
  sha256: string;
  size: number;
  bundlePath: string;
  signing: ReleaseSigning;
}
export interface UpdateManifest {
  schemaVersion: 1;
  appId: string;
  version: string;
  channel: 'stable' | 'beta';
  releasedAt: string;
  issuedAt: string;
  expiresAt: string;
  minimumVersion?: string;
  artifacts: UpdateArtifact[];
}
export interface SignedUpdateManifest { keyId: string; payload: string; signature: string; }
export interface UpdateConfiguration {
  enabled: boolean;
  appId: string;
  channel: 'stable' | 'beta';
  feedUrl?: string;
  artifactOrigins?: string[];
  publicKeys?: Record<string, string>;
  signing?: { darwinTeamId?: string; windowsCertificateThumbprint?: string };
  maxDownloadBytes?: number;
  maxExtractedBytes?: number;
  maxEntryBytes?: number;
  maxEntries?: number;
  requestTimeoutMs?: number;
  configurationGates?: string[];
}
