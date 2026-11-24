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
  incrementalFavScan: true,
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

  // 6. ExHentai Cookie 与里站支持参数 (cookies)
  enableExCookieManager: true,
  autoSyncEhToExCookie: true,
  syncCookieToMirror: false,
  preferExhentaiApi: true,
  autoRedirectUnavailableToEx: true,
  exCookieMemberId: '',
  exCookiePassHash: '',
  exCookieIgneous: '',
  exCookieSk: '',

  // 7. 测试器参数 (tester)
  sampleGalleryPath: '/g/1000000/0123456789/'
};

const SETTINGS_SECTION_KEYS = [
  'features',
  'redirect',
  'shortcutCopy',
  'favorites',
  'tagStats',
  'cookies',
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

function cleanCookieValue(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .split(';')[0]
    .split(/\r|\n/)[0]
    .trim();
}

function isValidIgneous(val) {
  const v = cleanCookieValue(val).toLowerCase();
  return Boolean(
    v &&
      v !== 'mystery' &&
      v !== 'deleted' &&
      v !== 'null' &&
      v !== 'undefined' &&
      v !== '0'
  );
}

function parseCookieInput(rawInput) {
  const result = {
    ipb_member_id: '',
    ipb_pass_hash: '',
    igneous: '',
    sk: ''
  };
  if (!rawInput) return result;

  const targetKeys = new Set(['ipb_member_id', 'ipb_pass_hash', 'igneous', 'sk']);
  const assignKey = (k, v) => {
    if (!k) return;
    const lower = String(k).trim().toLowerCase();
    if (targetKeys.has(lower)) {
      const cleaned = cleanCookieValue(v);
      if (cleaned) {
        result[lower] = cleaned;
      }
    }
  };

  if (typeof rawInput === 'object') {
    if (Array.isArray(rawInput)) {
      for (const item of rawInput) {
        if (item && typeof item === 'object') {
          assignKey(item.name || item.key, item.value);
        }
      }
      return result;
    }
    const sourceObj =
      rawInput.cookies && typeof rawInput.cookies === 'object' ? rawInput.cookies : rawInput;
    for (const [k, v] of Object.entries(sourceObj)) {
      assignKey(k, v);
    }
    assignKey('ipb_member_id', sourceObj.exCookieMemberId);
    assignKey('ipb_pass_hash', sourceObj.exCookiePassHash);
    assignKey('igneous', sourceObj.exCookieIgneous);
    assignKey('sk', sourceObj.exCookieSk);
    return result;
  }

  if (typeof rawInput !== 'string') return result;
  let text = rawInput.trim();
  if (!text) return result;

  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsedJson = JSON.parse(text);
      return parseCookieInput(parsedJson);
    } catch {
      // Fallback to text parsing
    }
  }

  text = text.replace(/^cookie\s*:\s*/i, '');

  // Support semicolon, newline, or DevTools tab-copied rows
  const lines = text.split(/[\r\n]+/);
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    if (trimmedLine.includes('\t') && !trimmedLine.includes('=')) {
      const cols = trimmedLine.split('\t').map((c) => c.trim());
      if (cols.length >= 2) {
        assignKey(cols[0], cols[1]);
      }
      continue;
    }

    const parts = trimmedLine.split(';');
    for (const part of parts) {
      const eqIdx = part.indexOf('=');
      if (eqIdx <= 0) continue;
      const k = part.slice(0, eqIdx).trim();
      const v = part.slice(eqIdx + 1).trim();
      assignKey(k, v);
    }
  }

  return result;
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
    incrementalFavScan:
      src.incrementalFavScan !== undefined
        ? Boolean(src.incrementalFavScan)
        : base.incrementalFavScan !== undefined
          ? Boolean(base.incrementalFavScan)
          : true,
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
    enableExCookieManager:
      src.enableExCookieManager !== undefined
        ? Boolean(src.enableExCookieManager)
        : Boolean(base.enableExCookieManager),
    autoSyncEhToExCookie:
      src.autoSyncEhToExCookie !== undefined
        ? Boolean(src.autoSyncEhToExCookie)
        : Boolean(base.autoSyncEhToExCookie),
    syncCookieToMirror:
      src.syncCookieToMirror !== undefined
        ? Boolean(src.syncCookieToMirror)
        : Boolean(base.syncCookieToMirror),
    preferExhentaiApi:
      src.preferExhentaiApi !== undefined
        ? Boolean(src.preferExhentaiApi)
        : Boolean(base.preferExhentaiApi),
    autoRedirectUnavailableToEx:
      src.autoRedirectUnavailableToEx !== undefined
        ? Boolean(src.autoRedirectUnavailableToEx)
        : Boolean(base.autoRedirectUnavailableToEx),
    exCookieMemberId:
      src.exCookieMemberId !== undefined
        ? cleanCookieValue(src.exCookieMemberId)
        : cleanCookieValue(base.exCookieMemberId),
    exCookiePassHash:
      src.exCookiePassHash !== undefined
        ? cleanCookieValue(src.exCookiePassHash)
        : cleanCookieValue(base.exCookiePassHash),
    exCookieIgneous:
      src.exCookieIgneous !== undefined
        ? cleanCookieValue(src.exCookieIgneous)
        : cleanCookieValue(base.exCookieIgneous),
    exCookieSk:
      src.exCookieSk !== undefined
        ? cleanCookieValue(src.exCookieSk)
        : cleanCookieValue(base.exCookieSk),
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
      incrementalFavScan: s.incrementalFavScan,
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
    cookies: {
      enableExCookieManager: s.enableExCookieManager,
      autoSyncEhToExCookie: s.autoSyncEhToExCookie,
      syncCookieToMirror: s.syncCookieToMirror,
      preferExhentaiApi: s.preferExhentaiApi,
      autoRedirectUnavailableToEx: s.autoRedirectUnavailableToEx,
      exCookieMemberId: s.exCookieMemberId,
      exCookiePassHash: s.exCookiePassHash,
      exCookieIgneous: s.exCookieIgneous,
      exCookieSk: s.exCookieSk
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
let cookieSyncChain = Promise.resolve();
let lastNavCookieEnsureAt = 0;
const recentRedirects = new Map(); // tabId -> { targetUrl, time }
const tabLastHost = new Map(); // tabId -> hostname
let badgeClearTimer = null;

function buildCookieRemovalUrl(cookie) {
  const rawDomain = String(cookie.domain || '').replace(/^\./, '');
  const proto = cookie.secure ? 'https://' : 'http://';
  const path = cookie.path || '/';
  return `${proto}${rawDomain}${path}`;
}

function summarizeDomainCookies(cookieList, primaryHost) {
  const list = Array.isArray(cookieList) ? cookieList : [];
  const targetNames = ['ipb_member_id', 'ipb_pass_hash', 'igneous', 'sk', 'yay'];
  const picked = {
    memberId: '',
    passHash: '',
    igneous: '',
    sk: '',
    yay: '',
    hasMysteryCookie: false,
    hasSadPandaLock: false
  };

  // Sort so primary root domain (.exhentai.org / exhentai.org) takes priority over subdomains
  const sorted = [...list].sort((a, b) => {
    const domA = String(a.domain || '').replace(/^\./, '').toLowerCase();
    const domB = String(b.domain || '').replace(/^\./, '').toLowerCase();
    const scoreA = domA === primaryHost ? (a.hostOnly ? 1 : 0) : 2;
    const scoreB = domB === primaryHost ? (b.hostOnly ? 1 : 0) : 2;
    return scoreA - scoreB;
  });

  for (const c of sorted) {
    if (!c || !targetNames.includes(c.name)) continue;
    const val = cleanCookieValue(c.value);
    if (!val) continue;

    if (c.name === 'ipb_member_id' && !picked.memberId) {
      picked.memberId = val;
    } else if (c.name === 'ipb_pass_hash' && !picked.passHash) {
      picked.passHash = val;
    } else if (c.name === 'sk' && !picked.sk) {
      picked.sk = val;
    } else if (c.name === 'yay') {
      picked.yay = val;
      picked.hasSadPandaLock = true;
    } else if (c.name === 'igneous') {
      if (val.toLowerCase() === 'mystery') {
        picked.hasMysteryCookie = true;
        if (!picked.igneous) picked.igneous = val;
      } else if (isValidIgneous(val) && !isValidIgneous(picked.igneous)) {
        picked.igneous = val;
      }
    }
  }

  const hasLogin = Boolean(picked.memberId && picked.passHash);
  const hasValidIgneous = isValidIgneous(picked.igneous);
  const isMystery = !hasValidIgneous && picked.hasMysteryCookie;

  return {
    ...picked,
    hasLogin,
    hasValidIgneous,
    isMystery
  };
}

function formatCookieHeaderString(summary) {
  if (!summary) return '';
  const parts = [];
  if (summary.memberId) parts.push(`ipb_member_id=${summary.memberId}`);
  if (summary.passHash) parts.push(`ipb_pass_hash=${summary.passHash}`);
  if (isValidIgneous(summary.igneous)) parts.push(`igneous=${summary.igneous}`);
  if (summary.sk) parts.push(`sk=${summary.sk}`);
  return parts.join('; ');
}

async function clearSadPandaOnExhentai() {
  if (typeof chrome === 'undefined' || !chrome.cookies) return 0;
  let removed = 0;
  try {
    const allEx = await chrome.cookies.getAll({ domain: 'exhentai.org' });
    for (const c of allEx) {
      const val = cleanCookieValue(c.value).toLowerCase();
      if (c.name === 'yay' || (c.name === 'igneous' && !isValidIgneous(val))) {
        await chrome.cookies.remove({
          url: buildCookieRemovalUrl(c),
          name: c.name,
          storeId: c.storeId
        });
        removed += 1;
      }
    }
  } catch (err) {
    console.warn('[EH Toolkit] Failed clearing Sad Panda cookies:', err);
  }
  return removed;
}

async function setEhSiteCookies(targetHost, values, options = {}) {
  if (typeof chrome === 'undefined' || !chrome.cookies || !targetHost) return false;
  const host = normalizeDomain(targetHost);
  if (!host) return false;

  const isOfficialEh = host === 'exhentai.org' || host === 'e-hentai.org';
  const baseUrl = `https://${host}/`;
  const exp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;

  const entries = [];
  if (values.ipb_member_id) entries.push(['ipb_member_id', cleanCookieValue(values.ipb_member_id)]);
  if (values.ipb_pass_hash) entries.push(['ipb_pass_hash', cleanCookieValue(values.ipb_pass_hash)]);
  if (isValidIgneous(values.igneous)) {
    entries.push(['igneous', cleanCookieValue(values.igneous)]);
  }
  if (values.sk) entries.push(['sk', cleanCookieValue(values.sk)]);

  try {
    const existing = isOfficialEh
      ? await chrome.cookies.getAll({ domain: host })
      : await chrome.cookies.getAll({ url: baseUrl });

    const namesToUpdate = new Set(entries.map(([n]) => n));
    if (options.clearOldIgneousWhenMissing && !isValidIgneous(values.igneous)) {
      namesToUpdate.add('igneous');
    }

    // Remove conflicting hostOnly/subdomain duplicates before writing clean cookie
    for (const c of existing) {
      if (isOfficialEh && c.hostOnly && namesToUpdate.has(c.name)) {
        await chrome.cookies.remove({
          url: buildCookieRemovalUrl(c),
          name: c.name,
          storeId: c.storeId
        });
      } else if (
        options.clearOldIgneousWhenMissing &&
        c.name === 'igneous' &&
        !isValidIgneous(values.igneous)
      ) {
        await chrome.cookies.remove({
          url: buildCookieRemovalUrl(c),
          name: c.name,
          storeId: c.storeId
        });
      }
    }

    for (const [name, value] of entries) {
      if (!value) continue;
      const details = {
        url: baseUrl,
        name,
        value,
        path: '/',
        secure: true,
        sameSite: 'lax',
        expirationDate: exp
      };
      if (isOfficialEh) {
        details.domain = `.${host}`;
      }
      await chrome.cookies.set(details);
    }
    return true;
  } catch (err) {
    console.warn(`[EH Toolkit] Failed setting cookies on ${host}:`, err);
    return false;
  }
}

async function inspectCookieStatus(rawSettings) {
  const settings = mergeSettings(rawSettings || cachedSettings || DEFAULT_SETTINGS);
  if (typeof chrome === 'undefined' || !chrome.cookies) {
    return {
      supported: false,
      state: 'permission_missing',
      exReady: false,
      ex: { hasLogin: false, hasValidIgneous: false },
      eh: { hasLogin: false, hasValidIgneous: false },
      mirror: null,
      cookieHeaderString: ''
    };
  }

  try {
    const [exList, ehList] = await Promise.all([
      chrome.cookies.getAll({ domain: 'exhentai.org' }),
      chrome.cookies.getAll({ domain: 'e-hentai.org' })
    ]);

    const ex = summarizeDomainCookies(exList, 'exhentai.org');
    const eh = summarizeDomainCookies(ehList, 'e-hentai.org');

    let mirror = null;
    const mirrorHost = normalizeDomain(settings.mirrorDomain);
    if (mirrorHost && !STATIC_CONTENT_HOSTS.has(mirrorHost)) {
      try {
        const mList = await chrome.cookies.getAll({ url: `https://${mirrorHost}/` });
        const mSummary = summarizeDomainCookies(mList, mirrorHost);
        mirror = {
          domain: mirrorHost,
          hasLogin: mSummary.hasLogin,
          hasValidIgneous: mSummary.hasValidIgneous,
          memberId: mSummary.memberId
        };
      } catch {
        mirror = { domain: mirrorHost, hasLogin: false, hasValidIgneous: false, memberId: '' };
      }
    }

    let state = 'unauthenticated';
    if (ex.isMystery || ex.hasSadPandaLock) {
      state = 'sad_panda_locked';
    } else if (ex.hasLogin && ex.hasValidIgneous) {
      state = 'ready_full';
    } else if (ex.hasLogin) {
      state = 'ready_basic';
    } else if (eh.hasLogin) {
      state = 'can_sync_from_eh';
    }

    const exReady = state === 'ready_full' || state === 'ready_basic';
    const primarySource = ex.hasLogin ? ex : eh;

    return {
      supported: true,
      state,
      exReady,
      ex,
      eh,
      mirror,
      hasManualConfig: Boolean(settings.exCookieMemberId && settings.exCookiePassHash),
      cookieHeaderString: formatCookieHeaderString(primarySource)
    };
  } catch (err) {
    console.warn('[EH Toolkit] Failed inspecting cookies:', err);
    return {
      supported: false,
      state: 'error',
      exReady: false,
      ex: { hasLogin: false, hasValidIgneous: false },
      eh: { hasLogin: false, hasValidIgneous: false },
      mirror: null,
      cookieHeaderString: ''
    };
  }
}

function ensureExhentaiCookies(options = {}) {
  cookieSyncChain = cookieSyncChain
    .then(async () => {
      const settings = await getSettings();
      if (typeof chrome === 'undefined' || !chrome.cookies) {
        return inspectCookieStatus(settings);
      }

      if (!settings.enableExCookieManager && !options.force) {
        return inspectCookieStatus(settings);
      }

      await clearSadPandaOnExhentai();
      let status = await inspectCookieStatus(settings);

      const hasManual = Boolean(settings.exCookieMemberId && settings.exCookiePassHash);
      const mirrorHost = normalizeDomain(settings.mirrorDomain);

      if (hasManual && !options.forceSyncFromEh) {
        const manualValues = {
          ipb_member_id: settings.exCookieMemberId,
          ipb_pass_hash: settings.exCookiePassHash,
          igneous: isValidIgneous(settings.exCookieIgneous)
            ? settings.exCookieIgneous
            : status.ex.memberId === settings.exCookieMemberId && status.ex.hasValidIgneous
              ? status.ex.igneous
              : '',
          sk: settings.exCookieSk || status.ex.sk || status.eh.sk || ''
        };

        const exNeedsManual =
          options.forceManual ||
          status.ex.memberId !== manualValues.ipb_member_id ||
          status.ex.passHash !== manualValues.ipb_pass_hash ||
          (isValidIgneous(manualValues.igneous) && status.ex.igneous !== manualValues.igneous);

        if (exNeedsManual) {
          await setEhSiteCookies('exhentai.org', manualValues, {
            clearOldIgneousWhenMissing: status.ex.memberId !== manualValues.ipb_member_id
          });
        }

        if (options.alsoApplyToEh || !status.eh.hasLogin) {
          await setEhSiteCookies('e-hentai.org', manualValues, {
            clearOldIgneousWhenMissing: false
          });
        }

        if (settings.syncCookieToMirror && mirrorHost) {
          if (
            options.forceManual ||
            !status.mirror ||
            !status.mirror.hasLogin ||
            status.mirror.memberId !== manualValues.ipb_member_id
          ) {
            await setEhSiteCookies(mirrorHost, manualValues, {
              clearOldIgneousWhenMissing: true
            });
          }
        }

        return inspectCookieStatus(settings);
      }

      if (options.forceSyncFromEh || settings.autoSyncEhToExCookie) {
        if (status.eh.hasLogin) {
          const accountChanged =
            Boolean(status.ex.memberId) && status.ex.memberId !== status.eh.memberId;
          const syncValues = {
            ipb_member_id: status.eh.memberId,
            ipb_pass_hash: status.eh.passHash,
            igneous: status.eh.hasValidIgneous
              ? status.eh.igneous
              : !accountChanged && status.ex.hasValidIgneous
                ? status.ex.igneous
                : isValidIgneous(settings.exCookieIgneous) && !accountChanged
                  ? settings.exCookieIgneous
                  : '',
            sk: status.eh.sk || status.ex.sk || ''
          };

          const needsSync =
            options.forceSyncFromEh ||
            !status.ex.hasLogin ||
            accountChanged ||
            status.ex.passHash !== status.eh.passHash ||
            (isValidIgneous(syncValues.igneous) && !status.ex.hasValidIgneous);

          if (needsSync) {
            await setEhSiteCookies('exhentai.org', syncValues, {
              clearOldIgneousWhenMissing: accountChanged
            });
          }

          if (settings.syncCookieToMirror && mirrorHost) {
            if (
              options.forceSyncFromEh ||
              !status.mirror ||
              !status.mirror.hasLogin ||
              status.mirror.memberId !== syncValues.ipb_member_id
            ) {
              await setEhSiteCookies(mirrorHost, syncValues, {
                clearOldIgneousWhenMissing: accountChanged
              });
            }
          }

          status = await inspectCookieStatus(settings);
        } else if (
          status.ex.hasLogin &&
          settings.syncCookieToMirror &&
          mirrorHost &&
          (!status.mirror || !status.mirror.hasLogin)
        ) {
          await setEhSiteCookies(mirrorHost, {
            ipb_member_id: status.ex.memberId,
            ipb_pass_hash: status.ex.passHash,
            igneous: status.ex.hasValidIgneous ? status.ex.igneous : '',
            sk: status.ex.sk || ''
          });
          status = await inspectCookieStatus(settings);
        }
      }

      return status;
    })
    .catch((err) => {
      console.warn('[EH Toolkit] ensureExhentaiCookies error:', err);
      return inspectCookieStatus(cachedSettings);
    });

  return cookieSyncChain;
}

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
  lastNavCookieEnsureAt = 0;
  await ensureExhentaiCookies();
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
    await ensureExhentaiCookies();
  });

  chrome.runtime.onStartup.addListener(async () => {
    await getSettings();
    await ensureExhentaiCookies();
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
    const currentKind = classifyHost(currentHost, settings);

    if (
      settings.enableExCookieManager &&
      (currentKind === 'exhentai' || (currentKind === 'mirror' && settings.syncCookieToMirror))
    ) {
      if (Date.now() - lastNavCookieEnsureAt > 3000) {
        lastNavCookieEnsureAt = Date.now();
        await ensureExhentaiCookies();
      }
    }

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
      const targetKind = classifyHost(decision.targetHost, settings);
      if (
        settings.enableExCookieManager &&
        (targetKind === 'exhentai' || (targetKind === 'mirror' && settings.syncCookieToMirror))
      ) {
        lastNavCookieEnsureAt = Date.now();
        await ensureExhentaiCookies();
      }

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
      getSettings(true).then(async (settings) => {
        await ensureExhentaiCookies();
        sendResponse({
          ok: true,
          settings,
          fileDefaults: cachedFileDefaults || DEFAULT_SETTINGS,
          fileSource: cachedFileSource
        });
      });
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

    if (msg.type === 'EH_GET_COOKIE_STATUS') {
      getSettings()
        .then((settings) => inspectCookieStatus(settings))
        .then((cookieStatus) => sendResponse({ ok: true, cookieStatus }));
      return true;
    }

    if (msg.type === 'EH_ENSURE_EX_COOKIES') {
      ensureExhentaiCookies(msg.options || {}).then((cookieStatus) =>
        sendResponse({ ok: true, cookieStatus })
      );
      return true;
    }

    if (msg.type === 'EH_SYNC_COOKIES_FROM_EH') {
      ensureExhentaiCookies({ force: true, forceSyncFromEh: true }).then((cookieStatus) =>
        sendResponse({ ok: true, cookieStatus })
      );
      return true;
    }

    if (msg.type === 'EH_CLEAR_SAD_PANDA') {
      clearSadPandaOnExhentai()
        .then((removedCount) =>
          ensureExhentaiCookies({ force: true }).then((cookieStatus) =>
            sendResponse({ ok: true, removedCount, cookieStatus })
          )
        );
      return true;
    }

    if (msg.type === 'EH_PARSE_COOKIE_INPUT') {
      const parsed = parseCookieInput(msg.raw || '');
      sendResponse({ ok: true, parsed });
      return false;
    }

    if (msg.type === 'EH_APPLY_MANUAL_COOKIES') {
      (async () => {
        const parsedFromRaw = msg.rawCookieString ? parseCookieInput(msg.rawCookieString) : {};
        const memberId = cleanCookieValue(
          msg.exCookieMemberId !== undefined ? msg.exCookieMemberId : parsedFromRaw.ipb_member_id
        );
        const passHash = cleanCookieValue(
          msg.exCookiePassHash !== undefined ? msg.exCookiePassHash : parsedFromRaw.ipb_pass_hash
        );
        const igneous = cleanCookieValue(
          msg.exCookieIgneous !== undefined ? msg.exCookieIgneous : parsedFromRaw.igneous
        );
        const sk = cleanCookieValue(
          msg.exCookieSk !== undefined ? msg.exCookieSk : parsedFromRaw.sk
        );

        const nextSettings = await saveSettings({
          enableExCookieManager: true,
          exCookieMemberId: memberId,
          exCookiePassHash: passHash,
          exCookieIgneous: igneous,
          exCookieSk: sk,
          ...(msg.syncCookieToMirror !== undefined
            ? { syncCookieToMirror: Boolean(msg.syncCookieToMirror) }
            : {})
        });

        const cookieStatus = await ensureExhentaiCookies({
          force: true,
          forceManual: Boolean(memberId && passHash),
          alsoApplyToEh: msg.alsoApplyToEh !== false
        });

        sendResponse({
          ok: true,
          settings: nextSettings,
          cookieStatus
        });
      })();
      return true;
    }

    if (msg.type === 'EH_CLEAR_MANUAL_COOKIES') {
      (async () => {
        const nextSettings = await saveSettings({
          exCookieMemberId: '',
          exCookiePassHash: '',
          exCookieIgneous: '',
          exCookieSk: ''
        });
        const cookieStatus = await inspectCookieStatus(nextSettings);
        sendResponse({ ok: true, settings: nextSettings, cookieStatus });
      })();
      return true;
    }

    if (msg.type === 'EH_OPEN_DASHBOARD') {
      (async () => {
        const hash = msg.hash ? `#${String(msg.hash).replace(/^#/, '')}` : '';
        const dashboardUrl = chrome.runtime.getURL('dashboard.html') + hash;
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
        sendResponse({ ok: true });
      })();
      return true;
    }

    if (msg.type === 'EH_NOTIFY_BADGE') {
      flashBadge(msg.text || 'OK', msg.color || '#10b981');
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'EH_CONVERT_URL') {
      getSettings().then((settings) => {
        const effective =
          msg.previewSettings && typeof msg.previewSettings === 'object'
            ? mergeSettings(msg.previewSettings, settings)
            : settings;
        sendResponse({
          ok: true,
          converted: convertGalleryUrl(msg.url, effective),
          redirect: resolveRedirectDecision(msg.url, effective, null)
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
    cleanCookieValue,
    isValidIgneous,
    parseCookieInput,
    summarizeDomainCookies,
    formatCookieHeaderString,
    flattenSettingsInput,
    mergeSettings,
    formatSettingsObjectForFile,
    classifyHost,
    convertGalleryUrl,
    resolveRedirectDecision
  };
}
