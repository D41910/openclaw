import { solidContent } from "../lit/solid-content.tsx";
import { copyMarkdownLabel } from "./copy-button-state.ts";
import { CopyButton } from "./solid/copy-button.tsx";

export { copyMarkdownLabel, handleCopyButton } from "./copy-button-state.ts";

export function renderCopyButton(text: string, idleLabel = copyMarkdownLabel(), bare = false) {
  return solidContent(CopyButton, { text, idleLabel, bare });
}

export function renderCopyAsMarkdownButton(markdown: string) {
  return renderCopyButton(markdown, copyMarkdownLabel(), true);
}
