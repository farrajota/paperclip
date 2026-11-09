export class ChatSdkEndpointNotRegisteredError extends Error {
  readonly endpointId: string;

  constructor(endpointId: string) {
    super(`No Chat SDK runtime is registered for endpoint ${endpointId}`);
    this.name = "ChatSdkEndpointNotRegisteredError";
    this.endpointId = endpointId;
  }
}

export class DiscordAdapterCompatibilityError extends Error {
  readonly code = "CHAT_ADAPTER_COMPATIBILITY_ERROR";

  constructor(detail: string) {
    super(`The pinned Discord adapter is incompatible: ${detail}`);
    this.name = "DiscordAdapterCompatibilityError";
  }
}
