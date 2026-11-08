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
  DotHarnessDriver,
  DotAssignment,
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
  LinuxProcessStartOptions,
  NativeAcpxAgent,
  NativeAcpxPermissionMode,
  NativeCodexApprovalPolicy,
  NativeExecutionInput,
  NativeExecutionInputV4,
  NativeExecutionInputV5,
  NativeExecutionInputV6,
  NativeExecutionInputV8,
  NativeExecutionInputV9,
  MuseBindingSnapshot,
  DotBindingSnapshot,
  ExternalProviderPort,
  ExternalProviderOperation,
  NativeExecutionInputV7,
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
  RunnerExecutionDriver,
  RunnerLaunchPreparer,
  DurableRecoveryIdentity,
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
  linuxProcessStart,
  openCodeRecovery,
  runnerBinary,
  providerMode,
  claudeEffort,
  generatedProfiles,
  codexCommand,
  installationIntegrity,
  profileInstallation,
  remoteProviderPack,
  externalProvider,
  semanticReceipts,
  configuredEnvironmentSource,
] = await Promise.all([
  loadRunnerSource<
    | "inspectWarmRunTransition"
    | "DurablePrpControlPlane"
    | "RUNNER_PRP_PROTOCOL_MIN"
    | "RUNNER_PRP_PROTOCOL_MAX"
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
    | "probeNativeRunnerEnvironment"
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
  loadRunnerSource<"parseNativeExecutionInput" | "buildNativeModelEnvelope">("contracts/native-execution.ts"),
  loadRunnerSource<
    | "parsePaperclipQuestionSet"
    | "parsePaperclipQuestionResponse"
  >("contracts/question-set.ts"),
  loadRunnerSource<
    | "resolveQualifiedAcpxProfile"
    | "QUALIFIED_ACPX_PROFILES"
    | "QUALIFIED_ACPX_VERSION"
  >("drivers/acpx/qualified-profiles.ts"),
  loadRunnerSource<
    | "validatePrpEvent"
    | "validatePrpStructuredRunResult"
  >("protocol/replay-contract.ts"),
  loadRunnerSource<"readLinuxProcessStartedAt">("live/linux-process-start.ts"),
  loadRunnerSource<
    | "OPENCODE_ISOLATED_HOMES_DIRECTORY"
    | "opencodeRuntimeSessionDirectoryName"
  >("drivers/opencode/opencode-server-driver.ts"),
  loadRunnerSource<"runnerBinaryTarget">("live/runner-binary.ts"),
  loadRunnerSource<"isProviderMode">("contracts/provider-mode.ts"),
  loadRunnerSource<"resolveClaudeEffort">("drivers/acpx/claude-effort.ts"),
  loadRunnerSource<"CURSOR_DISTRIBUTION_PINS">("drivers/acpx/generated-profiles.ts"),
  loadRunnerSource<"resolveCodexCommand" | "resolvePinnedCodexCommand">("drivers/codex/codex-command.ts"),
  loadRunnerSource<"probeAcpxClaudeInstallation" | "probeAcpxGrokInstallation">("drivers/acpx/installation-integrity.ts"),
  loadRunnerSource<"probeAcpxPiInstallation">("drivers/acpx/profile-installation.ts"),
  loadRunnerSource<
    | "PROVIDER_PACK_COMPATIBILITY"
    | "bundledRemoteProviderPackManifestPath"
    | "bundledRemoteRunnerBinary"
  >("live/bundled-remote-provider-pack.ts"),
  loadRunnerSource<"externalOperationDigest">("contracts/external-provider.ts"),
  loadRunnerSource<"digestPaperclipSemanticContent">("semantic-tools/receipts.ts"),
  loadRunnerSource<
    | "CONFIGURED_ENVIRONMENT_KEYS"
    | "GENERATED_RUNTIME_ENVIRONMENT_KEYS"
    | "configuredEnvironmentProjection"
    | "configuredEnvironment"
  >("configured-environment.ts"),
  // Preserve canonical operation validation without loading unused aggregate APIs.
  import(new URL("catalog/canonical-operations.ts", sourceRootUrl).href),
]);

export const DurablePrpControlPlane = controlPlane.DurablePrpControlPlane;
export const RUNNER_PRP_PROTOCOL_MIN = controlPlane.RUNNER_PRP_PROTOCOL_MIN;
export const RUNNER_PRP_PROTOCOL_MAX = controlPlane.RUNNER_PRP_PROTOCOL_MAX;
export const runnerCodexDynamicToolsFit = runnerdTransport.runnerCodexDynamicToolsFit;
export const inspectWarmRunTransition = controlPlane.inspectWarmRunTransition;
export const readRunnerdArtifactBinding = runnerdTransport.readRunnerdArtifactBinding;
export const readLinuxProcessStartedAt = linuxProcessStart.readLinuxProcessStartedAt;
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
export const OPENCODE_ISOLATED_HOMES_DIRECTORY =
  openCodeRecovery.OPENCODE_ISOLATED_HOMES_DIRECTORY;
export const opencodeRuntimeSessionDirectoryName =
  openCodeRecovery.opencodeRuntimeSessionDirectoryName;
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
export const runnerBinaryTarget = runnerBinary.runnerBinaryTarget;
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
export const buildNativeModelEnvelope = executionContracts.buildNativeModelEnvelope;
export const isProviderMode = providerMode.isProviderMode;
export const parseNativeRuntimeContext = runtimeContext.parseNativeRuntimeContext;
export const parsePaperclipQuestionSet = questionContracts.parsePaperclipQuestionSet;
export const parsePaperclipQuestionResponse =
  questionContracts.parsePaperclipQuestionResponse;
export const resolveQualifiedAcpxProfile = acpxProfiles.resolveQualifiedAcpxProfile;
export const resolveClaudeEffort = claudeEffort.resolveClaudeEffort;
export const QUALIFIED_ACPX_PROFILES = acpxProfiles.QUALIFIED_ACPX_PROFILES;
export const QUALIFIED_ACPX_VERSION = acpxProfiles.QUALIFIED_ACPX_VERSION;
export const CURSOR_DISTRIBUTION_PINS = generatedProfiles.CURSOR_DISTRIBUTION_PINS;
export const resolveSourceCodexHome = runnerdTransport.resolveSourceCodexHome;
export const resolveCodexCommand = codexCommand.resolveCodexCommand;
export const resolvePinnedCodexCommand = codexCommand.resolvePinnedCodexCommand;
export const validatePrpEvent = replayContracts.validatePrpEvent;
export const validatePrpStructuredRunResult =
  replayContracts.validatePrpStructuredRunResult;

export const NativeProviderTerminalFailure = backendContracts.NativeProviderTerminalFailure;
export const nativeRestartInterruptedTurnId = backendContracts.nativeRestartInterruptedTurnId;

export const completeTerminatedRemoteNativeSessionCleanup = sessionRuntime.completeTerminatedRemoteNativeSessionCleanup;
export const completeTerminatedLocalNativeSessionCleanup = sessionRuntime.completeTerminatedLocalNativeSessionCleanup;

export const probeAcpxClaudeInstallation = installationIntegrity.probeAcpxClaudeInstallation;
export const probeAcpxGrokInstallation = installationIntegrity.probeAcpxGrokInstallation;
export const probeAcpxPiInstallation = profileInstallation.probeAcpxPiInstallation;
export const PROVIDER_PACK_COMPATIBILITY = remoteProviderPack.PROVIDER_PACK_COMPATIBILITY;
export const bundledRemoteProviderPackManifestPath = remoteProviderPack.bundledRemoteProviderPackManifestPath;
export const bundledRemoteRunnerBinary = remoteProviderPack.bundledRemoteRunnerBinary;

export const externalOperationDigest = externalProvider.externalOperationDigest;
export const digestPaperclipSemanticContent = semanticReceipts.digestPaperclipSemanticContent;
export const CONFIGURED_ENVIRONMENT_KEYS = configuredEnvironmentSource.CONFIGURED_ENVIRONMENT_KEYS;
export const GENERATED_RUNTIME_ENVIRONMENT_KEYS = configuredEnvironmentSource.GENERATED_RUNTIME_ENVIRONMENT_KEYS;
export const configuredEnvironmentProjection = configuredEnvironmentSource.configuredEnvironmentProjection;
export const configuredEnvironment = configuredEnvironmentSource.configuredEnvironment;

export const probeNativeRunnerEnvironment = runnerdTransport.probeNativeRunnerEnvironment;
