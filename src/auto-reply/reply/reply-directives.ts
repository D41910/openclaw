import { trySafeFileURLToPath } from "@openclaw/fs-safe/advanced";
import { splitMediaFromOutput } from "../../media/parse.js";
import {
  parseReplyDirectivesFromMedia,
  type ReplyDirectiveParseResult,
} from "./reply-directives-core.js";

export type { ReplyDirectiveParseResult } from "./reply-directives-core.js";

/** Whole-message silence outranks phase selection; selected silence does not erase commentary. */
export function parseReplyDirectivesForMessage(
  messageText: string,
  selectedText: string,
): ReplyDirectiveParseResult {
  const message = parseReplyDirectives(messageText);
  return message.hasSilentIntent || messageText === selectedText
    ? message
    : { ...parseReplyDirectives(selectedText), hasSilentIntent: false };
}

export function parseReplyDirectives(
  raw: string,
  options: {
    currentMessageId?: string;
    silentToken?: string;
    extractMarkdownImages?: boolean;
    extractMediaDirectives?: boolean;
    preserveTrailingWhitespace?: boolean;
    onAudioDirective?: () => void;
  } = {},
): ReplyDirectiveParseResult {
  const parsed = parseReplyDirectivesFromMedia(splitMediaFromOutput(raw, options), options);
  return {
    ...parsed,
    // Native loaders own file URL decoding; browser display preserves source spelling.
    mediaUrls: parsed.mediaUrls?.map((source) => trySafeFileURLToPath(source) ?? source),
  };
}
