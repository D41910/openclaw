/** Token that marks a heartbeat response as an acknowledgement with no user notification. */
export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
/** Token that marks an auto-reply response as intentionally silent. */
export const SILENT_REPLY_TOKEN = "NO_REPLY";
/** Exact first line of an unattended automation reply that records the run as failed. */
export const AUTOMATION_FAILED_TOKEN = "AUTOMATION_FAILED";

const HARMONY_CHANNEL_MARKER_RE = /^\s*(?:set-thought\s+)?<[\w]*\|[^>]*>\s*$/;
const BOX_DRAWING_HR_ONLY_RE = /^\s*─{3,}\s*$/;

export function isInternalFormattingArtifact(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return HARMONY_CHANNEL_MARKER_RE.test(text) || BOX_DRAWING_HR_ONLY_RE.test(text);
}

/** Returns true only for the exact, case-sensitive whole-reply control token. */
export function isSilentReplyText(text?: string): boolean {
  return text?.trim() === SILENT_REPLY_TOKEN;
}
