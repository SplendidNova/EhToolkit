'use strict';

(() => {
  const FAVORITES_STORAGE_KEY = 'eh_favorites_data';
  const IMPORT_HISTORY_KEY = 'eh_import_history';
  const TAG_CACHE_KEY = 'eh_tag_cache';
  const DEFAULT_OFFICIAL_API_URL = 'https://api.e-hentai.org/api.php';
  const DEFAULT_HIGHLIGHT_TAGS = ['female:stocking', 'female:stockings'];
  const DEFAULT_HIGHLIGHT_LABEL = 'female:stocking(s)';
  const DEFAULT_SAMPLE_GALLERY_PATH = '/g/1000000/0123456789/';
  const GALLERY_HREF_RE = /\/g\/(\d+)\/([0-9a-f]{10})(?:\/|$|\?|#)/i;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function chunkArray(arr, size) {
    const chunks = [];
    const step = Math.max(1, Number(size) || 25);
    for (let i = 0; i < arr.length; i += step) {
      chunks.push(arr.slice(i, i + step));
    }
    return chunks;
  }

  function normalizeOrigin(input) {
    if (!input || typeof input !== 'string') return '';
    let s = input.trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) {
      s = `https://${s}`;
    }
    try {
      const u = new URL(s);
      return `${u.protocol}//${u.host}`;
    } catch {
      return '';
    }
  }

  function isLoginOrErrorPage(doc, rawHtml) {
    const html = typeof rawHtml === 'string' ? rawHtml : '';
    if (
      html.includes('This page requires you to log on') ||
      html.includes('You must be logged in') ||
      html.includes('Username or email')
    ) {
      return true;
    }
    if (!doc) return true;
    const hasLoginForm = Boolean(
      doc.querySelector('form[action*="Login"], input[name="UserName"], input[name="PassWord"]')
    );
    if (hasLoginForm) return true;
    const hasFavBar = Boolean(doc.querySelector('.nosel'));
    const hasGalleryList = Boolean(doc.querySelector('.itg'));
    if (!hasFavBar && !hasGalleryList) {
      return true;
    }
    return false;
  }

  function parseFavoritesCategories(doc) {
    const names = {};
    for (let i = 0; i < 10; i++) {
      names[i] = `Favorites ${i}`;
    }
    if (!doc) return names;

    const fpNodes = Array.from(doc.querySelectorAll('.nosel .fp'));
    for (const node of fpNodes) {
      const onclick = node.getAttribute ? node.getAttribute('onclick') || '' : '';
      let match = onclick.match(/favcat=(\d+)/i);
      if (!match && node.querySelector) {
        const anchor = node.querySelector('a[href*="favcat="]');
        if (anchor && anchor.getAttribute) {
          match = (anchor.getAttribute('href') || '').match(/favcat=(\d+)/i);
        }
      }
      if (!match) continue;
      const catIdx = Number(match[1]);
      if (catIdx < 0 || catIdx > 9) continue;

      const divs = node.querySelectorAll ? Array.from(node.querySelectorAll('div')) : [];
      if (divs.length >= 3) {
        const label = (divs[divs.length - 1].textContent || '').trim();
        if (label) names[catIdx] = label;
      } else if (divs.length > 0) {
        const label = (divs[divs.length - 1].textContent || '').trim();
        if (label && !/^\d+$/.test(label)) names[catIdx] = label;
      }
    }
    return names;
  }

  function extractNextPageUrl(doc, currentUrl) {
    if (!doc) return null;
    const primaryNext = doc.querySelector('a#unext[href], a#dnext[href]');
    if (primaryNext) {
      const href = (primaryNext.getAttribute('href') || '').trim();
      if (href && href !== '#') {
        try {
          return new URL(href, currentUrl).toString();
        } catch {
          // fallback
        }
      }
    }

    const pttLinks = Array.from(doc.querySelectorAll('table.ptt a[href], .searchnav a[href]'));
    for (const a of pttLinks) {
      const text = (a.textContent || '').trim();
      const href = (a.getAttribute('href') || '').trim();
      if (!href || href === '#') continue;
      if (text === '>' || text === 'Next >' || text.toLowerCase() === 'next') {
        try {
          return new URL(href, currentUrl).toString();
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  function parseFavoritesDocument(doc, favcat, currentUrl, rawHtml) {
    if (isLoginOrErrorPage(doc, rawHtml)) {
      return {
        loginRequired: true,
        categoryNames: parseFavoritesCategories(doc),
        galleries: [],
        nextPageUrl: null
      };
    }

    const categoryNames = parseFavoritesCategories(doc);
    const scope = doc.querySelector('.itg') || doc;
    const anchors = Array.from(scope.querySelectorAll('a[href]'));
    const byGid = new Map();

    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const m = href.match(GALLERY_HREF_RE);
      if (!m) continue;

      const gid = m[1];
      const token = m[2].toLowerCase();
      const container =
        (a.closest && a.closest('tr, .gl1t, .gl1e, .id1, .gl3t')) || a.parentElement;

      let title = '';
      if (container && container.querySelector) {
        const glink = container.querySelector('.glink');
        if (glink && glink.textContent) {
          title = glink.textContent.trim();
        }
      }
      if (!title && a.querySelector) {
        const innerGlink = a.querySelector('.glink');
        if (innerGlink && innerGlink.textContent) {
          title = innerGlink.textContent.trim();
        }
      }
      if (!title && a.textContent) {
        const directText = a.textContent.trim();
        if (directText) title = directText;
      }
      if (!title && container && container.querySelector) {
        const img = container.querySelector('img');
        if (img && img.getAttribute) {
          title = (img.getAttribute('title') || img.getAttribute('alt') || '').trim();
        }
      }

      let favnote = '';
      if (container && container.querySelector) {
        const noteEl =
          container.querySelector(`#favnote_${gid}`) ||
          container.querySelector('div[id^="favnote_"], .favnote');
        if (noteEl && noteEl.textContent) {
          favnote = noteEl.textContent.trim().replace(/^Note:\s*/i, '');
        }
      }

      if (!byGid.has(gid)) {
        byGid.set(gid, {
          gid,
          token,
          title: title || `Gallery ${gid}`,
          favnote,
          favcat
        });
      } else {
        const existing = byGid.get(gid);
        if (title && existing.title === `Gallery ${gid}`) {
          existing.title = title;
        }
        if (favnote && !existing.favnote) {
          existing.favnote = favnote;
        }
      }
    }

    return {
      loginRequired: false,
      categoryNames,
      galleries: Array.from(byGid.values()),
      nextPageUrl: extractNextPageUrl(doc, currentUrl)
    };
  }

  function parseFavoritesHtml(html, favcat, currentUrl, customParser) {
    const doc = customParser
      ? customParser(html)
      : new DOMParser().parseFromString(html, 'text/html');
    return parseFavoritesDocument(doc, favcat, currentUrl, html);
  }

  function computeTagStats(favoritesData, tagCache, options) {
    const rawHighlightTags =
      options && Array.isArray(options.highlightTags) && options.highlightTags.length > 0
        ? options.highlightTags
        : DEFAULT_HIGHLIGHT_TAGS;
    const normalizedHighlightList = rawHighlightTags
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean);
    const highlightTagSet = new Set(
      normalizedHighlightList.length > 0 ? normalizedHighlightList : DEFAULT_HIGHLIGHT_TAGS
    );
    const highlightTagLabel =
      options && typeof options.highlightTagLabel === 'string' && options.highlightTagLabel.trim()
        ? options.highlightTagLabel.trim()
        : DEFAULT_HIGHLIGHT_LABEL;

    const uniqueGalleries = new Map();
    const categories =
      favoritesData && Array.isArray(favoritesData.categories)
        ? favoritesData.categories
        : [];

    for (const cat of categories) {
      const catName = cat.name || `Favorites ${cat.favcat}`;
      const list = Array.isArray(cat.galleries) ? cat.galleries : [];
      for (const item of list) {
        const gid = String(item.gid);
        if (!uniqueGalleries.has(gid)) {
          uniqueGalleries.set(gid, {
            gid,
            token: item.token,
            title: item.title || `Gallery ${gid}`,
            favcat: cat.favcat,
            favcatName: catName
          });
        }
      }
    }

    const artistMap = new Map();
    const groupMap = new Map();
    const parodyMap = new Map();
    const stockingGalleries = [];
    const galleryMap = {};

    let fetchedGalleries = 0;
    let errorGalleries = 0;
    let unfetchedGalleries = 0;
    let galleriesWithArtist = 0;
    let galleriesWithGroup = 0;
    let galleriesWithParody = 0;

    function addTagEntry(targetMap, name, gid) {
      if (!targetMap.has(name)) {
        targetMap.set(name, { name, count: 0, gids: [] });
      }
      const entry = targetMap.get(name);
      entry.count += 1;
      entry.gids.push(gid);
    }

    for (const [gid, info] of uniqueGalleries.entries()) {
      const cached = tagCache && tagCache[gid];
      if (!cached) {
        unfetchedGalleries += 1;
        galleryMap[gid] = info;
        continue;
      }
      if (cached.error) {
        errorGalleries += 1;
        galleryMap[gid] = info;
        continue;
      }

      fetchedGalleries += 1;
      const mergedInfo = {
        ...info,
        title: cached.title || info.title
      };
      galleryMap[gid] = mergedInfo;

      const tags = Array.isArray(cached.tags) ? cached.tags : [];
      const artistsInGallery = new Set();
      const groupsInGallery = new Set();
      const parodiesInGallery = new Set();
      const matchedStockingTags = [];

      for (const rawTag of tags) {
        if (typeof rawTag !== 'string') continue;
        const trimmed = rawTag.trim();
        const lower = trimmed.toLowerCase();

        if (highlightTagSet.has(lower)) {
          if (!matchedStockingTags.includes(lower)) {
            matchedStockingTags.push(lower);
          }
        }

        const colonIdx = trimmed.indexOf(':');
        if (colonIdx <= 0) continue;
        const ns = trimmed.slice(0, colonIdx).trim().toLowerCase();
        const val = trimmed.slice(colonIdx + 1).trim().toLowerCase();
        if (!val) continue;

        if (ns === 'artist') {
          artistsInGallery.add(val);
        } else if (ns === 'group') {
          groupsInGallery.add(val);
        } else if (ns === 'parody') {
          parodiesInGallery.add(val);
        }
      }

      if (artistsInGallery.size > 0) {
        galleriesWithArtist += 1;
        for (const a of artistsInGallery) addTagEntry(artistMap, a, gid);
      }
      if (groupsInGallery.size > 0) {
        galleriesWithGroup += 1;
        for (const g of groupsInGallery) addTagEntry(groupMap, g, gid);
      }
      if (parodiesInGallery.size > 0) {
        galleriesWithParody += 1;
        for (const p of parodiesInGallery) addTagEntry(parodyMap, p, gid);
      }
      if (matchedStockingTags.length > 0) {
        stockingGalleries.push({
          ...mergedInfo,
          matchedTags: matchedStockingTags
        });
      }
    }

    const sortDefault = (a, b) => b.count - a.count || a.name.localeCompare(b.name);
    const totalGalleries = uniqueGalleries.size;
    const baseDenominator = fetchedGalleries > 0 ? fetchedGalleries : totalGalleries;
    const stockingPct =
      baseDenominator > 0
        ? ((stockingGalleries.length / baseDenominator) * 100).toFixed(1)
        : '0.0';

    return {
      totalGalleries,
      fetchedGalleries,
      errorGalleries,
      unfetchedGalleries,
      galleriesWithArtist,
      galleriesWithGroup,
      galleriesWithParody,
      highlightTags: Array.from(highlightTagSet),
      highlightTagLabel,
      artists: Array.from(artistMap.values()).sort(sortDefault),
      groups: Array.from(groupMap.values()).sort(sortDefault),
      parodies: Array.from(parodyMap.values()).sort(sortDefault),
      stocking: {
        count: stockingGalleries.length,
        percentage: stockingPct,
        galleries: stockingGalleries
      },
      galleryMap
    };
  }

  function formatStatsSummaryText(stats) {
    const tagListText =
      Array.isArray(stats.highlightTags) && stats.highlightTags.length > 0
        ? stats.highlightTags.join(' / ')
        : DEFAULT_HIGHLIGHT_TAGS.join(' / ');
    const lines = [];
    lines.push('=== EH 收藏夹标签统计结果 ===');
    lines.push(`去重画廊总数: ${stats.totalGalleries}`);
    lines.push(`已成功解析标签画廊数: ${stats.fetchedGalleries}`);
    lines.push(`含有 ${tagListText} 标签的画廊数: ${stats.stocking.count} (${stats.stocking.percentage}%)`);
    lines.push('');
    lines.push(`[Artist 列表 - 共 ${stats.artists.length} 位，覆盖 ${stats.galleriesWithArtist} 个画廊]`);
    stats.artists.forEach((item, idx) => {
      lines.push(`${idx + 1}. ${item.name} (${item.count})`);
    });
    lines.push('');
    lines.push(`[Group 列表 - 共 ${stats.groups.length} 个，覆盖 ${stats.galleriesWithGroup} 个画廊]`);
    stats.groups.forEach((item, idx) => {
      lines.push(`${idx + 1}. ${item.name} (${item.count})`);
    });
    lines.push('');
    lines.push(`[Parody 列表 - 共 ${stats.parodies.length} 部，覆盖 ${stats.galleriesWithParody} 个画廊]`);
    stats.parodies.forEach((item, idx) => {
      lines.push(`${idx + 1}. ${item.name} (${item.count})`);
    });
    return lines.join('\n');
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.__EH_DASHBOARD_EXPORTS__ = {
      isLoginOrErrorPage,
      parseFavoritesCategories,
      extractNextPageUrl,
      parseFavoritesDocument,
      parseFavoritesHtml,
      computeTagStats,
      formatStatsSummaryText,
      chunkArray,
      normalizeOrigin
    };
  }

  // Stop here when loaded inside non-browser unit-test runtime
  if (typeof document === 'undefined' || typeof chrome === 'undefined' || !chrome.storage) {
    return;
  }

  // --- UI State & Controllers ---
  let settings = {};
  let fileDefaults = null;
  let fileSource = 'settings.json';
  let favoritesData = null;
  let importHistory = {};
  let tagCache = {};
  let currentStats = null;

  let selectedCatSet = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  let previewFavcat = 0;
  let activeSubtab = 'artist';

  let readAbort = null;
  let importController = { state: 'idle', aborted: false, resumeResolver: null, failedItems: [] };
  let tagController = { state: 'idle', aborted: false, resumeResolver: null };

  const els = {
    siteSelect: document.getElementById('siteSelect'),
    customOriginInput: document.getElementById('customOriginInput'),
    detectSiteBtn: document.getElementById('detectSiteBtn'),
    transferDisabledBanner: document.getElementById('transferDisabledBanner'),
    enableFavTransferInlineBtn: document.getElementById('enableFavTransferInlineBtn'),
    tagsDisabledBanner: document.getElementById('tagsDisabledBanner'),
    enableTagStatsInlineBtn: document.getElementById('enableTagStatsInlineBtn'),

    // Tab 1
    readAllFavsBtn: document.getElementById('readAllFavsBtn'),
    stopReadFavsBtn: document.getElementById('stopReadFavsBtn'),
    readDelayInput: document.getElementById('readDelayInput'),
    exportFavBackupBtn: document.getElementById('exportFavBackupBtn'),
    importFavBackupInput: document.getElementById('importFavBackupInput'),
    clearFavCacheBtn: document.getElementById('clearFavCacheBtn'),
    readProgressBox: document.getElementById('readProgressBox'),
    readStatusText: document.getElementById('readStatusText'),
    readPercentText: document.getElementById('readPercentText'),
    readProgressFill: document.getElementById('readProgressFill'),
    favSummaryText: document.getElementById('favSummaryText'),
    selectAllCatsBtn: document.getElementById('selectAllCatsBtn'),
    deselectAllCatsBtn: document.getElementById('deselectAllCatsBtn'),
    favCategoryGrid: document.getElementById('favCategoryGrid'),
    favPreviewSection: document.getElementById('favPreviewSection'),
    favPreviewTitle: document.getElementById('favPreviewTitle'),
    favPreviewSearch: document.getElementById('favPreviewSearch'),
    favPreviewTbody: document.getElementById('favPreviewTbody'),

    startImportBtn: document.getElementById('startImportBtn'),
    pauseImportBtn: document.getElementById('pauseImportBtn'),
    resumeImportBtn: document.getElementById('resumeImportBtn'),
    stopImportBtn: document.getElementById('stopImportBtn'),
    reverseOrderCheck: document.getElementById('reverseOrderCheck'),
    skipImportedCheck: document.getElementById('skipImportedCheck'),
    importDelayInput: document.getElementById('importDelayInput'),
    retryFailedImportBtn: document.getElementById('retryFailedImportBtn'),
    clearImportHistoryBtn: document.getElementById('clearImportHistoryBtn'),
    impTotalCount: document.getElementById('impTotalCount'),
    impSuccessCount: document.getElementById('impSuccessCount'),
    impSkippedCount: document.getElementById('impSkippedCount'),
    impFailedCount: document.getElementById('impFailedCount'),
    importProgressBox: document.getElementById('importProgressBox'),
    importStatusText: document.getElementById('importStatusText'),
    importPercentText: document.getElementById('importPercentText'),
    importProgressFill: document.getElementById('importProgressFill'),
    importLogBox: document.getElementById('importLogBox'),

    // Tab 2
    tagStatsHeading: document.getElementById('tagStatsHeading'),
    tagStatsSubheading: document.getElementById('tagStatsSubheading'),
    scanAndFetchTagsBtn: document.getElementById('scanAndFetchTagsBtn'),
    fetchTagsFromCacheBtn: document.getElementById('fetchTagsFromCacheBtn'),
    pauseTagFetchBtn: document.getElementById('pauseTagFetchBtn'),
    resumeTagFetchBtn: document.getElementById('resumeTagFetchBtn'),
    stopTagFetchBtn: document.getElementById('stopTagFetchBtn'),
    tagDelayInput: document.getElementById('tagDelayInput'),
    tagCacheStatus: document.getElementById('tagCacheStatus'),
    clearTagCacheBtn: document.getElementById('clearTagCacheBtn'),
    tagProgressBox: document.getElementById('tagProgressBox'),
    tagStatusText: document.getElementById('tagStatusText'),
    tagPercentText: document.getElementById('tagPercentText'),
    tagProgressFill: document.getElementById('tagProgressFill'),
    statTotalGalleries: document.getElementById('statTotalGalleries'),
    statFetchedSub: document.getElementById('statFetchedSub'),
    statArtistUnique: document.getElementById('statArtistUnique'),
    statArtistCovered: document.getElementById('statArtistCovered'),
    statGroupUnique: document.getElementById('statGroupUnique'),
    statGroupCovered: document.getElementById('statGroupCovered'),
    statParodyUnique: document.getElementById('statParodyUnique'),
    statParodyCovered: document.getElementById('statParodyCovered'),
    statHighlightTagName: document.getElementById('statHighlightTagName'),
    statStockingCount: document.getElementById('statStockingCount'),
    statStockingSub: document.getElementById('statStockingSub'),
    countBadgeArtist: document.getElementById('countBadgeArtist'),
    countBadgeGroup: document.getElementById('countBadgeGroup'),
    countBadgeParody: document.getElementById('countBadgeParody'),
    subtabHighlightTagName: document.getElementById('subtabHighlightTagName'),
    countBadgeStocking: document.getElementById('countBadgeStocking'),
    tagSearchInput: document.getElementById('tagSearchInput'),
    tagSortSelect: document.getElementById('tagSortSelect'),
    copyStatsSummaryBtn: document.getElementById('copyStatsSummaryBtn'),
    exportStatsJsonBtn: document.getElementById('exportStatsJsonBtn'),
    exportStatsCsvBtn: document.getElementById('exportStatsCsvBtn'),
    tagResultNotice: document.getElementById('tagResultNotice'),
    tagResultThead: document.getElementById('tagResultThead'),
    tagResultTbody: document.getElementById('tagResultTbody'),

    // Tab 3 Settings
    setEnableFavTransfer: document.getElementById('setEnableFavTransfer'),
    setEnableTagStats: document.getElementById('setEnableTagStats'),
    setTagStatsDesc: document.getElementById('setTagStatsDesc'),
    setEnableMirrorRedirect: document.getElementById('setEnableMirrorRedirect'),
    setEnableShortcutCopy: document.getElementById('setEnableShortcutCopy'),
    setEnableDomainSwapRedirect: document.getElementById('setEnableDomainSwapRedirect'),
    setMirrorDomain: document.getElementById('setMirrorDomain'),
    setMirrorSourceScope: document.getElementById('setMirrorSourceScope'),
    setDomainSwapRedirectMode: document.getElementById('setDomainSwapRedirectMode'),
    setRedirectPriority: document.getElementById('setRedirectPriority'),
    setRedirectExternalOnly: document.getElementById('setRedirectExternalOnly'),
    setCopyTargetDomain: document.getElementById('setCopyTargetDomain'),
    setShortcutInput: document.getElementById('setShortcutInput'),
    setResetShortcutBtn: document.getElementById('setResetShortcutBtn'),
    setMirrorCopyTargetRow: document.getElementById('setMirrorCopyTargetRow'),
    setMirrorCopyTarget: document.getElementById('setMirrorCopyTarget'),
    setOpenBrowserShortcutsBtn: document.getElementById('setOpenBrowserShortcutsBtn'),

    // File settings & advanced controls
    fileSettingsSourceText: document.getElementById('fileSettingsSourceText'),
    reloadFileSettingsBtn: document.getElementById('reloadFileSettingsBtn'),
    exportSettingsJsonBtn: document.getElementById('exportSettingsJsonBtn'),
    importSettingsJsonInput: document.getElementById('importSettingsJsonInput'),
    setHighlightTags: document.getElementById('setHighlightTags'),
    setHighlightTagLabel: document.getElementById('setHighlightTagLabel'),
    setSampleGalleryPath: document.getElementById('setSampleGalleryPath'),
    setApiBatchSize: document.getElementById('setApiBatchSize'),
    setTagCooldownEveryBatches: document.getElementById('setTagCooldownEveryBatches'),
    setTagCooldownExtraMs: document.getElementById('setTagCooldownExtraMs'),
    setRedirectDedupWindowMs: document.getElementById('setRedirectDedupWindowMs'),
    setCopyDedupWindowMs: document.getElementById('setCopyDedupWindowMs'),
    setToastDurationMs: document.getElementById('setToastDurationMs'),
    settingsActionNotice: document.getElementById('settingsActionNotice'),

    testerUrlInput: document.getElementById('testerUrlInput'),
    testerRedirectOutput: document.getElementById('testerRedirectOutput'),
    testerCopyOutput: document.getElementById('testerCopyOutput'),

    // Modal
    galleryModal: document.getElementById('galleryModal'),
    galleryModalBackdrop: document.getElementById('galleryModalBackdrop'),
    galleryModalTitle: document.getElementById('galleryModalTitle'),
    closeGalleryModalBtn: document.getElementById('closeGalleryModalBtn'),
    galleryModalTbody: document.getElementById('galleryModalTbody')
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

  function getSamplePath() {
    const p = (settings && settings.sampleGalleryPath) || DEFAULT_SAMPLE_GALLERY_PATH;
    return p.startsWith('/') ? p : `/${p}`;
  }

  function buildPresetUrl(kind) {
    const samplePath = getSamplePath();
    if (kind === 'e-hentai') {
      return `https://e-hentai.org${samplePath}`;
    }
    if (kind === 'mirror') {
      const m = (settings && settings.mirrorDomain) || 'mirror.example.com';
      return `https://${m}${samplePath}`;
    }
    return `https://exhentai.org${samplePath}`;
  }

  function applyDefaultActiveSite() {
    const target = (settings && settings.defaultActiveSite) || 'https://exhentai.org';
    if (target === 'mirror' && settings.mirrorDomain) {
      els.siteSelect.value = 'mirror';
      els.customOriginInput.classList.add('hidden');
    } else if (target === 'https://e-hentai.org') {
      els.siteSelect.value = 'https://e-hentai.org';
      els.customOriginInput.classList.add('hidden');
    } else if (target === 'https://exhentai.org') {
      els.siteSelect.value = 'https://exhentai.org';
      els.customOriginInput.classList.add('hidden');
    } else {
      const normalized = normalizeOrigin(target);
      if (normalized) {
        els.siteSelect.value = 'custom';
        els.customOriginInput.value = normalized;
        els.customOriginInput.classList.remove('hidden');
      }
    }
  }

  function getActiveOrigin() {
    const val = els.siteSelect.value;
    if (val === 'mirror') {
      if (settings.mirrorDomain) {
        return `https://${settings.mirrorDomain}`;
      }
      return 'https://exhentai.org';
    }
    if (val === 'custom') {
      return normalizeOrigin(els.customOriginInput.value) || 'https://exhentai.org';
    }
    return val;
  }

  function refreshSiteSelectLabels() {
    const mirrorOpt = els.siteSelect.querySelector('option[value="mirror"]');
    if (mirrorOpt) {
      if (settings.mirrorDomain) {
        mirrorOpt.textContent = `https://${settings.mirrorDomain} (镜像站)`;
      } else {
        mirrorOpt.textContent = '镜像站 (未配置域名)';
      }
    }
  }

  async function detectOpenSite() {
    const tabs = await chrome.tabs.query({});
    const mirrorDomain = (settings.mirrorDomain || '').toLowerCase();
    const matchTab =
      (mirrorDomain &&
        tabs.find((t) => {
          if (!t.url) return false;
          try {
            const h = new URL(t.url).hostname.toLowerCase();
            return h === mirrorDomain;
          } catch {
            return false;
          }
        })) ||
      tabs.find((t) => {
        if (!t.url) return false;
        try {
          const h = new URL(t.url).hostname.toLowerCase();
          return h === 'exhentai.org' || h === 'e-hentai.org';
        } catch {
          return false;
        }
      });

    if (!matchTab) {
      appendImportLog('未检测到已打开的 e-hentai / exhentai / 镜像站标签页', 'warn');
      return;
    }

    const host = new URL(matchTab.url).hostname.toLowerCase();
    if (mirrorDomain && host === mirrorDomain) {
      els.siteSelect.value = 'mirror';
      els.customOriginInput.classList.add('hidden');
    } else if (host === 'exhentai.org' || host === 'www.exhentai.org') {
      els.siteSelect.value = 'https://exhentai.org';
      els.customOriginInput.classList.add('hidden');
    } else if (host === 'e-hentai.org' || host === 'www.e-hentai.org') {
      els.siteSelect.value = 'https://e-hentai.org';
      els.customOriginInput.classList.add('hidden');
    }
    appendImportLog(`已切换当前操作站点为: ${getActiveOrigin()}`, 'info');
    renderFavoritesView();
  }

  function appendImportLog(text, level = 'info') {
    const line = document.createElement('div');
    line.className = `log-line log-${level}`;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    line.textContent = `[${time}] ${text}`;
    els.importLogBox.appendChild(line);
    els.importLogBox.scrollTop = els.importLogBox.scrollHeight;
  }

  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // --- Feature 1: Reading & Importing Favorites ---
  async function fetchCategoryPages(origin, favcat, delayMs, signal, onPageProgress) {
    let nextUrl = `${origin}/favorites.php?favcat=${favcat}`;
    const visited = new Set();
    const galleryMap = new Map();
    let categoryNames = null;
    let pageNum = 0;

    while (nextUrl && !visited.has(nextUrl)) {
      if (signal && signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      visited.add(nextUrl);
      pageNum += 1;
      onPageProgress(pageNum);

      const res = await fetch(nextUrl, { credentials: 'include', signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} (${nextUrl})`);
      }
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('text/html')) {
        throw new Error('站点未返回 HTML 页面（如在 exhentai 遇到 Sad Panda，请先登录或切换到镜像站）');
      }

      const html = await res.text();
      const parsed = parseFavoritesHtml(html, favcat, nextUrl);
      if (parsed.loginRequired) {
        throw new Error(`站点 ${origin} 未登录或登录已失效，请先在浏览器中登录账号后重试`);
      }

      if (!categoryNames) {
        categoryNames = parsed.categoryNames;
      }

      for (const item of parsed.galleries) {
        if (!galleryMap.has(item.gid)) {
          galleryMap.set(item.gid, item);
        }
      }

      nextUrl = parsed.nextPageUrl;
      if (nextUrl && !visited.has(nextUrl)) {
        await sleep(delayMs);
      }
    }

    return {
      favcat,
      name: (categoryNames && categoryNames[favcat]) || `Favorites ${favcat}`,
      galleries: Array.from(galleryMap.values())
    };
  }

  async function runReadAllFavorites(silentIfSuccess = false) {
    if (!settings.enableFavTransfer && !silentIfSuccess) {
      appendImportLog('功能 1 当前已关闭，请先开启后再读取收藏夹', 'warn');
      return null;
    }

    const origin = getActiveOrigin();
    const minDelay = Number(settings.readDelayMinMs) || 100;
    const defaultDelay = Number(settings.readDelayMs) || 350;
    const delayMs = Math.max(minDelay, Number(els.readDelayInput.value) || defaultDelay);
    readAbort = new AbortController();

    els.readAllFavsBtn.disabled = true;
    els.stopReadFavsBtn.classList.remove('hidden');
    els.readProgressBox.classList.remove('hidden');
    appendImportLog(`开始从 ${origin} 读取 10 个收藏夹 (favcat 0~9)...`, 'info');

    const categories = [];
    try {
      for (let favcat = 0; favcat < 10; favcat++) {
        const result = await fetchCategoryPages(
          origin,
          favcat,
          delayMs,
          readAbort.signal,
          (pageNum) => {
            const pct = Math.round(((favcat + 0.3) / 10) * 100);
            els.readStatusText.textContent = `正在读取 favcat ${favcat} (第 ${pageNum} 页)...`;
            els.readPercentText.textContent = `${pct}%`;
            els.readProgressFill.style.width = `${pct}%`;
          }
        );
        categories.push(result);
        appendImportLog(
          `读取完成 favcat ${favcat} [${result.name}]：共 ${result.galleries.length} 个画廊`,
          'ok'
        );
        const pctDone = Math.round(((favcat + 1) / 10) * 100);
        els.readPercentText.textContent = `${pctDone}%`;
        els.readProgressFill.style.width = `${pctDone}%`;

        if (favcat < 9) {
          await sleep(delayMs);
        }
      }

      favoritesData = {
        exportedAt: new Date().toISOString(),
        sourceOrigin: origin,
        categories
      };
      await chrome.storage.local.set({ [FAVORITES_STORAGE_KEY]: favoritesData });
      selectedCatSet = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      els.readStatusText.textContent = '10 个收藏夹全部读取完成！';
      renderFavoritesView();
      refreshTagStatsView();
      return favoritesData;
    } catch (err) {
      if (err.name === 'AbortError') {
        els.readStatusText.textContent = '已停止读取';
        appendImportLog('用户停止了收藏夹读取', 'warn');
      } else {
        els.readStatusText.textContent = `读取失败: ${err.message}`;
        appendImportLog(`读取失败: ${err.message}`, 'err');
      }
      return null;
    } finally {
      readAbort = null;
      els.readAllFavsBtn.disabled = false;
      els.stopReadFavsBtn.classList.add('hidden');
    }
  }

  function renderFavoritesView() {
    els.favCategoryGrid.textContent = '';
    if (!favoritesData || !Array.isArray(favoritesData.categories)) {
      els.favSummaryText.textContent = '尚未读取收藏夹数据';
      els.exportFavBackupBtn.disabled = true;
      els.startImportBtn.disabled = true;
      els.favPreviewSection.classList.add('hidden');
      els.impTotalCount.textContent = '0';
      return;
    }

    const totalCount = favoritesData.categories.reduce(
      (acc, c) => acc + (c.galleries ? c.galleries.length : 0),
      0
    );
    els.favSummaryText.textContent = `来源：${favoritesData.sourceOrigin || '-'} | 读取时间：${new Date(favoritesData.exportedAt).toLocaleString()} | 共 ${totalCount} 个画廊`;
    els.exportFavBackupBtn.disabled = totalCount === 0;
    els.startImportBtn.disabled = totalCount === 0 || !settings.enableFavTransfer;

    let selectedTotal = 0;
    for (const cat of favoritesData.categories) {
      const count = cat.galleries ? cat.galleries.length : 0;
      const checked = selectedCatSet.has(cat.favcat);
      if (checked) selectedTotal += count;

      const card = document.createElement('div');
      card.className = `cat-card${previewFavcat === cat.favcat ? ' selected-preview' : ''}`;

      const top = document.createElement('div');
      top.className = 'cat-card-top';

      const checkLabel = document.createElement('label');
      checkLabel.className = 'cat-check-wrap';
      checkLabel.addEventListener('click', (e) => e.stopPropagation());

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = checked;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selectedCatSet.add(cat.favcat);
        } else {
          selectedCatSet.delete(cat.favcat);
        }
        updateSelectedImportCount();
      });

      const idxSpan = document.createElement('span');
      idxSpan.textContent = `收藏夹 ${cat.favcat}`;
      checkLabel.appendChild(checkbox);
      checkLabel.appendChild(idxSpan);

      const badge = document.createElement('span');
      badge.className = 'cat-badge';
      badge.textContent = `${count} 本`;

      top.appendChild(checkLabel);
      top.appendChild(badge);

      const nameDiv = document.createElement('div');
      nameDiv.className = 'cat-name';
      nameDiv.textContent = cat.name || `Favorites ${cat.favcat}`;
      nameDiv.title = nameDiv.textContent;

      card.appendChild(top);
      card.appendChild(nameDiv);
      card.addEventListener('click', () => {
        previewFavcat = cat.favcat;
        renderFavoritesView();
      });

      els.favCategoryGrid.appendChild(card);
    }

    els.impTotalCount.textContent = String(selectedTotal);
    renderFavPreview();
  }

  function updateSelectedImportCount() {
    if (!favoritesData || !Array.isArray(favoritesData.categories)) {
      els.impTotalCount.textContent = '0';
      return;
    }
    let count = 0;
    for (const cat of favoritesData.categories) {
      if (selectedCatSet.has(cat.favcat) && Array.isArray(cat.galleries)) {
        count += cat.galleries.length;
      }
    }
    els.impTotalCount.textContent = String(count);
  }

  function renderFavPreview() {
    if (!favoritesData || !Array.isArray(favoritesData.categories)) {
      els.favPreviewSection.classList.add('hidden');
      return;
    }
    const cat = favoritesData.categories.find((c) => c.favcat === previewFavcat);
    if (!cat) {
      els.favPreviewSection.classList.add('hidden');
      return;
    }

    els.favPreviewSection.classList.remove('hidden');
    els.favPreviewTitle.textContent = `收藏夹 ${cat.favcat}「${cat.name}」预览 (${cat.galleries.length} 本)`;

    const query = (els.favPreviewSearch.value || '').trim().toLowerCase();
    const list = cat.galleries.filter((g) => {
      if (!query) return true;
      return (
        (g.title || '').toLowerCase().includes(query) ||
        String(g.gid).includes(query) ||
        (g.favnote || '').toLowerCase().includes(query)
      );
    });

    els.favPreviewTbody.textContent = '';
    const origin = getActiveOrigin();
    const previewLimit = Number(settings.favPreviewLimit) || 300;
    const displayList = list.slice(0, previewLimit);

    if (displayList.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'muted';
      td.textContent = '该收藏夹暂无匹配的画廊';
      tr.appendChild(td);
      els.favPreviewTbody.appendChild(tr);
      return;
    }

    displayList.forEach((g, idx) => {
      const tr = document.createElement('tr');

      const tdIdx = document.createElement('td');
      tdIdx.textContent = String(idx + 1);

      const tdTitle = document.createElement('td');
      const link = document.createElement('a');
      link.href = `${origin}/g/${g.gid}/${g.token}/`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = g.title || `Gallery ${g.gid}`;
      tdTitle.appendChild(link);

      const tdGid = document.createElement('td');
      const code = document.createElement('span');
      code.className = 'code-pill';
      code.textContent = `${g.gid}/${g.token}`;
      tdGid.appendChild(code);

      const tdNote = document.createElement('td');
      tdNote.textContent = g.favnote || '-';

      tr.appendChild(tdIdx);
      tr.appendChild(tdTitle);
      tr.appendChild(tdGid);
      tr.appendChild(tdNote);
      els.favPreviewTbody.appendChild(tr);
    });
  }

  async function waitIfPaused(controller) {
    while (controller.state === 'paused' && !controller.aborted) {
      await new Promise((resolve) => {
        controller.resumeResolver = resolve;
      });
    }
  }

  async function importSingleGallery(origin, item) {
    const endpoint = `${origin}/gallerypopups.php?gid=${encodeURIComponent(item.gid)}&t=${encodeURIComponent(item.token)}&act=addfav`;
    const body = new URLSearchParams();
    body.set('favcat', String(item.favcat));
    body.set('favnote', item.favnote || '');
    body.set('apply', 'Add to Favorites');
    body.set('update', '1');

    const res = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html')) {
      const err = new Error('站点返回非 HTML（请检查是否已在目标域名/镜像站登录账号）');
      err.fatalAuth = true;
      throw err;
    }

    const html = await res.text();
    if (
      html.includes('This page requires you to log on') ||
      html.includes('You must be logged in') ||
      html.includes('name="UserName"')
    ) {
      const err = new Error('当前操作站点未登录新账号，请先登录后再继续导入');
      err.fatalAuth = true;
      throw err;
    }

    if (
      html.includes('Invalid gallery') ||
      html.includes('Key missing') ||
      html.includes('Gallery not found')
    ) {
      throw new Error('画廊已被删除或密钥失效');
    }
  }

  function buildImportQueue(onlyFailedItems) {
    if (onlyFailedItems) {
      return [...onlyFailedItems];
    }
    const queue = [];
    const reverse = Boolean(els.reverseOrderCheck.checked);
    for (const cat of favoritesData.categories) {
      if (!selectedCatSet.has(cat.favcat)) continue;
      const list = Array.isArray(cat.galleries) ? [...cat.galleries] : [];
      if (reverse) list.reverse();
      for (const g of list) {
        queue.push({ ...g, favcat: cat.favcat });
      }
    }
    return queue;
  }

  async function runImportQueue(onlyFailedItems = null) {
    if (!settings.enableFavTransfer) {
      appendImportLog('功能 1 当前处于关闭状态，请先开启', 'warn');
      return;
    }
    if (!favoritesData || !Array.isArray(favoritesData.categories)) {
      appendImportLog('没有可导入的收藏夹数据，请先读取或导入备份', 'warn');
      return;
    }

    const queue = buildImportQueue(onlyFailedItems);
    if (queue.length === 0) {
      appendImportLog('当前选中的收藏夹没有可导入的画廊', 'warn');
      return;
    }

    const origin = getActiveOrigin();
    const minDelay = Number(settings.importDelayMinMs) || 150;
    const defaultDelay = Number(settings.importDelayMs) || 400;
    const delayMs = Math.max(minDelay, Number(els.importDelayInput.value) || defaultDelay);
    const skipImported = Boolean(els.skipImportedCheck.checked);
    const saveEveryN = Math.max(1, Number(settings.importSaveEveryN) || 10);

    importController.state = 'running';
    importController.aborted = false;
    importController.failedItems = [];

    els.startImportBtn.disabled = true;
    els.pauseImportBtn.classList.remove('hidden');
    els.resumeImportBtn.classList.add('hidden');
    els.stopImportBtn.classList.remove('hidden');
    els.retryFailedImportBtn.classList.add('hidden');
    els.importProgressBox.classList.remove('hidden');

    let successCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const total = queue.length;

    els.impTotalCount.textContent = String(total);
    els.impSuccessCount.textContent = '0';
    els.impSkippedCount.textContent = '0';
    els.impFailedCount.textContent = '0';

    appendImportLog(`开始向 ${origin} 导入 ${total} 个画廊...`, 'info');

    for (let i = 0; i < total; i++) {
      if (importController.aborted) break;
      await waitIfPaused(importController);
      if (importController.aborted) break;

      const item = queue[i];
      const gidKey = String(item.gid);

      if (skipImported && importHistory[gidKey] && Number(importHistory[gidKey].favcat) === Number(item.favcat)) {
        skippedCount += 1;
        els.impSkippedCount.textContent = String(skippedCount);
      } else {
        try {
          await importSingleGallery(origin, item);
          successCount += 1;
          importHistory[gidKey] = {
            favcat: item.favcat,
            importedAt: Date.now()
          };
          els.impSuccessCount.textContent = String(successCount);
          if (successCount % saveEveryN === 0) {
            await chrome.storage.local.set({ [IMPORT_HISTORY_KEY]: importHistory });
          }
          appendImportLog(
            `[favcat ${item.favcat}] 导入成功: ${item.gid} (${item.title})`,
            'ok'
          );
        } catch (err) {
          failedCount += 1;
          importController.failedItems.push(item);
          els.impFailedCount.textContent = String(failedCount);
          appendImportLog(
            `[favcat ${item.favcat}] 导入失败 ${item.gid}: ${err.message}`,
            'err'
          );
          if (err.fatalAuth) {
            importController.aborted = true;
            break;
          }
        }
        if (i < total - 1 && !importController.aborted) {
          await sleep(delayMs);
        }
      }

      const pct = Math.round(((i + 1) / total) * 100);
      els.importStatusText.textContent = `进度 ${i + 1} / ${total} (favcat ${item.favcat})`;
      els.importPercentText.textContent = `${pct}%`;
      els.importProgressFill.style.width = `${pct}%`;
    }

    await chrome.storage.local.set({ [IMPORT_HISTORY_KEY]: importHistory });

    importController.state = 'idle';
    els.startImportBtn.disabled = false;
    els.pauseImportBtn.classList.add('hidden');
    els.resumeImportBtn.classList.add('hidden');
    els.stopImportBtn.classList.add('hidden');

    if (importController.failedItems.length > 0) {
      els.retryFailedImportBtn.classList.remove('hidden');
    }

    els.importStatusText.textContent = importController.aborted
      ? '导入已终止'
      : `导入结束：成功 ${successCount}，跳过 ${skippedCount}，失败 ${failedCount}`;
    appendImportLog(els.importStatusText.textContent, failedCount > 0 ? 'warn' : 'ok');
  }

  // --- Feature 2: API Tag Extraction & Deduplicated Stats ---
  async function requestGdataBatch(origin, batch) {
    const payload = JSON.stringify({
      method: 'gdata',
      gidlist: batch.map((g) => [Number(g.gid), String(g.token)]),
      namespace: 1
    });

    const officialApiUrl = (settings && settings.officialApiUrl) || DEFAULT_OFFICIAL_API_URL;
    const candidates =
      origin === 'https://api.e-hentai.org'
        ? [officialApiUrl]
        : [`${origin}/api.php`, officialApiUrl];

    let lastError = null;
    for (const apiUrl of candidates) {
      try {
        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          credentials: apiUrl.startsWith(origin) ? 'include' : 'omit'
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        if (data && data.error) {
          throw new Error(`API 返回限制提示: ${data.error}`);
        }
        if (data && Array.isArray(data.gmetadata)) {
          return data.gmetadata;
        }
        throw new Error('API 返回结构缺少 gmetadata');
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('API 请求失败');
  }

  async function runTagFetch(scanFavoritesFirst) {
    if (!settings.enableTagStats) {
      els.tagResultNotice.textContent = '功能 2 当前已关闭，请先开启后再统计标签';
      return;
    }

    if (scanFavoritesFirst) {
      const scanned = await runReadAllFavorites(true);
      if (!scanned) return;
    }

    if (!favoritesData || !Array.isArray(favoritesData.categories)) {
      els.tagResultNotice.textContent = '当前尚未读取收藏夹，正在自动扫描当前站点收藏夹...';
      const scanned = await runReadAllFavorites(true);
      if (!scanned) return;
    }

    const uniqueMap = new Map();
    for (const cat of favoritesData.categories) {
      for (const item of cat.galleries || []) {
        const gid = String(item.gid);
        if (!uniqueMap.has(gid)) {
          uniqueMap.set(gid, {
            gid,
            token: item.token,
            title: item.title
          });
        }
      }
    }

    const allGalleries = Array.from(uniqueMap.values());
    const pending = allGalleries.filter((g) => !tagCache[g.gid] || tagCache[g.gid].error);

    refreshTagStatsView();
    if (pending.length === 0) {
      els.tagProgressBox.classList.remove('hidden');
      els.tagStatusText.textContent = `全部 ${allGalleries.length} 个收藏画廊均已命中缓存，统计已完成！`;
      els.tagPercentText.textContent = '100%';
      els.tagProgressFill.style.width = '100%';
      return;
    }

    const origin = getActiveOrigin();
    const minDelay = Number(settings.tagDelayMinMs) || 200;
    const defaultDelay = Number(settings.tagDelayMs) || 600;
    const delayMs = Math.max(minDelay, Number(els.tagDelayInput.value) || defaultDelay);
    const batchSize = Math.min(25, Math.max(1, Number(settings.apiBatchSize) || 25));
    const cooldownEvery = Number(settings.tagCooldownEveryBatches) || 0;
    const cooldownExtraMs = Number(settings.tagCooldownExtraMs) || 0;
    const batches = chunkArray(pending, batchSize);

    tagController.state = 'running';
    tagController.aborted = false;

    els.scanAndFetchTagsBtn.disabled = true;
    els.fetchTagsFromCacheBtn.disabled = true;
    els.pauseTagFetchBtn.classList.remove('hidden');
    els.resumeTagFetchBtn.classList.add('hidden');
    els.stopTagFetchBtn.classList.remove('hidden');
    els.tagProgressBox.classList.remove('hidden');

    let processed = 0;

    try {
      for (let b = 0; b < batches.length; b++) {
        if (tagController.aborted) break;
        await waitIfPaused(tagController);
        if (tagController.aborted) break;

        const batch = batches[b];
        els.tagStatusText.textContent = `正在获取标签第 ${b + 1}/${batches.length} 批 (${processed}/${pending.length})...`;

        const gmetadataList = await requestGdataBatch(origin, batch);
        for (const meta of gmetadataList) {
          const gid = String(meta.gid);
          if (meta.error) {
            tagCache[gid] = {
              gid,
              error: meta.error,
              fetchedAt: Date.now()
            };
          } else {
            tagCache[gid] = {
              gid,
              token: meta.token,
              title: meta.title_jpn || meta.title || '',
              tags: Array.isArray(meta.tags) ? meta.tags : [],
              fetchedAt: Date.now()
            };
          }
        }

        processed += batch.length;
        const pct = Math.round((processed / pending.length) * 100);
        els.tagPercentText.textContent = `${pct}%`;
        els.tagProgressFill.style.width = `${pct}%`;

        await chrome.storage.local.set({ [TAG_CACHE_KEY]: tagCache });
        refreshTagStatsView();

        if (b < batches.length - 1 && !tagController.aborted) {
          const extraPause =
            cooldownEvery > 0 && (b + 1) % cooldownEvery === 0 ? cooldownExtraMs : 0;
          await sleep(delayMs + extraPause);
        }
      }

      if (!tagController.aborted) {
        els.tagStatusText.textContent = '标签提取与去重统计全部完成！';
      } else {
        els.tagStatusText.textContent = '标签提取已停止（已获取部分已缓存）';
      }
    } catch (err) {
      els.tagStatusText.textContent = `获取标签出错: ${err.message}`;
      els.tagResultNotice.textContent = `请求中断: ${err.message}（可稍后点击“直接统计已读取的收藏夹”断点继续）`;
    } finally {
      tagController.state = 'idle';
      els.scanAndFetchTagsBtn.disabled = false;
      els.fetchTagsFromCacheBtn.disabled = false;
      els.pauseTagFetchBtn.classList.add('hidden');
      els.resumeTagFetchBtn.classList.add('hidden');
      els.stopTagFetchBtn.classList.add('hidden');
    }
  }

  function refreshTagStatsView() {
    const cacheCount = Object.keys(tagCache || {}).length;
    els.tagCacheStatus.textContent = `标签缓存：${cacheCount} 条`;

    const highlightLabel = (settings && settings.highlightTagLabel) || DEFAULT_HIGHLIGHT_LABEL;
    const highlightTags =
      settings && Array.isArray(settings.highlightTags) && settings.highlightTags.length > 0
        ? settings.highlightTags
        : DEFAULT_HIGHLIGHT_TAGS;
    const batchSize = Math.min(25, Math.max(1, Number(settings && settings.apiBatchSize) || 25));

    if (els.tagStatsHeading) {
      els.tagStatsHeading.textContent = `收藏夹画廊标签提取 (artist / group / parody / ${highlightLabel})`;
    }
    if (els.tagStatsSubheading) {
      els.tagStatsSubheading.textContent = `自动按每批 ${batchSize} 个画廊调用 API (namespace=1)，支持本地缓存与镜像站点自动回退官方 API。`;
    }
    if (els.statHighlightTagName) {
      els.statHighlightTagName.textContent = highlightLabel;
    }
    if (els.subtabHighlightTagName) {
      els.subtabHighlightTagName.textContent = highlightLabel;
    }

    currentStats = computeTagStats(favoritesData, tagCache, {
      highlightTags,
      highlightTagLabel: highlightLabel
    });

    els.statTotalGalleries.textContent = String(currentStats.totalGalleries);
    els.statFetchedSub.textContent =
      `已解析标签 ${currentStats.fetchedGalleries} 个` +
      (currentStats.errorGalleries ? `（错误 ${currentStats.errorGalleries}）` : '');

    els.statArtistUnique.textContent = String(currentStats.artists.length);
    els.statArtistCovered.textContent = `覆盖 ${currentStats.galleriesWithArtist} 个画廊`;

    els.statGroupUnique.textContent = String(currentStats.groups.length);
    els.statGroupCovered.textContent = `覆盖 ${currentStats.galleriesWithGroup} 个画廊`;

    els.statParodyUnique.textContent = String(currentStats.parodies.length);
    els.statParodyCovered.textContent = `覆盖 ${currentStats.galleriesWithParody} 个画廊`;

    els.statStockingCount.textContent = String(currentStats.stocking.count);
    els.statStockingSub.textContent = `占比 ${currentStats.stocking.percentage}%`;

    els.countBadgeArtist.textContent = String(currentStats.artists.length);
    els.countBadgeGroup.textContent = String(currentStats.groups.length);
    els.countBadgeParody.textContent = String(currentStats.parodies.length);
    els.countBadgeStocking.textContent = String(currentStats.stocking.count);

    renderTagResultTable();
  }

  function renderTagResultTable() {
    if (!currentStats) return;
    const search = (els.tagSearchInput.value || '').trim().toLowerCase();
    const sortMode = els.tagSortSelect.value;
    const origin = getActiveOrigin();

    els.tagResultThead.textContent = '';
    els.tagResultTbody.textContent = '';

    if (activeSubtab === 'stocking') {
      const headRow = document.createElement('tr');
      ['#', '画廊标题', 'GID / Token', '所属收藏夹', '命中标签'].forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        headRow.appendChild(th);
      });
      els.tagResultThead.appendChild(headRow);

      let rows = currentStats.stocking.galleries.filter((g) => {
        if (!search) return true;
        return (
          (g.title || '').toLowerCase().includes(search) ||
          String(g.gid).includes(search) ||
          g.matchedTags.some((t) => t.includes(search))
        );
      });

      if (sortMode === 'name_asc') {
        rows = [...rows].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      }

      const tagListText = (currentStats.highlightTags || DEFAULT_HIGHLIGHT_TAGS).join(' / ');
      els.tagResultNotice.textContent = `共统计到 ${currentStats.stocking.count} 个画廊含有 ${tagListText} 标签（占比 ${currentStats.stocking.percentage}%）。`;

      if (rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.className = 'muted';
        td.textContent = '暂无匹配的命中画廊';
        tr.appendChild(td);
        els.tagResultTbody.appendChild(tr);
        return;
      }

      rows.forEach((g, idx) => {
        const tr = document.createElement('tr');

        const tdIdx = document.createElement('td');
        tdIdx.textContent = String(idx + 1);

        const tdTitle = document.createElement('td');
        const link = document.createElement('a');
        link.href = `${origin}/g/${g.gid}/${g.token}/`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = g.title || `Gallery ${g.gid}`;
        tdTitle.appendChild(link);

        const tdGid = document.createElement('td');
        const code = document.createElement('span');
        code.className = 'code-pill';
        code.textContent = `${g.gid}/${g.token}`;
        tdGid.appendChild(code);

        const tdCat = document.createElement('td');
        tdCat.textContent = `${g.favcat}: ${g.favcatName}`;

        const tdTag = document.createElement('td');
        const tagPill = document.createElement('span');
        tagPill.className = 'code-pill';
        tagPill.textContent = g.matchedTags.join(', ');
        tdTag.appendChild(tagPill);

        tr.appendChild(tdIdx);
        tr.appendChild(tdTitle);
        tr.appendChild(tdGid);
        tr.appendChild(tdCat);
        tr.appendChild(tdTag);
        els.tagResultTbody.appendChild(tr);
      });
      return;
    }

    const listMap = {
      artist: currentStats.artists,
      group: currentStats.groups,
      parody: currentStats.parodies
    };
    const labelMap = {
      artist: 'Artist 名称',
      group: 'Group 名称',
      parody: 'Parody 名称'
    };

    const headRow = document.createElement('tr');
    ['#', labelMap[activeSubtab], '收藏画廊数量', '占比 (相对已解析)', '操作'].forEach((label) => {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    });
    els.tagResultThead.appendChild(headRow);

    let items = (listMap[activeSubtab] || []).filter((item) => {
      if (!search) return true;
      return item.name.toLowerCase().includes(search);
    });

    if (sortMode === 'name_asc') {
      items = [...items].sort((a, b) => a.name.localeCompare(b.name));
    } else {
      items = [...items].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    }

    els.tagResultNotice.textContent = `当前分类共去重列出 ${items.length} 项（已基于 ${currentStats.fetchedGalleries} 个已解析画廊统计）。`;

    if (items.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'muted';
      td.textContent = '暂无数据，请先点击「扫描收藏夹并统计标签」';
      tr.appendChild(td);
      els.tagResultTbody.appendChild(tr);
      return;
    }

    const denom = currentStats.fetchedGalleries || currentStats.totalGalleries || 1;
    items.forEach((item, idx) => {
      const tr = document.createElement('tr');

      const tdIdx = document.createElement('td');
      tdIdx.textContent = String(idx + 1);

      const tdName = document.createElement('td');
      tdName.textContent = item.name;

      const tdCount = document.createElement('td');
      const strong = document.createElement('strong');
      strong.textContent = String(item.count);
      tdCount.appendChild(strong);

      const tdPct = document.createElement('td');
      tdPct.textContent = `${((item.count / denom) * 100).toFixed(1)}%`;

      const tdAction = document.createElement('td');
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost btn-xs';
      btn.textContent = `查看 ${item.count} 个画廊`;
      btn.addEventListener('click', () => openGalleryModal(`${activeSubtab}:${item.name}`, item.gids));
      tdAction.appendChild(btn);

      tr.appendChild(tdIdx);
      tr.appendChild(tdName);
      tr.appendChild(tdCount);
      tr.appendChild(tdPct);
      tr.appendChild(tdAction);
      els.tagResultTbody.appendChild(tr);
    });
  }

  function openGalleryModal(title, gids) {
    if (!currentStats) return;
    const origin = getActiveOrigin();
    els.galleryModalTitle.textContent = `${title} (${gids.length} 本)`;
    els.galleryModalTbody.textContent = '';

    gids.forEach((gid, idx) => {
      const info = currentStats.galleryMap[String(gid)];
      if (!info) return;
      const tr = document.createElement('tr');

      const tdIdx = document.createElement('td');
      tdIdx.textContent = String(idx + 1);

      const tdTitle = document.createElement('td');
      const link = document.createElement('a');
      link.href = `${origin}/g/${info.gid}/${info.token}/`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = info.title;
      tdTitle.appendChild(link);

      const tdGid = document.createElement('td');
      const code = document.createElement('span');
      code.className = 'code-pill';
      code.textContent = `${info.gid}/${info.token}`;
      tdGid.appendChild(code);

      const tdCat = document.createElement('td');
      tdCat.textContent = `${info.favcat}: ${info.favcatName}`;

      tr.appendChild(tdIdx);
      tr.appendChild(tdTitle);
      tr.appendChild(tdGid);
      tr.appendChild(tdCat);
      els.galleryModalTbody.appendChild(tr);
    });

    els.galleryModal.classList.remove('hidden');
  }

  // --- Settings Sync & Tester ---
  function renderSettingsControls() {
    els.setEnableFavTransfer.checked = Boolean(settings.enableFavTransfer);
    els.setEnableTagStats.checked = Boolean(settings.enableTagStats);
    els.setEnableMirrorRedirect.checked = Boolean(settings.enableMirrorRedirect);
    els.setEnableShortcutCopy.checked = Boolean(settings.enableShortcutCopy);
    els.setEnableDomainSwapRedirect.checked = Boolean(settings.enableDomainSwapRedirect);

    const highlightLabel = settings.highlightTagLabel || DEFAULT_HIGHLIGHT_LABEL;
    if (els.setTagStatsDesc) {
      els.setTagStatsDesc.textContent = `统计不重复 artist / group / parody 与 ${highlightLabel}`;
    }

    els.setMirrorDomain.value = settings.mirrorDomain || '';
    els.setMirrorSourceScope.value = settings.mirrorSourceScope || 'both';
    els.setDomainSwapRedirectMode.value = settings.domainSwapRedirectMode || 'e2ex';
    els.setRedirectPriority.value = settings.redirectPriority || 'mirror';
    els.setRedirectExternalOnly.checked = Boolean(settings.redirectExternalOnly);

    els.setCopyTargetDomain.value = settings.copyTargetDomain || 'exhentai.org';
    els.setShortcutInput.value =
      (settings.customShortcut && settings.customShortcut.label) || 'Alt + C';
    els.setMirrorCopyTarget.value = settings.mirrorCopyTarget || 'exhentai.org';
    els.setMirrorCopyTargetRow.classList.toggle(
      'hidden',
      els.setCopyTargetDomain.value !== 'swap'
    );

    // Sync operational inputs in Tab 1 & Tab 2
    if (document.activeElement !== els.readDelayInput) {
      els.readDelayInput.min = String(settings.readDelayMinMs || 100);
      els.readDelayInput.value = String(settings.readDelayMs || 350);
    }
    if (document.activeElement !== els.importDelayInput) {
      els.importDelayInput.min = String(settings.importDelayMinMs || 150);
      els.importDelayInput.value = String(settings.importDelayMs || 400);
    }
    els.reverseOrderCheck.checked =
      settings.importReverseOrder !== undefined ? Boolean(settings.importReverseOrder) : true;
    els.skipImportedCheck.checked =
      settings.importSkipExisting !== undefined ? Boolean(settings.importSkipExisting) : true;

    if (document.activeElement !== els.tagDelayInput) {
      els.tagDelayInput.min = String(settings.tagDelayMinMs || 200);
      els.tagDelayInput.value = String(settings.tagDelayMs || 600);
    }

    // Sync advanced controls in Tab 3
    if (els.fileSettingsSourceText) {
      els.fileSettingsSourceText.textContent = `当前默认基准配置文件：${fileSource}（支持编辑本地 settings.json 后重新加载，或将当前界面配置导出为 settings.json）。`;
    }
    if (els.setHighlightTags && document.activeElement !== els.setHighlightTags) {
      els.setHighlightTags.value = Array.isArray(settings.highlightTags)
        ? settings.highlightTags.join(', ')
        : DEFAULT_HIGHLIGHT_TAGS.join(', ');
    }
    if (els.setHighlightTagLabel && document.activeElement !== els.setHighlightTagLabel) {
      els.setHighlightTagLabel.value = highlightLabel;
    }
    if (els.setSampleGalleryPath && document.activeElement !== els.setSampleGalleryPath) {
      els.setSampleGalleryPath.value = settings.sampleGalleryPath || DEFAULT_SAMPLE_GALLERY_PATH;
    }
    if (els.setApiBatchSize && document.activeElement !== els.setApiBatchSize) {
      els.setApiBatchSize.value = String(settings.apiBatchSize || 25);
    }
    if (
      els.setTagCooldownEveryBatches &&
      document.activeElement !== els.setTagCooldownEveryBatches
    ) {
      els.setTagCooldownEveryBatches.value = String(
        settings.tagCooldownEveryBatches !== undefined ? settings.tagCooldownEveryBatches : 5
      );
    }
    if (els.setTagCooldownExtraMs && document.activeElement !== els.setTagCooldownExtraMs) {
      els.setTagCooldownExtraMs.value = String(
        settings.tagCooldownExtraMs !== undefined ? settings.tagCooldownExtraMs : 2000
      );
    }
    if (els.setRedirectDedupWindowMs && document.activeElement !== els.setRedirectDedupWindowMs) {
      els.setRedirectDedupWindowMs.value = String(settings.redirectDedupWindowMs || 6000);
    }
    if (els.setCopyDedupWindowMs && document.activeElement !== els.setCopyDedupWindowMs) {
      els.setCopyDedupWindowMs.value = String(settings.copyDedupWindowMs || 400);
    }
    if (els.setToastDurationMs && document.activeElement !== els.setToastDurationMs) {
      els.setToastDurationMs.value = String(settings.toastDurationMs || 3200);
    }

    els.transferDisabledBanner.classList.toggle('hidden', Boolean(settings.enableFavTransfer));
    els.tagsDisabledBanner.classList.toggle('hidden', Boolean(settings.enableTagStats));

    if (!els.testerUrlInput.value) {
      els.testerUrlInput.value = buildPresetUrl('exhentai');
    }

    refreshSiteSelectLabels();
    renderFavoritesView();
    refreshTagStatsView();
    runUrlTester();
  }

  async function savePartialSettings(partial) {
    const resp = await sendMessage({ type: 'EH_SAVE_SETTINGS', settings: partial });
    if (resp && resp.ok && resp.settings) {
      settings = resp.settings;
      if (resp.fileDefaults) fileDefaults = resp.fileDefaults;
      if (resp.fileSource) fileSource = resp.fileSource;
      renderSettingsControls();
    }
  }

  async function runUrlTester() {
    const urlStr = (els.testerUrlInput.value || '').trim();
    if (!urlStr) {
      els.testerRedirectOutput.textContent = '-';
      els.testerCopyOutput.textContent = '-';
      return;
    }
    const resp = await sendMessage({ type: 'EH_CONVERT_URL', url: urlStr });
    if (!resp || !resp.ok) return;

    if (resp.redirect && resp.redirect.targetUrl) {
      els.testerRedirectOutput.textContent = `${resp.redirect.targetUrl} (${resp.redirect.reason === 'mirror' ? '功能3 转镜像站' : '功能4B 表里站域名转换'})`;
    } else {
      els.testerRedirectOutput.textContent = '不触发跳转（保留原链接）';
    }

    if (settings.enableShortcutCopy && resp.converted) {
      els.testerCopyOutput.textContent = resp.converted.unchanged
        ? `${resp.converted.convertedUrl} (当前已是目标域名，保留不变)`
        : resp.converted.convertedUrl;
    } else if (!settings.enableShortcutCopy) {
      els.testerCopyOutput.textContent = '功能 4A 当前已关闭';
    } else {
      els.testerCopyOutput.textContent = '非支持的 EH/镜像站链接';
    }
  }

  function switchMainTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tabName}`);
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

  function showSettingsNotice(text) {
    if (!els.settingsActionNotice) return;
    els.settingsActionNotice.textContent = text;
  }

  function bindEvents() {
    // Tabs
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchMainTab(btn.dataset.tab);
        window.location.hash = btn.dataset.tab;
      });
    });

    // Subtabs
    document.querySelectorAll('.subtab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeSubtab = btn.dataset.subtab;
        document.querySelectorAll('.subtab-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        renderTagResultTable();
      });
    });

    // Site Picker
    els.siteSelect.addEventListener('change', () => {
      els.customOriginInput.classList.toggle('hidden', els.siteSelect.value !== 'custom');
      renderFavPreview();
      renderTagResultTable();
    });
    els.customOriginInput.addEventListener('input', () => {
      renderFavPreview();
      renderTagResultTable();
    });
    els.detectSiteBtn.addEventListener('click', detectOpenSite);

    // Disabled banners inline enable
    els.enableFavTransferInlineBtn.addEventListener('click', () =>
      savePartialSettings({ enableFavTransfer: true })
    );
    els.enableTagStatsInlineBtn.addEventListener('click', () =>
      savePartialSettings({ enableTagStats: true })
    );

    // Persist Tab 1 & Tab 2 operational controls into settings
    els.readDelayInput.addEventListener('change', () => {
      savePartialSettings({ readDelayMs: Number(els.readDelayInput.value) });
    });
    els.importDelayInput.addEventListener('change', () => {
      savePartialSettings({ importDelayMs: Number(els.importDelayInput.value) });
    });
    els.reverseOrderCheck.addEventListener('change', () => {
      savePartialSettings({ importReverseOrder: els.reverseOrderCheck.checked });
    });
    els.skipImportedCheck.addEventListener('change', () => {
      savePartialSettings({ importSkipExisting: els.skipImportedCheck.checked });
    });
    els.tagDelayInput.addEventListener('change', () => {
      savePartialSettings({ tagDelayMs: Number(els.tagDelayInput.value) });
    });

    // Tab 1 actions
    els.readAllFavsBtn.addEventListener('click', () => runReadAllFavorites(false));
    els.stopReadFavsBtn.addEventListener('click', () => {
      if (readAbort) readAbort.abort();
    });

    els.selectAllCatsBtn.addEventListener('click', () => {
      selectedCatSet = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      renderFavoritesView();
    });
    els.deselectAllCatsBtn.addEventListener('click', () => {
      selectedCatSet.clear();
      renderFavoritesView();
    });

    els.favPreviewSearch.addEventListener('input', renderFavPreview);

    els.exportFavBackupBtn.addEventListener('click', () => {
      if (!favoritesData) return;
      const dateStr = new Date().toISOString().slice(0, 10);
      downloadFile(
        `eh-favorites-backup-${dateStr}.json`,
        JSON.stringify(favoritesData, null, 2),
        'application/json'
      );
    });

    els.importFavBackupInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed || !Array.isArray(parsed.categories)) {
          throw new Error('JSON 文件格式不正确（缺少 categories 数组）');
        }
        favoritesData = parsed;
        await chrome.storage.local.set({ [FAVORITES_STORAGE_KEY]: favoritesData });
        selectedCatSet = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        appendImportLog(`已成功加载备份文件：${file.name}`, 'ok');
        renderFavoritesView();
        refreshTagStatsView();
      } catch (err) {
        appendImportLog(`加载备份失败：${err.message}`, 'err');
      } finally {
        els.importFavBackupInput.value = '';
      }
    });

    els.clearFavCacheBtn.addEventListener('click', async () => {
      favoritesData = null;
      await chrome.storage.local.remove(FAVORITES_STORAGE_KEY);
      appendImportLog('已清空本地缓存的收藏夹数据', 'info');
      renderFavoritesView();
      refreshTagStatsView();
    });

    els.startImportBtn.addEventListener('click', () => runImportQueue(null));
    els.retryFailedImportBtn.addEventListener('click', () => {
      if (importController.failedItems.length > 0) {
        runImportQueue(importController.failedItems);
      }
    });
    els.pauseImportBtn.addEventListener('click', () => {
      if (importController.state === 'running') {
        importController.state = 'paused';
        els.pauseImportBtn.classList.add('hidden');
        els.resumeImportBtn.classList.remove('hidden');
        appendImportLog('导入已暂停', 'warn');
      }
    });
    els.resumeImportBtn.addEventListener('click', () => {
      if (importController.state === 'paused') {
        importController.state = 'running';
        els.resumeImportBtn.classList.add('hidden');
        els.pauseImportBtn.classList.remove('hidden');
        if (importController.resumeResolver) {
          importController.resumeResolver();
          importController.resumeResolver = null;
        }
        appendImportLog('导入已恢复', 'info');
      }
    });
    els.stopImportBtn.addEventListener('click', () => {
      importController.aborted = true;
      if (importController.resumeResolver) {
        importController.resumeResolver();
        importController.resumeResolver = null;
      }
    });
    els.clearImportHistoryBtn.addEventListener('click', async () => {
      importHistory = {};
      await chrome.storage.local.remove(IMPORT_HISTORY_KEY);
      appendImportLog('已清空历史导入记录，下次导入将不会跳过已导入条目', 'info');
    });

    // Tab 2 actions
    els.scanAndFetchTagsBtn.addEventListener('click', () => runTagFetch(true));
    els.fetchTagsFromCacheBtn.addEventListener('click', () => runTagFetch(false));
    els.pauseTagFetchBtn.addEventListener('click', () => {
      if (tagController.state === 'running') {
        tagController.state = 'paused';
        els.pauseTagFetchBtn.classList.add('hidden');
        els.resumeTagFetchBtn.classList.remove('hidden');
      }
    });
    els.resumeTagFetchBtn.addEventListener('click', () => {
      if (tagController.state === 'paused') {
        tagController.state = 'running';
        els.resumeTagFetchBtn.classList.add('hidden');
        els.pauseTagFetchBtn.classList.remove('hidden');
        if (tagController.resumeResolver) {
          tagController.resumeResolver();
          tagController.resumeResolver = null;
        }
      }
    });
    els.stopTagFetchBtn.addEventListener('click', () => {
      tagController.aborted = true;
      if (tagController.resumeResolver) {
        tagController.resumeResolver();
        tagController.resumeResolver = null;
      }
    });
    els.clearTagCacheBtn.addEventListener('click', async () => {
      tagCache = {};
      await chrome.storage.local.remove(TAG_CACHE_KEY);
      refreshTagStatsView();
    });

    els.tagSearchInput.addEventListener('input', renderTagResultTable);
    els.tagSortSelect.addEventListener('change', renderTagResultTable);

    els.copyStatsSummaryBtn.addEventListener('click', async () => {
      if (!currentStats) return;
      const summary = formatStatsSummaryText(currentStats);
      await navigator.clipboard.writeText(summary);
      const label = currentStats.highlightTagLabel || DEFAULT_HIGHLIGHT_LABEL;
      els.tagResultNotice.textContent = `已将不重复 artist / group / parody 与 ${label} 统计文本复制到剪贴板！`;
    });

    els.exportStatsJsonBtn.addEventListener('click', () => {
      if (!currentStats) return;
      const out = {
        totalGalleries: currentStats.totalGalleries,
        fetchedGalleries: currentStats.fetchedGalleries,
        highlightTags: currentStats.highlightTags,
        highlightTagLabel: currentStats.highlightTagLabel,
        highlightTagCount: currentStats.stocking.count,
        highlightTagPercentage: currentStats.stocking.percentage,
        artists: currentStats.artists,
        groups: currentStats.groups,
        parodies: currentStats.parodies,
        highlightedGalleries: currentStats.stocking.galleries
      };
      downloadFile(
        `eh-tag-stats-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(out, null, 2),
        'application/json'
      );
    });

    els.exportStatsCsvBtn.addEventListener('click', () => {
      if (!currentStats) return;
      const lines = ['type,name,gallery_count'];
      const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
      currentStats.artists.forEach((x) => lines.push(`artist,${esc(x.name)},${x.count}`));
      currentStats.groups.forEach((x) => lines.push(`group,${esc(x.name)},${x.count}`));
      currentStats.parodies.forEach((x) => lines.push(`parody,${esc(x.name)},${x.count}`));
      const label = currentStats.highlightTagLabel || DEFAULT_HIGHLIGHT_LABEL;
      lines.push(`${esc(label)},total_galleries,${currentStats.stocking.count}`);
      downloadFile(
        `eh-tag-stats-${new Date().toISOString().slice(0, 10)}.csv`,
        '\uFEFF' + lines.join('\r\n'),
        'text/csv;charset=utf-8'
      );
    });

    // Modal
    els.closeGalleryModalBtn.addEventListener('click', () =>
      els.galleryModal.classList.add('hidden')
    );
    els.galleryModalBackdrop.addEventListener('click', () =>
      els.galleryModal.classList.add('hidden')
    );

    // Tab 3 Settings
    const togglePairs = [
      ['setEnableFavTransfer', 'enableFavTransfer'],
      ['setEnableTagStats', 'enableTagStats'],
      ['setEnableMirrorRedirect', 'enableMirrorRedirect'],
      ['setEnableShortcutCopy', 'enableShortcutCopy'],
      ['setEnableDomainSwapRedirect', 'enableDomainSwapRedirect'],
      ['setRedirectExternalOnly', 'redirectExternalOnly']
    ];
    togglePairs.forEach(([elId, key]) => {
      els[elId].addEventListener('change', () => {
        savePartialSettings({ [key]: els[elId].checked });
      });
    });

    const selectPairs = [
      ['setMirrorSourceScope', 'mirrorSourceScope'],
      ['setDomainSwapRedirectMode', 'domainSwapRedirectMode'],
      ['setRedirectPriority', 'redirectPriority'],
      ['setCopyTargetDomain', 'copyTargetDomain'],
      ['setMirrorCopyTarget', 'mirrorCopyTarget']
    ];
    selectPairs.forEach(([elId, key]) => {
      els[elId].addEventListener('change', () => {
        savePartialSettings({ [key]: els[elId].value });
      });
    });

    let mirrorDebounce = null;
    els.setMirrorDomain.addEventListener('input', () => {
      clearTimeout(mirrorDebounce);
      mirrorDebounce = setTimeout(() => {
        savePartialSettings({ mirrorDomain: els.setMirrorDomain.value });
      }, 350);
    });
    els.setMirrorDomain.addEventListener('blur', () => {
      clearTimeout(mirrorDebounce);
      savePartialSettings({ mirrorDomain: els.setMirrorDomain.value });
    });

    let isRecording = false;
    els.setShortcutInput.addEventListener('focus', () => {
      isRecording = true;
      els.setShortcutInput.classList.add('recording');
      els.setShortcutInput.value = '请按下新快捷键 (Esc取消)';
    });
    els.setShortcutInput.addEventListener('blur', () => {
      if (isRecording) {
        isRecording = false;
        els.setShortcutInput.classList.remove('recording');
        renderSettingsControls();
      }
    });
    els.setShortcutInput.addEventListener('keydown', (e) => {
      if (!isRecording) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        isRecording = false;
        els.setShortcutInput.classList.remove('recording');
        renderSettingsControls();
        els.setShortcutInput.blur();
        return;
      }
      if (
        ['Control', 'Alt', 'AltGraph', 'Shift', 'Meta', 'OS', 'Super', 'Hyper'].includes(
          e.key
        )
      ) {
        return;
      }

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
      els.setShortcutInput.classList.remove('recording');
      els.setShortcutInput.blur();
      savePartialSettings({ customShortcut: shortcut });
    });

    els.setResetShortcutBtn.addEventListener('click', () => {
      const defaultShortcut = (fileDefaults && fileDefaults.customShortcut) || {
        altKey: true,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
        code: 'KeyC',
        key: 'c',
        label: 'Alt + C'
      };
      savePartialSettings({ customShortcut: { ...defaultShortcut } });
    });

    els.setOpenBrowserShortcutsBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });

    // Advanced & settings.json actions
    els.reloadFileSettingsBtn.addEventListener('click', async () => {
      const resp = await sendMessage({ type: 'EH_RELOAD_FILE_SETTINGS' });
      if (resp && resp.ok && resp.settings) {
        settings = resp.settings;
        fileDefaults = resp.fileDefaults || null;
        fileSource = resp.fileSource || 'settings.json';
        els.testerUrlInput.value = buildPresetUrl('exhentai');
        renderSettingsControls();
        showSettingsNotice(`已从 ${fileSource} 重新读取并应用全部参数！`);
      }
    });

    els.exportSettingsJsonBtn.addEventListener('click', async () => {
      const resp = await sendMessage({ type: 'EH_EXPORT_SETTINGS_JSON' });
      if (resp && resp.ok && resp.jsonText) {
        downloadFile('settings.json', resp.jsonText, 'application/json');
        showSettingsNotice('已导出 settings.json，可直接放入插件根目录覆盖原文件。');
      }
    });

    els.importSettingsJsonInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('JSON 根节点必须是对象');
        }
        await savePartialSettings(parsed);
        showSettingsNotice(`已成功导入并应用配置文件：${file.name}`);
      } catch (err) {
        showSettingsNotice(`导入配置失败：${err.message}`);
      } finally {
        els.importSettingsJsonInput.value = '';
      }
    });

    els.setHighlightTags.addEventListener('change', () => {
      savePartialSettings({ highlightTags: els.setHighlightTags.value });
    });
    els.setHighlightTagLabel.addEventListener('change', () => {
      savePartialSettings({ highlightTagLabel: els.setHighlightTagLabel.value });
    });
    els.setSampleGalleryPath.addEventListener('change', () => {
      savePartialSettings({ sampleGalleryPath: els.setSampleGalleryPath.value });
      els.testerUrlInput.value = buildPresetUrl('exhentai');
      runUrlTester();
    });

    const numericAdvancedPairs = [
      ['setApiBatchSize', 'apiBatchSize'],
      ['setTagCooldownEveryBatches', 'tagCooldownEveryBatches'],
      ['setTagCooldownExtraMs', 'tagCooldownExtraMs'],
      ['setRedirectDedupWindowMs', 'redirectDedupWindowMs'],
      ['setCopyDedupWindowMs', 'copyDedupWindowMs'],
      ['setToastDurationMs', 'toastDurationMs']
    ];
    numericAdvancedPairs.forEach(([elId, key]) => {
      els[elId].addEventListener('change', () => {
        savePartialSettings({ [key]: Number(els[elId].value) });
      });
    });

    els.testerUrlInput.addEventListener('input', runUrlTester);
    document.querySelectorAll('.preset-test-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        els.testerUrlInput.value = buildPresetUrl(btn.dataset.preset);
        runUrlTester();
      });
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.eh_settings && changes.eh_settings.newValue) {
        settings = changes.eh_settings.newValue;
        renderSettingsControls();
      }
    });
  }

  async function init() {
    const resp = await sendMessage({ type: 'EH_GET_SETTINGS' });
    settings = resp && resp.settings ? resp.settings : {};
    fileDefaults = resp && resp.fileDefaults ? resp.fileDefaults : null;
    fileSource = (resp && resp.fileSource) || 'settings.json';

    const stored = await chrome.storage.local.get([
      FAVORITES_STORAGE_KEY,
      IMPORT_HISTORY_KEY,
      TAG_CACHE_KEY
    ]);
    favoritesData = stored[FAVORITES_STORAGE_KEY] || null;
    importHistory = stored[IMPORT_HISTORY_KEY] || {};
    tagCache = stored[TAG_CACHE_KEY] || {};

    applyDefaultActiveSite();
    bindEvents();
    renderSettingsControls();
    refreshTagStatsView();

    const hash = (window.location.hash || '').replace('#', '');
    if (['transfer', 'tags', 'settings'].includes(hash)) {
      switchMainTab(hash);
    }

    await detectOpenSite();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
