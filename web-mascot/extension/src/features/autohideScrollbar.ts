/**
 * 自动探测与持久隐藏页面滚动条管理模块 (全生命周期自愈与防失效设计)
 */
export type ScrollbarLogger = (msg: string, ...details: unknown[]) => void;

const SCROLLBAR_STYLE_ID = "__web_mascot_hide_scrollbar_style__";
const SCROLLBAR_HIDE_CLASS = "__web_mascot_hide_scrollbar__";

let isAutoHideScrollbarActive = false;
let currentLogger: ScrollbarLogger | null = null;
let domObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let isGuardRegistered = false;

/**
 * 确保隐藏滚动条的专属 CSS 样式表注入在文档顶层
 */
function ensureScrollbarStyle(): void {
  if (typeof document === "undefined") return;
  const existing = document.getElementById(SCROLLBAR_STYLE_ID);
  if (existing) return;

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

  // 优先挂载到 head；在 document_start 最早期 head 尚未闭合时，挂载到 documentElement
  const target = document.head || document.documentElement;
  if (target) {
    target.appendChild(style);
  }
}

/**
 * 探测当前页面是否存在可见或潜在的垂直/水平滚动条（辅助诊断与扩展接口）
 */
export function hasPageScrollbars(): boolean {
  if (typeof document === "undefined") return false;
  const doc = document.documentElement;
  const body = document.body;
  if (!doc) return false;

  // 1. 经典滚动条物理占据尺寸（在滚动条未被 CSS 隐藏时为硬指标）
  const physicalVScroll = window.innerWidth > doc.clientWidth;
  const physicalHScroll = window.innerHeight > doc.clientHeight;

  // 2. 页面内容尺寸溢出视口
  const overflowY =
    doc.scrollHeight > window.innerHeight + 1 ||
    (body ? body.scrollHeight > window.innerHeight + 1 : false);
  const overflowX =
    doc.scrollWidth > window.innerWidth + 1 ||
    (body ? body.scrollWidth > window.innerWidth + 1 : false);

  // 3. 计算样式是否显式开启滚动模式
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

/**
 * 应用或撤销滚动条隐藏类名与样式
 */
export function applyScrollbarHiding(hide: boolean): void {
  if (typeof document === "undefined" || !document.documentElement) return;

  if (hide) {
    ensureScrollbarStyle();
    if (!document.documentElement.classList.contains(SCROLLBAR_HIDE_CLASS)) {
      document.documentElement.classList.add(SCROLLBAR_HIDE_CLASS);
    }
  } else {
    document.documentElement.classList.remove(SCROLLBAR_HIDE_CLASS);
    const existing = document.getElementById(SCROLLBAR_STYLE_ID);
    if (existing) {
      existing.remove();
    }
  }
}

/**
 * 状态自愈强制器：确保在 SPA 路由切换、主题切换覆写 class 或 head 节点重置时，状态依然稳固
 */
function enforceState(): void {
  if (!isAutoHideScrollbarActive) return;
  applyScrollbarHiding(true);
}

/**
 * 挂载全生命周期自愈监听（DOMContentLoaded / load / MutationObserver / ResizeObserver）
 */
function setupLifecycleGuard(): void {
  if (isGuardRegistered || typeof document === "undefined") return;
  isGuardRegistered = true;

  // 1. 文档生命周期就绪回调：应对 document_start 时 DOM/head 尚不健全的初始阶段
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", enforceState, { once: true });
  }
  window.addEventListener("load", enforceState, { once: true });

  // 2. DOM 突变监控：防止 SPA（React/Vue/Next/Nuxt）或第三方脚本覆写 html.className 或移除 style
  if (typeof window !== "undefined" && window.MutationObserver && document.documentElement) {
    domObserver = new window.MutationObserver((mutations) => {
      if (!isAutoHideScrollbarActive) return;

      let needReapply = false;
      for (const mutation of mutations) {
        if (
          mutation.type === "attributes" &&
          mutation.attributeName === "class" &&
          !document.documentElement.classList.contains(SCROLLBAR_HIDE_CLASS)
        ) {
          needReapply = true;
          break;
        }
        if (mutation.type === "childList") {
          for (let i = 0; i < mutation.removedNodes.length; i++) {
            const removed = mutation.removedNodes[i];
            if (removed instanceof HTMLElement && removed.id === SCROLLBAR_STYLE_ID) {
              needReapply = true;
              break;
            }
          }
        }
        if (needReapply) break;
      }

      if (needReapply) {
        enforceState();
      }
    });

    domObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
      childList: true,
      subtree: true,
    });
  }

  // 3. 视口与根容器尺寸变化监听（动态异步渲染页面内容时确保样式生效）
  if (typeof window !== "undefined" && window.ResizeObserver && document.documentElement) {
    resizeObserver = new window.ResizeObserver(() => {
      if (!isAutoHideScrollbarActive) return;
      if (!document.documentElement.classList.contains(SCROLLBAR_HIDE_CLASS)) {
        enforceState();
      }
    });
    resizeObserver.observe(document.documentElement);
    if (document.body) {
      resizeObserver.observe(document.body);
    }
  }
}

/**
 * 外部主入口：根据用户配置开关生效或清理滚动条隐藏
 */
export function checkAndApplyScrollbar(enabled: boolean, logger?: ScrollbarLogger): void {
  isAutoHideScrollbarActive = enabled;
  if (logger) currentLogger = logger;

  if (!enabled) {
    cleanupScrollbar();
    currentLogger?.("自动隐藏滚动条已关闭 (恢复原生显示)");
    return;
  }

  // 只要用户启用了自动隐藏滚动条，立即注入样式并激活自愈守卫
  applyScrollbarHiding(true);
  setupLifecycleGuard();
  currentLogger?.("自动隐藏页面滚动条已激活并安装全生命周期自愈守卫");
}

/**
 * 用户主动禁用或注销时的清理函数
 */
export function cleanupScrollbar(): void {
  isAutoHideScrollbarActive = false;
  applyScrollbarHiding(false);

  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }

  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }

  document.removeEventListener("DOMContentLoaded", enforceState);
  window.removeEventListener("load", enforceState);
  isGuardRegistered = false;
}
