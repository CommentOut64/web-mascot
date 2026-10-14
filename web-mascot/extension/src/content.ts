import { packsForMode, type SnapshotSubmission, type LeaseReply } from "./protocol.js";
import {
  configure,
  Mascot,
  MascotEngine,
  MascotGroup,
  ViewportHost,
  type EngineEvent,
  type RelaySnapshot,
} from "../../src/index.js";
import {
  checkAndApplyScrollbar,
  cleanupScrollbar,
} from "./features/autohideScrollbar.js";

/** Avoid duplicate injection within the same document context */
const EXTENSION_KEY = "__WEB_MASCOT_INJECTED__";
if ((window as unknown as Record<string, boolean>)[EXTENSION_KEY]) {
  // Already active
} else {
  (window as unknown as Record<string, boolean>)[EXTENSION_KEY] = true;

  const EXT_VERSION = "0.0.4";

  const host = new ViewportHost("web-mascot-extension-root");
  const group = new MascotGroup();
  let activeMascots: Mascot[] = [];

  function syncActiveMascots(): void {
    activeMascots = group.engines.map((e) => new Mascot(e));
  }

  let debounceSpawnTimer: number | null = null;
  let isLeaseHolder = false;
  let leaseMode: string | null = null;
  let settingsReady = false;

  // Runtime settings
  let isEnabled = true;
  let mascotMode = "both"; // "Neuron" | "Eviling" | "both"
  let isClickThrough = false;
  let isDebugLog = false;
  let isScrollInteraction = false;
  let isAutoHideScrollbar = false;
  let blacklistHosts: string[] = [];
  let isOrphaned = false;
  let acquireInFlight: Promise<void> | null = null;
  let acquireAgain = false;
  let lifecycleToken = 0;
  let yieldInFlight: Promise<void> | null = null;
  let backgroundEvictionTimer: number | null = null;
  const BACKGROUND_EVICT_MS = 30000;

  // Tell MascotEngine that scroll tracking is handled externally by content script
  MascotEngine.extensionMode = true;
  MascotEngine.externalScroll = true;

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

    cleanupScrollbar();
    group.destroy();
    activeMascots = [];
    host.destroy();
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

  const getPacksForMode = packsForMode;

  /** Capture actual page/container movement; wheel intent alone is not movement. */
  const lastScrollYMap = new WeakMap<EventTarget, number>();
  let lastWindowY = window.scrollY;

  function resetScrollInput(): void {
    lastWindowY = window.scrollY;
    for (const mascot of activeMascots) mascot.engine.resetScrollTracking();
  }

  document.addEventListener("scroll", (event: Event) => {
    if (isOrphaned) return;
    const target = event.target;
    const documentScroll = target === document || target === window || target === document.scrollingElement;
    let delta = 0;
    if (documentScroll) {
      delta = window.scrollY - lastWindowY;
      lastWindowY = window.scrollY;
    } else if (target instanceof HTMLElement) {
      // Internal containers can release a wall grip, but do not shift the
      // document position of a mascot standing on the viewport floor.
      const previous = lastScrollYMap.get(target) ?? 0;
      delta = target.scrollTop - previous;
      lastScrollYMap.set(target, target.scrollTop);
    }
    // Update baselines even while interactions are disabled or this page has no lease.
    if (!isScrollInteraction || !isLeaseHolder || !Number.isFinite(delta) || delta === 0) return;
    for (const mascot of activeMascots) mascot.engine.handleExternalScroll(delta, documentScroll);
  }, { capture: true, passive: true });

  /**
   * Relay lease and lifecycle management
   */
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
    stopHeartbeat();
    if (acquireDebounceTimer !== null) window.clearTimeout(acquireDebounceTimer);
    acquireDebounceTimer = null;
    group.pauseForRelay();
    host.hide();
    scheduleBackgroundEviction();
  }

  function scheduleBackgroundEviction(): void {
    if (backgroundEvictionTimer !== null) window.clearTimeout(backgroundEvictionTimer);
    if (group.count === 0) return;
    backgroundEvictionTimer = window.setTimeout(() => {
      backgroundEvictionTimer = null;
      if (!isLeaseHolder) despawnAllMascots();
    }, BACKGROUND_EVICT_MS);
  }

  function createSubmission(): SnapshotSubmission {
    const packs = getPacksForMode(mascotMode);
    if (!group.isReady || group.count !== packs.length ||
      !packs.every((pack) => group.engines.filter((m) => m.mascotName === pack).length === 1)) {
      return { status: "UNINITIALIZED" };
    }
    return { status: "READY", packs, pets: group.createRelaySnapshots() };
  }

  function applyClickThrough(clickThrough: boolean): void {
    isClickThrough = clickThrough;
    group.setClickThrough(clickThrough);
    if (clickThrough) {
      log("👻 鼠标穿透已开启 (点击将直接穿透到底层网页)");
    } else {
      log("🎯 鼠标穿透已关闭 (可正常点击与拖拽桌宠)");
    }
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
    if (!isExtensionValid() || document.hidden || !isEnabled) return;

    const currentHost = window.location.hostname;
    if (currentHost && blacklistHosts.includes(currentHost)) return;
    if (isLeaseHolder && leaseMode === mascotMode) return;

    const localSnapshots = isLeaseHolder && group.isReady ? group.createRelaySnapshots() : null;
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

    if (
      requestToken !== lifecycleToken ||
      document.visibilityState !== "visible" || !isEnabled ||
      blacklistHosts.includes(window.location.hostname)
    ) {
      sendLeaseYield(response.epoch);
      return;
    }

    resetScrollInput();
    isLeaseHolder = true;
    leaseMode = mascotMode;
    currentLeaseEpoch = response.epoch;
    if (backgroundEvictionTimer !== null) window.clearTimeout(backgroundEvictionTimer);
    backgroundEvictionTimer = null;
    startHeartbeat();

    const snapshots = localSnapshots ?? response.snapshots;
    const expectedPacks = getPacksForMode(mascotMode);
    const packsMatch = group.isReady && group.count === expectedPacks.length &&
      expectedPacks.every((p) => group.engines.some((m) => m.mascotName === p));
    const fastResume = packsMatch && host.isMounted;

    host.showPlaceholders(snapshots.filter((pet) => expectedPacks.includes(pet.pack)), chrome.runtime.getURL("mascot_pack"));
    host.show();

    if (fastResume && expectedPacks.every((pack) => snapshots.some((pet) => pet.pack === pack))) {
      try {
        await group.fastResume(expectedPacks, snapshots);
        if (!isLeaseHolder || requestToken !== lifecycleToken) return;
        syncActiveMascots();
        host.clearPlaceholders();
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
      if (errMsg.includes("Extension context invalidated")) handleExtensionInvalidated();
      return Promise.resolve();
    }
    const completed = Promise.resolve(request)
      .then(() => undefined)
      .catch((err: unknown) => {
        const errMsg = (err as Error)?.message || String(err);
        if (errMsg.includes("Extension context invalidated")) handleExtensionInvalidated();
      });
    const tracked = completed.finally(() => {
      if (yieldInFlight === tracked) yieldInFlight = null;
    });
    yieldInFlight = tracked;
    return tracked;
  }

  /**
   * Spawns all requested mascots using MascotGroup
   */
  async function spawnAllMascots(
    packs: string[],
    snapshots: RelaySnapshot[] = [],
  ): Promise<void> {
    group.despawn();
    syncActiveMascots();

    if (!isEnabled || packs.length === 0 || document.hidden || !isLeaseHolder) return;

    const currentHost = window.location.hostname;
    if (currentHost && blacklistHosts.includes(currentHost)) {
      log(`🚫 当前网站【${currentHost}】处于黑名单中，桌宠已跳过加载`);
      return;
    }

    log(`📦 正在启动桌宠组: [${packs.join(", ")}] ...`);

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

    try {
      await group.spawn({
        packs,
        snapshots,
        host,
        isClickThrough,
        onSpawned: (pack, isRestored) => {
          if (isRestored) {
            log(`桌宠【${pack}】已恢复接力状态`);
          } else {
            log(`🌟 桌宠【${pack}】全新登场，自顶部落下！`);
          }
        },
        onFailed: (pack, err) => {
          logWarn(`创建桌宠【${pack}】失败:`, err);
          yieldLease();
          despawnAllMascots();
        },
      });
      syncActiveMascots();
    } catch {
      // handled in onFailed
    }
  }

  function scheduleSpawn(
    packs: string[],
    snapshots: RelaySnapshot[] = [],
    delayMs = 60,
  ): void {
    if (debounceSpawnTimer) {
      window.clearTimeout(debounceSpawnTimer);
      debounceSpawnTimer = null;
    }
    if (document.visibilityState === "hidden") return;

    debounceSpawnTimer = window.setTimeout(() => {
      debounceSpawnTimer = null;
      spawnAllMascots(packs, snapshots);
    }, delayMs);
  }

  function despawnAllMascots(): void {
    if (backgroundEvictionTimer !== null) window.clearTimeout(backgroundEvictionTimer);
    backgroundEvictionTimer = null;
    if (debounceSpawnTimer) {
      window.clearTimeout(debounceSpawnTimer);
      debounceSpawnTimer = null;
    }
    group.despawn();
    syncActiveMascots();
    host.destroy();
    log("🛑 当前标签页已清理桌宠 DOM 与运行循环");
  }

  function resetPositions(): void {
    group.resetToSpawn();
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
          debugLog: false,
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
          mascotMode =
            typeof items.mascotMode === "string" ? items.mascotMode : "both";
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

          checkAndApplyScrollbar(isAutoHideScrollbar, log);

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
      resetScrollInput();
      log(
        isScrollInteraction
          ? "🌪️ 页面滚动互动已开启 (实验性)"
          : "🛡️ 页面滚动互动已关闭",
      );
    }

    if (changes.autoHideScrollbar !== undefined) {
      isAutoHideScrollbar = Boolean(changes.autoHideScrollbar.newValue);
      checkAndApplyScrollbar(isAutoHideScrollbar, log);
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
        group.count === 0 &&
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
        count: group.count,
        mode: mascotMode,
        clickThrough: isClickThrough,
      });
      return true;
    }
  });
}
