'use strict';

(() => {
  const DEFAULT_SHORTCUT = {
    altKey: true,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    code: 'KeyC',
    key: 'c',
    label: 'Alt + C'
  };

  let settings = null;
  let fileDefaults = null;
  let convertedTargetUrl = '';

  const els = {
    openDashboardBtn: document.getElementById('openDashboardBtn'),
    currentSiteBadge: document.getElementById('currentSiteBadge'),
    copyStatusText: document.getElementById('copyStatusText'),
    currentUrlText: document.getElementById('currentUrlText'),
    convertedUrlText: document.getElementById('convertedUrlText'),
    quickCopyBtn: document.getElementById('quickCopyBtn'),
    enableFavTransfer: document.getElementById('enableFavTransfer'),
    enableTagStats: document.getElementById('enableTagStats'),
    tagStatsPopupDesc: document.getElementById('tagStatsPopupDesc'),
    enableMirrorRedirect: document.getElementById('enableMirrorRedirect'),
    mirrorDomain: document.getElementById('mirrorDomain'),
    mirrorSourceScope: document.getElementById('mirrorSourceScope'),
    enableShortcutCopy: document.getElementById('enableShortcutCopy'),
    copyTargetDomain: document.getElementById('copyTargetDomain'),
    shortcutInput: document.getElementById('shortcutInput'),
    resetShortcutBtn: document.getElementById('resetShortcutBtn'),
    mirrorCopyTargetRow: document.getElementById('mirrorCopyTargetRow'),
    mirrorCopyTarget: document.getElementById('mirrorCopyTarget'),
    openBrowserShortcutsBtn: document.getElementById('openBrowserShortcutsBtn'),
    enableDomainSwapRedirect: document.getElementById('enableDomainSwapRedirect'),
    domainSwapRedirectMode: document.getElementById('domainSwapRedirectMode'),
    redirectPriority: document.getElementById('redirectPriority'),
    redirectExternalOnly: document.getElementById('redirectExternalOnly')
  };

  function sendMessage(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (resp) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(resp);
      });
    });
  }

  function getMetaLabel() {
    const p = (navigator.platform || '').toLowerCase();
    if (p.includes('mac')) return 'Cmd';
    if (p.includes('win')) return 'Win';
    return 'Meta';
  }

  function formatShortcutFromEvent(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push(getMetaLabel());

    let keyLabel = '';
    if (e.code && e.code.startsWith('Key')) {
      keyLabel = e.code.slice(3);
    } else if (e.code && e.code.startsWith('Digit')) {
      keyLabel = e.code.slice(5);
    } else if (e.key && e.key.length === 1) {
      keyLabel = e.key.toUpperCase();
    } else {
      keyLabel = e.code || e.key;
    }

    parts.push(keyLabel);
    return parts.join(' + ');
  }

  function isModifierKey(e) {
    return [
      'Control',
      'Alt',
      'AltGraph',
      'Shift',
      'Meta',
      'OS',
      'Super',
      'Hyper'
    ].includes(e.key);
  }

  function renderSettings() {
    if (!settings) return;
    els.enableFavTransfer.checked = Boolean(settings.enableFavTransfer);
    els.enableTagStats.checked = Boolean(settings.enableTagStats);
    if (els.tagStatsPopupDesc) {
      const label = settings.highlightTagLabel || 'female:stocking(s)';
      els.tagStatsPopupDesc.textContent = `去重列出 artist/group/parody 与 ${label}`;
    }
    els.enableMirrorRedirect.checked = Boolean(settings.enableMirrorRedirect);
    els.mirrorDomain.value = settings.mirrorDomain || '';
    els.mirrorSourceScope.value = settings.mirrorSourceScope || 'both';
    els.enableShortcutCopy.checked = Boolean(settings.enableShortcutCopy);
    els.copyTargetDomain.value = settings.copyTargetDomain || 'exhentai.org';
    els.shortcutInput.value =
      (settings.customShortcut && settings.customShortcut.label) || 'Alt + C';
    els.mirrorCopyTarget.value = settings.mirrorCopyTarget || 'exhentai.org';
    els.mirrorCopyTargetRow.classList.toggle(
      'hidden',
      els.copyTargetDomain.value !== 'swap'
    );
    els.enableDomainSwapRedirect.checked = Boolean(settings.enableDomainSwapRedirect);
    els.domainSwapRedirectMode.value = settings.domainSwapRedirectMode || 'e2ex';
    els.redirectPriority.value = settings.redirectPriority || 'mirror';
    els.redirectExternalOnly.checked = Boolean(settings.redirectExternalOnly);
  }

  async function persistPartial(partial) {
    const resp = await sendMessage({ type: 'EH_SAVE_SETTINGS', settings: partial });
    if (resp && resp.ok && resp.settings) {
      settings = resp.settings;
      if (resp.fileDefaults) fileDefaults = resp.fileDefaults;
      renderSettings();
      await refreshActiveTabPreview();
    }
  }

  async function refreshActiveTabPreview() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.url) {
      els.currentSiteBadge.textContent = '无活动页面';
      els.currentSiteBadge.classList.add('inactive');
      els.currentUrlText.textContent = '-';
      els.convertedUrlText.textContent = '-';
      els.quickCopyBtn.disabled = true;
      convertedTargetUrl = '';
      return;
    }

    els.currentUrlText.textContent = tab.url;
    const resp = await sendMessage({ type: 'EH_CONVERT_URL', url: tab.url });
    const converted = resp && resp.converted;

    if (!converted) {
      els.currentSiteBadge.textContent = '非 EH/镜像站页面';
      els.currentSiteBadge.classList.add('inactive');
      els.convertedUrlText.textContent = '仅在 e-hentai / exhentai / 镜像站页面生效';
      els.quickCopyBtn.disabled = true;
      convertedTargetUrl = '';
      return;
    }

    const kindLabelMap = {
      'e-hentai': '当前：E-Hentai 表站',
      exhentai: '当前：ExHentai 里站',
      mirror: '当前：镜像站'
    };
    const baseLabel = kindLabelMap[converted.sourceKind] || '已识别页面';
    els.currentSiteBadge.textContent = converted.unchanged
      ? `${baseLabel} (已是目标域名)`
      : baseLabel;
    els.currentSiteBadge.classList.remove('inactive');
    els.convertedUrlText.textContent = converted.convertedUrl;
    convertedTargetUrl = converted.convertedUrl;
    els.quickCopyBtn.disabled = false;
  }

  async function openDashboard(hash) {
    const dashboardUrl = chrome.runtime.getURL('dashboard.html') + (hash ? `#${hash}` : '');
    const basePrefix = chrome.runtime.getURL('dashboard.html');
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((t) => t.url && t.url.startsWith(basePrefix));
    if (existing && existing.id) {
      await chrome.tabs.update(existing.id, { url: dashboardUrl, active: true });
      if (existing.windowId) {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
    } else {
      await chrome.tabs.create({ url: dashboardUrl });
    }
    window.close();
  }

  function bindEvents() {
    els.openDashboardBtn.addEventListener('click', () => openDashboard(''));

    document.querySelectorAll('[data-open-tab]').forEach((btn) => {
      btn.addEventListener('click', () => openDashboard(btn.getAttribute('data-open-tab')));
    });

    els.quickCopyBtn.addEventListener('click', async () => {
      if (!convertedTargetUrl) return;
      try {
        await navigator.clipboard.writeText(convertedTargetUrl);
        els.copyStatusText.textContent = '已复制到剪贴板！';
        sendMessage({ type: 'EH_NOTIFY_BADGE', text: 'OK', color: '#10b981' });
        setTimeout(() => {
          els.copyStatusText.textContent = '';
        }, 2500);
      } catch {
        els.copyStatusText.textContent = '复制失败';
      }
    });

    const toggleIds = [
      'enableFavTransfer',
      'enableTagStats',
      'enableMirrorRedirect',
      'enableShortcutCopy',
      'enableDomainSwapRedirect',
      'redirectExternalOnly'
    ];
    toggleIds.forEach((id) => {
      els[id].addEventListener('change', () => {
        persistPartial({ [id]: els[id].checked });
      });
    });

    const selectIds = [
      'mirrorSourceScope',
      'copyTargetDomain',
      'mirrorCopyTarget',
      'domainSwapRedirectMode',
      'redirectPriority'
    ];
    selectIds.forEach((id) => {
      els[id].addEventListener('change', () => {
        persistPartial({ [id]: els[id].value });
      });
    });

    let mirrorTimer = null;
    els.mirrorDomain.addEventListener('input', () => {
      clearTimeout(mirrorTimer);
      mirrorTimer = setTimeout(() => {
        persistPartial({ mirrorDomain: els.mirrorDomain.value });
      }, 350);
    });
    els.mirrorDomain.addEventListener('blur', () => {
      clearTimeout(mirrorTimer);
      persistPartial({ mirrorDomain: els.mirrorDomain.value });
    });

    // Shortcut recorder
    let isRecording = false;
    els.shortcutInput.addEventListener('focus', () => {
      isRecording = true;
      els.shortcutInput.classList.add('recording');
      els.shortcutInput.value = '请按下新快捷键 (Esc取消)';
    });

    els.shortcutInput.addEventListener('blur', () => {
      if (isRecording) {
        isRecording = false;
        els.shortcutInput.classList.remove('recording');
        renderSettings();
      }
    });

    els.shortcutInput.addEventListener('keydown', (e) => {
      if (!isRecording) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        isRecording = false;
        els.shortcutInput.classList.remove('recording');
        renderSettings();
        els.shortcutInput.blur();
        return;
      }

      if (isModifierKey(e)) return;

      const shortcut = {
        altKey: Boolean(e.altKey),
        ctrlKey: Boolean(e.ctrlKey),
        shiftKey: Boolean(e.shiftKey),
        metaKey: Boolean(e.metaKey),
        code: e.code || '',
        key: e.key || '',
        label: formatShortcutFromEvent(e)
      };

      isRecording = false;
      els.shortcutInput.classList.remove('recording');
      els.shortcutInput.blur();
      persistPartial({ customShortcut: shortcut });
    });

    els.resetShortcutBtn.addEventListener('click', () => {
      const targetShortcut =
        (fileDefaults && fileDefaults.customShortcut) || DEFAULT_SHORTCUT;
      persistPartial({ customShortcut: { ...targetShortcut } });
    });

    els.openBrowserShortcutsBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  }

  async function init() {
    const resp = await sendMessage({ type: 'EH_GET_SETTINGS' });
    settings = resp && resp.settings ? resp.settings : {};
    fileDefaults = resp && resp.fileDefaults ? resp.fileDefaults : null;
    renderSettings();
    bindEvents();
    await refreshActiveTabPreview();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
