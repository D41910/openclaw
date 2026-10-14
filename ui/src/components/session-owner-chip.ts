import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { SessionCreatedActor, SessionOwnerOption } from "../lib/session-owner.ts";
import { emptyLegacyContent, solidContent } from "../lit/solid-content.tsx";
import { SessionOwnerAvatar, SessionOwnerChip } from "./solid/session-owner-chip.tsx";

export { sessionOwnerInitials, sessionSelfOwner } from "../lib/session-owner.ts";
export type { SessionCreatedActor, SessionOwnerOption } from "../lib/session-owner.ts";

export function renderSessionOwnerChip(
  owner: SessionCreatedActor | null | undefined,
  size: "row" | "header",
  attribution: "created" | "owned" | "archived" = "created",
  viewingNow?: boolean,
  participants?: readonly SessionParticipant[],
  participantCount?: number,
) {
  return owner?.id
    ? solidContent(SessionOwnerChip, {
        owner,
        size,
        attribution,
        viewingNow,
        participants: participants ?? [],
        participantCount: participantCount ?? participants?.length ?? 0,
      })
    : emptyLegacyContent;
}

export function renderSessionOwnerAvatar(
  owner: Pick<SessionOwnerOption, "id" | "label" | "avatarUrl" | "identity">,
) {
  return solidContent(SessionOwnerAvatar, { owner });
}
