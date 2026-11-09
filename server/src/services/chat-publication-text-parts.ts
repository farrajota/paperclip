import type { SafeChatPublicationPayload } from "@paperclipai/shared";

const MAX_WRAPPER_LENGTH = 292;
const PREFIX = /^(`{3,256}|~{3,256})([A-Za-z0-9_+.-]{0,32})\n$/;
const SUFFIX = /^\n(`{3,256}|~{3,256})\n?$/;

export function invalidTransport(): never {
  throw Object.assign(new Error("Invalid durable publication text transport"), {
    name: "ValidationError",
    code: "VALIDATION_ERROR",
  });
}

/** Never accept arbitrary persisted prose, links, or credentials as a wrapper. */
export function renderPublicationTransportText(
  payload: SafeChatPublicationPayload,
): string {
  const part = payload.transportPart;
  const prefix: unknown = part?.prefix;
  const suffix: unknown = part?.suffix;
  if (prefix === undefined && suffix === undefined) return payload.text;
  if (part?.mode && part.mode !== "inline") invalidTransport();
  if (
    prefix !== undefined &&
    (typeof prefix !== "string" ||
      prefix.length > MAX_WRAPPER_LENGTH ||
      !PREFIX.test(prefix))
  )
    invalidTransport();
  if (
    suffix !== undefined &&
    (typeof suffix !== "string" ||
      suffix.length > MAX_WRAPPER_LENGTH ||
      !SUFFIX.test(suffix))
  )
    invalidTransport();
  if (
    prefix !== undefined &&
    suffix !== undefined &&
    PREFIX.exec(prefix as string)![1] !== SUFFIX.exec(suffix as string)![1]
  )
    invalidTransport();
  return `${prefix ?? ""}${payload.text}${suffix ?? ""}`;
}
