import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { ChatTypingIndicator } from "./chat-typing-indicator.tsx";
import {
  ChatWorkingIndicator,
  type ChatWorkingIndicatorOptions,
} from "./chat-working-indicator.tsx";

type WorkingProps = Parameters<typeof ChatWorkingIndicator>[0];
type TypingProps = Parameters<typeof ChatTypingIndicator>[0];
const workingViews = new WeakMap<HTMLElement, { update: (props: WorkingProps) => void }>();
const typingViews = new WeakMap<HTMLElement, { update: (props: TypingProps) => void }>();

export function renderWorkingIndicator(
  part: WorkingProps["part"],
  options: ChatWorkingIndicatorOptions | undefined,
  container: HTMLElement,
) {
  const props = { part, options };
  const view = workingViews.get(container);
  if (view) {
    view.update(props);
  } else {
    workingViews.set(container, mountSolid(ChatWorkingIndicator, props, container));
  }
}

export function renderTypingIndicator(
  actors: TypingProps["actors"],
  container: HTMLElement,
  avatarPlacement?: TypingProps["avatarPlacement"],
  overflow?: TypingProps["overflow"],
) {
  const props = { actors, avatarPlacement, overflow };
  const view = typingViews.get(container);
  if (view) {
    view.update(props);
  } else {
    typingViews.set(container, mountSolid(ChatTypingIndicator, props, container));
  }
}
