import type { JSX } from "@solidjs/web";
import { createEffect, onCleanup, Show, untrack, useContext } from "solid-js";
import { observeScrollState } from "../../../components/scroll-state-observer.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { SolidContentPresentation } from "../../../lit/solid-content.tsx";
import type { CommentPreview } from "./chat-comment-preview.ts";
import "../../../styles/chat/selection-annotations.css";

registerChatMessageMetadataEnglish();

function scrollRef() {
  let element: HTMLElement | undefined;
  let observation: ReturnType<typeof observeScrollState> | undefined;
  const presented = useContext(SolidContentPresentation);
  const connect = (active: boolean) => {
    observation?.disconnect();
    observation = undefined;
    if (!active || !element) {
      return;
    }
    const target = element;
    observation = observeScrollState(target, (state) => {
      for (const key of ["scrollable", "atStart", "atEnd"] as const) {
        target.dataset[key] = String(state[key]);
      }
    });
  };
  createEffect(presented, connect);
  onCleanup(() => observation?.disconnect());
  return (value: HTMLElement) => {
    element = value;
    connect(untrack(presented));
  };
}

export function CommentPreviewRow(props: { comment: CommentPreview; children?: JSX.Element }) {
  const ref = scrollRef();
  return (
    <li class="chat-comment-preview__item">
      <div class="chat-comment-preview__body">
        <span class="muted">{t("chat.messages.annotationSelectedText")}</span>
        <div class="chat-comment-preview__text chat-comment-preview__text--selection">
          {props.comment.text}
        </div>
        <Show when={props.comment.comment}>
          <span class="muted">{t("chat.messages.annotationUserComment")}</span>
          <div
            class="chat-comment-preview__text chat-comment-preview__text--comment"
            tabindex={0}
            role="region"
            aria-label={t("chat.messages.annotationUserComment")}
            ref={ref}
          >
            {props.comment.comment}
          </div>
        </Show>
      </div>
      {props.children}
    </li>
  );
}

export function CommentPreviewChip(props: {
  count: number;
  children?: JSX.Element;
  onReveal?: () => void;
  removal?: { onRemove: (event: Event) => void; disabled: boolean };
  elementRef?: (element: Element | undefined) => void;
}) {
  const ref = scrollRef();
  const label = () =>
    t(props.count === 1 ? "chat.messages.annotationCount" : "chat.messages.annotationsCount", {
      count: String(props.count),
    });
  onCleanup(() => props.elementRef?.(undefined));
  return (
    <openclaw-tooltip
      class={
        props.removal
          ? "chat-comment-preview chat-comment-preview--editable"
          : "chat-comment-preview"
      }
      placement="top-start"
      auto-size
      prop:describe={false}
      prop:openOnClick={true}
      prop:hoverDismissDelay={props.removal ? 200 : undefined}
    >
      <span
        ref={(element) => props.elementRef?.(element)}
        class="chat-attachment-thumb chat-attachment-thumb--file chat-selection-annotations__chip"
        role={props.removal ? undefined : "button"}
        tabindex={props.removal ? undefined : 0}
        onPointerEnter={() => props.onReveal?.()}
        onFocusIn={() => props.onReveal?.()}
        onClick={() => props.onReveal?.()}
        onKeyDown={(event) => {
          if (!props.removal && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
      >
        <Show
          when={props.removal}
          fallback={
            <span class="chat-attachment-file">
              <span aria-hidden="true">
                <Icon name="messageSquare" />
              </span>
              <span class="chat-attachment-preview-label" dir="auto">
                {label()}
              </span>
            </span>
          }
        >
          <button type="button" class="chat-attachment-file chat-selection-annotations__trigger">
            <span aria-hidden="true">
              <Icon name="messageSquare" />
            </span>
            <span class="chat-selection-annotations__label" dir="auto">
              {label()}
            </span>
          </button>
          <button
            type="button"
            class="chat-selection-annotations__remove"
            aria-label={t("chat.messages.removeAnnotations")}
            disabled={props.removal?.disabled}
            onClick={(event) => props.removal?.onRemove(event)}
          >
            <Icon name="x" />
          </button>
        </Show>
      </span>
      <div
        slot="content"
        class="chat-comment-preview__scroll"
        tabindex={0}
        role="region"
        aria-label={t("chat.messages.annotations")}
        ref={ref}
      >
        {props.children}
      </div>
    </openclaw-tooltip>
  );
}
