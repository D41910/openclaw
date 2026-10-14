import { createSignal, getOwner } from "solid-js";
import { mountSolid, type MountSolidOptions } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { MessageGroup, type NativeMessageGroupOptions } from "./chat-message-group-view.tsx";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { ChatThread } from "./chat-thread-view.tsx";
import type { ChatTranscriptController } from "./chat-transcript-controller.ts";

export function createMessageGroupHarness(
  container: HTMLElement,
  options: Omit<MountSolidOptions, "container"> = {},
) {
  type Props = Parameters<typeof MessageGroup>[0];
  let root: ReturnType<typeof mountSolid> | undefined;
  let update: (props: Props) => void;
  return {
    render(group: Props["group"], renderOptions: NativeMessageGroupOptions) {
      const next = { group, options: renderOptions };
      if (root) {
        update(next);
      } else {
        root = mountSolid(
          () => {
            const [props, setProps] = createSignal(next);
            update = setProps;
            return <MessageGroup group={props().group} options={props().options} />;
          },
          { ...options, container },
        );
      }
      if (!getOwner()) {
        flush();
      }
    },
    unmount() {
      root?.unmount();
      root = undefined;
    },
  };
}

export function createChatThreadHarness(
  container: HTMLElement,
  transcript: ChatTranscriptController,
) {
  let root: ReturnType<typeof mountSolid> | undefined;
  let update: (props: ChatThreadProps) => void;
  return {
    render(props: ChatThreadProps) {
      const next = { ...props };
      if (root) {
        update(next);
      } else {
        root = mountSolid(
          () => {
            const [current, setCurrent] = createSignal(next);
            update = setCurrent;
            return <ChatThread props={current()} transcript={transcript} />;
          },
          { container },
        );
      }
      if (!getOwner()) {
        flush();
      }
    },
    unmount() {
      root?.unmount();
      root = undefined;
    },
  };
}
