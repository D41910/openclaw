import { createMemo, createSignal, Show } from "solid-js";
import { pluginFallbackGradient, pluginMonogram } from "../pages/plugins/presentation.ts";
import "../styles/channels.css";

export function ChannelIcon(props: {
  channelId: string;
  label: string;
  variant: "tile" | "cover" | "picker";
  pluginIconUrl?: string;
}) {
  const [failed, setFailed] = createSignal(
    () => {
      void props.pluginIconUrl;
      return false;
    },
    { ownedWrite: true },
  );
  const art = createMemo(() => (props.pluginIconUrl && !failed() ? props.pluginIconUrl : null));
  const variant = () => (props.variant === "picker" ? "tile" : props.variant);
  const style = createMemo(() => {
    const [from, to] = art() ? ["", ""] : pluginFallbackGradient(props.channelId);
    return `${props.variant === "picker" ? "--channels-art-size:24px;" : ""}${
      art() ? "" : `--channels-art-a:${from};--channels-art-b:${to}`
    }`;
  });
  return (
    <span
      class={[
        `channels-${variant()}`,
        {
          "channels-cover--icon": props.variant === "cover" && Boolean(props.pluginIconUrl),
          [`channels-${variant()}--fallback`]: !art(),
        },
      ]}
      style={style()}
      aria-hidden="true"
    >
      <Show when={art()} keyed fallback={<span>{pluginMonogram(props.label)}</span>}>
        {(url) => (
          <img
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => {
              if (props.pluginIconUrl === url) {
                setFailed(true);
              }
            }}
          />
        )}
      </Show>
    </span>
  );
}
