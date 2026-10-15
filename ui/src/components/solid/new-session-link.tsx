import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, createUniqueId, lazy, Loading, onSettled, Show } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { rosterActivityStore } from "../../lib/agents/roster-activity-store.ts";
import { IdentityAvatarController } from "../../lib/identity-avatar-loader.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../../lib/keyboard-shortcut-contract.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRosterActivity } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { newSessionSearch, type NewSessionTarget } from "../../pages/new-session/location.ts";
import type { AgentIdentity } from "../identity-avatar-view.ts";
import { renderShortcutHint } from "../kbd.ts";
import { Icon } from "./icon.tsx";
import { AgentIdentityAvatar } from "./identity-avatar.tsx";
import type { MenuItem } from "./menu.tsx";
import "../tooltip.ts";
import "../../styles/sidebar-agent-roster.css";

// The shell imports this adapter before any team menu is mounted. Keep Zag deferred.
const Menu = lazy(() => import("./menu.tsx"), { export: "Menu" });

export function renderNewSessionLink(params: {
  basePath: string;
  agentId: string;
  target?: NewSessionTarget;
  className: string;
  label: string;
  disabledReason?: string;
  showShortcut?: boolean;
  onOpen?: (agentId: string, target?: NewSessionTarget) => void;
}): JSX.Element {
  const disabled = () => Boolean(params.disabledReason);
  const href = () =>
    `${pathForRoute("new-session", params.basePath)}${newSessionSearch(params.agentId, params.target)}`;
  const hint = () =>
    params.showShortcut
      ? `${params.label} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.newSession)})`
      : params.label;
  return (
    <openclaw-tooltip
      prop:content={params.disabledReason ?? hint()}
      prop:contentTemplate={
        params.disabledReason == null && params.showShortcut
          ? renderShortcutHint(params.label, KEYBOARD_SHORTCUT_COMBOS.newSession)
          : undefined
      }
    >
      <a
        class={params.className}
        role="link"
        href={disabled() ? undefined : href()}
        aria-label={params.label}
        aria-disabled={disabled() ? "true" : undefined}
        tabindex={disabled() ? -1 : undefined}
        onContextMenu={(event: MouseEvent) => {
          // Section menus must not replace the browser's Open Link in New Tab actions.
          event.stopPropagation();
        }}
        onClick={(event: MouseEvent) => {
          if (disabled()) {
            event.preventDefault();
            return;
          }
          if (params.onOpen && shouldHandleNavigationClick(event)) {
            event.preventDefault();
            params.onOpen?.(params.agentId, params.target);
          }
        }}
      >
        <Icon name="plus" />
      </a>
    </openclaw-tooltip>
  );
}

export function ContextNewSessionAction(props: {
  context: ApplicationContext;
  class: string;
  agentId?: string;
}): JSX.Element {
  const readAccess = () =>
    readSessionMethodAccess(props.context.gateway.snapshot, {
      method: "sessions.create",
      params: {},
      sessionScope: true,
    });
  const access = createMemo(readAccess);
  const onOpen = (agentId: string) => {
    if (readAccess().allowed) {
      props.context.navigate("new-session", { search: newSessionSearch(agentId) });
    }
  };
  return (
    <Show
      when={props.context.theme.settings.sidebarAgentsMode === "roster"}
      fallback={renderNewSessionLink({
        get basePath() {
          return props.context.basePath;
        },
        get agentId() {
          return (
            props.agentId ??
            normalizeAgentId(
              props.context.agentSelection.state.selectedId ??
                props.context.gateway.snapshot.assistantAgentId,
            )
          );
        },
        get className() {
          return props.class;
        },
        get label() {
          return t("agentChip.newConversation");
        },
        showShortcut: true,
        get disabledReason() {
          const current = access();
          return current.allowed ? undefined : current.reason;
        },
        onOpen,
      })}
    >
      <NewSessionMenu
        basePath={props.context.basePath}
        access={access()}
        triggerClass={props.class}
        active={true}
        snapshotCards={null}
        onOpen={onOpen}
      />
    </Show>
  );
}

type NewSessionMenuProps = {
  basePath: string;
  triggerClass: string;
  access: SessionMethodAccess | null;
  active: boolean;
  snapshotCards: readonly AgentIdentity[] | null;
  onOpen: (agentId: string) => void;
  onShow?: () => void;
};

function NewSessionMenuContent(props: NewSessionMenuProps) {
  const application = useApplication();
  const store = rosterActivityStore(application);
  const projection = projectRosterActivity(store);
  const id = createUniqueId();
  const [opened, setOpened] = createSignal(false, { ownedWrite: true });
  const [avatarRevision, setAvatarRevision] = createSignal(0, { ownedWrite: true });
  const avatars = new IdentityAvatarController(() => setAvatarRevision((value) => value + 1));
  onSettled(() => {
    avatars.hostConnected();
    return () => avatars.hostDisconnected();
  });
  const cards = createMemo(() => {
    const snapshot = props.active ? projection.read() : store.snapshot;
    const cached = props.snapshotCards;
    if (cached) {
      return avatars.withActiveRoutes(() => cached);
    }
    avatarRevision();
    return avatars.withActiveRoutes(() =>
      snapshot.cards.map((card) =>
        Object.assign({}, card, { avatar: card.avatar ? avatars.resolve(card.avatar) : null }),
      ),
    );
  });
  // Native rows stay resident; avatar contents wait for the first accepted open.
  const items = createMemo((): MenuItem[] =>
    cards().map((card) => ({
      id: card.id,
      label: card.name ?? card.id,
      href: `${pathForRoute("new-session", props.basePath)}${newSessionSearch(card.id)}`,
      class: "sidebar-agent-roster__link",
      disabled: !props.access?.allowed,
      icon: (
        <Show when={opened()}>
          <span class="sidebar-agent-roster__avatar" aria-hidden="true">
            <AgentIdentityAvatar agent={card} />
          </span>
        </Show>
      ),
    })),
  );
  return (
    <Loading>
      <Menu
        id={id}
        class="sidebar-new-session-menu"
        placement="bottom-end"
        label={t("agentChip.newConversation")}
        trigger={<Icon name="plus" />}
        triggerClass={props.triggerClass}
        triggerAttributes={{
          title: props.access?.allowed ? t("agentChip.newConversation") : props.access?.reason,
        }}
        disabled={!props.access?.allowed || cards().length === 0}
        items={items()}
        onOpenChange={(open) => {
          if (open) {
            setOpened(true);
            props.onShow?.();
          }
        }}
        onSelect={(item, event) => {
          if (!props.access?.allowed || !cards().some((card) => card.id === item.id)) {
            event.preventDefault();
            return;
          }
          props.onOpen(item.id);
        }}
      />
    </Loading>
  );
}

export const NewSessionMenu = defineSolidBridge<NewSessionMenuProps>(
  "openclaw-sidebar-new-session-menu",
  (props) => <NewSessionMenuContent {...props} />,
  {
    properties: {
      basePath: { default: "", attribute: false },
      triggerClass: { default: "sidebar-rail__button sidebar-new-session", attribute: false },
      access: { default: null, attribute: false },
      active: { default: true, type: Boolean },
      snapshotCards: { default: null, attribute: false },
      onOpen: { default: () => {}, attribute: false },
      onShow: { default: undefined, attribute: false },
    },
  },
);
