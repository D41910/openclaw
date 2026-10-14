import { createSignal, Show, type ComponentProps } from "solid-js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { AgentRunFrame } from "../components/chat-agent-run-frame.tsx";
import { MessageGroup } from "../components/chat-message-group-view.tsx";

type GroupProps = ComponentProps<typeof MessageGroup>;
type Fixture =
  | { kind: "group"; props: GroupProps; after: boolean }
  | { kind: "frame"; props: ComponentProps<typeof AgentRunFrame> };

export function groupFixture(
  group: GroupProps["group"],
  options: GroupProps["options"],
  after = false,
): Fixture {
  return { kind: "group", props: { group, options }, after };
}

export function frameFixture(props: ComponentProps<typeof AgentRunFrame>): Fixture {
  return { kind: "frame", props };
}

function AttributionFixture(props: { value: Fixture }) {
  const group = () => (props.value.kind === "group" ? props.value : undefined);
  const frame = () => (props.value.kind === "frame" ? props.value : undefined);
  return (
    <>
      <Show when={group()}>
        {(fixture) => (
          <>
            <MessageGroup group={fixture().props.group} options={fixture().props.options} />
            <Show when={fixture().after}>
              <div class="after">Next</div>
            </Show>
          </>
        )}
      </Show>
      <Show when={frame()}>{(fixture) => <AgentRunFrame {...fixture().props} />}</Show>
    </>
  );
}

const mounts = new WeakMap<HTMLElement, { update(value: Fixture): void; unmount(): void }>();

/** Reconcile props into one mounted component so layout tests observe real updates. */
export function renderFixture(value: Fixture | null, container: HTMLElement): void {
  const existing = mounts.get(container);
  if (value === null) {
    existing?.unmount();
    mounts.delete(container);
    return;
  }
  if (existing) {
    existing.update(value);
  } else {
    let update!: (value: Fixture) => void;
    const view = mountSolid(
      () => {
        const [fixture, setFixture] = createSignal(value);
        update = (next) => setFixture(next);
        return <AttributionFixture value={fixture()} />;
      },
      { container },
    );
    mounts.set(container, { update: (next) => update(next), unmount: view.unmount });
  }
  flush();
}
