import type { AnalyticsFilter, Settings } from '../shared/types';
import type {} from '../shared/preparation-types';
import { validateSmartConfiguration } from './smart';
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object'); return value as Record<string, unknown>; }
export function string(value: unknown, field = 'value', max = 10000): string { if (typeof value !== 'string' || value.length > max) throw new Error(`${field} must be text of at most ${max} characters`); return value; }
export function optionalString(value: unknown, field?: string, max?: number) { return value === undefined ? undefined : string(value, field, max); }
export function boolean(value: unknown, field = 'value'): boolean { if (typeof value !== 'boolean') throw new Error(`${field} must be true or false`); return value; }
export function strings(value: unknown, field = 'value', maxItems = 100): string[] { if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} must be an array with at most ${maxItems} items`); return value.map(item => string(item, field)); }
export function oneOf<const T extends string>(value: unknown, allowed: readonly T[], field = 'value'): T { if (!allowed.includes(value as T)) throw new Error(`Invalid ${field}`); return value as T; }
export function safeExternalUrl(value: unknown, maxLength = 4000) { const url = new URL(string(value, 'URL', maxLength)); if (url.protocol !== 'https:') throw new Error('Only HTTPS links may open outside Watson'); return url.href; }
export function finiteNumber(value: unknown, field: string, minimum: number, maximum: number) { if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${field} must be a number between ${minimum} and ${maximum}`); return value; }
export function dateString(value: unknown, field = 'date') { const text = string(value, field, 200); if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(text) || !Number.isFinite(Date.parse(text))) throw new Error(`${field} must be a valid ISO date`); return new Date(text).toISOString(); }
export function analyticsFilter(value: unknown): AnalyticsFilter { const input = object(value); const result: AnalyticsFilter = {}; for (const field of ['from', 'to'] as const) if (input[field]) { const normalized = dateString(input[field], field); result[field] = field === 'to' && /^\d{4}-\d{2}-\d{2}$/.test(String(input[field])) ? normalized.replace('T00:00:00.000Z', 'T23:59:59.999Z') : normalized; } if (result.from && result.to && result.from > result.to) throw new Error('The report end date must follow its start date'); if (input.modeId) result.modeId = string(input.modeId, 'mode ID', 200); if (input.personId) result.personId = string(input.personId, 'person ID', 200); if (input.includeDemo !== undefined) result.includeDemo = boolean(input.includeDemo); return result; }
export function validateSettings(value: unknown): Partial<Settings> {
  const input = object(value); const result: Partial<Settings> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'theme') result.theme = oneOf(value, ['dark', 'light', 'system'], 'theme');
    else if (key === 'opacity') { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.3 || value > 1) throw new Error('Opacity must be between 0.3 and 1'); result.opacity = value; }
    else if (['contentProtection', 'clickthrough', 'captureSystem', 'captureMicrophone', 'captureScreen', 'smartMode', 'autoAssist', 'launchAtLogin', 'meetingDetectionEnabled', 'meetingBrowserAlerts', 'meetingBrowserAutoStart', 'smartWebSearch', 'onboardingCompleted', 'automaticPreparation'].includes(key)) (result as Record<string, unknown>)[key] = boolean(value, key);
    else if (['displayId', 'microphoneDeviceId', 'language', 'outputLanguage', 'model', 'transcriptionModel', 'activeModeId', 'smartModel', 'preparationModel'].includes(key)) { const text = string(value, key, 200); if (['model', 'smartModel'].includes(key) && !text.trim()) throw new Error(`${key} must name a model`); (result as Record<string, unknown>)[key] = text; }
    else if (key === 'smartReasoningEffort') result.smartReasoningEffort = oneOf(value, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], key);
    else if (key === 'smartMaxOutputTokens') { result.smartMaxOutputTokens = finiteNumber(value, key, 1024, 128000); if (!Number.isInteger(result.smartMaxOutputTokens)) throw new Error('Smart token budget must be an integer'); }
    else if (key === 'meetingStartAction') result.meetingStartAction = oneOf(value, ['off', 'alert', 'start'], key);
    else if (key === 'meetingEndAction') result.meetingEndAction = oneOf(value, ['off', 'alert', 'stop'], key);
    else if (key === 'meetingStartDelaySeconds') result.meetingStartDelaySeconds = finiteNumber(value, key, 2, 60);
    else if (key === 'meetingEndDelaySeconds') result.meetingEndDelaySeconds = finiteNumber(value, key, 10, 300);
    else if (key === 'meetingAppBundleIds') { result.meetingAppBundleIds = strings(value, key, 50).map(id => { if (!/^[A-Za-z0-9_.:\-]{1,200}$/.test(id)) throw new Error('Meeting app identities must be macOS bundle IDs or exe:application.exe'); return id; }); }
    else if (key === 'preparationLeadMinutes') result.preparationLeadMinutes = finiteNumber(value, key, 1, 180);
    else if (key === 'preparationRefreshMinutes') result.preparationRefreshMinutes = finiteNumber(value, key, 5, 1440);
    else if (key === 'instructions') result.instructions = string(value, key, 20000);
    else if (key === 'shortcuts') { const shortcuts = object(value); const allowed = ['toggleOverlay', 'assist', 'toggleClickthrough', 'moveLeft', 'moveRight', 'moveUp', 'moveDown', 'scrollUp', 'scrollDown', 'clearChat', 'startStopSession']; result.shortcuts = {} as Settings['shortcuts']; for (const [action, accelerator] of Object.entries(shortcuts)) { oneOf(action, allowed, 'shortcut action'); result.shortcuts[action as keyof Settings['shortcuts']] = string(accelerator, 'shortcut', 100); } }
    else throw new Error(`Unknown setting: ${key}`);
  }
  if (result.smartModel !== undefined && result.smartReasoningEffort !== undefined) validateSmartConfiguration(result);
  return result;
}
