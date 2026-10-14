import { t } from "../lib/reactive/i18n.ts";
import { CopyButton } from "./solid/copy-button.tsx";
import "./tooltip.ts";

export function ConnectCommand(props: { command: string; variant?: "inline" | "hero" }) {
  const copyCommand = (event: { currentTarget: HTMLElement }) => {
    event.currentTarget.querySelector<HTMLButtonElement>(".chat-copy-btn")?.click();
  };
  return (
    <openclaw-tooltip prop:content={t("connection.help.copyCommand")}>
      <div
        class={["login-gate__command", { "login-gate__command--hero": props.variant === "hero" }]}
        role="button"
        tabindex={0}
        aria-label={t("connection.help.copyCommandAria", { command: props.command })}
        onClick={(event) => {
          if (!(event.target instanceof Element && event.target.closest(".chat-copy-btn"))) {
            copyCommand(event);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            copyCommand(event);
          }
        }}
      >
        <code translate="no">{props.command}</code>
        <CopyButton text={props.command} idleLabel={t("connection.help.copyCommand")} />
      </div>
    </openclaw-tooltip>
  );
}
