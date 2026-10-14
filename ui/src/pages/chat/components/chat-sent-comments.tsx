import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../../lit/solid-bridge.ts";
import { LitContent } from "../../../lit/solid-content.tsx";
import { readAttachmentText } from "./chat-attachment-text-reader.ts";
import { parseCommentAttachment, type CommentPreview } from "./chat-comment-preview.ts";
import { CommentPreviewChip, CommentPreviewRow } from "./chat-comment-preview.tsx";
import {
  needsAttachmentSourceAdmission,
  type AttachmentAdmission,
} from "./chat-message-attachment-admission-model.ts";
import { ChatAttachmentAdmission } from "./chat-message-attachment-admission-solid.tsx";
import type { AttachmentItem, ImageRenderOptions } from "./chat-message-media.ts";

export type SentCommentSource = {
  identity: string;
  src?: string;
  sizeBytes?: number;
  pending?: boolean;
  fallback: unknown;
};
type SentCommentsProps = {
  sources: SentCommentSource[];
  scope: string;
  admission?: AttachmentAdmission;
};

function SentComments(props: SentCommentsProps) {
  const [revealed, setRevealed] = createSignal(false);
  const identity = createMemo(() =>
    JSON.stringify([
      props.scope,
      props.sources.map(({ fallback: _fallback, ...source }) => source),
    ]),
  );
  const [loaded, setLoaded] = createSignal<{
    key: string;
    comments: Array<CommentPreview | null | undefined>;
  }>({ key: "", comments: [] });
  const commentAt = (index: number) =>
    loaded().key === identity()
      ? loaded().comments[index]
      : !props.sources[index]?.src && !props.sources[index]?.pending
        ? null
        : undefined;
  createEffect(
    () => [identity(), revealed()] as const,
    ([key, open]) => {
      if (!open) {
        return undefined;
      }
      const sources = untrack(() => props.sources);
      const controller = new AbortController();
      let active = true;
      setLoaded({
        key,
        comments: sources.map((source) => (!source.src && !source.pending ? null : undefined)),
      });
      sources.forEach((source, index) => {
        if (!source.src) {
          return;
        }
        const accept = (comment: CommentPreview | null) => {
          if (active && !controller.signal.aborted) {
            setLoaded((current) => ({
              key,
              comments: current.comments.map((value, i) => (i === index ? comment : value)),
            }));
          }
        };
        void readAttachmentText(source.src, source.sizeBytes, controller.signal).then(
          (text) => accept(parseCommentAttachment(text)),
          () => accept(null),
        );
      });
      return () => {
        active = false;
        controller.abort();
      };
    },
  );
  const count = () => props.sources.filter((_, index) => commentAt(index) !== null).length;
  return (
    <>
      <Show when={count() > 0}>
        <CommentPreviewChip
          count={count()}
          onReveal={() => {
            setRevealed(true);
            props.admission?.onAdmit();
          }}
          elementRef={props.admission?.observeElement}
        >
          <ol class="chat-comment-preview__list" role="list">
            <For each={props.sources}>
              {(source, index) => (
                <Show
                  when={commentAt(index())}
                  fallback={
                    commentAt(index()) === null ? null : (
                      <li class="chat-comment-preview__item muted">
                        {source.src || source.pending
                          ? t("common.loading")
                          : t("chat.attachments.textPreviewUnavailable")}
                      </li>
                    )
                  }
                >
                  {(comment) => <CommentPreviewRow comment={comment()} />}
                </Show>
              )}
            </For>
          </ol>
        </CommentPreviewChip>
      </Show>
      <For each={props.sources}>
        {(source, index) => (
          <Show when={commentAt(index()) === null}>
            <LitContent value={source.fallback} />
          </Show>
        )}
      </For>
    </>
  );
}

const ChatSentComments = defineSolidBridge<SentCommentsProps>(
  "openclaw-chat-sent-comments",
  (props, host) => {
    host.style.display = "contents";
    return <SentComments {...props} />;
  },
  {
    properties: {
      sources: { default: [], attribute: false },
      scope: { default: "" },
      admission: { default: undefined, attribute: false },
    },
  },
);

export function SentCommentAttachments(props: {
  comments: AttachmentItem[];
  options: ImageRenderOptions;
  resolve: (item: AttachmentItem) => SentCommentSource;
}) {
  const scope = () =>
    JSON.stringify([
      props.options.sessionKey,
      props.options.agentId,
      props.options.messageId,
      props.options.connectionEpoch,
      props.options.resourceBasePath,
      props.options.authToken,
      props.options.policyKey,
    ]);
  const content = (admission?: AttachmentAdmission) => (
    <ChatSentComments
      sources={props.comments.map((item) =>
        admission?.observeElement
          ? { identity: item.attachment.url, pending: true, fallback: undefined }
          : props.resolve(item),
      )}
      scope={scope()}
      admission={admission}
    />
  );
  return (
    <Show when={props.comments.length > 0}>
      <Show
        when={props.comments.some((item) => needsAttachmentSourceAdmission(item.attachment))}
        fallback={content()}
      >
        <ChatAttachmentAdmission
          attachments={props.comments.map((item) => item.attachment)}
          options={props.options}
          render={content}
        />
      </Show>
    </Show>
  );
}
