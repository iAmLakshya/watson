import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { BUILTIN_MODES, BUILTIN_SCORECARDS, DEFAULT_EMAIL_TEMPLATE, DEFAULT_SETTINGS } from '../shared/defaults';
import type { Answer, CalendarEvent, Commitment, CredentialsStatus, KnowledgeDocument, KnowledgeFolder, Mode, Person, Scorecard, Session, Settings } from '../shared/types';

interface PersistedData { schemaVersion: 1; settings: Settings; sessions: Session[]; knowledge: KnowledgeDocument[]; modes: Mode[]; calendar: CalendarEvent[]; encryptedKeys: { openai?: string; deepgram?: string }; contextAnswers: Answer[]; people: Person[]; scorecards: Scorecard[]; folders: KnowledgeFolder[]; }
export class Store {
  data: PersistedData;
  private readonly path: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); this.path = join(directory, 'watson.json');
    const empty: PersistedData = { schemaVersion: 1, settings: structuredClone(DEFAULT_SETTINGS), sessions: [], knowledge: [], modes: structuredClone(BUILTIN_MODES), calendar: [], encryptedKeys: {}, contextAnswers: [], people: [], scorecards: structuredClone(BUILTIN_SCORECARDS), folders: [] };
    this.data = empty;
    if (existsSync(this.path)) {
      const saved: Partial<PersistedData> = JSON.parse(readFileSync(this.path, 'utf8'));
      if (saved.schemaVersion !== 1) throw new Error('Unsupported Watson data format. Your existing file has been preserved.');
      this.data = { ...empty, ...saved, settings: { ...empty.settings, ...saved.settings, shortcuts: { ...empty.settings.shortcuts, ...saved.settings?.shortcuts } }, encryptedKeys: saved.encryptedKeys ?? {} };
      if (!Array.isArray(this.data.sessions) || !Array.isArray(this.data.knowledge) || !Array.isArray(this.data.modes) || !Array.isArray(this.data.calendar) || !Array.isArray(this.data.contextAnswers) || !Array.isArray(this.data.people) || !Array.isArray(this.data.scorecards) || !Array.isArray(this.data.folders)) throw new Error('Watson data file is malformed; the original file has been preserved.');
    }
    this.data.modes = this.data.modes.map(mode => ({ ...mode, emailTemplate: mode.emailTemplate ?? DEFAULT_EMAIL_TEMPLATE, customActions: mode.customActions ?? [] }));
  }
  save() { const temporary = `${this.path}.tmp`; writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 }); renameSync(temporary, this.path); }
  key(provider: 'openai' | 'deepgram'): string | undefined {
    const environment = process.env[provider === 'openai' ? 'OPENAI_API_KEY' : 'DEEPGRAM_API_KEY'];
    if (environment) return environment;
    const encrypted = this.data.encryptedKeys[provider];
    if (!encrypted || !safeStorage.isEncryptionAvailable()) return;
    try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); } catch { return; }
  }
  credentialStatus(): CredentialsStatus { return { openai: !!this.key('openai'), deepgram: !!this.key('deepgram'), secureStorage: safeStorage.isEncryptionAvailable() }; }
  saveKeys(keys: { openai?: string; deepgram?: string }) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable. Set provider keys in the launch environment instead.');
    for (const provider of ['openai', 'deepgram'] as const) {
      const value = keys[provider]; if (value === undefined) continue;
      if (!value.trim()) delete this.data.encryptedKeys[provider];
      else this.data.encryptedKeys[provider] = safeStorage.encryptString(value.trim()).toString('base64');
    }
    this.save(); return this.credentialStatus();
  }
  session(id: string) { const session = this.data.sessions.find(item => item.id === id); if (!session) throw new Error('Session does not exist'); return session; }
  createSession(title: string, demo: boolean, modeId: string) {
    const session: Session = { id: randomUUID(), title: title || 'Untitled session', startedAt: new Date().toISOString(), modeId, demo, pinned: false, transcript: [], answers: [], notes: '', actions: [], followupDraft: '', tags: [], attendeeIds: [], commitments: [], coaching: [], usage: { captureMs: 0, audioSamples: { microphone: 0, system: 0 }, screenshots: 0, providerRequests: 0, inputTokens: 0, outputTokens: 0 } };
    this.data.sessions.unshift(session); this.save(); return session;
  }
  addKnowledge(title: string, text: string, fileType = 'text', size = Buffer.byteLength(text)) {
    if (!text.trim()) throw new Error('The document contains no readable text');
    const document: KnowledgeDocument = { id: randomUUID(), title, text, addedAt: new Date().toISOString(), size, fileType };
    this.data.knowledge.unshift(document); this.save(); return document;
  }
  savePerson(input: Omit<Person, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) {
    const email = input.email?.trim().toLowerCase() || undefined; const existing = input.id ? this.data.people.find(person => person.id === input.id) : email ? this.data.people.find(person => person.email?.toLowerCase() === email) : undefined;
    if (input.id && !existing) throw new Error('Person does not exist'); if (email && this.data.people.some(person => person.email === email && person.id !== existing?.id)) throw new Error('Another person already has this email address');
    const now = new Date().toISOString(); const person: Person = { ...input, id: existing?.id ?? randomUUID(), email, name: input.name.trim(), createdAt: existing?.createdAt ?? now, updatedAt: now };
    if (!person.name) throw new Error('A person needs a name'); this.data.people = existing ? this.data.people.map(item => item.id === person.id ? person : item) : [...this.data.people, person]; this.save(); return person;
  }
  saveCommitment(input: { sessionId: string; id?: string; text: string; personId?: string; ownerName?: string; dueAt?: string; status?: 'open' | 'done' }) {
    const session = this.session(input.sessionId); if (input.personId && !this.data.people.some(person => person.id === input.personId)) throw new Error('The selected owner does not exist');
    const existing = session.commitments?.find(item => item.id === input.id); if (input.id && !existing) throw new Error('Commitment does not exist'); const now = new Date().toISOString();
    const commitment: Commitment = { id: existing?.id ?? randomUUID(), text: input.text.trim(), personId: input.personId, ownerName: input.ownerName || this.data.people.find(person => person.id === input.personId)?.name, dueAt: input.dueAt, status: input.status ?? existing?.status ?? 'open', createdAt: existing?.createdAt ?? now, updatedAt: now };
    if (!commitment.text) throw new Error('A commitment needs a description'); session.commitments = existing ? (session.commitments ?? []).map(item => item.id === commitment.id ? commitment : item) : [...session.commitments ?? [], commitment]; this.save(); return commitment;
  }
}
