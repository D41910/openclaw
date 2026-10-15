// Remaining Lit settings adapters; Solid primitives live in ./solid/settings-ui.tsx.
import { html, nothing, type TemplateResult } from "lit";

type SettingsRowControl = TemplateResult | typeof nothing;

type SettingsRowProps = {
  title: unknown;
  description?: unknown;
  control?: SettingsRowControl;
  /** Full-width control below the text (textareas, segmented sets that wrap). */
  stacked?: boolean;
  /** Full-width control below the text through the narrow-layout breakpoint. */
  stackedOnNarrow?: boolean;
};

function renderSettingsRowText(title: unknown, description: unknown) {
  return html`
    <div class="settings-row__text">
      <span class="settings-row__title">${title}</span>
      ${description ? html`<span class="settings-row__desc">${description}</span>` : nothing}
    </div>
  `;
}

export function renderSettingsRow(
  props: SettingsRowProps & { role?: "alert" | "status" },
): TemplateResult {
  const className = [
    "settings-row",
    props.stacked ? "settings-row--stacked" : "",
    props.stackedOnNarrow ? "settings-row--stacked-on-narrow" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <div class=${className} role=${props.role ?? nothing}>
      ${renderSettingsRowText(props.title, props.description)}
      ${
        props.control !== undefined && props.control !== nothing
          ? html`<div class="settings-row__control">${props.control}</div>`
          : nothing
      }
    </div>
  `;
}
