import { createEffect, getOwner, onCleanup, runWithOwner } from "solid-js";
import type { AgentIdentity } from "../lib/identity-avatar-view.ts";
import { mountLitContent, solidContent } from "../lit/solid-content.tsx";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";

export type { AgentIdentity } from "../lib/identity-avatar-view.ts";

/** Legacy icon callers retain their own template region until they migrate. */
export function avatarArtwork(read: () => unknown) {
  const owner = getOwner();
  let target: HTMLElement;
  let mount: ReturnType<typeof mountLitContent> | undefined;
  createEffect(read, (template) => {
    mount = runWithOwner(owner, () => mountLitContent(template, target));
  });
  onCleanup(() => mount?.dispose());
  return (element: HTMLElement) => {
    target = element;
  };
}

/** Remaining Lit consumers share the native avatar's resource and event owner. */
export function renderAgentIdentityAvatar(
  agent: AgentIdentity,
  className = "",
  onImageError?: () => void,
) {
  return solidContent(AgentIdentityAvatar, { agent, class: className, onImageError });
}
