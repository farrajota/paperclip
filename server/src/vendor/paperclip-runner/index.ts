/**
 * Development shim for the package-local runner runtime.
 *
 * Source-mode server entry points do not build workspace dependencies first,
 * so this shim loads the package source through the TypeScript runtime. The
 * server build replaces the emitted shim with the package's compiled `dist`
 * tree so published server packages have no workspace runtime dependency.
 * Keep server imports pointed at this relative boundary.
 */
type RunnerModule = typeof import("@paperclipai/paperclip-runner");

export type {
  PaperclipJsonValue,
  PaperclipQuestionResponse,
  PaperclipSemanticActionBinding,
  PaperclipSemanticActionId,
  PaperclipSemanticAuthorizationRecord,
  PaperclipSemanticRunContext,
  PaperclipSemanticToolCall,
  PaperclipSemanticToolDefinition,
  PaperclipSemanticToolResult,
  PaperclipRunnerAuthorizedToolSet,
  PaperclipQuestionSet,
  PaperclipRuntimeInputRequest,
  CompleteControlPlaneRunInput,
  ControlPlanePort,
  HarnessRuntimeRequestKind,
  HarnessRuntimeRequestResolution,
  NativeAcpxAgent,
  NativeAcpxPermissionMode,
  NativeCodexApprovalPolicy,
  NativeExecutionInput,
  NativeExecutionInputV4,
  NativeExecutionInputV5,
  NativeCompletionSource,
  NativeCompletionSources,
  NativeInteractionResponseEnvelope,
  NativeOpenCodePermissionMode,
  NativePlanningContext,
  NativeRunEvent,
  NativeRunResult,
  NativeRuntimeAssetReference,
  NativeRuntimeContextSnapshot,
  NativeSession,
  NativeSessionBackend,
  NativeSessionGoalControl,
  OpenControlPlaneRunInput,
  PersistedNativeSession,
  PrpEvent,
  PrpIgnoredAttentionRequest,
  PrpNormalizedAttentionRequest,
  PrpStructuredRunResult,
  PrpTerminalState,
  PrpVerificationReasonCode,
  PrpWireConnection,
  ReplayControlPlaneEventsInput,
  RunnerProcessHandle,
  RunnerProcessLaunchSpec,
  StrictCompletionContractInput,
  TransportCloseReason,
} from "@paperclipai/paperclip-runner";
export type DurablePrpControlPlane =
  import("@paperclipai/paperclip-runner").DurablePrpControlPlane;
export type PaperclipSemanticDispatcher =
  import("@paperclipai/paperclip-runner").PaperclipSemanticDispatcher;

const sourceRootUrl = new URL(
  "../../../../packages/paperclip-runner/src/",
  import.meta.url,
);

function loadRunnerSource<K extends keyof RunnerModule>(
  relativePath: string,
): Promise<Pick<RunnerModule, K>> {
  return import(new URL(relativePath, sourceRootUrl).href) as Promise<
    Pick<RunnerModule, K>
  >;
}

const [
  controlPlane,
  runnerdTransport,
  backendContracts,
  semanticDispatcher,
  semanticCatalog,
  harnessContracts,
  runtimeContext,
  acpxRecovery,
  backendFactory,
  codexBackend,
  authorizedTools,
  sessionRuntime,
  resultNormalization,
  codexTurnDiff,
  executionContracts,
  questionContracts,
  acpxProfiles,
  replayContracts,
] = await Promise.all([
  loadRunnerSource<
    | "inspectWarmRunTransition"
    | "DurablePrpControlPlane"
  >("control-plane/durable-prp-control-plane.ts"),
  loadRunnerSource<
    | "readRunnerdArtifactBinding"
    | "retainedRunnerdMaintenanceIsIdle"
    | "drainRetainedRunnerdMaintenanceOperations"
    | "settleRetainedRunnerdSession"
    | "runnerCodexDynamicToolsFit"
    | "resolveSourceCodexHome"
    | "defaultCapabilityRunnerdBinary"
    | "createRunnerdCodexTransport"
  >("live/runnerd-codex-transport.ts"),
  loadRunnerSource<
    | "nativeRestartInterruptedTurnId"
    | "SemanticToolOutcomeUnknownError"
    | "NativeSessionProtocolIntegrityError"
    | "NativeSessionCleanupQuarantinedError"
    | "NativeProviderTerminalFailure"
  >("contracts/native-session-backend.ts"),
  loadRunnerSource<"PaperclipSemanticDispatcher">("semantic-tools/paperclip-dispatcher.ts"),
  loadRunnerSource<"CAPABILITY_SEMANTIC_TOOL_CATALOG">("semantic-tools/catalog.ts"),
  loadRunnerSource<
    | "HarnessRuntimeRequestResolutionError"
    | "parseHarnessRuntimeRequestResolution"
  >("contracts/harness-driver.ts"),
  loadRunnerSource<
    | "NATIVE_RUNTIME_ASSET_SCHEMA"
    | "PAPERCLIP_EXECUTION_PROMPT"
    | "PAPERCLIP_EXECUTION_PROMPT_REVISION"
    | "canonicalNativeRuntimeContextDigest"
    | "nativeRuntimePromptDigest"
    | "parseNativeRuntimeContext"
  >("contracts/runtime-context.ts"),
  loadRunnerSource<"acpxRuntimeSessionDirectoryName">("drivers/acpx/recovery-identity.ts"),
  loadRunnerSource<"createNativeSessionBackend">("backends/native-backend-factory.ts"),
  loadRunnerSource<"describeRunnerdNativeSessionBackend">("backends/codex-native-backend.ts"),
  loadRunnerSource<"createPaperclipRunnerAuthorizedToolSet">("semantic-tools/runner-authorized-tools.ts"),
  loadRunnerSource<
    | "completeRetainedNativeSessionCleanup"
    | "completeTerminatedRemoteNativeSessionCleanup"
    | "completeTerminatedLocalNativeSessionCleanup"
    | "applyNativeSessionGoalControl"
    | "executeNativeSession"
  >("native-session-runtime.ts"),
  loadRunnerSource<"normalizePrpResultSignals">("protocol/result-normalization.ts"),
  loadRunnerSource<"parseCodexTurnDiff">("drivers/codex/codex-turn-diff.ts"),
  loadRunnerSource<"parseNativeExecutionInput">("contracts/native-execution.ts"),
  loadRunnerSource<
    | "parsePaperclipQuestionSet"
    | "parsePaperclipQuestionResponse"
  >("contracts/question-set.ts"),
  loadRunnerSource<"resolveQualifiedAcpxProfile">("drivers/acpx/qualified-profiles.ts"),
  loadRunnerSource<
    | "validatePrpEvent"
    | "validatePrpStructuredRunResult"
  >("protocol/replay-contract.ts"),
  // Preserve canonical operation validation without loading unused aggregate APIs.
  import(new URL("catalog/canonical-operations.ts", sourceRootUrl).href),
]);

export const DurablePrpControlPlane = controlPlane.DurablePrpControlPlane;
export const runnerCodexDynamicToolsFit = runnerdTransport.runnerCodexDynamicToolsFit;
export const inspectWarmRunTransition = controlPlane.inspectWarmRunTransition;
export const readRunnerdArtifactBinding = runnerdTransport.readRunnerdArtifactBinding;
export const NativeSessionCleanupQuarantinedError =
  backendContracts.NativeSessionCleanupQuarantinedError;
export const NativeSessionProtocolIntegrityError =
  backendContracts.NativeSessionProtocolIntegrityError;
export const SemanticToolOutcomeUnknownError = backendContracts.SemanticToolOutcomeUnknownError;
export const PaperclipSemanticDispatcher = semanticDispatcher.PaperclipSemanticDispatcher;
export const CAPABILITY_SEMANTIC_TOOL_CATALOG =
  semanticCatalog.CAPABILITY_SEMANTIC_TOOL_CATALOG;
export const HarnessRuntimeRequestResolutionError =
  harnessContracts.HarnessRuntimeRequestResolutionError;
export const NATIVE_RUNTIME_ASSET_SCHEMA = runtimeContext.NATIVE_RUNTIME_ASSET_SCHEMA;
export const PAPERCLIP_EXECUTION_PROMPT = runtimeContext.PAPERCLIP_EXECUTION_PROMPT;
export const PAPERCLIP_EXECUTION_PROMPT_REVISION =
  runtimeContext.PAPERCLIP_EXECUTION_PROMPT_REVISION;
export const acpxRuntimeSessionDirectoryName =
  acpxRecovery.acpxRuntimeSessionDirectoryName;
export const canonicalNativeRuntimeContextDigest =
  runtimeContext.canonicalNativeRuntimeContextDigest;
export const createNativeSessionBackend = backendFactory.createNativeSessionBackend;
export const describeRunnerdNativeSessionBackend = codexBackend.describeRunnerdNativeSessionBackend;
export const createPaperclipRunnerAuthorizedToolSet =
  authorizedTools.createPaperclipRunnerAuthorizedToolSet;
export const createRunnerdCodexTransport: (
  options?: import("@paperclipai/paperclip-runner").RunnerdCodexTransportOptions,
) => import("@paperclipai/paperclip-runner").RunnerdCodexTransport =
  runnerdTransport.createRunnerdCodexTransport;
export const defaultCapabilityRunnerdBinary =
  runnerdTransport.defaultCapabilityRunnerdBinary;
export const executeNativeSession = sessionRuntime.executeNativeSession;
export const applyNativeSessionGoalControl =
  sessionRuntime.applyNativeSessionGoalControl;
export const completeRetainedNativeSessionCleanup = sessionRuntime.completeRetainedNativeSessionCleanup;
export const settleRetainedRunnerdSession = runnerdTransport.settleRetainedRunnerdSession;
export const retainedRunnerdMaintenanceIsIdle =
  runnerdTransport.retainedRunnerdMaintenanceIsIdle;
export const drainRetainedRunnerdMaintenanceOperations =
  runnerdTransport.drainRetainedRunnerdMaintenanceOperations;
export const nativeRuntimePromptDigest = runtimeContext.nativeRuntimePromptDigest;
export const normalizePrpResultSignals = resultNormalization.normalizePrpResultSignals;
export const parseCodexTurnDiff = codexTurnDiff.parseCodexTurnDiff;
export const parseHarnessRuntimeRequestResolution =
  harnessContracts.parseHarnessRuntimeRequestResolution;
export const parseNativeExecutionInput = executionContracts.parseNativeExecutionInput;
export const parseNativeRuntimeContext = runtimeContext.parseNativeRuntimeContext;
export const parsePaperclipQuestionSet = questionContracts.parsePaperclipQuestionSet;
export const parsePaperclipQuestionResponse =
  questionContracts.parsePaperclipQuestionResponse;
export const resolveQualifiedAcpxProfile = acpxProfiles.resolveQualifiedAcpxProfile;
export const resolveSourceCodexHome = runnerdTransport.resolveSourceCodexHome;
export const validatePrpEvent = replayContracts.validatePrpEvent;
export const validatePrpStructuredRunResult =
  replayContracts.validatePrpStructuredRunResult;

export const NativeProviderTerminalFailure = backendContracts.NativeProviderTerminalFailure;
export const nativeRestartInterruptedTurnId = backendContracts.nativeRestartInterruptedTurnId;

export const completeTerminatedRemoteNativeSessionCleanup = sessionRuntime.completeTerminatedRemoteNativeSessionCleanup;
export const completeTerminatedLocalNativeSessionCleanup = sessionRuntime.completeTerminatedLocalNativeSessionCleanup;
