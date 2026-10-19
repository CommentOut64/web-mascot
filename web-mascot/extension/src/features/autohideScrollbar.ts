/**
 * 自动探测与隐藏页面滚动条管理模块 (独立辅助功能)
 */
export type ScrollbarLogger = (msg: string, ...details: unknown[]) => void;

const SCROLLBAR_STYLE_ID = "__web_mascot_hide_scrollbar_style__";
const SCROLLBAR_HIDE_CLASS = "__web_mascot_hide_scrollbar__";
let scrollbarObserver: ResizeObserver | null = null;
let scrollbarResizeTimer: number | null = null;
let isAutoHideScrollbarActive = false;
let currentLogger: ScrollbarLogger | null = null;
let resizeListenerInstalled = false;

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
export function hasPageScrollbars(): boolean {
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

export function applyScrollbarHiding(hide: boolean): void {
  ensureScrollbarStyle();
  if (hide) {
    document.documentElement.classList.add(SCROLLBAR_HIDE_CLASS);
  } else {
    document.documentElement.classList.remove(SCROLLBAR_HIDE_CLASS);
  }
}

function handleResize(): void {
  if (!isAutoHideScrollbarActive) return;
  if (scrollbarResizeTimer !== null) {
    window.clearTimeout(scrollbarResizeTimer);
  }
  scrollbarResizeTimer = window.setTimeout(() => {
    scrollbarResizeTimer = null;
    if (isAutoHideScrollbarActive) {
      if (hasPageScrollbars()) {
        applyScrollbarHiding(true);
      } else {
        applyScrollbarHiding(false);
      }
    }
  }, 200);
}

export function checkAndApplyScrollbar(enabled: boolean, logger?: ScrollbarLogger): void {
  isAutoHideScrollbarActive = enabled;
  if (logger) currentLogger = logger;

  if (!enabled) {
    applyScrollbarHiding(false);
    if (scrollbarObserver) {
      scrollbarObserver.disconnect();
      scrollbarObserver = null;
    }
    return;
  }

  if (!resizeListenerInstalled) {
    window.addEventListener("resize", handleResize);
    resizeListenerInstalled = true;
  }

  // 立即执行一次静态探测
  const hasScroll = hasPageScrollbars();
  if (hasScroll) {
    applyScrollbarHiding(true);
    currentLogger?.("探测到页面存在滚动条，已自动应用持久隐藏");
  } else {
    currentLogger?.("页面当前无可见滚动条，跳过隐藏");
  }

  // 为应对 SPA 动态异步加载内容，挂载轻量 ResizeObserver 监听内容高度变化
  if (!scrollbarObserver && window.ResizeObserver && document.body) {
    scrollbarObserver = new ResizeObserver(() => {
      if (!isAutoHideScrollbarActive) return;
      if (!document.documentElement.classList.contains(SCROLLBAR_HIDE_CLASS)) {
        if (hasPageScrollbars()) {
          applyScrollbarHiding(true);
          currentLogger?.("动态探测到页面出现滚动条，已自动应用持久隐藏");
        }
      }
    });
    scrollbarObserver.observe(document.body);
  }
}

export function cleanupScrollbar(): void {
  isAutoHideScrollbarActive = false;
  applyScrollbarHiding(false);
  if (scrollbarObserver) {
    scrollbarObserver.disconnect();
    scrollbarObserver = null;
  }
  if (scrollbarResizeTimer !== null) {
    window.clearTimeout(scrollbarResizeTimer);
    scrollbarResizeTimer = null;
  }
  if (resizeListenerInstalled) {
    window.removeEventListener("resize", handleResize);
    resizeListenerInstalled = false;
  }
}

