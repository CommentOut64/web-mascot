document.addEventListener("DOMContentLoaded", () => {
  const versionBadge = document.getElementById("version-badge");
  const enabledToggle = document.getElementById("enabled-toggle") as HTMLInputElement | null;
  const clickthroughToggle = document.getElementById("clickthrough-toggle") as HTMLInputElement | null;
  const debuglogToggle = document.getElementById("debuglog-toggle") as HTMLInputElement | null;
  const scrollToggle = document.getElementById("scroll-toggle") as HTMLInputElement | null;
  const autohideScrollbarToggle = document.getElementById("autohide-scrollbar-toggle") as HTMLInputElement | null;
  const modeRadios = document.querySelectorAll<HTMLInputElement>('input[name="mode"]');
  const btnRestart = document.getElementById("btn-restart") as HTMLButtonElement | null;
  const btnResetPos = document.getElementById("btn-reset-pos") as HTMLButtonElement | null;

  // Site control
  const hostLabel = document.getElementById("current-hostname") as HTMLElement | null;
  const btnBlacklist = document.getElementById("btn-toggle-blacklist") as HTMLButtonElement | null;
  const btnBlacklistText = document.getElementById("btn-blacklist-text") as HTMLElement | null;

  let currentHostname = "";
  let isProtectedPage = false;
  let blacklistHosts: string[] = [];

  // Set version from extension manifest
  try {
    const manifest = chrome.runtime.getManifest();
    if (manifest && versionBadge) {
      versionBadge.textContent = `v${manifest.version}`;
    }
  } catch {
    // Fallback
  }

  // Detect active tab and domain
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const urlStr = tabs[0]?.url || "";
    if (
      urlStr.startsWith("chrome://") ||
      urlStr.startsWith("edge://") ||
      urlStr.startsWith("about:") ||
      urlStr.includes("chromewebstore.google.com") ||
      urlStr.includes("microsoftedge.microsoft.com")
    ) {
      isProtectedPage = true;
      if (hostLabel) hostLabel.textContent = "浏览器保护页面";
      if (btnBlacklist) {
        btnBlacklist.disabled = true;
        if (btnBlacklistText) btnBlacklistText.textContent = "内核禁止注入";
      }
      return;
    }

    try {
      const url = new URL(urlStr);
      currentHostname = url.hostname;
      if (hostLabel) hostLabel.textContent = currentHostname || "本地页面";
      updateBlacklistButton();
    } catch {
      if (hostLabel) hostLabel.textContent = "无法识别的网址";
      if (btnBlacklist) btnBlacklist.disabled = true;
    }
  });

  function updateBlacklistButton(): void {
    if (isProtectedPage || !currentHostname || !btnBlacklist || !btnBlacklistText) return;
    const isBlacklisted = blacklistHosts.includes(currentHostname);
    if (isBlacklisted) {
      btnBlacklistText.textContent = "移出黑名单 (恢复)";
      btnBlacklist.className = "btn btn-sm btn-whitelisted";
    } else {
      btnBlacklistText.textContent = "禁用当前网站";
      btnBlacklist.className = "btn btn-sm btn-blacklist";
    }
    btnBlacklist.disabled = false;
  }

  // Read saved settings
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
      if (enabledToggle) enabledToggle.checked = Boolean(items.enabled);
      if (clickthroughToggle) clickthroughToggle.checked = Boolean(items.clickThrough);
      if (debuglogToggle) debuglogToggle.checked = Boolean(items.debugLog);
      if (scrollToggle) scrollToggle.checked = Boolean(items.scrollInteraction);
      if (autohideScrollbarToggle) autohideScrollbarToggle.checked = Boolean(items.autoHideScrollbar);
      blacklistHosts = Array.isArray(items.blacklist) ? items.blacklist : [];

      modeRadios.forEach((radio) => {
        radio.checked = radio.value === items.mascotMode;
      });

      updateBlacklistButton();
    }
  );

  // Handle blacklist toggle
  btnBlacklist?.addEventListener("click", () => {
    if (!currentHostname || isProtectedPage) return;
    const index = blacklistHosts.indexOf(currentHostname);
    if (index >= 0) {
      blacklistHosts.splice(index, 1);
    } else {
      blacklistHosts.push(currentHostname);
    }
    chrome.storage.local.set({ blacklist: [...blacklistHosts] }, () => {
      updateBlacklistButton();
    });
  });

  // Handle enable/disable toggle
  enabledToggle?.addEventListener("change", () => {
    chrome.storage.local.set({ enabled: enabledToggle.checked });
  });

  // Handle click-through toggle
  clickthroughToggle?.addEventListener("change", () => {
    chrome.storage.local.set({ clickThrough: clickthroughToggle.checked });
  });

  // Handle debug log toggle
  debuglogToggle?.addEventListener("change", () => {
    chrome.storage.local.set({ debugLog: debuglogToggle.checked });
  });

  // Handle scroll interaction toggle (experimental)
  scrollToggle?.addEventListener("change", () => {
    chrome.storage.local.set({ scrollInteraction: scrollToggle.checked });
  });

  // Handle auto hide scrollbar toggle
  autohideScrollbarToggle?.addEventListener("change", () => {
    chrome.storage.local.set({ autoHideScrollbar: autohideScrollbarToggle.checked });
  });

  // Handle mascot mode selection
  modeRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        chrome.storage.local.set({ mascotMode: radio.value });
      }
    });
  });

  // Handle restart button
  btnRestart?.addEventListener("click", () => {
    const originalText = btnRestart.textContent || "🔄 重启全部桌宠";
    btnRestart.disabled = true;
    btnRestart.textContent = "正在重启...";

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTabId = tabs[0]?.id;
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, { type: "RESTART" }, () => {
          setTimeout(() => {
            btnRestart.disabled = false;
            btnRestart.textContent = "已重启！";
            setTimeout(() => {
              btnRestart.textContent = originalText;
            }, 1000);
          }, 300);
        });
      } else {
        btnRestart.disabled = false;
        btnRestart.textContent = originalText;
      }
    });
  });

  // Handle reset position button
  btnResetPos?.addEventListener("click", () => {
    const originalText = btnResetPos.textContent || "📍 重置宠物位置";
    btnResetPos.disabled = true;
    btnResetPos.textContent = "正在落位...";

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTabId = tabs[0]?.id;
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, { type: "RESET_POSITION" }, () => {
          setTimeout(() => {
            btnResetPos.disabled = false;
            btnResetPos.textContent = "已落位！";
            setTimeout(() => {
              btnResetPos.textContent = originalText;
            }, 1000);
          }, 300);
        });
      } else {
        btnResetPos.disabled = false;
        btnResetPos.textContent = originalText;
      }
    });
  });
});
