// @chema/whatsapp — WhatsApp as a thin channel over the core services (P08,
// docs/09). The provider boundary (simulator, Meta stub) lives in @chema/channels.
export { WhatsAppService, WA_INBOUND_TOPIC, WA_PIPELINE, type WhatsAppServiceDeps, type HandoffSummary } from './service';
export { Orchestrator, WA_LIMITS, AMOUNT_STATES, type HandoffPurpose, type TurnResult } from './orchestrator';
export { FAQ, NoAssistant, matchFaq, humanSignal, type Assistant, type AssistantRoute } from './faq';
export { looksSensitive, maskPhone, parseAmount, parseSlug, waKeys } from './util';
