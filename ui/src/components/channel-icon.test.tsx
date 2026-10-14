/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { ChannelIcon } from "./channel-icon.tsx";

afterEach(cleanupSolid);

it("shows the channel monogram when artwork fails and retries a changed source", () => {
  let changeSource!: (source: string) => void;
  const { container } = mountSolid(() => {
    const [source, setSource] = createSignal("/first.svg");
    changeSource = setSource;
    return (
      <ChannelIcon channelId="test" label="Test Channel" variant="cover" pluginIconUrl={source()} />
    );
  });

  const first = container.querySelector("img")!;
  expect(first.getAttribute("src")).toBe("/first.svg");
  first.dispatchEvent(new Event("error"));
  flush();
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".channels-cover--fallback")?.textContent).toBe("TC");
  expect(container.querySelector(".channels-cover--icon")).not.toBeNull();

  changeSource("/second.svg");
  flush();
  expect(container.querySelector("img")?.getAttribute("src")).toBe("/second.svg");
  changeSource("/first.svg");
  flush();
  expect(container.querySelector("img")?.getAttribute("src")).toBe("/first.svg");
});

it("keeps picker art compact and hidden from the accessible name", () => {
  const { container } = mountSolid(() => (
    <ChannelIcon channelId="test" label="Test" variant="picker" />
  ));
  const icon = container.querySelector<HTMLElement>(".channels-tile--fallback")!;
  expect(icon.style.getPropertyValue("--channels-art-size")).toBe("24px");
  expect(icon.getAttribute("aria-hidden")).toBe("true");
});
