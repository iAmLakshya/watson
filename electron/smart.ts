import type { ReasoningEffort, Settings } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/defaults';

// Verified against the official model page, not inferred from a model's name.
const MINI_EFFORTS: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh'];
export function validateSmartConfiguration(settings: Pick<Settings, 'smartModel' | 'smartReasoningEffort'>) {
  const model = settings.smartModel ?? DEFAULT_SETTINGS.smartModel!;
  const effort = settings.smartReasoningEffort ?? DEFAULT_SETTINGS.smartReasoningEffort!;
  if (/^gpt-5\.4-mini(?:-\d{4}-\d{2}-\d{2})?$/.test(model) && !MINI_EFFORTS.includes(effort)) throw new Error(`Smart model ${model} supports reasoning efforts: ${MINI_EFFORTS.join(', ')}.`);
  if (/^(gpt-4(?:\.|o)|gpt-3\.5)/.test(model)) throw new Error(`Smart model ${model} does not support reasoning. Choose a reasoning model or turn off Smart mode.`);
}
export function personalModelOptions(settings: Settings, web = true): { model: string; reasoningEffort?: ReasoningEffort; smart?: boolean; maxOutputTokens?: number } {
  if (!settings.smartMode) return { model: settings.model };
  validateSmartConfiguration(settings);
  const model = settings.smartModel ?? DEFAULT_SETTINGS.smartModel!;
  const effort = settings.smartReasoningEffort ?? DEFAULT_SETTINGS.smartReasoningEffort!;
  return { model, reasoningEffort: effort, smart: web && (settings.smartWebSearch ?? true), maxOutputTokens: settings.smartMaxOutputTokens ?? 25000 };
}
