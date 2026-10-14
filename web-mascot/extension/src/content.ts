import { packsForMode, type SnapshotSubmission, type LeaseReply } from "./protocol.js";
import {
  configure,
  createMascot,
  Mascot,
  MascotEngine,
  EngineEvent,
} from "../../src/index.js";

/** Avoid duplicate injection within the same document context */
const EXTENSION_KEY = "__WEB_MASCOT_INJECTED__";
if ((window as unknown as Record<string, boolean>)[EXTENSION_KEY]) {
  // Already active
} else {
  (window as unknown as Record<string, boolean>)[EXTENSION_KEY] = true;

  const EXT_VERSION = "0.0.3";

  let activeMascots: Mascot[] = [];
  let hostEl: HTMLElement | null = null;
  let spawnEpoch = 0;
  let spawnAbort: AbortController | null = null;
  let debounceSpawnTimer: number | null = null;
  let isLeaseHolder = false;
  let leaseMode: string | null = null;
  let groupReady = false;
  let settingsReady = false;

  // Runtime settings
  let isEnabled = true;
  let mascotMode = "both"; // "Neuron" | "Eviling" | "both"
  let isClickThrough = false;
  let isDebugLog = true;
  let isScrollInteraction = false;
  let isAutoHideScrollbar = false;
  let blacklistHosts: string[] = [];
  let isOrphaned = false;
  let acquireInFlight: Promise<void> | null = null;
  let acquireAgain = false;
  // Incremented whenever this document becomes hidden. A response from an
  // earlier lease request must not resurrect a background page.
  let lifecycleToken = 0;
  let yieldInFlight: Promise<void> | null = null;
  let backgroundEvictionTimer: number | null = null;
  const BACKGROUND_EVICT_MS = 30000;
  let relayPlaceholders: HTMLElement[] = [];

  // Extension viewport is fixed, disable built-in scroll shifts by default
  
  MascotEngine.extensionMode = true;

  /**
   * 检查当前扩展上下文是否依然有效。
   * 当用户在浏览器扩展管理页点击“重载”或热更新插件时，已打开标签页中的旧脚本将失效。
   */
  function isExtensionValid(): boolean {
    if (isOrphaned) return false;
    try {
      return Boolean(typeof chrome !== "undefined" && chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  /**
   * 当扩展上下文失效时，彻底自毁当前孤儿实例，清理所有定时器、DOM 与桌宠，防止控制台报错与内存泄漏
   */
  function handleExtensionInvalidated(): void {
    if (isOrphaned) return;
    isOrphaned = true;
    isLeaseHolder = false;
    spawnAbort?.abort();
    spawnAbort = null;

    stopHeartbeat();
    lifecycleToken++;
    if (acquireDebounceTimer !== null) window.clearTimeout(acquireDebounceTimer);
    acquireDebounceTimer = null;
    if (backgroundEvictionTimer !== null) window.clearTimeout(backgroundEvictionTimer);
    backgroundEvictionTimer = null;

    if (debounceSpawnTimer !== null) {
      window.clearTimeout(debounceSpawnTimer);
      debounceSpawnTimer = null;
    }
    if (scrollbarObserver) {
      scrollbarObserver.disconnect();
      scrollbarObserver = null;
    }
    if (scrollbarResizeTimer !== null) {
      window.clearTimeout(scrollbarResizeTimer);
      scrollbarResizeTimer = null;
    }

    for (const m of activeMascots) {
      try {
        m.destroy();
      } catch {
        // ignore
      }
    }
    activeMascots = [];
    clearRelayPlaceholders();

    if (hostEl && hostEl.parentNode) {
      hostEl.parentNode.removeChild(hostEl);
      hostEl = null;
    }
  }

  /**
   * Formatted console logger with distinct badge style
   */
  function log(msg: string, ...details: unknown[]): void {
    if (!isDebugLog || isOrphaned) return;
    console.log(
      `%c[Web Mascot v${EXT_VERSION}]%c ${msg}`,
      "background: #4f46e5; color: #ffffff; padding: 2px 6px; border-radius: 3px; font-weight: bold; font-size: 11px;",
      "color: #2563eb; font-weight: 500;",
      ...details,
    );
  }

  function logWarn(msg: string, ...details: unknown[]): void {
    if (isOrphaned) return;
    // 捕获并过滤扩展上下文失效信息，静默自毁，杜绝污染控制台
    const isContextInvalidated = details.some((d) => {
      const text = d instanceof Error ? d.message : String(d);
      return text.includes("Extension context invalidated");
    });
    if (isContextInvalidated) {
      handleExtensionInvalidated();
      return;
    }
    console.warn(
      `%c[Web Mascot v${EXT_VERSION}]%c ⚠️ ${msg}`,
      "background: #f59e0b; color: #ffffff; padding: 2px 6px; border-radius: 3px; font-weight: bold; font-size: 11px;",
      "color: #d97706; font-weight: 500;",
      ...details,
    );
  }

  log("🚀 插件内容脚本已就绪", {
    url: window.location.href,
    time: new Date().toLocaleTimeString(),
  });

  /**
   * Resolve packs to spawn based on mascotMode
   */
  const getPacksForMode = packsForMode;

  /**
   * Universal Scroll & Wheel Detection:
   * Captures wheel and scroll events across window and internal overflow containers,
   * triggering detachment & Fall for mascots on walls/ceilings, and LieDown / SitDown avoidance on the floor.
   */
  let lastScrollYMap = new WeakMap<EventTarget, number>();
  let lastWindowY = window.scrollY;

  function notifyScrollToEngines(delta: number): void {
    // Trackpads frequently emit sub-pixel / one-pixel deltas.  Do not discard
    // those events: the wheel event is the only reliable signal on pages whose
    // scroll container does not bubble a `scroll` event to the document.
    if (
      !isScrollInteraction ||
      isOrphaned ||
      !isLeaseHolder ||
      !Number.isFinite(delta) ||
      delta === 0
    )
      return;
    for (const m of activeMascots) {
      try {
        m.engine.handleExternalScroll(delta);
      } catch {
        // ignore
      }
    }
  }

  function setupUniversalScroll(): void {
    // Drive reactions from the resulting scroll position only. A wheel event
    // is merely an intent signal and is also emitted at a scroll boundary;
    // using it directly makes the mascot fall while the page remains still.
    document.addEventListener(
      "scroll",
      (e: Event) => {
        if (!isScrollInteraction || isOrphaned || !isLeaseHolder) return;
        const target = e.target;
        let delta = 0;
        if (
          target === document ||
          target === window ||
          target === document.documentElement ||
          target === document.body
        ) {
          delta = window.scrollY - lastWindowY;
          lastWindowY = window.scrollY;
        } else if (target instanceof HTMLElement) {
          const prev = lastScrollYMap.get(target) ?? target.scrollTop;
          delta = target.scrollTop - prev;
          lastScrollYMap.set(target, target.scrollTop);
        }
        if (delta !== 0) {
          notifyScrollToEngines(delta);
        }
      },
      { capture: true, passive: true },
    );
  }

  // Initialize universal scroll & wheel listener
  setupUniversalScroll();

  /**
   * 自动探测与隐藏页面滚动条管理模块
   */
  const SCROLLBAR_STYLE_ID = "__web_mascot_hide_scrollbar_style__";
  const SCROLLBAR_HIDE_CLASS = "__web_mascot_hide_scrollbar__";
  let scrollbarObserver: ResizeObserver | null = null;
  let scrollbarResizeTimer: number | null = null;

  function ensureScrollbarStyle(): void {
    if (document.getElementById(SCROLLBAR_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = SCROLLBAR_STYLE_ID;
    style.textContent = `
      html.${SCROLLBAR_HIDE_CLASS},
      html.${SCROLLBAR_HIDE_CLASS} * {
        scrollbar-width: none !important;
        -ms-overflow-style: none !important;
      }
      html.${SCROLLBAR_HIDE_CLASS} *::-webkit-scrollbar,
      html.${SCROLLBAR_HIDE_CLASS}::-webkit-scrollbar {
        display: none !important;
        width: 0 !important;
        height: 0 !important;
      }
      /* 防御部分第三方 UI 库（如 Element Plus / Ant Design）锁屏弹窗强行注入 padding-right 导致的白边 */
      html.${SCROLLBAR_HIDE_CLASS} body[style*="padding-right"] {
        padding-right: 0px !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * 探测当前页面是否存在可见或潜在的垂直/水平滚动条
   */
  function hasPageScrollbars(): boolean {
    const doc = document.documentElement;
    const body = document.body;
    if (!doc) return false;

    // 1. 经典滚动条物理占据尺寸（在滚动条未被 CSS 隐藏时为硬指标）
    const physicalVScroll = window.innerWidth > doc.clientWidth;
    const physicalHScroll = window.innerHeight > doc.clientHeight;

    // 2. 页面内容尺寸溢出视口（即使滚动条外观已被隐藏，scrollHeight/scrollWidth 依然能反映可滚动状态）
    const overflowY =
      doc.scrollHeight > window.innerHeight + 1 ||
      (body ? body.scrollHeight > window.innerHeight + 1 : false);
    const overflowX =
      doc.scrollWidth > window.innerWidth + 1 ||
      (body ? body.scrollWidth > window.innerWidth + 1 : false);

    // 3. 计算样式是否显式开启滚动模式（如 overflow: scroll 或 overflow-y: scroll）
    let computedScroll = false;
    try {
      const docStyle = window.getComputedStyle(doc);
      const bodyStyle = body ? window.getComputedStyle(body) : null;
      computedScroll =
        docStyle.overflowY === "scroll" ||
        docStyle.overflowX === "scroll" ||
        (bodyStyle
          ? bodyStyle.overflowY === "scroll" || bodyStyle.overflowX === "scroll"
          : false);
    } catch {
      // ignore
    }

    return (
      physicalVScroll ||
      physicalHScroll ||
      overflowY ||
      overflowX ||
      computedScroll
    );
  }

  function applyScrollbarHiding(hide: boolean): void {
    ensureScrollbarStyle();
    if (hide) {
      document.documentElement.classList.add(SCROLLBAR_HIDE_CLASS);
    } else {
      document.documentElement.classList.remove(SCROLLBAR_HIDE_CLASS);
    }
  }

  function checkAndApplyScrollbar(enabled: boolean): void {
    if (!enabled) {
      applyScrollbarHiding(false);
      if (scrollbarObserver) {
        scrollbarObserver.disconnect();
        scrollbarObserver = null;
      }
      return;
    }

    // 立即执行一次静态探测
    const hasScroll = hasPageScrollbars();
    if (hasScroll) {
      applyScrollbarHiding(true);
      log("🪟 探测到页面存在滚动条，已自动应用持久隐藏");
    } else {
      log("🪟 页面当前无可见滚动条，跳过隐藏");
    }

    // 为应对 SPA 动态异步加载内容，挂载轻量 ResizeObserver 监听内容高度变化
    if (!scrollbarObserver && window.ResizeObserver && document.body) {
      scrollbarObserver = new ResizeObserver(() => {
        if (!isAutoHideScrollbar) return;
        if (
          !document.documentElement.classList.contains(SCROLLBAR_HIDE_CLASS)
        ) {
          if (hasPageScrollbars()) {
            applyScrollbarHiding(true);
            log("🪟 动态探测到页面出现滚动条，已自动应用持久隐藏");
          }
        }
      });
      scrollbarObserver.observe(document.body);
    }
  }

  // 监听窗口大小变化（防抖重算）
  window.addEventListener("resize", () => {
    if (!isAutoHideScrollbar) return;
    if (scrollbarResizeTimer !== null) {
      window.clearTimeout(scrollbarResizeTimer);
    }
    scrollbarResizeTimer = window.setTimeout(() => {
      scrollbarResizeTimer = null;
      if (isAutoHideScrollbar) {
        if (hasPageScrollbars()) {
          applyScrollbarHiding(true);
        } else {
          applyScrollbarHiding(false);
        }
      }
    }, 200);
  });

  /**
   * Apply click-through mode on all mascot elements
   */
  function applyClickThrough(clickThrough: boolean): void {
    isClickThrough = clickThrough;
    for (const mascot of activeMascots) {
      if (mascot.engine?.elRoot) {
        mascot.engine.elRoot.style.pointerEvents = clickThrough
          ? "none"
          : "auto";
        mascot.engine.elRoot.style.opacity = clickThrough ? "0.85" : "1";
      }
    }
    if (clickThrough) {
      log("👻 鼠标穿透已开启 (点击将直接穿透到底层网页)");
    } else {
      log("🎯 鼠标穿透已关闭 (可正常点击与拖拽桌宠)");
    }
  }

  /**
   * Ensure host and shadow DOM exist
   */
  function ensureHost(): { container: HTMLElement; shadow: ShadowRoot } {
    if (!hostEl || !hostEl.isConnected) {
      if (hostEl && hostEl.parentNode) {
        hostEl.parentNode.removeChild(hostEl);
      }
      hostEl = document.createElement("div");
      hostEl.id = "web-mascot-extension-root";
      hostEl.style.cssText =
        "position:fixed;top:0;left:0;right:0;bottom:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;overflow:visible;transform:translateZ(0);will-change:transform;contain:layout style;";

      const shadow = hostEl.attachShadow({ mode: "open" });
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
        }
      `;
      shadow.appendChild(style);

      const viewport = document.createElement("div");
      viewport.className = "mascot-viewport";
      shadow.appendChild(viewport);

      const mountPoint = document.documentElement || document.body;
      if (mountPoint) {
        mountPoint.appendChild(hostEl);
      }
    }

    const shadow = hostEl.shadowRoot!;
    const container =
      (shadow.querySelector(".mascot-viewport") as HTMLElement) || hostEl;
    return { container, shadow };
  }

  function clearRelayPlaceholders(): void {
    for (const placeholder of relayPlaceholders) placeholder.remove();
    relayPlaceholders = [];
  }

  function showRelayPlaceholders(records: RelaySnapshot[]): void {
    clearRelayPlaceholders();
    const visualRecords = records.filter((record) => record.visual?.image);
    if (visualRecords.length === 0) return;
    const { container } = ensureHost();
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
      image.src = `${chrome.runtime.getURL("mascot_pack")}/${record.pack}/img${visual.image}`;
      root.appendChild(image);
      container.appendChild(root);
      relayPlaceholders.push(root);
    }
    if (hostEl) hostEl.style.display = "";
  }

  type RelaySnapshot = import("../../src/core/types.js").RelaySnapshot;
  let currentLeaseEpoch = -1;
  let heartbeatTimer: number | null = null;

  function stopHeartbeat() {
    if (heartbeatTimer) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = window.setInterval(() => {
      if (!isExtensionValid()) { handleExtensionInvalidated(); return; }
      if (!isLeaseHolder) return;
      const epoch = currentLeaseEpoch;
      void chrome.runtime.sendMessage({ type: "HEARTBEAT_SNAPSHOT", epoch,
        submission: createSubmission() }).then((reply) => {
        if (isLeaseHolder && epoch === currentLeaseEpoch && !reply?.leaseValid) stopLocalLease();
      }).catch((error: unknown) => logWarn("Heartbeat failed", error));
    }, 500);
  }

  function stopLocalLease(): void {
    lifecycleToken++;
    isLeaseHolder = false;
    spawnAbort?.abort();
    spawnAbort = null;
    stopHeartbeat();
    if (acquireDebounceTimer !== null) window.clearTimeout(acquireDebounceTimer);
    acquireDebounceTimer = null;
    for (const mascot of activeMascots) mascot.engine.pauseForRelay();
    if (hostEl) hostEl.style.display = "none";
    clearRelayPlaceholders();
    scheduleBackgroundEviction();
  }

  function scheduleBackgroundEviction(): void {
    if (backgroundEvictionTimer !== null) window.clearTimeout(backgroundEvictionTimer);
    if (activeMascots.length === 0) return;
    backgroundEvictionTimer = window.setTimeout(() => {
      backgroundEvictionTimer = null;
      if (!isLeaseHolder) despawnAllMascots();
    }, BACKGROUND_EVICT_MS);
  }

  function createSubmission(): SnapshotSubmission {
    const packs = getPacksForMode(mascotMode);
    if (!groupReady || activeMascots.length !== packs.length ||
      !packs.every((pack) => activeMascots.filter((m) => m.engine.mascotName === pack).length === 1)) {
      return { status: "UNINITIALIZED" };
    }
    return { status: "READY", packs, pets: activeMascots.map((m) => m.engine.createRelaySnapshot()) };
  }

  /**
   * Claims exclusive lease for the active tab and resumes or spawns mascots
   */
  function acquireLease(): Promise<void> {
    if (acquireInFlight) {
      acquireAgain = true;
      return acquireInFlight;
    }
    acquireInFlight = acquireLeaseInternal().finally(() => {
      acquireInFlight = null;
      if (acquireAgain) {
        acquireAgain = false;
        scheduleAcquireLease();
      }
    });
    return acquireInFlight;
  }

  async function acquireLeaseInternal(): Promise<void> {
    if (!isExtensionValid()) {
      handleExtensionInvalidated();
      return;
    }
    if (document.visibilityState === "hidden") return;
    if (!settingsReady || !isEnabled) return;
    if (yieldInFlight) await yieldInFlight;
    if (
      !isExtensionValid() ||
      document.hidden ||
      !isEnabled
    )
      return;
    const currentHost = window.location.hostname;
    if (currentHost && blacklistHosts.includes(currentHost)) return;
    if (isLeaseHolder && leaseMode === mascotMode) return;
    const localSnapshots = isLeaseHolder && groupReady
      ? activeMascots.map((mascot) => mascot.engine.createRelaySnapshot()) : null;
    const requestToken = lifecycleToken;

    let response: LeaseReply;
    try {
      response = await chrome.runtime.sendMessage({ type: "ACQUIRE_LEASE" });
    } catch (err: unknown) {
      const errMsg = (err as Error)?.message || String(err);
      if (errMsg.includes("Extension context invalidated")) {
        handleExtensionInvalidated();
        return;
      }
      logWarn("Failed to contact background service worker", err);
      return;
    }

    if (!response || !response.success) return;

    // The browser may have switched tabs while the service worker waited for
    // the previous owner. Release this epoch if the response is now stale.
    if (
      requestToken !== lifecycleToken ||
      document.visibilityState !== "visible" || !isEnabled ||
      blacklistHosts.includes(window.location.hostname)
    ) {
      sendLeaseYield(response.epoch);
      return;
    }

    isLeaseHolder = true;
    leaseMode = mascotMode;
    currentLeaseEpoch = response.epoch;
    if (backgroundEvictionTimer !== null) window.clearTimeout(backgroundEvictionTimer);
    backgroundEvictionTimer = null;
    startHeartbeat();
    const snapshots = localSnapshots ?? response.snapshots;
    const expectedPacks = getPacksForMode(mascotMode);
    const packsMatch = activeMascots.length === expectedPacks.length &&
      expectedPacks.every((p) => activeMascots.some((m) => m.engine.mascotName === p));
    const fastResume = groupReady && packsMatch && hostEl;
    groupReady = false;
    showRelayPlaceholders(snapshots.filter((pet) => expectedPacks.includes(pet.pack)));
    if (hostEl) hostEl.style.display = "";
    if (fastResume && expectedPacks.every((pack) => snapshots.some((pet) => pet.pack === pack))) {
      try {
        await Promise.all(activeMascots.map((m) => m.engine.prepareForRelay(
          snapshots.find((pet) => pet.pack === m.engine.mascotName)!)));
        if (!isLeaseHolder || requestToken !== lifecycleToken) return;
        groupReady = true;
        for (const mascot of activeMascots) mascot.engine.resumeForRelay();
        clearRelayPlaceholders();
      } catch (error) {
        logWarn("Relay preparation failed", error);
        yieldLease();
        despawnAllMascots();
      }
      return;
    }
    scheduleSpawn(expectedPacks, snapshots, 0);
  }

  function yieldLease(clear = false): void {
    if (!isExtensionValid()) { handleExtensionInvalidated(); return; }
    const hadLease = isLeaseHolder;
    stopLocalLease();
    const submission: SnapshotSubmission = clear ? { status: "CLEARED" } : createSubmission();
    if (hadLease) void sendLeaseYield(currentLeaseEpoch, submission);
  }

  function sendLeaseYield(
    epoch: number,
    submission: SnapshotSubmission = { status: "UNINITIALIZED" },
  ): Promise<void> {
    let request: Promise<unknown>;
    try {
      request = chrome.runtime.sendMessage({
        type: "YIELD_LEASE",
        epoch,
        submission,
      });
    } catch (err: unknown) {
      const errMsg = (err as Error)?.message || String(err);
      if (errMsg.includes("Extension context invalidated"))
        handleExtensionInvalidated();
      return Promise.resolve();
    }
    const completed = Promise.resolve(request)
      .then(() => undefined)
      .catch((err: unknown) => {
        const errMsg = (err as Error)?.message || String(err);
        if (errMsg.includes("Extension context invalidated"))
          handleExtensionInvalidated();
      });
    const tracked = completed.finally(() => {
      if (yieldInFlight === tracked) yieldInFlight = null;
    });
    yieldInFlight = tracked;
    return tracked;
  }

  /**
   * Spawns all requested mascots cleanly with relay coordinates (never falls on relay)
   */
  async function spawnAllMascots(
    packs: string[],
    snapshots: RelaySnapshot[] = [],
  ): Promise<void> {
    const currentEpoch = ++spawnEpoch;
    const currentLeaseEpochSnap = currentLeaseEpoch;
    spawnAbort?.abort();
    const abort = new AbortController();
    spawnAbort = abort;

    // Clear existing
    for (const m of activeMascots) {
      m.destroy();
    }
    activeMascots = [];
    groupReady = false;

    if (
      !isEnabled ||
      packs.length === 0 ||
      document.hidden ||
      !isLeaseHolder
    )
      return;

    // Check domain blacklist
    const currentHost = window.location.hostname;
    if (currentHost && blacklistHosts.includes(currentHost)) {
      log(`🚫 当前网站【${currentHost}】处于黑名单中，桌宠已跳过加载`);
      return;
    }

    log(`📦 正在启动桌宠组: [${packs.join(", ")}] ...`);

    const { container } = ensureHost();

    // Configure assets
    let assetBase = "";
    let animConfigUrl = "";
    try {
      assetBase = chrome.runtime.getURL("mascot_pack");
      animConfigUrl = chrome.runtime.getURL("animation.config.json");
    } catch (err: unknown) {
      const errMsg = (err as Error)?.message || String(err);
      if (errMsg.includes("Extension context invalidated")) {
        handleExtensionInvalidated();
        return;
      }
    }
    configure({
      assets: assetBase,
      animationConfigUrl: animConfigUrl,
    });

    for (let i = 0; i < packs.length; i++) {
      const pack = packs[i];
      if (
        currentEpoch !== spawnEpoch ||
        document.hidden ||
        !isLeaseHolder ||
        currentLeaseEpochSnap !== currentLeaseEpoch
      )
        return;

      const saved = snapshots.find((r) => r.pack === pack);
      let initialSnapshot: RelaySnapshot | undefined = undefined;

      if (saved && typeof saved.x === "number" && typeof saved.y === "number") {
        initialSnapshot = saved;
      }

      try {
        const mascot = await createMascot({
          container,
          pack,
          initialSnapshot,
          startPaused: true,
          signal: abort.signal,
        });

        if (
          currentEpoch !== spawnEpoch ||
          document.hidden ||
          !isLeaseHolder ||
          currentLeaseEpochSnap !== currentLeaseEpoch
        ) {
          mascot.destroy();
          return;
        }

        if (mascot?.engine?.elRoot) {
          mascot.engine.elRoot.style.zIndex = "2147483647";
          mascot.engine.elRoot.style.pointerEvents = isClickThrough
            ? "none"
            : "auto";
          mascot.engine.elRoot.style.opacity = isClickThrough ? "0.85" : "1";
        }

        if (initialSnapshot) {
          log(
            `桌宠【${pack}】已恢复接力状态`,
          );
        } else {
          log(`🌟 桌宠【${pack}】全新登场，自顶部落下！`);
        }

        activeMascots.push(mascot);
      } catch (err) {
        if (abort.signal.aborted || currentEpoch !== spawnEpoch || !isLeaseHolder ||
          currentLeaseEpochSnap !== currentLeaseEpoch) return;
        logWarn(`创建桌宠【${pack}】失败:`, err);
        yieldLease();
        despawnAllMascots();
        return;
      }
    }
    if (currentEpoch === spawnEpoch && isLeaseHolder && currentLeaseEpochSnap === currentLeaseEpoch &&
      activeMascots.length === packs.length) {
      groupReady = true;
      spawnAbort = null;
      for (const mascot of activeMascots) mascot.engine.resumeForRelay();
      clearRelayPlaceholders();
    }
  }

  /**
   * Debounced spawn to protect against rapid page switching or navigation storms
   */
  function scheduleSpawn(
    packs: string[],
    snapshots: RelaySnapshot[] = [],
    delayMs = 60,
  ): void {
    if (debounceSpawnTimer) {
      window.clearTimeout(debounceSpawnTimer);
      debounceSpawnTimer = null;
    }

    if (document.visibilityState === "hidden") {
      return;
    }

    debounceSpawnTimer = window.setTimeout(() => {
      debounceSpawnTimer = null;
      spawnAllMascots(packs, snapshots);
    }, delayMs);
  }

  /**
   * Destroys all mascots and unmounts host DOM
   */
  function despawnAllMascots(): void {
    groupReady = false;
    ++spawnEpoch;
    spawnAbort?.abort();
    spawnAbort = null;
    if (backgroundEvictionTimer !== null) window.clearTimeout(backgroundEvictionTimer);
    backgroundEvictionTimer = null;
    if (debounceSpawnTimer) {
      window.clearTimeout(debounceSpawnTimer);
      debounceSpawnTimer = null;
    }
    for (const m of activeMascots) {
      m.destroy();
    }
    activeMascots = [];
    clearRelayPlaceholders();
    if (hostEl && hostEl.parentNode) {
      hostEl.parentNode.removeChild(hostEl);
      hostEl = null;
    }
    log("🛑 当前标签页已清理桌宠 DOM 与运行循环");
  }

  /**
   * Resets all mascots' positions to ceiling drop
   */
  function resetPositions(): void {
    for (const m of activeMascots) {
      try {
        m.engine.resetToSpawn();
      } catch {
        // ignore
      }
    }
    log("📍 全部桌宠已重置位置，自顶部落下！");
  }

  let acquireDebounceTimer: number | null = null;

  function scheduleAcquireLease(): void {
    if (!isExtensionValid() || document.visibilityState === "hidden") return;
    if (acquireDebounceTimer !== null) {
      window.clearTimeout(acquireDebounceTimer);
    }
    acquireDebounceTimer = window.setTimeout(() => {
      acquireDebounceTimer = null;
      if (document.visibilityState === "visible") {
        void acquireLease();
      }
    }, 16);
  }

  // Lifecycle guards: yield lease and clean up on tab hidden or unload
  document.addEventListener("visibilitychange", () => {
    if (!isExtensionValid()) {
      handleExtensionInvalidated();
      return;
    }
    if (document.visibilityState === "visible") {
      scheduleAcquireLease();
    } else {
      lifecycleToken++;
      if (acquireDebounceTimer !== null) {
        window.clearTimeout(acquireDebounceTimer);
        acquireDebounceTimer = null;
      }
      yieldLease();
    }
  });

  window.addEventListener("focus", () => {
    if (!isExtensionValid()) {
      handleExtensionInvalidated();
      return;
    }
    if (document.visibilityState === "visible" && !isLeaseHolder) {
      scheduleAcquireLease();
    }
  });

  window.addEventListener("pagehide", () => {
    lifecycleToken++;
    if (acquireDebounceTimer !== null) {
      window.clearTimeout(acquireDebounceTimer);
      acquireDebounceTimer = null;
    }
    if (isExtensionValid()) yieldLease();
    else handleExtensionInvalidated();
  });

  window.addEventListener("pageshow", () => {
    if (!isExtensionValid()) {
      handleExtensionInvalidated();
      return;
    }
    if (document.visibilityState === "visible") {
      scheduleAcquireLease();
    }
  });

  document.addEventListener("freeze", () => {
    lifecycleToken++;
    if (acquireDebounceTimer !== null) {
      window.clearTimeout(acquireDebounceTimer);
      acquireDebounceTimer = null;
    }
    if (isExtensionValid()) yieldLease();
  });

  document.addEventListener("resume", () => {
    if (!isExtensionValid()) {
      handleExtensionInvalidated();
      return;
    }
    if (document.visibilityState === "visible") scheduleAcquireLease();
  });

  // Hook into MascotEngine observer for runtime lifecycle logging
  MascotEngine.addObserver((engine, event: EngineEvent) => {
    if (!isDebugLog) return;
    const name = engine.mascotName || "Mascot";
    if (event.kind === "spawn") {
      log(`🐣【${name}】诞生事件 (Spawn): ${event.detail}`);
    } else if (event.kind === "despawn") {
      log(`💨【${name}】销毁事件 (Despawn): ${event.detail}`);
    } else if (event.kind === "behavior") {
      const pos = `(${Math.round(event.x)}, ${Math.round(event.y)})`;
      log(
        `🏃【${name}】动作切换: ${event.from} -> ${event.to} [原因: ${event.reason}] @ ${pos}`,
      );
    } else if (event.kind === "milestone") {
      if (event.name === "land") {
        log(
          `🛬【${name}】平稳着陆 (Land) @ (${Math.round(event.x)}, ${Math.round(event.y)})`,
        );
      } else if (event.name === "broadcast-start") {
        log(`📡【${name}】发起同伴互动广播: ${event.detail}`);
      } else if (event.name === "broadcast-connect") {
        log(`💕【${name}】同伴互动握手成功: ${event.detail}`);
      } else if (event.name === "interaction-arrived") {
        log(`🤝【${name}】同伴互动到位: ${event.detail}`);
      } else if (event.name === "drag-resist") {
        log(`💢【${name}】抗拒拖拽并准备挣脱！`);
      } else if (event.name === "resist-escape") {
        log(`💨【${name}】成功挣脱鼠标！`);
      } else if (event.name === "paused" && event.detail !== "hidden") {
        log(`⏸️【${name}】暂停模拟: ${event.detail}`);
      } else if (event.name === "resumed" && event.detail !== "hidden") {
        log(`▶️【${name}】恢复模拟: ${event.detail}`);
      }
    }
  });

  /**
   * Initialize settings from persistent chrome.storage.local
   */
  if (isExtensionValid()) {
    try {
      chrome.storage.local.get(
        {
          enabled: true,
          mascotMode: "both",
          clickThrough: false,
          debugLog: true,
          scrollInteraction: false,
          autoHideScrollbar: false,
          blacklist: [],
        },
        (items) => {
          if (!isExtensionValid()) {
            handleExtensionInvalidated();
            return;
          }
          isEnabled = Boolean(items.enabled);
          mascotMode = typeof items.mascotMode === "string" ? items.mascotMode : "both";
          isClickThrough = Boolean(items.clickThrough);
          isDebugLog = Boolean(items.debugLog);
          isScrollInteraction = Boolean(items.scrollInteraction);
          isAutoHideScrollbar = Boolean(items.autoHideScrollbar);
          blacklistHosts = Array.isArray(items.blacklist)
            ? items.blacklist
            : [];
          settingsReady = true;

          log("⚙️ 读取已保存配置:", {
            enabled: isEnabled,
            mode: mascotMode,
            clickThrough: isClickThrough,
            scrollInteraction: isScrollInteraction,
            autoHideScrollbar: isAutoHideScrollbar,
          });

          // 无论桌宠是否全局启用，自动隐藏滚动条作为独立辅助功能均执行探测与应用
          checkAndApplyScrollbar(isAutoHideScrollbar);

          if (!isEnabled) {
            log("💤 桌宠当前处于禁用状态 (可通过右上角扩展图标开启)");
            return;
          }

          if (document.visibilityState === "visible") {
            acquireLease();
          } else {
            log("💤 当前标签页处于后台，等待切至前台时自动接力桌宠...");
          }
        },
      );
    } catch {
      handleExtensionInvalidated();
    }
  }

  /**
   * React to storage updates from popup control panel and other tabs
   */
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (!isExtensionValid()) {
      handleExtensionInvalidated();
      return;
    }
    if (areaName !== "local") return;

    if (changes.debugLog !== undefined) {
      isDebugLog = Boolean(changes.debugLog.newValue);
    }

    if (changes.clickThrough !== undefined) {
      applyClickThrough(Boolean(changes.clickThrough.newValue));
    }

    if (changes.scrollInteraction !== undefined) {
      isScrollInteraction = Boolean(changes.scrollInteraction.newValue);
      log(
        isScrollInteraction
          ? "🌪️ 页面滚动互动已开启 (实验性)"
          : "🛡️ 页面滚动互动已关闭",
      );
    }

    if (changes.autoHideScrollbar !== undefined) {
      isAutoHideScrollbar = Boolean(changes.autoHideScrollbar.newValue);
      checkAndApplyScrollbar(isAutoHideScrollbar);
      log(
        isAutoHideScrollbar
          ? "🪟 自动隐藏滚动条已开启"
          : "🪟 自动隐藏滚动条已关闭（恢复原生显示）",
      );
    }

    let shouldUpdatePacks = false;

    if (changes.blacklist !== undefined) {
      blacklistHosts = Array.isArray(changes.blacklist.newValue)
        ? changes.blacklist.newValue
        : [];
      const currentHost = window.location.hostname;
      const isBlacklisted = currentHost && blacklistHosts.includes(currentHost);
      if (isBlacklisted) {
        yieldLease();
        despawnAllMascots();
        log(`🚫 当前网站【${currentHost}】已加入黑名单，桌宠已退出`);
        return;
      } else if (
        !isBlacklisted &&
        activeMascots.length === 0 &&
        isEnabled &&
        document.visibilityState === "visible"
      ) {
        shouldUpdatePacks = true;
      }
    }

    if (changes.enabled !== undefined) {
      const nextEnabled = Boolean(changes.enabled.newValue);
      if (nextEnabled !== isEnabled) {
        isEnabled = nextEnabled;
        if (!isEnabled) {
          yieldLease(true);
          despawnAllMascots();
          return;
        }
        shouldUpdatePacks = true;
      }
    }

    if (changes.mascotMode !== undefined) {
      const nextMode = typeof changes.mascotMode.newValue === "string" ? changes.mascotMode.newValue : "both";
      if (nextMode !== mascotMode) {
        lifecycleToken++;
        mascotMode = nextMode;
        if (isEnabled && document.visibilityState === "visible") {
          shouldUpdatePacks = true;
        }
      }
    }

    if (
      shouldUpdatePacks &&
      isEnabled &&
      document.visibilityState === "visible"
    ) {
      acquireLease();
    }
  });

  /**
   * Handle runtime messages (e.g. manual reset, restart)
   */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isExtensionValid()) {
      handleExtensionInvalidated();
      return;
    }
    if (message?.type === "ACQUIRE_IF_FOCUSED") {
      scheduleAcquireLease();
      sendResponse({ success: true });
      return;
    }
    if (message?.type === "PREPARE_TRANSFER") {
      if (!isLeaseHolder || message.epoch !== currentLeaseEpoch) {
        sendResponse({ success: false });
        return;
      }
      stopLocalLease();
      const submission = createSubmission();
      sendResponse({ success: true, submission });
      return;
    }

    if (message?.type === "RESET_POSITION") {
      resetPositions();
      sendResponse({ success: true });
      return true;
    }

    if (message?.type === "RESTART") {
      yieldLease();
      despawnAllMascots();
      if (document.visibilityState === "visible") {
        acquireLease();
      }
      sendResponse({ success: true });
      return true;
    }

    if (message?.type === "PING") {
      sendResponse({
        success: true,
        count: activeMascots.length,
        mode: mascotMode,
        clickThrough: isClickThrough,
      });
      return true;
    }
  });
}

