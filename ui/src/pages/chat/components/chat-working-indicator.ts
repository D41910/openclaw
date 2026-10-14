import { solidContent } from "../../../lit/solid-content.tsx";
import type { TurnRecap } from "../chat-progress.ts";
import { TurnRecapRow } from "./chat-working-indicator.tsx";

export function renderTurnRecapRow(
  recap: TurnRecap,
  options: { presentation?: "standalone" | "continuation" } = {},
) {
  return solidContent(TurnRecapRow, { recap, presentation: options.presentation });
}
