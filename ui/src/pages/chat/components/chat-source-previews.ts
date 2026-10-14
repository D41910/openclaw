import type { ChatSourcePreview } from "../../../lib/chat/source-previews.ts";
import { emptyLegacyContent, solidContent } from "../../../lit/solid-content.tsx";
import type { LinkFaviconFetcher } from "../link-favicon-cache.ts";
import { ChatSources } from "./chat-source-previews.tsx";

export function renderChatSourcePreviews(
  sources: readonly ChatSourcePreview[],
  fetchFavicon?: LinkFaviconFetcher,
) {
  return sources.length > 0
    ? solidContent(ChatSources, { sources, fetchFavicon })
    : emptyLegacyContent;
}
