/** Operator configuration only. Known model-family limits verified from official OpenAI model pages on 2026-10-12. */
export type ReasoningEffort='none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max';
export interface OperatorSmartOptions {apiKey?:string;smartModel?:string;smartReasoningEffort?:ReasoningEffort;smartMaxOutputTokens?:number;smartWebSearch?:boolean;}
const efforts:ReasoningEffort[]=['none','minimal','low','medium','high','xhigh','max'];
const known:Array<{pattern:RegExp;efforts:ReasoningEffort[]}>= [
 {pattern:/^gpt-5\.4-mini(?:-\d{4}-\d{2}-\d{2})?$/,efforts:['none','low','medium','high','xhigh']},
 {pattern:/^gpt-5\.5(?:-\d{4}-\d{2}-\d{2})?$/,efforts:['none','low','medium','high','xhigh']},
 {pattern:/^gpt-6-sol(?:-\d{4}-\d{2}-\d{2})?$/,efforts:['none','low','medium','high','xhigh','max']},
 {pattern:/^gpt-(?:6-astra|6\.1-sol)(?:-\d{4}-\d{2}-\d{2})?$/,efforts:['low','medium','high','xhigh','max']}
];
export function operatorSmartStatus(options:OperatorSmartOptions){const model=options.smartModel??null,effort=options.smartReasoningEffort??'high',budget=options.smartMaxOutputTokens??25000,web=options.smartWebSearch??true;let support:'supported'|'unknown'|'unsupported'|'unconfigured'=model?'unknown':'unconfigured',error:string|null=null;
 if(!options.apiKey||!model)error='Configure an operator Smart model and API key.';
 if(model&&(!model.trim()||model.length>200))error='Operator Smart model must be a nonempty model identifier of at most 200 characters.';
 if(model&&/^gpt-(?:3\.5|4(?:$|[.o-]))/.test(model)){support='unsupported';error='The operator Smart model is a known non-reasoning model. Configure a reasoning model; no normal-model fallback is permitted.';}
 const family=model?known.find(item=>item.pattern.test(model)):undefined;if(family){support='supported';if(!family.efforts.includes(effort))error=`The operator Smart model does not support reasoning effort ${effort}. Supported efforts: ${family.efforts.join(', ')}.`;}
 if(!efforts.includes(effort))error='Unknown operator Smart reasoning effort.';
 if(!Number.isSafeInteger(budget)||budget<1024||budget>128000)error='Operator Smart output budget must be an integer from 1024 to 128000.';
 if(typeof web!=='boolean')error='Operator Smart web-search policy must be boolean.';
 const configured=!!(options.apiKey&&model&&!error);return {smartConfigured:configured,smartModel:model,smartReasoningEffort:effort,smartMaxOutputTokens:Number.isFinite(budget)?budget:null,smartWebResearchEnabled:web,smartModelSupport:support,smartConfigurationError:error,smartWebResearchConfigured:configured&&web,smartReasoningEnabled:configured&&effort!=='none'};
}
