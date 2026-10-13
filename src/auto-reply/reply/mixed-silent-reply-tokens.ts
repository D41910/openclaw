import { SILENT_REPLY_TOKEN } from "../tokens.js";

export function isSilentReplyTokenOnly(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  return text !== undefined && text.trim().toUpperCase() === token.toUpperCase();
}

/** Removes one standalone leading control line without changing the remaining text. */
export function stripMixedSilentReplyTokens(
  text: string,
  token: string = SILENT_REPLY_TOKEN,
): string | null {
  const lineEnd = text.indexOf("\n");
  return lineEnd !== -1 && isSilentReplyTokenOnly(text.slice(0, lineEnd), token)
    ? text.slice(lineEnd + 1)
    : null;
}
