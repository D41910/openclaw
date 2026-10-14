import { solidContent } from "../lit/solid-content.tsx";
import { Kbd, type KbdOptions } from "./solid/kbd.tsx";

export function renderKbd(
  keys: string | number | readonly string[],
  { className, ...options }: Omit<KbdOptions, "class" | "ref"> & { className?: string } = {},
) {
  return solidContent(Kbd, { ...options, keys, class: className });
}
