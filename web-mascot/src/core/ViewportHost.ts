import type { RelaySnapshot } from "./types.js";

/**
 * Isolated viewport host using Open Shadow DOM.
 * Protects mascot rendering from page-level CSS pollution and provides
 * seamless first-frame placeholder bitmap display.
 */
export class ViewportHost {
  private hostEl: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private viewportEl: HTMLElement | null = null;
  private relayPlaceholders: HTMLElement[] = [];
  private readonly hostId: string;

  constructor(hostId = "web-mascot-host-root") {
    this.hostId = hostId;
  }

  /**
   * Ensures the host element and Shadow DOM structure are mounted in the document.
   * Returns the viewport container element inside the shadow root.
   */
  public ensureHost(): { container: HTMLElement; shadow: ShadowRoot; hostEl: HTMLElement } {
    if (!this.hostEl || !this.hostEl.isConnected) {
      if (this.hostEl && this.hostEl.parentNode) {
        this.hostEl.parentNode.removeChild(this.hostEl);
      }
      this.hostEl = document.createElement("div");
      this.hostEl.id = this.hostId;
      this.hostEl.style.cssText =
        "position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;overflow:visible;transform:translateZ(0);will-change:transform;contain:layout style;";

      const shadow = this.hostEl.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        :host { all: initial; }
        .mascot-viewport {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          overflow: visible;
          transform: translateZ(0);
          will-change: transform;
          contain: layout style;
        }
        .mascot-viewport img {
          max-width: none !important;
          max-height: none !important;
          border: none !important;
          box-shadow: none !important;
          background: transparent !important;
          filter: none !important;
          user-select: none !important;
          pointer-events: auto;
        }
        .relay-placeholder {
          position: fixed;
          left: 0;
          top: 0;
          width: 0;
          height: 0;
          overflow: visible;
          pointer-events: none;
          z-index: 2147483646;
          visibility: hidden;
        }
        .relay-placeholder img {
          position: absolute;
          left: 0;
          top: 0;
          width: auto !important;
          height: auto !important;
          max-width: none !important;
          max-height: none !important;
          pointer-events: none !important;
        }
      `;
      shadow.appendChild(style);

      const viewport = document.createElement("div");
      viewport.className = "mascot-viewport";
      shadow.appendChild(viewport);

      const mountPoint = document.documentElement || document.body;
      if (mountPoint) {
        mountPoint.appendChild(this.hostEl);
      }
      this.shadow = shadow;
      this.viewportEl = viewport;
    }

    const shadow = this.shadow || this.hostEl.shadowRoot!;
    const container = this.viewportEl || (shadow.querySelector(".mascot-viewport") as HTMLElement) || this.hostEl;
    return { container, shadow, hostEl: this.hostEl };
  }

  /**
   * Renders static bitmap placeholders for seamless cross-document handoffs.
   */
  public showPlaceholders(records: RelaySnapshot[], assetBaseUrl: string): void {
    this.clearPlaceholders();
    const visualRecords = records.filter((record) => record.visual?.image);
    if (visualRecords.length === 0) return;
    const { container } = this.ensureHost();

    for (const record of visualRecords) {
      const visual = record.visual!;
      const root = document.createElement("div");
      root.className = "relay-placeholder";
      root.dataset.pack = record.pack;
      root.style.transform = `translate3d(${visual.screenX * window.innerWidth / visual.viewportWidth}px, ${visual.screenY * window.innerHeight / visual.viewportHeight}px, 0)`;

      const image = document.createElement("img");
      image.alt = "";
      image.decoding = "async";
      image.style.transformOrigin = "0 0";
      const flip = visual.lookRight ? -1 : 1;
      image.style.transform = `translate(${-flip * visual.imageAnchor.x * visual.scale}px, ${-visual.imageAnchor.y * visual.scale}px) scaleX(${flip * visual.scale}) scaleY(${visual.scale})`;
      image.addEventListener("load", () => {
        root.style.visibility = "visible";
      });
      image.src = `${assetBaseUrl}/${record.pack}/img${visual.image}`;
      root.appendChild(image);
      container.appendChild(root);
      this.relayPlaceholders.push(root);
    }

    if (this.hostEl) this.hostEl.style.display = "";
  }

  /**
   * Removes all current placeholder elements.
   */
  public clearPlaceholders(): void {
    for (const placeholder of this.relayPlaceholders) placeholder.remove();
    this.relayPlaceholders = [];
  }

  /**
   * Shows the host container.
   */
  public show(): void {
    if (this.hostEl) this.hostEl.style.display = "";
  }

  /**
   * Hides the host container without destroying elements.
   */
  public hide(): void {
    if (this.hostEl) this.hostEl.style.display = "none";
  }

  /**
   * Destroys the host and removes it from DOM.
   */
  public destroy(): void {
    this.clearPlaceholders();
    if (this.hostEl && this.hostEl.parentNode) {
      this.hostEl.parentNode.removeChild(this.hostEl);
      this.hostEl = null;
    }
    this.shadow = null;
    this.viewportEl = null;
  }

  public get isMounted(): boolean {
    return Boolean(this.hostEl && this.hostEl.isConnected);
  }

  public get element(): HTMLElement | null {
    return this.hostEl;
  }
}

