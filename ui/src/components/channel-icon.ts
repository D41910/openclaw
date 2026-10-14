import { solidContent } from "../lit/solid-content.tsx";
import { ChannelIcon } from "./channel-icon.tsx";

export function renderChannelIcon(
  channelId: string,
  label: string,
  variant: "tile" | "cover" | "picker",
  options: { pluginIconUrl?: string } = {},
) {
  return solidContent(ChannelIcon, { channelId, label, variant, ...options });
}
