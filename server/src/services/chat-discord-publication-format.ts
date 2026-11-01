import { DiscordFormatConverter } from "@chat-adapter/discord";

const DISCORD_MAX_MESSAGE_UTF16_CODE_UNITS = 2_000;
const discordFormatConverter = new DiscordFormatConverter();

/**
 * Discord applies its content limit after the chat adapter has normalized
 * Markdown and expanded bare mentions. Use that exact formatter so Paperclip
 * can move an oversized response to a lossless file before the adapter's
 * defensive truncation would discard its tail.
 */
export function discordMarkdownRequiresAttachment(text: string): boolean {
  return (
    discordFormatConverter.renderPostable({ markdown: text }).length >
    DISCORD_MAX_MESSAGE_UTF16_CODE_UNITS
  );
}
