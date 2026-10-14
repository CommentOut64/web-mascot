import { acceptsGroup, packsForMode, type SnapshotSubmission } from "./protocol.js";
import type { RelaySnapshot } from "../../src/core/types.js";

type Owner = { tabId: number; documentId: string; windowId: number };
let owner: Owner | null = null;
let epoch = 0;
let snapshots: RelaySnapshot[] = [];
let settings = { enabled: true, mascotMode: "both", blacklist: [] as string[] };
let loaded: Promise<void> | null = null;
let acquireTail: Promise<unknown> = Promise.resolve();
let persistTail: Promise<void> = Promise.resolve();
let persistedAt = 0;
let pendingTransfer: { owner: Owner; epoch: number; finish: (stopped: boolean) => void } | null = null;

function sameDocument(a: Owner | null, b: Owner): boolean {
  return a?.tabId === b.tabId && a.documentId === b.documentId;
}

function identity(sender: chrome.runtime.MessageSender): Owner | null {
  return sender.documentLifecycle !== "prerender" && sender.documentLifecycle !== "cached" && sender.frameId === 0 && sender.tab?.id !== undefined && sender.documentId &&
    sender.tab.windowId !== undefined
    ? { tabId: sender.tab.id, documentId: sender.documentId, windowId: sender.tab.windowId }
    : null;
}

function loadState(): Promise<void> {
  if (!loaded) loaded = Promise.all([
    chrome.storage.session.get({ mascotLeaseOwner: null, mascotLeaseEpoch: 0, mascotRelaySnapshots: [] }),
    chrome.storage.local.get(settings),
  ]).then(([stored, config]) => {
    const saved = stored.mascotLeaseOwner as Partial<Owner> | null;
    owner = saved && typeof saved.tabId === "number" && typeof saved.documentId === "string" &&
      typeof saved.windowId === "number" ? saved as Owner : null;
    epoch = typeof stored.mascotLeaseEpoch === "number" && Number.isSafeInteger(stored.mascotLeaseEpoch) ? stored.mascotLeaseEpoch : 0;
    snapshots = Array.isArray(stored.mascotRelaySnapshots)
      ? stored.mascotRelaySnapshots.filter((pet: RelaySnapshot) => pet.schemaVersion === 2) : [];
    settings = { enabled: Boolean(config.enabled), mascotMode: typeof config.mascotMode === "string" ? config.mascotMode : "both",
      blacklist: Array.isArray(config.blacklist) ? config.blacklist : [] };
  });
  return loaded;
}

function persist(): Promise<void> {
  persistedAt = Date.now();
  const state = { mascotLeaseOwner: owner, mascotLeaseEpoch: epoch, mascotRelaySnapshots: snapshots };
  persistTail = persistTail.catch(() => undefined).then(() => chrome.storage.session.set(state));
  return persistTail;
}

function accept(submission?: SnapshotSubmission): void {
  if (!submission) return;
  if (submission.status === "CLEARED") snapshots = [];
  else if (acceptsGroup(submission, packsForMode(settings.mascotMode)) && submission.status === "READY") {
    snapshots = submission.pets;
  }
}

async function eligible(candidate: Owner, url?: string): Promise<boolean> {
  if (!settings.enabled) return false;
  const [tab, window] = await Promise.all([
    chrome.tabs.get(candidate.tabId), chrome.windows.getLastFocused(),
  ]);
  const host = new URL(url || tab.url || "https://invalid.local").hostname;
  return tab.active && window.id === candidate.windowId && window.focused &&
    !tab.discarded && !settings.blacklist.includes(host);
}

async function transfer(previous: Owner): Promise<boolean> {
  const transferEpoch = epoch;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (stopped: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingTransfer = null;
      resolve(stopped);
    };
    const timer = setTimeout(() => finish(false), 120);
    pendingTransfer = { owner: previous, epoch: transferEpoch, finish };
    void chrome.tabs.sendMessage(previous.tabId, { type: "PREPARE_TRANSFER", epoch: transferEpoch },
      { documentId: previous.documentId }).then(async (response) => {
      if (!response?.success || !sameDocument(owner, previous) || epoch !== transferEpoch) return;
      accept(response.submission);
      owner = null;
      if (!settled) finish(true);
      else {
        await persist();
        wakeFocusedTab();
      }
    }).catch(() => finish(false));
  });
}

async function acquire(candidate: Owner, url?: string) {
  await loadState();
  if (!await eligible(candidate, url)) return { success: false, epoch, snapshots: [] };
  if (sameDocument(owner, candidate)) return { success: true, epoch, snapshots };
  const previous = owner;
  if (previous && !await transfer(previous)) {
    // Navigation or an inactive/discarded tab proves the old document cannot
    // render. A visible old window requires acknowledgement before replacement.
    let stopped = previous.tabId === candidate.tabId;
    try {
      const tab = await chrome.tabs.get(previous.tabId);
      stopped ||= !tab.active || Boolean(tab.discarded);
    } catch { stopped = true; }
    if (!stopped && owner) return { success: false, epoch, snapshots: [] };
  }
  if (!await eligible(candidate, url)) {
    await persist();
    return { success: false, epoch, snapshots: [] };
  }
  owner = candidate;
  epoch++;
  await persist();
  return { success: true, epoch, snapshots };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const candidate = identity(sender);
  if (!candidate || !["ACQUIRE_LEASE", "HEARTBEAT_SNAPSHOT", "YIELD_LEASE"].includes(message?.type)) return;
  let operation: Promise<unknown>;
  if (message.type === "ACQUIRE_LEASE") {
    operation = acquireTail.catch(() => undefined).then(() => acquire(candidate, sender.url));
    acquireTail = operation;
  } else operation = loadState().then(async () => {
    const valid = sameDocument(owner, candidate) && message.epoch === epoch;
    if (valid) {
      accept(message.submission);
      if (message.type === "YIELD_LEASE") {
        owner = null;
        if (pendingTransfer && sameDocument(pendingTransfer.owner, candidate) && pendingTransfer.epoch === epoch) {
          pendingTransfer.finish(true);
        }
        await persist();
      } else if (Date.now() - persistedAt >= 5000) await persist();
    }
    return { success: true, leaseValid: valid, epoch };
  });
  void operation.then(respond).catch((error: unknown) => {
    console.warn("[Web Mascot] relay operation failed", error);
    respond({ success: false, leaseValid: false, epoch });
  });
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  void loadState().then(async () => {
    if (changes.enabled) settings.enabled = Boolean(changes.enabled.newValue);
    if (changes.mascotMode) settings.mascotMode = typeof changes.mascotMode.newValue === "string" ? changes.mascotMode.newValue : "both";
    if (changes.blacklist) settings.blacklist = Array.isArray(changes.blacklist.newValue) ? changes.blacklist.newValue : [];
    if (!settings.enabled) {
      const previous = owner;
      const previousEpoch = epoch;
      owner = null;
      snapshots = [];
      if (pendingTransfer) pendingTransfer.finish(true);
      if (previous) void chrome.tabs.sendMessage(previous.tabId,
        { type: "PREPARE_TRANSFER", epoch: previousEpoch }, { documentId: previous.documentId }).catch(() => undefined);
      await persist();
    }
  }).catch((error: unknown) => console.warn("[Web Mascot] settings update failed", error));
});

// Browser activation also covers focus returning from popup.
function wakeFocusedTab(): void {
  void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
    if (tabs[0]?.id !== undefined) void chrome.tabs.sendMessage(tabs[0].id,
      { type: "ACQUIRE_IF_FOCUSED" }).catch(() => undefined);
  });
}
chrome.tabs.onActivated.addListener(() => wakeFocusedTab());
chrome.tabs.onRemoved.addListener((tabId) => {
  void loadState().then(async () => {
    if (owner?.tabId === tabId) {
      owner = null;
      pendingTransfer?.finish(true);
      await persist();
    }
    wakeFocusedTab();
  }).catch((error: unknown) => console.warn("[Web Mascot] tab removal failed", error));
});
chrome.windows.onRemoved.addListener(wakeFocusedTab);
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) wakeFocusedTab();
});
