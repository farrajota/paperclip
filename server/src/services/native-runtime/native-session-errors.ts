export class NativeCancellationPendingRecoveryError extends Error {
  constructor() {
    super("native_cancellation_pending_recovery");
    this.name = "NativeCancellationPendingRecoveryError";
  }
}

export class NativeControllerDetachedForRestartError extends Error {
  constructor() {
    super("native_controller_detached_for_restart");
    this.name = "NativeControllerDetachedForRestartError";
  }
}

export class NativeSessionSteeringError extends Error {
  constructor(
    readonly code:
      | "steering_unsupported"
      | "steering_temporarily_unavailable"
      | "steering_stale_turn"
      | "steering_timeout"
      | "steering_rejected",
    message: string,
  ) {
    super(message);
    this.name = "NativeSessionSteeringError";
  }
}

export class NativeRuntimeRequestResolutionError extends Error {
  constructor(
    readonly code:
      | "native_session_not_active"
      | "runtime_request_resolution_unsupported"
      | "runtime_request_stale_turn"
      | "runtime_request_resolution_conflict",
    message: string,
  ) {
    super(message);
    this.name = "NativeRuntimeRequestResolutionError";
  }
}
