import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { updatePickers, choosePickerValue } from "../test-helpers/select-picker.ts";
import type { SelectPicker } from "./select-picker.ts";
import { ModelPicker } from "./solid/model-picker.tsx";
import { installTitleTooltips } from "./tooltip-title.ts";

afterEach(() => document.body.replaceChildren());

describe("ModelPicker", () => {
  it("shows a late selected model first without dropping the rest of a large catalog", async () => {
    const container = document.createElement("div");
    mountSolid(
      () =>
        createComponent(ModelPicker, {
          label: "Model",
          value: "fixture/model-299",
          options: Array.from({ length: 300 }, (_, index) => ({
            value: `fixture/model-${String(index).padStart(3, "0")}`,
            label: `Model ${index}`,
            provider: "fixture",
          })),
          onChange: vi.fn(),
        }),
      { container },
    );
    await updatePickers(container);
    const rows = Array.from(container.querySelectorAll('[role="option"][data-value]'));
    expect(rows).toHaveLength(300);
    expect(rows.slice(0, 3).map((row) => row.getAttribute("data-value"))).toEqual([
      "fixture/model-299",
      "fixture/model-000",
      "fixture/model-001",
    ]);
  });

  it("renders provider details and caller sentinels while preserving an unknown current model", async () => {
    const container = document.createElement("div");
    mountSolid(
      () =>
        createComponent(ModelPicker, {
          label: "Model",
          value: "legacy/model",
          options: [
            { value: "", label: "Automatic" },
            {
              value: "openai/fixture-model",
              label: "Fixture Model",
              provider: "openai",
              detail: "Fast · 128k",
              disabled: true,
            },
          ],
          onChange: vi.fn(),
        }),
      { container },
    );
    await updatePickers(container);

    expect(
      container.querySelector('[role="option"][data-value=""] .picker-select__leading'),
    ).toBeNull();
    const openai = container.querySelector('[role="option"][data-value="openai/fixture-model"]');
    expect(openai?.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
    expect(openai?.textContent).toContain("Fast · 128k");
    expect(openai?.getAttribute("aria-disabled") === "true").toBe(true);
    expect(
      container.querySelector('[role="option"][data-value="legacy/model"]')?.textContent,
    ).toContain("legacy/model");
  });

  it("reveals free-form entry without leaking its internal option value", async () => {
    const container = document.createElement("div");
    const onChange = vi.fn();
    mountSolid(
      () =>
        createComponent(ModelPicker, {
          label: "Model",
          value: "openai/fixture-model",
          options: [
            { value: "", label: "Default" },
            { value: "openai/fixture-model", label: "Fixture Model", provider: "openai" },
          ],
          custom: { label: "Custom model…", placeholder: "provider/model" },
          onChange,
        }),
      { container },
    );
    await updatePickers(container);

    const customOption = Array.from(container.querySelectorAll('[role="option"]')).find(
      (option) => option.textContent?.trim() === "Custom model…",
    );
    const picker = container.querySelector<SelectPicker>("openclaw-select-picker")!;
    const input = container.querySelector<HTMLInputElement>("input")!;
    expect(customOption).not.toBeNull();
    expect(input?.hidden).toBe(true);
    await choosePickerValue(picker, customOption!.getAttribute("data-value")!);
    expect(input.hidden).toBe(false);

    input.value = "vendor/model with spaces";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith("vendor/model with spaces");
    expect(onChange).not.toHaveBeenCalledWith(customOption!.getAttribute("data-value"));
  });

  it("does not show a raw model reference when a model option receives pointer hover", async () => {
    const host = document.createElement("div");
    const onChange = vi.fn();
    const dispose = installTitleTooltips(document);
    try {
      mountSolid(
        () =>
          createComponent(ModelPicker, {
            label: "Model",
            value: "openai/fixture-alpha",
            showSelectedDetail: true,
            options: [
              { value: "", label: "Select a model", disabled: true },
              {
                value: "openai/fixture-alpha",
                label: "Fixture Alpha",
                provider: "openai",
                detail: "API",
              },
              {
                value: "openai/fixture-beta",
                label: "Fixture Beta",
                provider: "openai",
                detail: "API",
              },
            ],
            onChange,
          }),
        { container: host },
      );
      await updatePickers(host);
      const picker = host.querySelector<SelectPicker>("openclaw-select-picker")!;
      picker.querySelector<HTMLButtonElement>(".picker-select__trigger")!.click();
      await picker.updateComplete;
      const row = picker.querySelector<HTMLElement>(
        '[role="option"][data-value="openai/fixture-beta"]',
      )!;
      expect(row.textContent).toContain("Fixture Beta");
      expect(row.textContent).toContain("API");
      expect(row.querySelector("[data-provider-icon]")).not.toBeNull();
      row.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true }));
      const tooltip = document.querySelector("openclaw-tooltip");
      expect(tooltip?.content ?? "").toBe("");
      row.click();
      await picker.updateComplete;
      expect(onChange).toHaveBeenCalledExactlyOnceWith("openai/fixture-beta");
    } finally {
      dispose();
      host.remove();
    }
  });
});
