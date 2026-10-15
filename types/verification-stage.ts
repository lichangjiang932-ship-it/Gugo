import type { createLoopExecutionScope } from '../server/services/loop/executionScope.js'
export type VerificationCall = Readonly<{ name?: string; args?: Readonly<Record<string, unknown>> }>
export type VerificationResult = Readonly<Record<string, unknown>>
export type VerificationObservation = Readonly<{ changed?: boolean; failed?: boolean; indeterminate?: boolean }>
export type VerificationStageInput = Readonly<{
  call: VerificationCall; result: VerificationResult; succeeded: boolean;
  htmlTargets: readonly string[]; executionScope: ReturnType<typeof createLoopExecutionScope>;
}>
export type VerificationStagePorts = Readonly<{
  observe: (call: VerificationCall, result: VerificationResult) => VerificationObservation;
  repairPrompt: () => string;
  normalizeTarget: (value: unknown) => string;
  targetsMatch: (candidate: string, target: string, scope: ReturnType<typeof createLoopExecutionScope>) => boolean;
}>
export type VerificationStageEffect = Readonly<{
  progress: boolean; messages: readonly Readonly<{ role: 'system'; content: string }>[];
  htmlReads: readonly Readonly<{ path: string; content: string }>[];
}>
export type VerificationEffectHost = Readonly<{
  markProgress: () => void; resetRetries: () => void;
  appendMessage: (message: Readonly<{ role: 'system'; content: string }>) => void;
  retainHtml: (path: string, content: string) => void;
}>
