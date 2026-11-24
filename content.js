'use strict';

(() => {
  const SETTINGS_KEY = 'eh_settings';

  const DEFAULT_CONTENT_SETTINGS = {
    settingsVersion: 3,
    enableShortcutCopy: true,
    enableMirrorRedirect: false,
    enableExCookieManager: true,
    autoRedirectUnavailableToEx: true,
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
  let settingsLoaded = false;
  let pageCheckExecuted = false;

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

  function sendBgMessage(payload) {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve(null);
        return;
      }
      chrome.runtime.sendMessage(payload, (resp) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(resp);
      });
    });
  }

  function isUnavailableEhGalleryPage(doc) {
    if (!doc || !doc.body) return false;
    if (doc.querySelector('#gdt, .gm, #i1')) return false;
    const noticeBox = doc.querySelector('.d');
    const text = noticeBox ? noticeBox.textContent || '' : doc.body.textContent || '';
    return (
      text.includes('This gallery has been removed or is unavailable') ||
      text.includes('This page is not available')
    );
  }

  function isSadPandaDocument(doc) {
    if (!doc) return false;
    const ct = String(doc.contentType || '').toLowerCase();
    if (ct.startsWith('image/')) return true;
    if (!doc.body) return false;
    if (doc.querySelector('.ido, .gm, .itg, #nb, #i1')) return false;
    const children = doc.body.children;
    if (
      children &&
      children.length === 1 &&
      children[0].tagName === 'IMG' &&
      !(doc.body.textContent || '').trim()
    ) {
      return true;
    }
    return false;
  }

  function buildInnerSiteTargetUrl(rawUrl, settings) {
    try {
      const u = new URL(rawUrl);
      const mirror = normalizeDomain(settings && settings.mirrorDomain);
      const targetHost =
        settings && settings.enableMirrorRedirect && mirror ? mirror : 'exhentai.org';
      u.protocol = 'https:';
      u.hostname = targetHost;
      u.port = '';
      return { url: u.toString(), targetHost };
    } catch {
      return null;
    }
  }

  async function handleUnavailableEhGallery() {
    const path = window.location.pathname || '';
    const isGalleryOrPage =
      /^\/g\/\d+\/[0-9a-f]{10}/i.test(path) || /^\/s\/[0-9a-f]{10}\/\d+-\d+/i.test(path);
    if (!isGalleryOrPage) return;
    if (!isUnavailableEhGalleryPage(document)) return;

    const target = buildInnerSiteTargetUrl(window.location.href, currentSettings);
    if (!target) return;

    const dedupKey = `eh_toolkit_unavail_jump_${path}`;
    let alreadyJumped = false;
    try {
      alreadyJumped = sessionStorage.getItem(dedupKey) === '1';
    } catch {
      alreadyJumped = false;
    }

    const noticeEl = document.querySelector('.d') || document.body;
    if (noticeEl && !document.getElementById('eh-toolkit-jump-ex-btn')) {
      const wrap = document.createElement('div');
      wrap.style.marginTop = '12px';
      const btn = document.createElement('button');
      btn.id = 'eh-toolkit-jump-ex-btn';
      btn.textContent = `在里站 (${target.targetHost}) 打开此画廊`;
      Object.assign(btn.style, {
        padding: '8px 14px',
        borderRadius: '7px',
        border: '1px solid #3b82f6',
        background: '#2563eb',
        color: '#ffffff',
        fontSize: '13px',
        fontWeight: '600',
        cursor: 'pointer'
      });
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '正在同步里站 Cookie 并跳转...';
        await sendBgMessage({ type: 'EH_ENSURE_EX_COOKIES' });
        window.location.href = target.url;
      });
      wrap.appendChild(btn);
      noticeEl.appendChild(wrap);
    }

    if (currentSettings.autoRedirectUnavailableToEx && !alreadyJumped) {
      try {
        sessionStorage.setItem(dedupKey, '1');
      } catch {
        // Ignore storage errors
      }
      showToast(
        `该画廊在表站不可见，正在同步 Cookie 并跳转至 ${target.targetHost}...`,
        target.url,
        false
      );
      await sendBgMessage({ type: 'EH_ENSURE_EX_COOKIES' });
      window.location.replace(target.url);
    }
  }

  function renderSadPandaHelper() {
    if (document.getElementById('eh-sad-panda-helper')) return;

    const card = document.createElement('div');
    card.id = 'eh-sad-panda-helper';
    Object.assign(card.style, {
      position: 'fixed',
      top: '18px',
      right: '18px',
      zIndex: '2147483647',
      maxWidth: '380px',
      padding: '14px 16px',
      borderRadius: '12px',
      background: 'rgba(15, 23, 42, 0.96)',
      color: '#f8fafc',
      border: '1px solid rgba(245, 158, 11, 0.8)',
      boxShadow: '0 14px 32px rgba(0,0,0,0.55)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '13px',
      lineHeight: '1.5'
    });

    const title = document.createElement('div');
    title.textContent = '检测到 ExHentai Sad Panda（里站访问受限）';
    Object.assign(title.style, {
      fontWeight: '700',
      color: '#fbbf24',
      marginBottom: '6px',
      fontSize: '14px'
    });

    const desc = document.createElement('div');
    desc.textContent =
      '可能原因：尚未同步表站登录 Cookie，或当前代理节点需要配置有效的 igneous 通行证。';
    Object.assign(desc.style, {
      color: '#cbd5e1',
      fontSize: '12px',
      marginBottom: '10px'
    });

    const statusLine = document.createElement('div');
    Object.assign(statusLine.style, {
      color: '#93c5fd',
      fontSize: '12px',
      marginBottom: '8px',
      display: 'none'
    });

    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, {
      display: 'flex',
      gap: '8px',
      flexWrap: 'wrap'
    });

    const syncBtn = document.createElement('button');
    syncBtn.textContent = '一键同步表站 Cookie 并刷新';
    Object.assign(syncBtn.style, {
      padding: '6px 11px',
      borderRadius: '7px',
      border: 'none',
      background: '#3b82f6',
      color: '#fff',
      fontSize: '12px',
      fontWeight: '600',
      cursor: 'pointer'
    });
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = '正在同步...';
      const resp = await sendBgMessage({ type: 'EH_SYNC_COOKIES_FROM_EH' });
      const st = resp && resp.cookieStatus;
      statusLine.style.display = 'block';
      if (st && st.exReady) {
        statusLine.style.color = '#34d399';
        statusLine.textContent = '已写入 Cookie 并清理 Sad Panda 缓存，正在刷新页面...';
        setTimeout(() => window.location.reload(), 400);
      } else {
        syncBtn.disabled = false;
        syncBtn.textContent = '重试同步';
        statusLine.style.color = '#fca5a5';
        statusLine.textContent =
          '未在表站检测到登录状态，请先登录 e-hentai.org 或点击右侧按钮手动填写 Cookie（含 igneous）。';
      }
    });

    const cfgBtn = document.createElement('button');
    cfgBtn.textContent = '打开控制台配置 Cookie';
    Object.assign(cfgBtn.style, {
      padding: '6px 11px',
      borderRadius: '7px',
      border: '1px solid #475569',
      background: 'rgba(148, 163, 184, 0.16)',
      color: '#e2e8f0',
      fontSize: '12px',
      fontWeight: '600',
      cursor: 'pointer'
    });
    cfgBtn.addEventListener('click', () => {
      sendBgMessage({ type: 'EH_OPEN_DASHBOARD', hash: 'cookies' });
    });

    btnRow.appendChild(syncBtn);
    btnRow.appendChild(cfgBtn);
    card.appendChild(title);
    card.appendChild(desc);
    card.appendChild(statusLine);
    card.appendChild(btnRow);
    (document.body || document.documentElement).appendChild(card);
  }

  function maybeRunPageEnhancements() {
    if (pageCheckExecuted || !settingsLoaded) return;
    if (document.readyState === 'loading') return;
    pageCheckExecuted = true;

    const kind = classifyHost(window.location.hostname, currentSettings);
    if (kind === 'e-hentai') {
      handleUnavailableEhGallery();
    } else if (kind === 'exhentai' && isSadPandaDocument(document)) {
      renderSadPandaHelper();
    }
  }

  function loadSettings() {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'EH_GET_SETTINGS' }, (resp) => {
        if (!chrome.runtime.lastError && resp && resp.ok && resp.settings) {
          currentSettings = { ...DEFAULT_CONTENT_SETTINGS, ...resp.settings };
          settingsLoaded = true;
          maybeRunPageEnhancements();
          return;
        }
        if (chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(SETTINGS_KEY, (res) => {
            if (res && res[SETTINGS_KEY]) {
              currentSettings = { ...DEFAULT_CONTENT_SETTINGS, ...res[SETTINGS_KEY] };
            }
            settingsLoaded = true;
            maybeRunPageEnhancements();
          });
        } else {
          settingsLoaded = true;
          maybeRunPageEnhancements();
        }
      });
      return;
    }
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(SETTINGS_KEY, (res) => {
        if (res && res[SETTINGS_KEY]) {
          currentSettings = { ...DEFAULT_CONTENT_SETTINGS, ...res[SETTINGS_KEY] };
        }
        settingsLoaded = true;
        maybeRunPageEnhancements();
      });
      return;
    }
    settingsLoaded = true;
    maybeRunPageEnhancements();
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    loadSettings();
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', maybeRunPageEnhancements, { once: true });
    } else {
      maybeRunPageEnhancements();
    }

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
      matchesShortcut,
      isUnavailableEhGalleryPage,
      isSadPandaDocument,
      buildInnerSiteTargetUrl
    };
  }
})();
