import { solidContent } from "../../../lit/solid-content.tsx";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { ChatSelectionAnnotations } from "./chat-selection-annotations.tsx";

export function dispatchChatCommentAction(
  event: Event,
  id: string | undefined,
  action: "edit" | "delete" | "delete-all",
) {
  event.currentTarget?.dispatchEvent(
    new CustomEvent("openclaw-comment-action", {
      bubbles: true,
      composed: true,
      detail: { id, action },
    }),
  );
}

/** The persistent comment owner handles edits from either preview or source marker. */
export function renderChatSelectionAnnotations(props: ChatAttachmentControlsProps) {
  return solidContent(ChatSelectionAnnotations, props);
}
