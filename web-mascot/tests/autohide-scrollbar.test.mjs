import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

async function bundle(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

const scrollbarCode = await bundle("extension/src/features/autohideScrollbar.ts");

function createMockEnvironment() {
  const elementsById = new Map();

  class ClassList {
    constructor() {
      this.classes = new Set();
    }
    add(cls) {
      this.classes.add(cls);
    }
    remove(cls) {
      this.classes.delete(cls);
    }
    contains(cls) {
      return this.classes.has(cls);
    }
    toString() {
      return Array.from(this.classes).join(" ");
    }
  }

  class MockNode {
    constructor(tagName = "div") {
      this.tagName = tagName.toUpperCase();
      this.id = "";
      this.textContent = "";
      this.classList = new ClassList();
      this.children = [];
      this.parentNode = null;
    }
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      if (child.id) elementsById.set(child.id, child);
      return child;
    }
    remove() {
      if (this.parentNode) {
        const idx = this.parentNode.children.indexOf(this);
        if (idx !== -1) this.parentNode.children.splice(idx, 1);
        if (this.id) elementsById.delete(this.id);
        const removed = this;
        this.parentNode = null;
        if (activeMutationObserver) {
          activeMutationObserver.trigger([{ type: "childList", removedNodes: [removed] }]);
        }
      }
    }
  }

  let activeMutationObserver = null;

  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback;
      activeMutationObserver = this;
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
    }
    disconnect() {
      if (activeMutationObserver === this) activeMutationObserver = null;
    }
    trigger(mutations) {
      this.callback(mutations);
    }
  }

  class MockResizeObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {}
    disconnect() {}
  }

  const documentElement = new MockNode("html");
  const head = new MockNode("head");
  documentElement.appendChild(head);
  const body = new MockNode("body");
  documentElement.appendChild(body);

  const docListeners = new Map();
  const winListeners = new Map();

  const mockDocument = {
    documentElement,
    head,
    body,
    readyState: "loading",
    getElementById(id) {
      return elementsById.get(id) || null;
    },
    createElement(tagName) {
      return new MockNode(tagName);
    },
    addEventListener(event, cb) {
      if (!docListeners.has(event)) docListeners.set(event, []);
      docListeners.get(event).push(cb);
    },
    removeEventListener(event, cb) {
      const arr = docListeners.get(event);
      if (arr) {
        const idx = arr.indexOf(cb);
        if (idx !== -1) arr.splice(idx, 1);
      }
    },
  };

  const mockWindow = {
    innerWidth: 1200,
    innerHeight: 800,
    MutationObserver: MockMutationObserver,
    ResizeObserver: MockResizeObserver,
    addEventListener(event, cb) {
      if (!winListeners.has(event)) winListeners.set(event, []);
      winListeners.get(event).push(cb);
    },
    removeEventListener(event, cb) {
      const arr = winListeners.get(event);
      if (arr) {
        const idx = arr.indexOf(cb);
        if (idx !== -1) arr.splice(idx, 1);
      }
    },
    getComputedStyle() {
      return { overflowY: "visible", overflowX: "visible" };
    },
  };

  const context = {
    module: { exports: {} },
    exports: {},
    document: mockDocument,
    window: mockWindow,
    HTMLElement: MockNode,
    MutationObserver: MockMutationObserver,
    ResizeObserver: MockResizeObserver,
  };

  vm.runInNewContext(scrollbarCode, context);
  const scrollbarModule = context.module.exports;

  return {
    mod: scrollbarModule,
    document: mockDocument,
    window: mockWindow,
    documentElement,
    docListeners,
    winListeners,
    getMutationObserver: () => activeMutationObserver,
  };
}

test("AutohideScrollbar: activation immediately injects style and class", () => {
  const env = createMockEnvironment();
  const { mod, documentElement, document } = env;

  mod.checkAndApplyScrollbar(true);
  assert.ok(documentElement.classList.contains("__web_mascot_hide_scrollbar__"), "html must have hide class");
  const style = document.getElementById("__web_mascot_hide_scrollbar_style__");
  assert.ok(style !== null, "style element must be injected");
  assert.ok(style.textContent.includes("scrollbar-width: none"), "must contain CSS rules");
});

test("AutohideScrollbar: deactivation removes class and style cleanly", () => {
  const env = createMockEnvironment();
  const { mod, documentElement, document } = env;

  mod.checkAndApplyScrollbar(true);
  assert.ok(documentElement.classList.contains("__web_mascot_hide_scrollbar__"));
  assert.ok(document.getElementById("__web_mascot_hide_scrollbar_style__") !== null);

  mod.checkAndApplyScrollbar(false);
  assert.equal(documentElement.classList.contains("__web_mascot_hide_scrollbar__"), false, "class must be removed");
  assert.equal(document.getElementById("__web_mascot_hide_scrollbar_style__"), null, "style must be removed");
});

test("AutohideScrollbar: self-heals when external SPA overrides html class", () => {
  const env = createMockEnvironment();
  const { mod, documentElement, getMutationObserver } = env;

  mod.checkAndApplyScrollbar(true);
  assert.ok(documentElement.classList.contains("__web_mascot_hide_scrollbar__"));

  // Simulate third-party script overriding className
  documentElement.classList.classes.clear();
  assert.equal(documentElement.classList.contains("__web_mascot_hide_scrollbar__"), false);

  // Trigger mutation observer
  const observer = getMutationObserver();
  assert.ok(observer !== null, "MutationObserver must be active");
  observer.trigger([{ type: "attributes", attributeName: "class" }]);

  assert.ok(documentElement.classList.contains("__web_mascot_hide_scrollbar__"), "class must be self-healed");
});

test("AutohideScrollbar: self-heals when external SPA removes style tag", () => {
  const env = createMockEnvironment();
  const { mod, document } = env;

  mod.checkAndApplyScrollbar(true);
  const style = document.getElementById("__web_mascot_hide_scrollbar_style__");
  assert.ok(style !== null);

  // Simulate style tag removal: the mock triggers childList mutation immediately
  style.remove();

  // MutationObserver triggers immediate re-injection
  const reInjected = document.getElementById("__web_mascot_hide_scrollbar_style__");
  assert.ok(reInjected !== null, "style tag must be re-injected automatically");
  assert.notEqual(reInjected, style, "re-injected style must be a newly created element");
});

test("AutohideScrollbar: lifecycle callbacks re-enforce state at DOMContentLoaded", () => {
  const env = createMockEnvironment();
  const { mod, documentElement, docListeners } = env;

  mod.checkAndApplyScrollbar(true);
  assert.ok(docListeners.has("DOMContentLoaded"));

  // Clear class
  documentElement.classList.classes.clear();
  assert.equal(documentElement.classList.contains("__web_mascot_hide_scrollbar__"), false);

  // Fire DOMContentLoaded
  for (const handler of docListeners.get("DOMContentLoaded")) {
    handler();
  }

  assert.ok(documentElement.classList.contains("__web_mascot_hide_scrollbar__"), "must be enforced on DOMContentLoaded");
});
