import { solidContent } from "../../../lit/solid-content.tsx";
import type {
  AssistantAttachmentItem,
  AttachmentItem,
  ImageRenderOptions,
} from "./chat-message-media.ts";
import { SentCommentAttachments, type SentCommentSource } from "./chat-sent-comments.tsx";

export function isSentCommentAttachment(item: AssistantAttachmentItem): item is AttachmentItem {
  return (
    item.type === "attachment" &&
    item.attachment.kind === "document" &&
    item.attachment.label === "selection-comment.txt" &&
    item.attachment.mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "text/plain"
  );
}

export function renderSentCommentAttachments(
  comments: AttachmentItem[],
  options: ImageRenderOptions,
  resolve: (item: AttachmentItem) => SentCommentSource,
) {
  return solidContent(SentCommentAttachments, { comments, options, resolve });
}
