import { LitContent } from "../../../lit/solid-content.tsx";

export function TranscriptWorkPreviews(props: { previews: readonly unknown[] }) {
  return (
    <div class="chat-group tool chat-group--turn-block">
      <div class="chat-group-messages">
        <LitContent value={props.previews} />
      </div>
    </div>
  );
}
