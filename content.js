'use strict';

(() => {
  const SETTINGS_KEY = 'eh_settings';

  const DEFAULT_CONTENT_SETTINGS = {
    settingsVersion: 3,
    enableShortcutCopy: true,
    copyTargetDomain: 'exhentai.org',
    mirrorDomain: '',
    mirrorCopyTarget: 'exhentai.org',
    copyDedupWindowMs: 400,
    toastDurationMs: 3200,
    toastErrorDurationMs: 7000,
    customShortcut: {
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
      code: 'KeyC',
      key: 'c',
      label: 'Alt + C'
    }
  };

  let currentSettings = { ...DEFAULT_CONTENT_SETTINGS };

  function normalizeDomain(input) {
    if (!input || typeof input !== 'string') return '';
    return input
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .split('?')[0]
      .split('#')[0]
      .replace(/:\d+$/, '')
      .replace(/\.+$/, '');
  }

  function classifyHost(hostname, settings) {
    if (!hostname || typeof hostname !== 'string') return null;
    const host = hostname.toLowerCase();
    if (host === 'e-hentai.org' || host === 'www.e-hentai.org') return 'e-hentai';
    if (host === 'exhentai.org' || host === 'www.exhentai.org') return 'exhentai';
    const mirror = normalizeDomain(settings && settings.mirrorDomain);
    if (mirror && host === mirror) return 'mirror';
    return null;
  }

  function convertUrlForCopy(rawUrl, settings) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    let url;
    try {
      url = new URL(rawUrl.trim());
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    const kind = classifyHost(url.hostname, settings);
    if (!kind) return null;

    const currentHost = url.hostname.toLowerCase();
    const copyMode =
      settings && ['exhentai.org', 'e-hentai.org', 'swap'].includes(settings.copyTargetDomain)
        ? settings.copyTargetDomain
        : 'exhentai.org';

    let targetHost = '';
    let unchanged = false;

    if (copyMode === 'exhentai.org') {
      targetHost = 'exhentai.org';
      unchanged = kind === 'exhentai' && currentHost === 'exhentai.org' && url.protocol === 'https:';
    } else if (copyMode === 'e-hentai.org') {
      targetHost = 'e-hentai.org';
      unchanged = kind === 'e-hentai' && currentHost === 'e-hentai.org' && url.protocol === 'https:';
    } else {
      if (kind === 'e-hentai') {
        targetHost = 'exhentai.org';
      } else if (kind === 'exhentai') {
        targetHost = 'e-hentai.org';
      } else if (kind === 'mirror') {
        targetHost =
          settings && settings.mirrorCopyTarget === 'e-hentai.org'
            ? 'e-hentai.org'
            : 'exhentai.org';
      }
    }

    if (!targetHost) return null;
    url.protocol = 'https:';
    url.hostname = targetHost;
    url.port = '';

    return {
      originalUrl: rawUrl,
      convertedUrl: url.toString(),
      sourceKind: kind,
      targetHost,
      unchanged
    };
  }

  function isPlainCopyShortcut(shortcut) {
    if (!shortcut) return false;
    const keyMatch =
      shortcut.code === 'KeyC' ||
      (typeof shortcut.key === 'string' && shortcut.key.toLowerCase() === 'c');
    return (
      keyMatch &&
      !shortcut.altKey &&
      !shortcut.shiftKey &&
      (Boolean(shortcut.ctrlKey) !== Boolean(shortcut.metaKey))
    );
  }

  function matchesShortcut(event, shortcut) {
    if (!event || !shortcut || event.repeat) return false;
    if (
      Boolean(event.altKey) !== Boolean(shortcut.altKey) ||
      Boolean(event.ctrlKey) !== Boolean(shortcut.ctrlKey) ||
      Boolean(event.shiftKey) !== Boolean(shortcut.shiftKey) ||
      Boolean(event.metaKey) !== Boolean(shortcut.metaKey)
    ) {
      return false;
    }
    if (shortcut.code && event.code) {
      return event.code === shortcut.code;
    }
    if (shortcut.key && event.key) {
      return event.key.toLowerCase() === shortcut.key.toLowerCase();
    }
    return false;
  }

  function isEditableTarget(target) {
    if (!target || typeof target !== 'object') return false;
    const tag = (target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return Boolean(target.isContentEditable);
  }

  function showToast(title, detailUrl, isError) {
    const existing = document.getElementById('eh-toolkit-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'eh-toolkit-toast';
    Object.assign(toast.style, {
      position: 'fixed',
      top: '16px',
      right: '16px',
      zIndex: '2147483647',
      maxWidth: '420px',
      padding: '12px 14px',
      borderRadius: '10px',
      background: isError ? 'rgba(69, 26, 3, 0.96)' : 'rgba(15, 23, 42, 0.95)',
      color: '#f8fafc',
      border: isError
        ? '1px solid rgba(245, 158, 11, 0.8)'
        : '1px solid rgba(59, 130, 246, 0.75)',
      boxShadow: '0 12px 30px rgba(0,0,0,0.45)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '13px',
      lineHeight: '1.45',
      backdropFilter: 'blur(8px)'
    });

    const titleEl = document.createElement('div');
    titleEl.textContent = title;
    titleEl.style.fontWeight = '600';
    titleEl.style.marginBottom = detailUrl ? '4px' : '0';
    titleEl.style.color = isError ? '#fbbf24' : '#60a5fa';
    toast.appendChild(titleEl);

    if (detailUrl) {
      const urlEl = document.createElement('div');
      urlEl.textContent = detailUrl;
      Object.assign(urlEl.style, {
        wordBreak: 'break-all',
        fontSize: '12px',
        color: '#e2e8f0',
        background: 'rgba(255,255,255,0.08)',
        padding: '6px 8px',
        borderRadius: '6px'
      });
      toast.appendChild(urlEl);
    }

    const durationMs = isError
      ? Number(currentSettings.toastErrorDurationMs) || 7000
      : Number(currentSettings.toastDurationMs) || 3200;

    (document.body || document.documentElement).appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, durationMs);
  }

  async function writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      (document.body || document.documentElement).appendChild(ta);
      ta.focus();
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  async function resolveCandidateUrl(selectedText) {
    if (selectedText) {
      const selectedConverted = convertUrlForCopy(selectedText, currentSettings);
      if (selectedConverted) return selectedConverted;
    }
    const pageConverted = convertUrlForCopy(window.location.href, currentSettings);
    if (pageConverted) return pageConverted;

    if (navigator.clipboard && navigator.clipboard.readText) {
      try {
        const clipText = (await navigator.clipboard.readText()).trim();
        const clipConverted = convertUrlForCopy(clipText, currentSettings);
        if (clipConverted) return clipConverted;
      } catch {
        // Ignore clipboard read denials
      }
    }
    return null;
  }

  function loadSettings() {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'EH_GET_SETTINGS' }, (resp) => {
        if (!chrome.runtime.lastError && resp && resp.ok && resp.settings) {
          currentSettings = { ...DEFAULT_CONTENT_SETTINGS, ...resp.settings };
          return;
        }
        if (chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(SETTINGS_KEY, (res) => {
            if (res && res[SETTINGS_KEY]) {
              currentSettings = { ...DEFAULT_CONTENT_SETTINGS, ...res[SETTINGS_KEY] };
            }
          });
        }
      });
      return;
    }
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(SETTINGS_KEY, (res) => {
        if (res && res[SETTINGS_KEY]) {
          currentSettings = { ...DEFAULT_CONTENT_SETTINGS, ...res[SETTINGS_KEY] };
        }
      });
    }
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    loadSettings();

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes[SETTINGS_KEY]) {
          currentSettings = {
            ...DEFAULT_CONTENT_SETTINGS,
            ...(changes[SETTINGS_KEY].newValue || {})
          };
        }
      });
    }

    window.addEventListener(
      'keydown',
      async (event) => {
        if (!currentSettings.enableShortcutCopy) return;
        if (!matchesShortcut(event, currentSettings.customShortcut)) return;
        const dedupMs = Number(currentSettings.copyDedupWindowMs) || 400;
        if (Date.now() - (window.__ehLastBgCopyAt || 0) < dedupMs) return;
        if (isEditableTarget(event.target)) return;

        const selection = window.getSelection
          ? String(window.getSelection()).trim()
          : '';

        if (isPlainCopyShortcut(currentSettings.customShortcut) && selection) {
          const selectedConverted = convertUrlForCopy(selection, currentSettings);
          if (!selectedConverted) {
            // Preserve normal Ctrl+C / Cmd+C when user selected regular text
            return;
          }
        }

        const result = await resolveCandidateUrl(selection);
        if (!result) return;

        event.preventDefault();
        event.stopPropagation();
        window.__ehLastContentCopyAt = Date.now();

        const ok = await writeClipboard(result.convertedUrl);
        if (ok) {
          showToast(
            result.unchanged ? '当前已是目标域名，已保持原链接并复制' : '已复制转换域名后的链接',
            result.convertedUrl,
            false
          );
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({
              type: 'EH_NOTIFY_BADGE',
              text: 'OK',
              color: '#10b981'
            });
          }
        } else {
          showToast('写入剪贴板失败，请手动复制', result.convertedUrl, true);
        }
      },
      true
    );
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.__EH_CONTENT_EXPORTS__ = {
      normalizeDomain,
      classifyHost,
      convertUrlForCopy,
      isPlainCopyShortcut,
      matchesShortcut
    };
  }
})();
