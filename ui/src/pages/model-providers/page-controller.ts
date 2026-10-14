import { i18n } from "../../i18n/lib/translate.ts";

export interface PageLifecycle {
  hostConnected?(): void;
  hostDisconnected?(): void;
  hostUpdate?(): void;
  hostUpdated?(): void;
}

export interface ControllerHost {
  addController(controller: PageLifecycle): void;
  removeController(controller: PageLifecycle): void;
  requestUpdate(): void;
  readonly updateComplete: Promise<boolean>;
}

/** Keeps synchronous page owners and their subscriptions independent of the renderer. */
export class ModelPageController implements ControllerHost {
  private readonly controllers = new Set<PageLifecycle>();
  private stopLocale: (() => void) | undefined;
  private connected = false;
  private settle: ((settled: boolean) => void) | undefined;
  updateComplete = Promise.resolve(true);

  readonly querySelector: HTMLElement["querySelector"];
  readonly querySelectorAll: HTMLElement["querySelectorAll"];

  constructor(
    readonly renderRoot: HTMLElement,
    private readonly notify: () => void,
  ) {
    this.querySelector = renderRoot.querySelector.bind(renderRoot);
    this.querySelectorAll = renderRoot.querySelectorAll.bind(renderRoot);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  addController(controller: PageLifecycle): void {
    this.controllers.add(controller);
    if (this.connected) {
      controller.hostConnected?.();
    }
  }

  removeController(controller: PageLifecycle): void {
    this.controllers.delete(controller);
  }

  requestUpdate(): void {
    if (!this.settle) {
      this.updateComplete = new Promise((resolve) => {
        this.settle = resolve;
      });
    }
    this.notify();
  }

  connect(): void {
    this.connected = true;
    this.stopLocale?.();
    this.stopLocale = i18n.subscribe(() => this.requestUpdate());
    for (const controller of this.controllers) {
      controller.hostConnected?.();
    }
    this.requestUpdate();
  }

  beforeUpdate(): void {
    for (const controller of this.controllers) {
      controller.hostUpdate?.();
    }
  }

  afterUpdate(): void {
    const settle = this.settle;
    this.settle = undefined;
    for (const controller of this.controllers) {
      controller.hostUpdated?.();
    }
    settle?.(!this.settle);
  }

  disconnect(): void {
    this.connected = false;
    this.stopLocale?.();
    this.stopLocale = undefined;
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
    this.settle?.(true);
    this.settle = undefined;
  }
}
