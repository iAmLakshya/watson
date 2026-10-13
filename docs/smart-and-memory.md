# Watson Smart reasoning and structured memory

Standard personal assistance keeps the configured normal model. Smart has separate model, reasoning-effort, web-search and total-output-budget preferences. The initial Smart model is `gpt-5.4-mini`, effort `medium`, with web research enabled and a 25,000-token ceiling.

The official model page lists Responses, image input, web search and reasoning efforts `none`, `low`, `medium`, `high` and `xhigh` for GPT-5.4 Mini. [OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-5.4-mini)

The output ceiling includes reasoning as well as visible answer tokens. The official reasoning guide recommends an initial allowance of at least 25,000 tokens while measuring requirements; an exhausted allowance can end a response before any visible text. Watson exposes the ceiling rather than counting it as actual usage. Completed provider usage is measured separately. [Reasoning and output limits](https://developers.openai.com/api/docs/guides/reasoning)

Personal Smart uses the selected model and effort, optionally adds `web_search`, and reports incomplete or incompatible provider responses as errors. Known non-reasoning Smart models are rejected before a request. An unknown custom model receives the configured effort; provider incompatibility remains visible, without a fallback to the normal model. Model, effort and budget do not establish answer quality or latency; those require actual provider testing.

## Context and reference provenance

Live requests include recent transcript text, provisional text identified as provisional, current notes/actions, linked contacts, tracked commitments and relevant document/history references. Finalized transcript history is used for post-meeting references. Long notes/email/recap/history requests chunk and summarize complete reference sections, preserving structured memory through the final assembly.

Commitments retain their text, tracker status, owner name or linked contact, due date, and update times. Contact names, emails, company, role and notes enter context only when linked to that session or a tracked owner; unrelated contacts are excluded. The prompt treats these records as reference data. A linked contact does not prove attendance or identify a transcript speaker, and a tracker marked done does not independently prove fulfillment. Conflicting saved owner names and linked people remain separate facts.

The managed assistant resolves private organization prompts and operator credentials on the server. User context travels as reference data; private prompt bodies and model credentials are not copied into personal-provider requests or renderer state. Organization model configuration is separate from personal Smart preferences.

## Evidence

[Context helper tests](../tests/context-memory.test.ts) check manually saved promises absent from transcript/notes, owner/date/status retrieval, contact scoping, instruction/data separation, finalized history, and conflicting records. [Engine semantic tests](../tests/context-only-assist.test.ts) check normal/history/managed request payloads and long-form assembly. Engine parity evidence (`evidence/engine-native-parity-validation.json`, local diagnostic) records source hashes and configured request tests.

These checks use source data and provider fixtures. The user deferred real Deepgram/OpenAI configuration; no paid response, identity-research accuracy or live answer timing is claimed by the fixtures.

The [published validation snapshot](validation.json) summarizes completed checks. Detailed diagnostic files named above are retained locally and excluded from Git.
