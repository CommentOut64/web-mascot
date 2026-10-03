type PageListener = (owner: boolean) => void;

type PageState = {
  id: string;
  visible: boolean;
  focusedAt: number;
  sentAt: number;
};

type PageMessage = { type: "state"; state: PageState } | { type: "leave"; id: string };

type KnownPage = PageState & { seenAt: number };

const CHANNEL_NAME = "neurolingsce-mascot-page-v1";
const STORAGE_PREFIX = "__neurolingsce_mascot_page_v1__:";
const HEARTBEAT_MS = 1500;
const LEASE_MS = HEARTBEAT_MS * 3;
const pageId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const listeners = new Set<PageListener>();
const pages = new Map<string, KnownPage>();

let channel: BroadcastChannel | null = null;
let transport: "broadcast" | "storage" | "none" = "none";
let heartbeat = 0;
let focusedAt = 0;
let pageHidden = false;
let currentOwner = true;
let started = false;

const storageKey = `${STORAGE_PREFIX}${pageId}`;

function readState(value: string | null): PageState | null {
  if (!value) return null;
  try {
    const state: unknown = JSON.parse(value);
    if (!state || typeof state !== "object") return null;
    const candidate = state as Partial<PageState>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.visible !== "boolean" ||
      typeof candidate.focusedAt !== "number" ||
      typeof candidate.sentAt !== "number"
    ) return null;
    return candidate as PageState;
  } catch {
    return null;
  }
}

function notifyOwner(owner: boolean) {
  if (currentOwner === owner) return;
  currentOwner = owner;
  for (const listener of listeners) listener(owner);
}

function electOwner() {
  if (transport === "none") {
    notifyOwner(true);
    return;
  }

  const now = Date.now();
  for (const [id, page] of pages) {
    if (now - page.seenAt > LEASE_MS) pages.delete(id);
  }

  const candidates = Array.from(pages.values()).filter((page) => page.visible);
  candidates.sort((a, b) => b.focusedAt - a.focusedAt || a.id.localeCompare(b.id));
  notifyOwner(candidates[0]?.id === pageId);
}

function acceptState(state: PageState, seenAt = Date.now()) {
  if (state.id === pageId) return;
  const previous = pages.get(state.id);
  if (previous && previous.sentAt >= state.sentAt) return;
  pages.set(state.id, { ...state, seenAt });
  electOwner();
}

function receive(message: PageMessage) {
  if (message.type === "leave") {
    pages.delete(message.id);
    electOwner();
  } else {
    acceptState(message.state);
  }
}

function broadcast(message: PageMessage) {
  if (transport === "broadcast") {
    try {
      channel?.postMessage(message);
      return;
    } catch {
      transport = "none";
    }
  } else if (transport === "storage") {
    try {
      if (message.type === "leave") {
        localStorage.removeItem(storageKey);
      } else {
        localStorage.setItem(storageKey, JSON.stringify(message.state));
      }
      return;
    } catch {
      transport = "none";
    }
  }
  electOwner();
}

function announce() {
  const now = Date.now();
  const visible = !pageHidden && document.visibilityState === "visible";
  if (visible && document.hasFocus()) focusedAt = now;
  const state: PageState = { id: pageId, visible, focusedAt, sentAt: now };
  pages.set(pageId, { ...state, seenAt: now });
  broadcast({ type: "state", state });
  electOwner();
}

function leave() {
  pages.delete(pageId);
  broadcast({ type: "leave", id: pageId });
  electOwner();
}

function onStorage(event: StorageEvent) {
  if (!event.key?.startsWith(STORAGE_PREFIX)) return;
  const id = event.key.slice(STORAGE_PREFIX.length);
  if (!event.newValue) {
    pages.delete(id);
    electOwner();
    return;
  }
  const state = readState(event.newValue);
  if (state) acceptState(state);
}

function onFocus() { announce(); }
function onVisibilityChange() { announce(); }
function onPageHide() {
  pageHidden = true;
  leave();
}
function onPageShow() {
  pageHidden = false;
  announce();
}

function start() {
  started = true;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener("message", (event: MessageEvent<PageMessage>) => receive(event.data));
    transport = "broadcast";
  } catch {
    try {
      transport = "storage";
      window.addEventListener("storage", onStorage);
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key?.startsWith(STORAGE_PREFIX)) continue;
        const state = readState(localStorage.getItem(key));
        if (state && Date.now() - state.sentAt <= LEASE_MS) acceptState(state, state.sentAt);
      }
    } catch {
      transport = "none";
    }
  }

  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  heartbeat = window.setInterval(announce, HEARTBEAT_MS);
  announce();
}

function stop() {
  if (!started) return;
  leave();
  started = false;
  window.clearInterval(heartbeat);
  window.removeEventListener("focus", onFocus);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("pagehide", onPageHide);
  window.removeEventListener("pageshow", onPageShow);
  window.removeEventListener("storage", onStorage);
  channel?.close();
  channel = null;
  pages.clear();
  transport = "none";
  currentOwner = true;
}

/** Register only after the page has at least one initialized mascot. */
export function registerMascotPage(listener: PageListener): () => void {
  if (!started) start();
  listeners.add(listener);
  listener(currentOwner);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}
