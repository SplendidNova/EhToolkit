'use strict';

const SETTINGS_STORAGE_KEY = 'eh_settings';
const FILE_SNAPSHOT_STORAGE_KEY = 'eh_file_settings_snapshot';
const DYNAMIC_SCRIPT_ID = 'eh_custom_mirror_content_script';
const STATIC_CONTENT_HOSTS = new Set(['e-hentai.org', 'exhentai.org']);

const DEFAULT_SETTINGS = {
  settingsVersion: 3,
  // 1. 功能开关 (features)
  enableFavTransfer: true,
  enableTagStats: true,
  enableMirrorRedirect: false,
  enableShortcutCopy: true,
  enableDomainSwapRedirect: false,

  // 2. 域名与重定向参数 (redirect)
  mirrorDomain: '',
  mirrorSourceScope: 'both', // 'both' | 'exhentai' | 'e-hentai'
  domainSwapRedirectMode: 'e2ex', // 'e2ex' | 'ex2e' | 'swap'
  redirectPriority: 'mirror', // 'mirror' | 'swap'
  redirectExternalOnly: true,
  redirectDedupWindowMs: 6000,

  // 3. 快捷键复制与提示参数 (shortcutCopy)
  copyTargetDomain: 'exhentai.org', // 'exhentai.org' | 'e-hentai.org' | 'swap'
  mirrorCopyTarget: 'exhentai.org', // 'exhentai.org' | 'e-hentai.org' (used when copyTargetDomain === 'swap')
  customShortcut: {
    altKey: true,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    code: 'KeyC',
    key: 'c',
    label: 'Alt + C'
  },
  copyDedupWindowMs: 400,
  toastDurationMs: 3200,
  toastErrorDurationMs: 7000,
  badgeClearDelayMs: 2600,

  // 4. 收藏夹读取与跨账号迁移参数 (favorites)
  defaultActiveSite: 'https://exhentai.org',
  readDelayMs: 350,
  readDelayMinMs: 100,
  importDelayMs: 400,
  importDelayMinMs: 150,
  importReverseOrder: true,
  importSkipExisting: true,
  importSaveEveryN: 10,
  favPreviewLimit: 300,

  // 5. 标签提取与去重统计参数 (tagStats)
  officialApiUrl: 'https://api.e-hentai.org/api.php',
  apiBatchSize: 25,
  tagDelayMs: 600,
  tagDelayMinMs: 200,
  tagCooldownEveryBatches: 5,
  tagCooldownExtraMs: 2000,
  highlightTags: ['female:stocking', 'female:stockings'],
  highlightTagLabel: 'female:stocking(s)',

  // 6. 测试器参数 (tester)
  sampleGalleryPath: '/g/1000000/0123456789/'
};

const SETTINGS_SECTION_KEYS = [
  'features',
  'redirect',
  'shortcutCopy',
  'favorites',
  'tagStats',
  'tester'
];

function normalizeDomain(input) {
  if (!input || typeof input !== 'string') return '';
  let cleaned = input.trim().toLowerCase();
  cleaned = cleaned.replace(/^https?:\/\//i, '');
  cleaned = cleaned.split('/')[0].split('?')[0].split('#')[0];
  cleaned = cleaned.replace(/:\d+$/, '');
  cleaned = cleaned.replace(/\.+$/, '');
  return cleaned;
}

function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.round(num);
  return Math.min(max, Math.max(min, rounded));
}

function normalizeSampleGalleryPath(input, fallback) {
  const fb = fallback || DEFAULT_SETTINGS.sampleGalleryPath;
  if (!input || typeof input !== 'string') return fb;
  const trimmed = input.trim();
  if (!trimmed) return fb;
  const match = trimmed.match(/\/g\/\d+\/[0-9a-f]{10}\/?/i);
  if (match) {
    return match[0].endsWith('/') ? match[0] : `${match[0]}/`;
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeHighlightTags(input, fallback) {
  const fb = Array.isArray(fallback) ? fallback : DEFAULT_SETTINGS.highlightTags;
  let rawList = [];
  if (Array.isArray(input)) {
    rawList = input;
  } else if (typeof input === 'string') {
    rawList = input.split(/[,，\n]/);
  } else {
    return [...fb];
  }
  const seen = new Set();
  const out = [];
  for (const item of rawList) {
    if (typeof item !== 'string') continue;
    const cleaned = item.trim().toLowerCase();
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out.length > 0 ? out : [...fb];
}

function flattenSettingsInput(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const flat = {};
  for (const section of SETTINGS_SECTION_KEYS) {
    if (raw[section] && typeof raw[section] === 'object' && !Array.isArray(raw[section])) {
      Object.assign(flat, raw[section]);
    }
  }
  for (const [key, val] of Object.entries(raw)) {
    if (!SETTINGS_SECTION_KEYS.includes(key) && !key.startsWith('_')) {
      flat[key] = val;
    }
  }
  return flat;
}

function mergeSettings(raw, baseDefaults = DEFAULT_SETTINGS) {
  const base = baseDefaults && typeof baseDefaults === 'object' ? baseDefaults : DEFAULT_SETTINGS;
  const src = flattenSettingsInput(raw);

  const mirrorDomain =
    src.mirrorDomain !== undefined
      ? normalizeDomain(src.mirrorDomain)
      : normalizeDomain(base.mirrorDomain);

  const baseShortcut =
    (base.customShortcut && typeof base.customShortcut === 'object'
      ? base.customShortcut
      : DEFAULT_SETTINGS.customShortcut);
  const shortcutRaw =
    src.customShortcut && typeof src.customShortcut === 'object' ? src.customShortcut : {};

  const customShortcut = {
    altKey: Boolean(
      shortcutRaw.altKey !== undefined ? shortcutRaw.altKey : baseShortcut.altKey
    ),
    ctrlKey: Boolean(
      shortcutRaw.ctrlKey !== undefined ? shortcutRaw.ctrlKey : baseShortcut.ctrlKey
    ),
    shiftKey: Boolean(
      shortcutRaw.shiftKey !== undefined ? shortcutRaw.shiftKey : baseShortcut.shiftKey
    ),
    metaKey: Boolean(
      shortcutRaw.metaKey !== undefined ? shortcutRaw.metaKey : baseShortcut.metaKey
    ),
    code:
      typeof shortcutRaw.code === 'string' && shortcutRaw.code
        ? shortcutRaw.code
        : baseShortcut.code,
    key:
      typeof shortcutRaw.key === 'string' && shortcutRaw.key
        ? shortcutRaw.key
        : baseShortcut.key,
    label:
      typeof shortcutRaw.label === 'string' && shortcutRaw.label
        ? shortcutRaw.label
        : baseShortcut.label
  };

  const isLegacyV1 = src.settingsVersion !== undefined && Number(src.settingsVersion) < 2;
  let resolvedSwapMode = ['e2ex', 'ex2e', 'swap'].includes(src.domainSwapRedirectMode)
    ? src.domainSwapRedirectMode
    : base.domainSwapRedirectMode;
  if (isLegacyV1 && (!src.domainSwapRedirectMode || src.domainSwapRedirectMode === 'swap')) {
    resolvedSwapMode = 'e2ex';
  }

  let resolvedCopyTarget = ['exhentai.org', 'e-hentai.org', 'swap'].includes(src.copyTargetDomain)
    ? src.copyTargetDomain
    : base.copyTargetDomain;
  if (isLegacyV1 && !src.copyTargetDomain) {
    resolvedCopyTarget =
      src.mirrorCopyTarget === 'e-hentai.org' ? 'e-hentai.org' : 'exhentai.org';
  }

  const readDelayMinMs = clampInt(src.readDelayMinMs, base.readDelayMinMs, 50, 10000);
  const importDelayMinMs = clampInt(src.importDelayMinMs, base.importDelayMinMs, 50, 10000);
  const tagDelayMinMs = clampInt(src.tagDelayMinMs, base.tagDelayMinMs, 50, 10000);

  const highlightTags =
    src.highlightTags !== undefined
      ? normalizeHighlightTags(src.highlightTags, base.highlightTags)
      : normalizeHighlightTags(base.highlightTags, DEFAULT_SETTINGS.highlightTags);

  const highlightTagLabel =
    typeof src.highlightTagLabel === 'string' && src.highlightTagLabel.trim()
      ? src.highlightTagLabel.trim()
      : base.highlightTagLabel || DEFAULT_SETTINGS.highlightTagLabel;

  const officialApiUrl =
    typeof src.officialApiUrl === 'string' && /^https?:\/\//i.test(src.officialApiUrl.trim())
      ? src.officialApiUrl.trim()
      : base.officialApiUrl || DEFAULT_SETTINGS.officialApiUrl;

  const defaultActiveSite =
    typeof src.defaultActiveSite === 'string' && src.defaultActiveSite.trim()
      ? src.defaultActiveSite.trim()
      : base.defaultActiveSite || DEFAULT_SETTINGS.defaultActiveSite;

  return {
    settingsVersion: 3,
    enableFavTransfer:
      src.enableFavTransfer !== undefined
        ? Boolean(src.enableFavTransfer)
        : Boolean(base.enableFavTransfer),
    enableTagStats:
      src.enableTagStats !== undefined
        ? Boolean(src.enableTagStats)
        : Boolean(base.enableTagStats),
    enableMirrorRedirect:
      src.enableMirrorRedirect !== undefined
        ? Boolean(src.enableMirrorRedirect)
        : Boolean(base.enableMirrorRedirect),
    mirrorDomain,
    mirrorSourceScope: ['both', 'exhentai', 'e-hentai'].includes(src.mirrorSourceScope)
      ? src.mirrorSourceScope
      : base.mirrorSourceScope,
    enableDomainSwapRedirect:
      src.enableDomainSwapRedirect !== undefined
        ? Boolean(src.enableDomainSwapRedirect)
        : Boolean(base.enableDomainSwapRedirect),
    domainSwapRedirectMode: resolvedSwapMode,
    redirectPriority: ['mirror', 'swap'].includes(src.redirectPriority)
      ? src.redirectPriority
      : base.redirectPriority,
    redirectExternalOnly:
      src.redirectExternalOnly !== undefined
        ? Boolean(src.redirectExternalOnly)
        : Boolean(base.redirectExternalOnly),
    redirectDedupWindowMs: clampInt(
      src.redirectDedupWindowMs,
      base.redirectDedupWindowMs,
      500,
      60000
    ),
    enableShortcutCopy:
      src.enableShortcutCopy !== undefined
        ? Boolean(src.enableShortcutCopy)
        : Boolean(base.enableShortcutCopy),
    copyTargetDomain: resolvedCopyTarget,
    customShortcut,
    mirrorCopyTarget:
      src.mirrorCopyTarget !== undefined
        ? src.mirrorCopyTarget === 'e-hentai.org'
          ? 'e-hentai.org'
          : 'exhentai.org'
        : base.mirrorCopyTarget === 'e-hentai.org'
          ? 'e-hentai.org'
          : 'exhentai.org',
    copyDedupWindowMs: clampInt(src.copyDedupWindowMs, base.copyDedupWindowMs, 50, 5000),
    toastDurationMs: clampInt(src.toastDurationMs, base.toastDurationMs, 500, 30000),
    toastErrorDurationMs: clampInt(
      src.toastErrorDurationMs,
      base.toastErrorDurationMs,
      1000,
      60000
    ),
    badgeClearDelayMs: clampInt(src.badgeClearDelayMs, base.badgeClearDelayMs, 500, 30000),
    defaultActiveSite,
    readDelayMs: clampInt(src.readDelayMs, base.readDelayMs, readDelayMinMs, 60000),
    readDelayMinMs,
    importDelayMs: clampInt(src.importDelayMs, base.importDelayMs, importDelayMinMs, 60000),
    importDelayMinMs,
    importReverseOrder:
      src.importReverseOrder !== undefined
        ? Boolean(src.importReverseOrder)
        : Boolean(base.importReverseOrder),
    importSkipExisting:
      src.importSkipExisting !== undefined
        ? Boolean(src.importSkipExisting)
        : Boolean(base.importSkipExisting),
    importSaveEveryN: clampInt(src.importSaveEveryN, base.importSaveEveryN, 1, 500),
    favPreviewLimit: clampInt(src.favPreviewLimit, base.favPreviewLimit, 20, 5000),
    officialApiUrl,
    apiBatchSize: clampInt(src.apiBatchSize, base.apiBatchSize, 1, 25),
    tagDelayMs: clampInt(src.tagDelayMs, base.tagDelayMs, tagDelayMinMs, 60000),
    tagDelayMinMs,
    tagCooldownEveryBatches: clampInt(
      src.tagCooldownEveryBatches,
      base.tagCooldownEveryBatches,
      0,
      100
    ),
    tagCooldownExtraMs: clampInt(src.tagCooldownExtraMs, base.tagCooldownExtraMs, 0, 60000),
    highlightTags,
    highlightTagLabel,
    sampleGalleryPath: normalizeSampleGalleryPath(
      src.sampleGalleryPath,
      base.sampleGalleryPath
    )
  };
}

function formatSettingsObjectForFile(rawSettings) {
  const s = mergeSettings(rawSettings);
  return {
    settingsVersion: 3,
    features: {
      enableFavTransfer: s.enableFavTransfer,
      enableTagStats: s.enableTagStats,
      enableMirrorRedirect: s.enableMirrorRedirect,
      enableShortcutCopy: s.enableShortcutCopy,
      enableDomainSwapRedirect: s.enableDomainSwapRedirect
    },
    redirect: {
      mirrorDomain: s.mirrorDomain,
      mirrorSourceScope: s.mirrorSourceScope,
      domainSwapRedirectMode: s.domainSwapRedirectMode,
      redirectPriority: s.redirectPriority,
      redirectExternalOnly: s.redirectExternalOnly,
      redirectDedupWindowMs: s.redirectDedupWindowMs
    },
    shortcutCopy: {
      copyTargetDomain: s.copyTargetDomain,
      mirrorCopyTarget: s.mirrorCopyTarget,
      customShortcut: { ...s.customShortcut },
      copyDedupWindowMs: s.copyDedupWindowMs,
      toastDurationMs: s.toastDurationMs,
      toastErrorDurationMs: s.toastErrorDurationMs,
      badgeClearDelayMs: s.badgeClearDelayMs
    },
    favorites: {
      defaultActiveSite: s.defaultActiveSite,
      readDelayMs: s.readDelayMs,
      readDelayMinMs: s.readDelayMinMs,
      importDelayMs: s.importDelayMs,
      importDelayMinMs: s.importDelayMinMs,
      importReverseOrder: s.importReverseOrder,
      importSkipExisting: s.importSkipExisting,
      importSaveEveryN: s.importSaveEveryN,
      favPreviewLimit: s.favPreviewLimit
    },
    tagStats: {
      officialApiUrl: s.officialApiUrl,
      apiBatchSize: s.apiBatchSize,
      tagDelayMs: s.tagDelayMs,
      tagDelayMinMs: s.tagDelayMinMs,
      tagCooldownEveryBatches: s.tagCooldownEveryBatches,
      tagCooldownExtraMs: s.tagCooldownExtraMs,
      highlightTags: [...s.highlightTags],
      highlightTagLabel: s.highlightTagLabel
    },
    tester: {
      sampleGalleryPath: s.sampleGalleryPath
    }
  };
}

function classifyHost(hostname, settings) {
  if (!hostname || typeof hostname !== 'string') return null;
  const host = hostname.toLowerCase();
  if (host === 'e-hentai.org' || host === 'www.e-hentai.org') {
    return 'e-hentai';
  }
  if (host === 'exhentai.org' || host === 'www.exhentai.org') {
    return 'exhentai';
  }
  const mirrorDomain = normalizeDomain(settings && settings.mirrorDomain);
  if (mirrorDomain && host === mirrorDomain) {
    return 'mirror';
  }
  return null;
}

function convertGalleryUrl(rawUrl, rawSettings) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const settings = mergeSettings(rawSettings);
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  const kind = classifyHost(url.hostname, settings);
  if (!kind) return null;

  const currentHost = url.hostname.toLowerCase();
  let targetHost = '';
  let unchanged = false;

  if (settings.copyTargetDomain === 'exhentai.org') {
    targetHost = 'exhentai.org';
    unchanged = kind === 'exhentai' && currentHost === 'exhentai.org' && url.protocol === 'https:';
  } else if (settings.copyTargetDomain === 'e-hentai.org') {
    targetHost = 'e-hentai.org';
    unchanged = kind === 'e-hentai' && currentHost === 'e-hentai.org' && url.protocol === 'https:';
  } else {
    if (kind === 'e-hentai') {
      targetHost = 'exhentai.org';
    } else if (kind === 'exhentai') {
      targetHost = 'e-hentai.org';
    } else if (kind === 'mirror') {
      targetHost =
        settings.mirrorCopyTarget === 'e-hentai.org' ? 'e-hentai.org' : 'exhentai.org';
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

function resolveRedirectDecision(rawUrl, rawSettings, prevHost) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const settings = mergeSettings(rawSettings);
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  const currentHost = url.hostname.toLowerCase();
  const kind = classifyHost(currentHost, settings);
  if (kind !== 'e-hentai' && kind !== 'exhentai') {
    return null;
  }

  const prevKind = prevHost ? classifyHost(prevHost, settings) : null;

  function tryMirror() {
    if (!settings.enableMirrorRedirect) return null;
    const mirrorHost = normalizeDomain(settings.mirrorDomain);
    if (!mirrorHost || mirrorHost === currentHost) return null;

    if (settings.mirrorSourceScope === 'exhentai' && kind !== 'exhentai') return null;
    if (settings.mirrorSourceScope === 'e-hentai' && kind !== 'e-hentai') return null;

    if (settings.redirectExternalOnly && prevKind === kind) {
      return null;
    }

    const nextUrl = new URL(url.toString());
    nextUrl.protocol = 'https:';
    nextUrl.hostname = mirrorHost;
    nextUrl.port = '';
    return {
      targetUrl: nextUrl.toString(),
      targetHost: mirrorHost,
      reason: 'mirror'
    };
  }

  function trySwap() {
    if (!settings.enableDomainSwapRedirect) return null;
    let targetHost = null;
    if (settings.domainSwapRedirectMode === 'swap') {
      targetHost = kind === 'e-hentai' ? 'exhentai.org' : 'e-hentai.org';
    } else if (settings.domainSwapRedirectMode === 'e2ex') {
      if (kind === 'e-hentai') targetHost = 'exhentai.org';
    } else if (settings.domainSwapRedirectMode === 'ex2e') {
      if (kind === 'exhentai') targetHost = 'e-hentai.org';
    }

    if (!targetHost || targetHost === currentHost) return null;

    const isOneWay =
      settings.domainSwapRedirectMode === 'e2ex' ||
      settings.domainSwapRedirectMode === 'ex2e';

    if (
      !isOneWay &&
      settings.redirectExternalOnly &&
      (prevKind === 'e-hentai' || prevKind === 'exhentai')
    ) {
      return null;
    }

    const nextUrl = new URL(url.toString());
    nextUrl.protocol = 'https:';
    nextUrl.hostname = targetHost;
    nextUrl.port = '';
    return {
      targetUrl: nextUrl.toString(),
      targetHost,
      reason: 'swap'
    };
  }

  if (settings.redirectPriority === 'swap') {
    return trySwap() || tryMirror();
  }
  return tryMirror() || trySwap();
}

// Runtime state & Chrome MV3 wiring
let cachedSettings = null;
let cachedFileDefaults = null;
let cachedFileSource = 'builtin';
let settingsLoadPromise = null;
let scriptSyncChain = Promise.resolve();
const recentRedirects = new Map(); // tabId -> { targetUrl, time }
const tabLastHost = new Map(); // tabId -> hostname
let badgeClearTimer = null;

async function fetchExtensionJson(filename) {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
    return null;
  }
  try {
    const url = chrome.runtime.getURL(filename);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function loadFileSettings() {
  const primary = await fetchExtensionJson('settings.json');
  if (primary && typeof primary === 'object') {
    const merged = mergeSettings(primary, DEFAULT_SETTINGS);
    cachedFileDefaults = merged;
    cachedFileSource = 'settings.json';
    return { settings: merged, source: 'settings.json' };
  }

  const example = await fetchExtensionJson('settings.example.json');
  if (example && typeof example === 'object') {
    const merged = mergeSettings(example, DEFAULT_SETTINGS);
    cachedFileDefaults = merged;
    cachedFileSource = 'settings.example.json';
    return { settings: merged, source: 'settings.example.json' };
  }

  const fallback = mergeSettings({}, DEFAULT_SETTINGS);
  cachedFileDefaults = fallback;
  cachedFileSource = 'builtin';
  return { settings: fallback, source: 'builtin' };
}

async function getSettings(forceReloadFromFile = false) {
  if (cachedSettings && !forceReloadFromFile) return cachedSettings;
  if (!settingsLoadPromise || forceReloadFromFile) {
    settingsLoadPromise = (async () => {
      const { settings: fileDefaults } = await loadFileSettings();
      const res = await chrome.storage.local.get([
        SETTINGS_STORAGE_KEY,
        FILE_SNAPSHOT_STORAGE_KEY
      ]);
      const stored = res[SETTINGS_STORAGE_KEY];
      const lastSnapshot = res[FILE_SNAPSHOT_STORAGE_KEY];

      if (forceReloadFromFile || !stored || typeof stored !== 'object') {
        cachedSettings = fileDefaults;
        await chrome.storage.local.set({
          [SETTINGS_STORAGE_KEY]: cachedSettings,
          [FILE_SNAPSHOT_STORAGE_KEY]: fileDefaults
        });
        await syncDynamicContentScript(cachedSettings);
        return cachedSettings;
      }

      // Apply legacy v1 flag when upgrading stored v1 settings
      const storedNormalizedInput =
        !stored.settingsVersion || Number(stored.settingsVersion) < 2
          ? { ...stored, settingsVersion: 1 }
          : stored;
      const mergedStored = mergeSettings(storedNormalizedInput, fileDefaults);

      if (lastSnapshot && typeof lastSnapshot === 'object') {
        const next = { ...mergedStored };
        let fileChanged = false;
        for (const key of Object.keys(fileDefaults)) {
          if (JSON.stringify(fileDefaults[key]) !== JSON.stringify(lastSnapshot[key])) {
            next[key] = fileDefaults[key];
            fileChanged = true;
          }
        }
        cachedSettings = mergeSettings(next, fileDefaults);
        if (fileChanged || Number(stored.settingsVersion) < 3) {
          await chrome.storage.local.set({
            [SETTINGS_STORAGE_KEY]: cachedSettings,
            [FILE_SNAPSHOT_STORAGE_KEY]: fileDefaults
          });
        }
      } else {
        // First upgrade to v3 (settings.json introduced): preserve stored settings while seeding new v3 fields from fileDefaults
        cachedSettings = mergedStored;
        await chrome.storage.local.set({
          [SETTINGS_STORAGE_KEY]: cachedSettings,
          [FILE_SNAPSHOT_STORAGE_KEY]: fileDefaults
        });
      }

      await syncDynamicContentScript(cachedSettings);
      return cachedSettings;
    })().finally(() => {
      settingsLoadPromise = null;
    });
  }
  return settingsLoadPromise;
}

async function saveSettings(nextPartial) {
  const current = await getSettings();
  const base = cachedFileDefaults || DEFAULT_SETTINGS;
  const flattenedPartial = flattenSettingsInput(nextPartial);
  const merged = mergeSettings({ ...current, ...flattenedPartial }, base);
  cachedSettings = merged;
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: merged });
  await syncDynamicContentScript(merged);
  return merged;
}

function syncDynamicContentScript(settings) {
  if (typeof chrome === 'undefined' || !chrome.scripting) {
    return Promise.resolve();
  }
  scriptSyncChain = scriptSyncChain
    .then(async () => {
      try {
        const existing = await chrome.scripting.getRegisteredContentScripts({
          ids: [DYNAMIC_SCRIPT_ID]
        });
        if (existing && existing.length > 0) {
          await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
        }
      } catch {
        // Ignore when not registered
      }

      const mirror = normalizeDomain(settings && settings.mirrorDomain);
      if (!mirror || STATIC_CONTENT_HOSTS.has(mirror)) {
        return;
      }

      try {
        await chrome.scripting.registerContentScripts([
          {
            id: DYNAMIC_SCRIPT_ID,
            matches: [`https://${mirror}/*`, `http://${mirror}/*`],
            js: ['content.js'],
            runAt: 'document_start'
          }
        ]);
      } catch (err) {
        console.warn('[EH Toolkit] Failed to register dynamic mirror script:', err);
      }
    })
    .catch(() => {});
  return scriptSyncChain;
}

function flashBadge(text, color, clearDelayMs) {
  if (typeof chrome === 'undefined' || !chrome.action) return;
  if (badgeClearTimer) {
    clearTimeout(badgeClearTimer);
    badgeClearTimer = null;
  }
  const delay =
    Number(clearDelayMs) > 0
      ? Number(clearDelayMs)
      : (cachedSettings && cachedSettings.badgeClearDelayMs) ||
        DEFAULT_SETTINGS.badgeClearDelayMs;
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  badgeClearTimer = setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
    badgeClearTimer = null;
  }, delay);
}

function injectedCopyAndToast(convertedUrl, originalUrl, unchanged, uiTimings) {
  const dedupMs = (uiTimings && Number(uiTimings.copyDedupWindowMs)) || 400;
  const okDuration = (uiTimings && Number(uiTimings.toastDurationMs)) || 3200;
  const errDuration = (uiTimings && Number(uiTimings.toastErrorDurationMs)) || 7000;

  if (Date.now() - (window.__ehLastContentCopyAt || 0) < dedupMs) {
    return { ok: true, convertedUrl, originalUrl, deduped: true };
  }
  window.__ehLastBgCopyAt = Date.now();

  function showBanner(success, message, urlText) {
    const existing = document.getElementById('eh-toolkit-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'eh-toolkit-toast';
    Object.assign(toast.style, {
      position: 'fixed',
      top: '16px',
      right: '16px',
      zIndex: '2147483647',
      maxWidth: '430px',
      padding: '12px 14px',
      borderRadius: '10px',
      background: success ? 'rgba(15, 23, 42, 0.95)' : 'rgba(69, 26, 3, 0.96)',
      color: '#f8fafc',
      border: success ? '1px solid rgba(59, 130, 246, 0.7)' : '1px solid rgba(245, 158, 11, 0.8)',
      boxShadow: '0 12px 30px rgba(0,0,0,0.45)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '13px',
      lineHeight: '1.45',
      backdropFilter: 'blur(8px)'
    });

    const titleEl = document.createElement('div');
    titleEl.textContent = message;
    titleEl.style.fontWeight = '600';
    titleEl.style.marginBottom = '4px';
    titleEl.style.color = success ? '#60a5fa' : '#fbbf24';

    const urlEl = document.createElement('div');
    urlEl.textContent = urlText;
    Object.assign(urlEl.style, {
      wordBreak: 'break-all',
      fontSize: '12px',
      color: '#e2e8f0',
      background: 'rgba(255,255,255,0.08)',
      padding: '6px 8px',
      borderRadius: '6px'
    });

    toast.appendChild(titleEl);
    toast.appendChild(urlEl);

    if (!success) {
      const btn = document.createElement('button');
      btn.textContent = '点击此处立即复制';
      Object.assign(btn.style, {
        marginTop: '8px',
        padding: '5px 10px',
        border: 'none',
        borderRadius: '6px',
        background: '#3b82f6',
        color: '#ffffff',
        fontSize: '12px',
        fontWeight: '600',
        cursor: 'pointer'
      });
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(urlText);
          showBanner(true, '已复制转换后链接', urlText);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = urlText;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          showBanner(true, '已复制转换后链接', urlText);
        }
      });
      toast.appendChild(btn);
    }

    (document.body || document.documentElement).appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, success ? okDuration : errDuration);
  }

  function legacyExecCopy(text) {
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

  return (async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(convertedUrl);
      ok = true;
    } catch {
      ok = legacyExecCopy(convertedUrl);
    }
    if (ok) {
      showBanner(
        true,
        unchanged ? '当前已是目标域名，已保持原链接并复制' : '已复制转换域名后的链接',
        convertedUrl
      );
    } else {
      showBanner(
        false,
        '地址栏焦点下浏览器禁止后台直接写入剪贴板，请点此按钮或点击页面后再按快捷键',
        convertedUrl
      );
    }
    return { ok, convertedUrl, originalUrl };
  })();
}

async function handleCopyCommand() {
  const settings = await getSettings();
  if (!settings.enableShortcutCopy) {
    flashBadge('OFF', '#64748b', settings.badgeClearDelayMs);
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.id || !tab.url) return;

  const converted = convertGalleryUrl(tab.url, settings);
  if (!converted) {
    flashBadge('N/A', '#64748b', settings.badgeClearDelayMs);
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectedCopyAndToast,
      args: [
        converted.convertedUrl,
        converted.originalUrl,
        Boolean(converted.unchanged),
        {
          copyDedupWindowMs: settings.copyDedupWindowMs,
          toastDurationMs: settings.toastDurationMs,
          toastErrorDurationMs: settings.toastErrorDurationMs
        }
      ]
    });
    const res = results && results[0] && results[0].result;
    if (res && res.ok) {
      flashBadge('OK', '#10b981', settings.badgeClearDelayMs);
    } else {
      flashBadge('!', '#f59e0b', settings.badgeClearDelayMs);
    }
  } catch (err) {
    console.warn('[EH Toolkit] Command copy executeScript failed:', err);
    flashBadge('ERR', '#ef4444', settings.badgeClearDelayMs);
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.webNavigation) {
  chrome.runtime.onInstalled.addListener(async () => {
    await getSettings();
  });

  chrome.runtime.onStartup.addListener(async () => {
    await getSettings();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[SETTINGS_STORAGE_KEY] && changes[SETTINGS_STORAGE_KEY].newValue) {
      const base = cachedFileDefaults || DEFAULT_SETTINGS;
      cachedSettings = mergeSettings(changes[SETTINGS_STORAGE_KEY].newValue, base);
      syncDynamicContentScript(cachedSettings);
    }
  });

  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    if (details.sourceTabId && details.tabId && tabLastHost.has(details.sourceTabId)) {
      tabLastHost.set(details.tabId, tabLastHost.get(details.sourceTabId));
    }
  });

  chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
    if (details.frameId !== 0 || details.tabId < 0) return;

    const urlStr = details.url;
    if (!urlStr || (!urlStr.startsWith('http://') && !urlStr.startsWith('https://'))) {
      if (
        urlStr &&
        (urlStr.startsWith('chrome://') ||
          urlStr.startsWith('edge://') ||
          urlStr.startsWith('about:'))
      ) {
        tabLastHost.delete(details.tabId);
      }
      return;
    }

    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch {
      return;
    }
    const currentHost = parsed.hostname.toLowerCase();

    const settings = await getSettings();
    const dedupWindow = settings.redirectDedupWindowMs || 6000;

    const recent = recentRedirects.get(details.tabId);
    if (recent) {
      if (Date.now() - recent.time > dedupWindow) {
        recentRedirects.delete(details.tabId);
      } else if (recent.targetUrl === urlStr) {
        recentRedirects.delete(details.tabId);
        tabLastHost.set(details.tabId, currentHost);
        return;
      }
    }

    const prevHost = tabLastHost.get(details.tabId) || null;
    const decision = resolveRedirectDecision(urlStr, settings, prevHost);

    if (decision && decision.targetUrl !== urlStr) {
      recentRedirects.set(details.tabId, {
        targetUrl: decision.targetUrl,
        time: Date.now()
      });
      tabLastHost.set(details.tabId, decision.targetHost);
      try {
        await chrome.tabs.update(details.tabId, { url: decision.targetUrl });
      } catch (err) {
        console.warn('[EH Toolkit] Tab redirect failed:', err);
      }
      return;
    }

    tabLastHost.set(details.tabId, currentHost);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    recentRedirects.delete(tabId);
    tabLastHost.delete(tabId);
  });

  chrome.commands.onCommand.addListener((command) => {
    if (command === 'copy-converted-url') {
      handleCopyCommand();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;

    if (msg.type === 'EH_GET_SETTINGS') {
      getSettings().then((settings) =>
        sendResponse({
          ok: true,
          settings,
          fileDefaults: cachedFileDefaults || DEFAULT_SETTINGS,
          fileSource: cachedFileSource
        })
      );
      return true;
    }

    if (msg.type === 'EH_SAVE_SETTINGS') {
      saveSettings(msg.settings || {}).then((settings) =>
        sendResponse({
          ok: true,
          settings,
          fileDefaults: cachedFileDefaults || DEFAULT_SETTINGS,
          fileSource: cachedFileSource
        })
      );
      return true;
    }

    if (msg.type === 'EH_RELOAD_FILE_SETTINGS') {
      getSettings(true).then((settings) =>
        sendResponse({
          ok: true,
          settings,
          fileDefaults: cachedFileDefaults || DEFAULT_SETTINGS,
          fileSource: cachedFileSource
        })
      );
      return true;
    }

    if (msg.type === 'EH_EXPORT_SETTINGS_JSON') {
      getSettings().then((settings) => {
        const structured = formatSettingsObjectForFile(settings);
        sendResponse({
          ok: true,
          structured,
          jsonText: JSON.stringify(structured, null, 2) + '\n'
        });
      });
      return true;
    }

    if (msg.type === 'EH_NOTIFY_BADGE') {
      flashBadge(msg.text || 'OK', msg.color || '#10b981');
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'EH_CONVERT_URL') {
      getSettings().then((settings) => {
        sendResponse({
          ok: true,
          converted: convertGalleryUrl(msg.url, settings),
          redirect: resolveRedirectDecision(msg.url, settings, null)
        });
      });
      return true;
    }

    return false;
  });
}

if (typeof globalThis !== 'undefined') {
  globalThis.__EH_BG_EXPORTS__ = {
    DEFAULT_SETTINGS,
    normalizeDomain,
    flattenSettingsInput,
    mergeSettings,
    formatSettingsObjectForFile,
    classifyHost,
    convertGalleryUrl,
    resolveRedirectDecision
  };
}
