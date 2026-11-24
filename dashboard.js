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

  function parseFavoritesMeta(doc) {
    const names = {};
    const counts = {};
    for (let i = 0; i < 10; i++) {
      names[i] = `Favorites ${i}`;
    }
    if (!doc) {
      return { names, counts: null, sortedByPublished: false };
    }

    let parsedCountTotal = 0;
    const fpNodes = Array.from(doc.querySelectorAll('.nosel .fp'));
    for (const node of fpNodes) {
      const onclick = node.getAttribute
        ? node.getAttribute('data-eh-onclick') || node.getAttribute('onclick') || ''
        : '';
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
      if (divs.length >= 2) {
        const rawNum = (divs[0].textContent || '').trim().replace(/,/g, '');
        if (/^\d+$/.test(rawNum)) {
          counts[catIdx] = Number(rawNum);
          parsedCountTotal += 1;
        }
      }
      if (divs.length >= 3) {
        const label = (divs[divs.length - 1].textContent || '').trim();
        if (label) names[catIdx] = label;
      } else if (divs.length > 0) {
        const label = (divs[divs.length - 1].textContent || '').trim();
        if (label && !/^\d+$/.test(label)) names[catIdx] = label;
      }
    }

    const sortedByPublished = Boolean(
      doc.querySelector('option[value="fs_p"][selected], a[href*="inline_set=fs_f"]')
    );

    return {
      names,
      counts: parsedCountTotal > 0 ? counts : null,
      sortedByPublished
    };
  }

  function parseFavoritesCategories(doc) {
    return parseFavoritesMeta(doc).names;
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
    const meta = parseFavoritesMeta(doc);
    if (isLoginOrErrorPage(doc, rawHtml)) {
      return {
        loginRequired: true,
        categoryNames: meta.names,
        categoryCounts: meta.counts,
        sortedByPublished: meta.sortedByPublished,
        galleries: [],
        nextPageUrl: null
      };
    }

    const categoryNames = meta.names;
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
      categoryCounts: meta.counts,
      sortedByPublished: meta.sortedByPublished,
      galleries: Array.from(byGid.values()),
      nextPageUrl: extractNextPageUrl(doc, currentUrl)
    };
  }

  function tryMergeIncrementalCategory(collectedList, prevList, liveCount, sortedByPublished) {
    if (!Array.isArray(prevList) || !Number.isInteger(liveCount) || liveCount < 0) {
      return null;
    }
    if (liveCount === 0) {
      return { merged: [], mode: 'empty', addedCount: 0 };
    }
    if (prevList.length === 0 || sortedByPublished) {
      return null;
    }

    const delta = liveCount - prevList.length;
    if (delta < 0) {
      // Deletion occurred in this category; scan full category to pinpoint removed items
      return null;
    }

    if (delta === 0) {
      if (collectedList.length === 0 || collectedList.length > prevList.length) {
        return null;
      }
      for (let i = 0; i < collectedList.length; i++) {
        if (String(collectedList[i].gid) !== String(prevList[i].gid)) {
          return null;
        }
      }
      const merged = [
        ...collectedList,
        ...prevList.slice(collectedList.length)
      ];
      return { merged, mode: 'unchanged', addedCount: 0 };
    }

    // delta > 0: Check if the first `delta` items are new and the remaining overlap aligns with prevList[0..]
    if (collectedList.length <= delta) {
      return null;
    }

    const prevGidSet = new Set(prevList.map((g) => String(g.gid)));
    for (let i = 0; i < delta; i++) {
      if (prevGidSet.has(String(collectedList[i].gid))) {
        return null;
      }
    }

    const overlapLen = Math.min(collectedList.length - delta, prevList.length);
    if (overlapLen < 1) {
      return null;
    }
    for (let j = 0; j < overlapLen; j++) {
      if (String(collectedList[delta + j].gid) !== String(prevList[j].gid)) {
        return null;
      }
    }

    const merged = [
      ...collectedList.slice(0, delta + overlapLen),
      ...prevList.slice(overlapLen)
    ];
    if (merged.length !== liveCount) {
      return null;
    }
    return { merged, mode: 'added_prefix', addedCount: delta };
  }

  function diffFavoritesSnapshots(prevData, nextData) {
    const hasPrev = Boolean(prevData && Array.isArray(prevData.categories));
    const prevUnique = new Map();
    const nextUnique = new Map();

    if (hasPrev) {
      for (const cat of prevData.categories) {
        for (const g of cat.galleries || []) {
          const gid = String(g.gid);
          if (!prevUnique.has(gid)) {
            prevUnique.set(gid, {
              gid,
              token: g.token,
              title: g.title,
              favcat: cat.favcat,
              favnote: g.favnote || ''
            });
          }
        }
      }
    }

    if (nextData && Array.isArray(nextData.categories)) {
      for (const cat of nextData.categories) {
        for (const g of cat.galleries || []) {
          const gid = String(g.gid);
          if (!nextUnique.has(gid)) {
            nextUnique.set(gid, {
              gid,
              token: g.token,
              title: g.title,
              favcat: cat.favcat,
              favnote: g.favnote || ''
            });
          }
        }
      }
    }

    const addedGids = [];
    const removedGids = [];
    let unchangedCount = 0;
    let metaChangedCount = 0;

    for (const [gid, nextItem] of nextUnique.entries()) {
      if (!prevUnique.has(gid)) {
        addedGids.push(gid);
      } else {
        unchangedCount += 1;
        const prevItem = prevUnique.get(gid);
        if (prevItem.favcat !== nextItem.favcat || prevItem.favnote !== nextItem.favnote) {
          metaChangedCount += 1;
        }
      }
    }

    if (hasPrev) {
      for (const gid of prevUnique.keys()) {
        if (!nextUnique.has(gid)) {
          removedGids.push(gid);
        }
      }
    }

    const isGallerySetIdentical =
      hasPrev && addedGids.length === 0 && removedGids.length === 0;
    const isIdentical = isGallerySetIdentical && metaChangedCount === 0;

    return {
      hasPrev,
      prevTotal: prevUnique.size,
      nextTotal: nextUnique.size,
      addedGids,
      removedGids,
      unchangedCount,
      metaChangedCount,
      isGallerySetIdentical,
      isIdentical
    };
  }

  function decodeNumericEntitiesForScheme(str) {
    return str
      .replace(/&#(\d+);?/g, (_, dec) => {
        const code = Number(dec);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      })
      .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
        const code = parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      });
  }

  function sanitizeHtmlForDomParser(rawHtml) {
    if (!rawHtml || typeof rawHtml !== 'string') return '';

    const STRIP_BLOCK_TAGS = new Set([
      'script',
      'style',
      'iframe',
      'object',
      'embed',
      'svg',
      'math'
    ]);
    const RAW_STOP_TAGS = new Set(['script', 'style']);
    const RCDATA_TAGS = new Set(['title', 'textarea']);
    const VOID_TAGS = new Set(['embed']);
    const URL_ATTRS = new Set(['href', 'action', 'formaction', 'src', 'xlink:href']);

    const isSpace = (ch) =>
      ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
    const isAsciiAlpha = (ch) =>
      (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');

    const len = rawHtml.length;
    const lowerHtml = rawHtml.toLowerCase();
    const out = [];
    let i = 0;

    function findClosingTag(tagLower, fromIdx) {
      const target = `</${tagLower}`;
      const targetLen = target.length;
      let idx = fromIdx;
      while (idx < len) {
        const found = lowerHtml.indexOf(target, idx);
        if (found === -1) return null;
        const afterIdx = found + targetLen;
        if (afterIdx >= len) {
          return { start: found, end: len };
        }
        const nextCh = rawHtml[afterIdx];
        if (nextCh === '>' || nextCh === '/' || isSpace(nextCh)) {
          const gtIdx = rawHtml.indexOf('>', afterIdx);
          return {
            start: found,
            end: gtIdx === -1 ? len : gtIdx + 1
          };
        }
        idx = afterIdx;
      }
      return null;
    }

    while (i < len) {
      const lt = rawHtml.indexOf('<', i);
      if (lt === -1) {
        out.push(rawHtml.slice(i));
        break;
      }
      if (lt > i) {
        out.push(rawHtml.slice(i, lt));
      }
      i = lt;

      if (i + 1 >= len) {
        out.push('<');
        break;
      }

      const next1 = rawHtml[i + 1];

      // Strip HTML comments
      if (rawHtml.startsWith('<!--', i)) {
        if (rawHtml.startsWith('<!-->', i)) {
          i += 5;
        } else if (rawHtml.startsWith('<!--->', i)) {
          i += 6;
        } else {
          const endComment = rawHtml.indexOf('-->', i + 4);
          i = endComment === -1 ? len : endComment + 3;
        }
        continue;
      }

      // Keep <!DOCTYPE ...> and strip bogus comments <!...>
      if (next1 === '!') {
        const gt = rawHtml.indexOf('>', i + 2);
        const endPos = gt === -1 ? len : gt + 1;
        if (lowerHtml.slice(i, i + 9) === '<!doctype') {
          out.push(rawHtml.slice(i, endPos));
        }
        i = endPos;
        continue;
      }

      // Strip processing instructions / bogus comments <?...>
      if (next1 === '?') {
        const gt = rawHtml.indexOf('>', i + 2);
        i = gt === -1 ? len : gt + 1;
        continue;
      }

      // End tag </...>
      if (next1 === '/') {
        if (i + 2 < len && isAsciiAlpha(rawHtml[i + 2])) {
          let p = i + 2;
          while (p < len && !isSpace(rawHtml[p]) && rawHtml[p] !== '>' && rawHtml[p] !== '/') {
            p += 1;
          }
          const endTagName = lowerHtml.slice(i + 2, p);
          const gt = rawHtml.indexOf('>', p);
          i = gt === -1 ? len : gt + 1;
          if (!STRIP_BLOCK_TAGS.has(endTagName)) {
            out.push(`</${endTagName}>`);
          }
        } else {
          const gt = rawHtml.indexOf('>', i + 2);
          i = gt === -1 ? len : gt + 1;
        }
        continue;
      }

      if (!isAsciiAlpha(next1)) {
        out.push('<');
        i += 1;
        continue;
      }

      let p = i + 1;
      while (p < len && !isSpace(rawHtml[p]) && rawHtml[p] !== '>' && rawHtml[p] !== '/') {
        p += 1;
      }
      const tagName = rawHtml.slice(i + 1, p);
      const lowerTag = tagName.toLowerCase();

      const attrs = [];
      let selfClosing = false;

      while (p < len) {
        while (p < len && isSpace(rawHtml[p])) {
          p += 1;
        }
        if (p >= len) break;

        if (rawHtml[p] === '>') {
          p += 1;
          break;
        }

        if (rawHtml[p] === '/') {
          p += 1;
          while (p < len && isSpace(rawHtml[p])) {
            p += 1;
          }
          if (p < len && rawHtml[p] === '>') {
            selfClosing = true;
            p += 1;
            break;
          }
          continue;
        }

        const nameStart = p;
        while (
          p < len &&
          !isSpace(rawHtml[p]) &&
          rawHtml[p] !== '=' &&
          rawHtml[p] !== '>' &&
          rawHtml[p] !== '/'
        ) {
          p += 1;
        }
        const attrName = rawHtml.slice(nameStart, p);

        while (p < len && isSpace(rawHtml[p])) {
          p += 1;
        }

        let hasValue = false;
        let attrValue = '';

        if (p < len && rawHtml[p] === '=') {
          hasValue = true;
          p += 1;
          while (p < len && isSpace(rawHtml[p])) {
            p += 1;
          }
          if (p < len) {
            const q = rawHtml[p];
            if (q === '"' || q === "'") {
              p += 1;
              const valStart = p;
              const closeQ = rawHtml.indexOf(q, p);
              if (closeQ === -1) {
                attrValue = rawHtml.slice(valStart);
                p = len;
              } else {
                attrValue = rawHtml.slice(valStart, closeQ);
                p = closeQ + 1;
              }
            } else if (rawHtml[p] !== '>') {
              const valStart = p;
              while (p < len && !isSpace(rawHtml[p]) && rawHtml[p] !== '>') {
                p += 1;
              }
              attrValue = rawHtml.slice(valStart, p);
            }
          }
        }

        if (attrName) {
          attrs.push({ name: attrName, hasValue, value: attrValue });
        }
      }

      i = p;

      if (STRIP_BLOCK_TAGS.has(lowerTag)) {
        if (VOID_TAGS.has(lowerTag)) {
          continue;
        }
        if (!RAW_STOP_TAGS.has(lowerTag) && selfClosing) {
          continue;
        }
        const closeMatch = findClosingTag(lowerTag, i);
        if (closeMatch) {
          i = closeMatch.end;
        } else if (RAW_STOP_TAGS.has(lowerTag)) {
          i = len;
        }
        continue;
      }

      const serializedAttrs = [];
      for (const attr of attrs) {
        if (!/^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/.test(attr.name)) {
          continue;
        }
        const lowerAttr = attr.name.toLowerCase();
        if (/^on[a-z0-9]+$/i.test(lowerAttr)) {
          if (lowerAttr === 'onclick' && attr.hasValue && /favcat=/i.test(attr.value)) {
            const safeVal = attr.value.replace(/"/g, '&quot;');
            serializedAttrs.push(`data-eh-onclick="${safeVal}"`);
          }
          continue;
        }

        if (URL_ATTRS.has(lowerAttr) && attr.hasValue) {
          const decoded = decodeNumericEntitiesForScheme(attr.value);
          const compactScheme = decoded.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
          if (compactScheme.startsWith('javascript:') || compactScheme.startsWith('vbscript:')) {
            serializedAttrs.push(`${attr.name}="#"`);
            continue;
          }
        }

        if (attr.hasValue) {
          const safeVal = attr.value.replace(/"/g, '&quot;');
          serializedAttrs.push(`${attr.name}="${safeVal}"`);
        } else {
          serializedAttrs.push(attr.name);
        }
      }

      const attrStr = serializedAttrs.length > 0 ? ` ${serializedAttrs.join(' ')}` : '';
      out.push(`<${tagName}${attrStr}${selfClosing ? ' /' : ''}>`);

      if (RCDATA_TAGS.has(lowerTag) && !selfClosing) {
        const closeMatch = findClosingTag(lowerTag, i);
        if (closeMatch) {
          out.push(rawHtml.slice(i, closeMatch.start));
          out.push(`</${lowerTag}>`);
          i = closeMatch.end;
        } else {
          out.push(rawHtml.slice(i));
          i = len;
        }
      }
    }

    return out.join('');
  }

  function parseFavoritesHtml(html, favcat, currentUrl, customParser) {
    const safeHtml = sanitizeHtmlForDomParser(html);
    const doc = customParser
      ? customParser(safeHtml)
      : new DOMParser().parseFromString(safeHtml, 'text/html');
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

  function buildApiCandidates(origin, rawSettings, exCookieReady) {
    const officialApiUrl =
      (rawSettings && rawSettings.officialApiUrl) || DEFAULT_OFFICIAL_API_URL;
    const preferEx = Boolean(
      (!rawSettings || rawSettings.preferExhentaiApi !== false) && exCookieReady
    );
    const exApi = 'https://exhentai.org/api.php';
    const rawList = [];

    if (origin === 'https://api.e-hentai.org') {
      if (preferEx) rawList.push(exApi);
      rawList.push(officialApiUrl);
    } else if (origin === 'https://exhentai.org') {
      rawList.push(exApi, officialApiUrl);
    } else if (origin === 'https://e-hentai.org') {
      if (preferEx) {
        rawList.push(exApi, 'https://e-hentai.org/api.php', officialApiUrl);
      } else {
        rawList.push('https://e-hentai.org/api.php', officialApiUrl);
      }
    } else {
      // Custom or mirror origin
      if (origin) rawList.push(`${origin}/api.php`);
      if (preferEx) rawList.push(exApi);
      rawList.push(officialApiUrl);
    }

    return Array.from(new Set(rawList.filter(Boolean)));
  }

  function getApiFetchCredentials(apiUrl, origin) {
    if (!apiUrl) return 'omit';
    if (origin && apiUrl.startsWith(origin)) return 'include';
    try {
      const host = new URL(apiUrl).hostname.toLowerCase();
      if (
        host === 'exhentai.org' ||
        host === 'www.exhentai.org' ||
        host === 'e-hentai.org' ||
        host === 'www.e-hentai.org'
      ) {
        return 'include';
      }
    } catch {
      // ignore
    }
    return 'omit';
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.__EH_DASHBOARD_EXPORTS__ = {
      isLoginOrErrorPage,
      parseFavoritesMeta,
      parseFavoritesCategories,
      extractNextPageUrl,
      parseFavoritesDocument,
      sanitizeHtmlForDomParser,
      parseFavoritesHtml,
      tryMergeIncrementalCategory,
      diffFavoritesSnapshots,
      computeTagStats,
      formatStatsSummaryText,
      chunkArray,
      normalizeOrigin,
      buildApiCandidates,
      getApiFetchCredentials
    };
  }

  // Stop here when loaded inside non-browser unit-test runtime
  if (typeof document === 'undefined' || typeof chrome === 'undefined' || !chrome.storage) {
    return;
  }

  // --- UI State & Controllers ---
  let settings = {};
  let draftSettings = {};
  let hasUnsavedChanges = false;
  let fileDefaults = null;
  let fileSource = 'settings.json';
  let latestCookieStatus = null;
  let favoritesData = null;
  let importHistory = {};
  let tagCache = {};
  let currentStats = null;

  function cloneSettingsObj(obj) {
    return JSON.parse(JSON.stringify(obj || {}));
  }

  function getActiveSettings() {
    return settings || {};
  }

  function getDraftSettings() {
    return draftSettings && Object.keys(draftSettings).length > 0
      ? draftSettings
      : settings || {};
  }

  function flattenDraftInput(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const sections = [
      'features',
      'redirect',
      'shortcutCopy',
      'favorites',
      'tagStats',
      'cookies',
      'tester'
    ];
    const flat = {};
    for (const sec of sections) {
      if (raw[sec] && typeof raw[sec] === 'object' && !Array.isArray(raw[sec])) {
        Object.assign(flat, raw[sec]);
      }
    }
    for (const [k, v] of Object.entries(raw)) {
      if (!sections.includes(k) && !k.startsWith('_')) {
        flat[k] = v;
      }
    }
    if (typeof flat.highlightTags === 'string') {
      const parsedTags = flat.highlightTags
        .split(/[,，\n]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (parsedTags.length > 0) {
        flat.highlightTags = Array.from(new Set(parsedTags));
      }
    }
    return flat;
  }

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
    topbarCookieBadge: document.getElementById('topbarCookieBadge'),
    topbarSaveSettingsBtn: document.getElementById('topbarSaveSettingsBtn'),
    transferDisabledBanner: document.getElementById('transferDisabledBanner'),
    enableFavTransferInlineBtn: document.getElementById('enableFavTransferInlineBtn'),
    tagsDisabledBanner: document.getElementById('tagsDisabledBanner'),
    enableTagStatsInlineBtn: document.getElementById('enableTagStatsInlineBtn'),

    // Tab 1
    readAllFavsBtn: document.getElementById('readAllFavsBtn'),
    stopReadFavsBtn: document.getElementById('stopReadFavsBtn'),
    readDelayInput: document.getElementById('readDelayInput'),
    incrementalScanCheck: document.getElementById('incrementalScanCheck'),
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
    settingsSaveBar: document.getElementById('settingsSaveBar'),
    settingsSaveBadge: document.getElementById('settingsSaveBadge'),
    settingsSaveStatusText: document.getElementById('settingsSaveStatusText'),
    discardSettingsBtn: document.getElementById('discardSettingsBtn'),
    saveAllSettingsBtn: document.getElementById('saveAllSettingsBtn'),
    setEnableFavTransfer: document.getElementById('setEnableFavTransfer'),
    setEnableTagStats: document.getElementById('setEnableTagStats'),
    setTagStatsDesc: document.getElementById('setTagStatsDesc'),
    setEnableMirrorRedirect: document.getElementById('setEnableMirrorRedirect'),
    setEnableShortcutCopy: document.getElementById('setEnableShortcutCopy'),
    setEnableDomainSwapRedirect: document.getElementById('setEnableDomainSwapRedirect'),
    setIncrementalFavScan: document.getElementById('setIncrementalFavScan'),
    setEnableFavCompactArchiver: document.getElementById('setEnableFavCompactArchiver'),
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

    // Cookie manager controls
    cookieManagerCard: document.getElementById('cookieManagerCard'),
    syncEhToExCookieBtn: document.getElementById('syncEhToExCookieBtn'),
    loadBrowserCookiesBtn: document.getElementById('loadBrowserCookiesBtn'),
    copyCurrentCookiesBtn: document.getElementById('copyCurrentCookiesBtn'),
    clearSadPandaBtn: document.getElementById('clearSadPandaBtn'),
    exCookieStatusBadge: document.getElementById('exCookieStatusBadge'),
    ehCookieStatusBadge: document.getElementById('ehCookieStatusBadge'),
    igneousStatusBadge: document.getElementById('igneousStatusBadge'),
    cookiePasteInput: document.getElementById('cookiePasteInput'),
    parseCookiePasteBtn: document.getElementById('parseCookiePasteBtn'),
    setExCookieMemberId: document.getElementById('setExCookieMemberId'),
    setExCookiePassHash: document.getElementById('setExCookiePassHash'),
    togglePassHashVisBtn: document.getElementById('togglePassHashVisBtn'),
    setExCookieIgneous: document.getElementById('setExCookieIgneous'),
    setExCookieSk: document.getElementById('setExCookieSk'),
    applyManualCookiesBtn: document.getElementById('applyManualCookiesBtn'),
    clearManualCookiesBtn: document.getElementById('clearManualCookiesBtn'),
    cookieActionNotice: document.getElementById('cookieActionNotice'),
    setEnableExCookieManager: document.getElementById('setEnableExCookieManager'),
    setAutoSyncEhToExCookie: document.getElementById('setAutoSyncEhToExCookie'),
    setAutoRedirectUnavailableToEx: document.getElementById('setAutoRedirectUnavailableToEx'),
    setPreferExhentaiApi: document.getElementById('setPreferExhentaiApi'),
    setSyncCookieToMirror: document.getElementById('setSyncCookieToMirror'),

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
    const d = getDraftSettings();
    const p = (d && d.sampleGalleryPath) || DEFAULT_SAMPLE_GALLERY_PATH;
    return p.startsWith('/') ? p : `/${p}`;
  }

  function buildPresetUrl(kind) {
    const d = getDraftSettings();
    const samplePath = getSamplePath();
    if (kind === 'e-hentai') {
      return `https://e-hentai.org${samplePath}`;
    }
    if (kind === 'mirror') {
      const m = (d && d.mirrorDomain) || 'mirror.example.com';
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
  let lastFavoritesDiff = null;

  function resolveActiveMemberId(origin, cookieStatus) {
    if (!cookieStatus) return '';
    if (origin === 'https://exhentai.org' && cookieStatus.ex && cookieStatus.ex.memberId) {
      return String(cookieStatus.ex.memberId);
    }
    if (origin === 'https://e-hentai.org' && cookieStatus.eh && cookieStatus.eh.memberId) {
      return String(cookieStatus.eh.memberId);
    }
    return String(
      (cookieStatus.ex && cookieStatus.ex.memberId) ||
        (cookieStatus.eh && cookieStatus.eh.memberId) ||
        ''
    );
  }

  async function fetchCategoryPages(
    origin,
    favcat,
    delayMs,
    signal,
    onPageProgress,
    incrementalOpts
  ) {
    const useIncremental = Boolean(incrementalOpts && incrementalOpts.enabled);
    const prevList =
      useIncremental && Array.isArray(incrementalOpts.prevGalleries)
        ? incrementalOpts.prevGalleries
        : null;
    let knownCounts = (incrementalOpts && incrementalOpts.knownCounts) || null;
    let knownNames = (incrementalOpts && incrementalOpts.knownNames) || null;

    if (
      useIncremental &&
      knownCounts &&
      Number.isInteger(knownCounts[favcat]) &&
      knownCounts[favcat] === 0
    ) {
      return {
        favcat,
        name: (knownNames && knownNames[favcat]) || `Favorites ${favcat}`,
        galleries: [],
        categoryNames: knownNames,
        categoryCounts: knownCounts,
        pagesFetched: 0,
        incrementalMode: 'empty_skip'
      };
    }

    let nextUrl = `${origin}/favorites.php?favcat=${favcat}`;
    const visited = new Set();
    const galleryMap = new Map();
    let categoryNames = knownNames;
    let categoryCounts = knownCounts;
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
        throw new Error(
          '站点返回非网页内容 (Sad Panda)，请在「3. 跳转与全局参数设置 → ExHentai Cookie 管理」同步表站 Cookie 或填写有效的 igneous 通行证'
        );
      }

      const html = await res.text();
      const parsed = parseFavoritesHtml(html, favcat, nextUrl);
      if (parsed.loginRequired) {
        throw new Error(
          `站点 ${origin} 未登录或缺少有效 Cookie，请在浏览器登录或在「设置 → ExHentai Cookie 管理」配置 Cookie 后重试`
        );
      }

      if (parsed.categoryNames) {
        categoryNames = parsed.categoryNames;
      }
      if (parsed.categoryCounts) {
        categoryCounts = parsed.categoryCounts;
      }

      for (const item of parsed.galleries) {
        if (!galleryMap.has(item.gid)) {
          galleryMap.set(item.gid, item);
        }
      }

      const liveCount =
        categoryCounts && Number.isInteger(categoryCounts[favcat])
          ? categoryCounts[favcat]
          : null;

      if (useIncremental && prevList && parsed.nextPageUrl) {
        const mergedAttempt = tryMergeIncrementalCategory(
          Array.from(galleryMap.values()),
          prevList,
          liveCount,
          Boolean(parsed.sortedByPublished)
        );
        if (mergedAttempt) {
          return {
            favcat,
            name: (categoryNames && categoryNames[favcat]) || `Favorites ${favcat}`,
            galleries: mergedAttempt.merged,
            categoryNames,
            categoryCounts,
            pagesFetched: pageNum,
            incrementalMode: mergedAttempt.mode,
            addedInCat: mergedAttempt.addedCount
          };
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
      galleries: Array.from(galleryMap.values()),
      categoryNames,
      categoryCounts,
      pagesFetched: pageNum,
      incrementalMode: 'full'
    };
  }

  async function runReadAllFavorites(silentIfSuccess = false) {
    const activeCfg = getActiveSettings();
    if (!activeCfg.enableFavTransfer && !silentIfSuccess) {
      appendImportLog('功能 1 当前已关闭，请先开启并保存设置后再读取收藏夹', 'warn');
      return null;
    }

    const origin = getActiveOrigin();
    const minDelay = Number(activeCfg.readDelayMinMs) || 100;
    const defaultDelay = Number(activeCfg.readDelayMs) || 350;
    const delayMs = Math.max(minDelay, Number(els.readDelayInput.value) || defaultDelay);
    const incrementalSettingEnabled = els.incrementalScanCheck
      ? Boolean(els.incrementalScanCheck.checked)
      : activeCfg.incrementalFavScan !== false;

    readAbort = new AbortController();
    lastFavoritesDiff = null;

    els.readAllFavsBtn.disabled = true;
    els.stopReadFavsBtn.classList.remove('hidden');
    els.readProgressBox.classList.remove('hidden');

    if (origin === 'https://e-hentai.org') {
      appendImportLog(
        '提示：表站 (e-hentai.org) 会隐藏里站限定画廊。若收藏夹含里站限定画廊，建议切换到 https://exhentai.org 读取以免遗漏！',
        'warn'
      );
    }

    const cookieEnsureResp = await sendMessage({ type: 'EH_ENSURE_EX_COOKIES' });
    if (cookieEnsureResp && cookieEnsureResp.cookieStatus) {
      latestCookieStatus = cookieEnsureResp.cookieStatus;
      renderCookieStatusSummary(latestCookieStatus);
      if (origin === 'https://exhentai.org' && !latestCookieStatus.exReady) {
        appendImportLog(
          '警告：当前未检测到 exhentai.org 登录 Cookie，若读取报错请在「设置 → ExHentai Cookie 管理」同步或填写 Cookie（含 igneous）。',
          'warn'
        );
      }
    }

    const activeMemberId = resolveActiveMemberId(origin, latestCookieStatus);
    const prevSnapshot = favoritesData;
    const canIncrementalCompare = Boolean(
      incrementalSettingEnabled &&
        prevSnapshot &&
        Array.isArray(prevSnapshot.categories) &&
        prevSnapshot.sourceOrigin === origin &&
        (!activeMemberId ||
          !prevSnapshot.sourceMemberId ||
          prevSnapshot.sourceMemberId === activeMemberId)
    );

    appendImportLog(
      canIncrementalCompare
        ? `开始从 ${origin} 增量对比扫描 10 个收藏夹（防封禁模式：未变动分页自动跳过）...`
        : `开始从 ${origin} 完整读取 10 个收藏夹 (favcat 0~9)...`,
      'info'
    );

    const prevCatMap = new Map();
    if (canIncrementalCompare) {
      for (const c of prevSnapshot.categories) {
        prevCatMap.set(Number(c.favcat), Array.isArray(c.galleries) ? c.galleries : []);
      }
    }

    let knownCounts = null;
    let knownNames = null;
    let totalPagesFetched = 0;
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
            els.readStatusText.textContent = `正在扫描 favcat ${favcat} (第 ${pageNum} 页)...`;
            els.readPercentText.textContent = `${pct}%`;
            els.readProgressFill.style.width = `${pct}%`;
          },
          {
            enabled: canIncrementalCompare,
            prevGalleries: prevCatMap.get(favcat) || null,
            knownCounts,
            knownNames
          }
        );

        if (result.categoryCounts) knownCounts = result.categoryCounts;
        if (result.categoryNames) knownNames = result.categoryNames;
        totalPagesFetched += result.pagesFetched || 0;

        categories.push({
          favcat: result.favcat,
          name: result.name,
          galleries: result.galleries
        });

        let modeNote = '';
        if (result.incrementalMode === 'empty_skip') {
          modeNote = '（空收藏夹，0 请求跳过）';
        } else if (result.incrementalMode === 'unchanged') {
          modeNote = `（第 1 页对比未变动，已跳过后续翻页）`;
        } else if (result.incrementalMode === 'added_prefix') {
          modeNote = `（增量识别新增 +${result.addedInCat} 本，已跳过后续翻页）`;
        }

        appendImportLog(
          `读取完成 favcat ${favcat} [${result.name}]：共 ${result.galleries.length} 个画廊${modeNote}`,
          'ok'
        );
        const pctDone = Math.round(((favcat + 1) / 10) * 100);
        els.readPercentText.textContent = `${pctDone}%`;
        els.readProgressFill.style.width = `${pctDone}%`;

        if (favcat < 9 && result.pagesFetched > 0) {
          const nextIsZeroSkip =
            canIncrementalCompare &&
            knownCounts &&
            Number.isInteger(knownCounts[favcat + 1]) &&
            knownCounts[favcat + 1] === 0;
          if (!nextIsZeroSkip) {
            await sleep(delayMs);
          }
        }
      }

      const nextFavoritesData = {
        exportedAt: new Date().toISOString(),
        sourceOrigin: origin,
        sourceMemberId: activeMemberId || '',
        categories
      };

      const diff = diffFavoritesSnapshots(
        canIncrementalCompare ? prevSnapshot : null,
        nextFavoritesData
      );
      lastFavoritesDiff = diff;
      favoritesData = nextFavoritesData;
      await chrome.storage.local.set({ [FAVORITES_STORAGE_KEY]: favoritesData });

      // Remove deleted galleries from tagCache when syncing the same account
      if (diff.hasPrev && diff.removedGids.length > 0) {
        let removedCacheCount = 0;
        for (const gid of diff.removedGids) {
          if (tagCache && Object.prototype.hasOwnProperty.call(tagCache, gid)) {
            delete tagCache[gid];
            removedCacheCount += 1;
          }
        }
        if (removedCacheCount > 0) {
          await chrome.storage.local.set({ [TAG_CACHE_KEY]: tagCache });
        }
      }

      selectedCatSet = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

      if (diff.hasPrev) {
        if (diff.isGallerySetIdentical) {
          const msg = `对比完成：与上次读取完全一致（共 ${diff.nextTotal} 本去重画廊，本次仅请求 ${totalPagesFetched} 页）！`;
          els.readStatusText.textContent = msg;
          appendImportLog(msg, 'ok');
        } else {
          const msg = `增量对比完成：新增 +${diff.addedGids.length} 本，减少 -${diff.removedGids.length} 本，未变动 ${diff.unchangedCount} 本（本次共请求 ${totalPagesFetched} 页）！`;
          els.readStatusText.textContent = msg;
          appendImportLog(msg, 'ok');
        }
      } else {
        els.readStatusText.textContent = `10 个收藏夹首次完整读取完成（共 ${diff.nextTotal} 本去重画廊，请求 ${totalPagesFetched} 页）！`;
      }

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
      const err = new Error(
        '站点返回 Sad Panda 非 HTML 响应，请在「设置 → ExHentai Cookie 管理」同步新账号 Cookie 或补充有效 igneous'
      );
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

    if (origin === 'https://e-hentai.org') {
      appendImportLog(
        '提示：当前目标站点为表站 (e-hentai.org)，里站限定画廊可能无法在表站收藏。建议切换到 https://exhentai.org 导入。',
        'warn'
      );
    }

    const cookieEnsureResp = await sendMessage({ type: 'EH_ENSURE_EX_COOKIES' });
    if (cookieEnsureResp && cookieEnsureResp.cookieStatus) {
      latestCookieStatus = cookieEnsureResp.cookieStatus;
      renderCookieStatusSummary(latestCookieStatus);
    }

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
  async function callSingleApiEndpoint(apiUrl, origin, batchList) {
    const payload = JSON.stringify({
      method: 'gdata',
      gidlist: batchList.map((g) => [Number(g.gid), String(g.token)]),
      namespace: 1
    });

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      credentials: getApiFetchCredentials(apiUrl, origin)
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.startsWith('image/')) {
      throw new Error('接口返回 Sad Panda (缺少有效里站 Cookie 或 igneous)');
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('接口返回非 JSON 数据');
    }
    if (data && data.error) {
      throw new Error(`API 返回限制提示: ${data.error}`);
    }
    if (data && Array.isArray(data.gmetadata)) {
      return data.gmetadata;
    }
    throw new Error('API 返回结构缺少 gmetadata');
  }

  async function requestGdataBatch(origin, batch, exCookieReady) {
    const exApi = 'https://exhentai.org/api.php';
    const candidates = buildApiCandidates(origin, settings, exCookieReady);

    let lastError = null;
    for (const apiUrl of candidates) {
      try {
        const gmetadata = await callSingleApiEndpoint(apiUrl, origin, batch);

        // If queried via non-ExHentai API and some inner-site galleries returned errors, retry them on exhentai.org/api.php with cookies
        if (apiUrl !== exApi && exCookieReady) {
          const failedGids = new Set(
            gmetadata.filter((m) => m && m.error).map((m) => String(m.gid))
          );
          if (failedGids.size > 0) {
            const retryBatch = batch.filter((g) => failedGids.has(String(g.gid)));
            if (retryBatch.length > 0) {
              try {
                const recovered = await callSingleApiEndpoint(exApi, 'https://exhentai.org', retryBatch);
                const recMap = new Map(
                  recovered.filter((m) => m && !m.error).map((m) => [String(m.gid), m])
                );
                if (recMap.size > 0) {
                  return gmetadata.map((m) => recMap.get(String(m.gid)) || m);
                }
              } catch {
                // Keep primary gmetadata if fallback retry fails
              }
            }
          }
        }

        return gmetadata;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('API 请求失败');
  }

  async function runTagFetch(scanFavoritesFirst) {
    const activeCfg = getActiveSettings();
    if (!activeCfg.enableTagStats) {
      els.tagResultNotice.textContent = '功能 2 当前已关闭，请先开启并保存设置后再统计标签';
      return;
    }

    let scanDiff = null;
    if (scanFavoritesFirst) {
      const scanned = await runReadAllFavorites(true);
      if (!scanned) return;
      scanDiff = lastFavoritesDiff;
    } else if (!favoritesData || !Array.isArray(favoritesData.categories)) {
      els.tagResultNotice.textContent = '当前尚未读取收藏夹，正在自动扫描当前站点收藏夹...';
      const scanned = await runReadAllFavorites(true);
      if (!scanned) return;
      scanDiff = lastFavoritesDiff;
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

    // When favorites snapshot is 100% identical to previous scan and no uncached items remain, skip API completely!
    const pending = allGalleries.filter((g) => !tagCache[g.gid] || tagCache[g.gid].error);

    refreshTagStatsView();
    if (scanDiff && scanDiff.isGallerySetIdentical && pending.length === 0) {
      els.tagProgressBox.classList.remove('hidden');
      const skipMsg = `对比判断：本次收藏夹与上次读取完全一致（共 ${allGalleries.length} 个去重画廊无增删），已跳过标签 API 请求！`;
      els.tagStatusText.textContent = skipMsg;
      els.tagResultNotice.textContent = skipMsg;
      els.tagPercentText.textContent = '100%';
      els.tagProgressFill.style.width = '100%';
      return;
    }

    if (pending.length === 0) {
      els.tagProgressBox.classList.remove('hidden');
      const doneMsg =
        scanDiff && scanDiff.hasPrev && scanDiff.removedGids.length > 0
          ? `增量更新完成：已同步移除 ${scanDiff.removedGids.length} 个减少的画廊（无新增画廊），剩余 ${allGalleries.length} 个画廊均命中缓存，无需请求 API！`
          : `全部 ${allGalleries.length} 个收藏画廊均已命中缓存，统计已完成！`;
      els.tagStatusText.textContent = doneMsg;
      els.tagResultNotice.textContent = doneMsg;
      els.tagPercentText.textContent = '100%';
      els.tagProgressFill.style.width = '100%';
      return;
    }

    const origin = getActiveOrigin();
    const cookieResp = await sendMessage({ type: 'EH_ENSURE_EX_COOKIES' });
    if (cookieResp && cookieResp.cookieStatus) {
      latestCookieStatus = cookieResp.cookieStatus;
      renderCookieStatusSummary(latestCookieStatus);
    }
    const exCookieReady = Boolean(latestCookieStatus && latestCookieStatus.exReady);

    const minDelay = Number(activeCfg.tagDelayMinMs) || 200;
    const defaultDelay = Number(activeCfg.tagDelayMs) || 600;
    const delayMs = Math.max(minDelay, Number(els.tagDelayInput.value) || defaultDelay);
    const batchSize = Math.min(25, Math.max(1, Number(activeCfg.apiBatchSize) || 25));
    const cooldownEvery = Number(activeCfg.tagCooldownEveryBatches) || 0;
    const cooldownExtraMs = Number(activeCfg.tagCooldownExtraMs) || 0;
    const batches = chunkArray(pending, batchSize);

    tagController.state = 'running';
    tagController.aborted = false;

    els.scanAndFetchTagsBtn.disabled = true;
    els.fetchTagsFromCacheBtn.disabled = true;
    els.pauseTagFetchBtn.classList.remove('hidden');
    els.resumeTagFetchBtn.classList.add('hidden');
    els.stopTagFetchBtn.classList.remove('hidden');
    els.tagProgressBox.classList.remove('hidden');

    const diffPrefix =
      scanDiff && scanDiff.hasPrev
        ? `增量对比（新增 +${scanDiff.addedGids.length}，减少 -${scanDiff.removedGids.length}）：仅请求 ${pending.length} 本待更新画廊标签`
        : `正在获取 ${pending.length} 本未缓存画廊标签`;

    let processed = 0;

    try {
      for (let b = 0; b < batches.length; b++) {
        if (tagController.aborted) break;
        await waitIfPaused(tagController);
        if (tagController.aborted) break;

        const batch = batches[b];
        els.tagStatusText.textContent = `${diffPrefix} — 第 ${b + 1}/${batches.length} 批 (${processed}/${pending.length})...`;

        const gmetadataList = await requestGdataBatch(origin, batch, exCookieReady);
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
  function showCookieNotice(text) {
    if (!els.cookieActionNotice) return;
    els.cookieActionNotice.textContent = text;
  }

  function renderCookieStatusSummary(status) {
    if (!status) return;
    const setStrong = (el, text, cls) => {
      if (!el) return;
      el.textContent = text;
      el.className = cls || '';
    };

    if (!status.supported) {
      if (els.topbarCookieBadge) {
        els.topbarCookieBadge.textContent = '里站 Cookie: 需刷新插件权限';
        els.topbarCookieBadge.className = 'cookie-pill status-warn';
      }
      setStrong(els.exCookieStatusBadge, '请在扩展页刷新重载插件', 'text-amber');
      setStrong(els.ehCookieStatusBadge, '-', '');
      setStrong(els.igneousStatusBadge, '-', '');
      return;
    }

    const ex = status.ex || {};
    const eh = status.eh || {};

    if (ex.hasLogin) {
      setStrong(els.exCookieStatusBadge, `已登录 (UID: ${ex.memberId})`, 'text-green');
    } else {
      setStrong(els.exCookieStatusBadge, '未检测到登录 Cookie', 'text-red');
    }

    if (eh.hasLogin) {
      setStrong(els.ehCookieStatusBadge, `已登录 (UID: ${eh.memberId})`, 'text-green');
    } else {
      setStrong(els.ehCookieStatusBadge, '未登录', 'muted');
    }

    if (ex.hasSadPandaLock || ex.isMystery) {
      setStrong(
        els.igneousStatusBadge,
        ex.isMystery ? '受限 (mystery — 需填写有效 igneous)' : '存在 yay 白屏锁定',
        'text-red'
      );
    } else if (ex.hasValidIgneous) {
      const shortIg =
        ex.igneous.length > 8 ? `${ex.igneous.slice(0, 4)}...${ex.igneous.slice(-4)}` : ex.igneous;
      setStrong(els.igneousStatusBadge, `有效 (${shortIg})`, 'text-green');
    } else if (ex.hasLogin) {
      setStrong(els.igneousStatusBadge, '待访问里站自动签发 (或手动填入)', 'text-amber');
    } else {
      setStrong(els.igneousStatusBadge, '未配置', 'muted');
    }

    if (els.topbarCookieBadge) {
      if (status.state === 'ready_full') {
        els.topbarCookieBadge.textContent = `里站 Cookie: 已就绪 (UID ${ex.memberId})`;
        els.topbarCookieBadge.className = 'cookie-pill status-ok';
      } else if (status.state === 'ready_basic') {
        els.topbarCookieBadge.textContent = `里站 Cookie: 已登录 (UID ${ex.memberId})`;
        els.topbarCookieBadge.className = 'cookie-pill status-ok';
      } else if (status.state === 'can_sync_from_eh') {
        els.topbarCookieBadge.textContent = '里站 Cookie: 可从表站同步';
        els.topbarCookieBadge.className = 'cookie-pill status-warn';
      } else if (status.state === 'sad_panda_locked') {
        els.topbarCookieBadge.textContent = '里站 Cookie: Sad Panda 受限';
        els.topbarCookieBadge.className = 'cookie-pill status-err';
      } else {
        els.topbarCookieBadge.textContent = '里站 Cookie: 未登录';
        els.topbarCookieBadge.className = 'cookie-pill status-warn';
      }
    }
  }

  async function refreshCookieStatusUI() {
    const resp = await sendMessage({ type: 'EH_GET_COOKIE_STATUS' });
    if (resp && resp.ok && resp.cookieStatus) {
      latestCookieStatus = resp.cookieStatus;
      renderCookieStatusSummary(latestCookieStatus);
    }
  }

  function renderSaveBarState(customStatusMsg) {
    if (els.settingsSaveBar) {
      els.settingsSaveBar.classList.toggle('is-dirty', hasUnsavedChanges);
    }
    if (els.settingsSaveBadge) {
      els.settingsSaveBadge.classList.toggle('dirty', hasUnsavedChanges);
    }
    if (els.discardSettingsBtn) {
      els.discardSettingsBtn.disabled = !hasUnsavedChanges;
    }
    if (els.saveAllSettingsBtn) {
      els.saveAllSettingsBtn.textContent = hasUnsavedChanges ? '保存设置 (有未保存更改)' : '保存设置';
      els.saveAllSettingsBtn.classList.toggle('btn-unsaved', hasUnsavedChanges);
    }
    if (els.topbarSaveSettingsBtn) {
      els.topbarSaveSettingsBtn.textContent = hasUnsavedChanges ? '保存设置 *' : '保存设置';
      els.topbarSaveSettingsBtn.classList.toggle('btn-unsaved', hasUnsavedChanges);
    }
    if (els.settingsSaveStatusText) {
      if (customStatusMsg) {
        els.settingsSaveStatusText.textContent = customStatusMsg;
      } else if (hasUnsavedChanges) {
        els.settingsSaveStatusText.textContent =
          '检测到未保存的设置更改，请点击右侧「保存设置」按钮使其正式保存生效。';
      } else {
        els.settingsSaveStatusText.textContent =
          '修改控制台内任意设置参数后，请点击右侧「保存设置」按钮正式保存生效。';
      }
    }
  }

  function renderSettingsControls() {
    const d = getDraftSettings();
    els.setEnableFavTransfer.checked = Boolean(d.enableFavTransfer);
    els.setEnableTagStats.checked = Boolean(d.enableTagStats);
    els.setEnableMirrorRedirect.checked = Boolean(d.enableMirrorRedirect);
    els.setEnableShortcutCopy.checked = Boolean(d.enableShortcutCopy);
    els.setEnableDomainSwapRedirect.checked = Boolean(d.enableDomainSwapRedirect);
    if (els.setIncrementalFavScan) {
      els.setIncrementalFavScan.checked = d.incrementalFavScan !== false;
    }
    if (els.setEnableFavCompactArchiver) {
      els.setEnableFavCompactArchiver.checked = d.enableFavCompactArchiver !== false;
    }

    const highlightLabel = d.highlightTagLabel || DEFAULT_HIGHLIGHT_LABEL;
    if (els.setTagStatsDesc) {
      els.setTagStatsDesc.textContent = `统计不重复 artist / group / parody 与 ${highlightLabel}`;
    }

    if (document.activeElement !== els.setMirrorDomain) {
      els.setMirrorDomain.value = d.mirrorDomain || '';
    }
    els.setMirrorSourceScope.value = d.mirrorSourceScope || 'both';
    els.setDomainSwapRedirectMode.value = d.domainSwapRedirectMode || 'e2ex';
    els.setRedirectPriority.value = d.redirectPriority || 'mirror';
    els.setRedirectExternalOnly.checked = Boolean(d.redirectExternalOnly);

    els.setCopyTargetDomain.value = d.copyTargetDomain || 'exhentai.org';
    els.setShortcutInput.value =
      (d.customShortcut && d.customShortcut.label) || 'Alt + C';
    els.setMirrorCopyTarget.value = d.mirrorCopyTarget || 'exhentai.org';
    els.setMirrorCopyTargetRow.classList.toggle(
      'hidden',
      els.setCopyTargetDomain.value !== 'swap'
    );

    // Sync operational inputs in Tab 1 & Tab 2
    if (document.activeElement !== els.readDelayInput) {
      els.readDelayInput.min = String(d.readDelayMinMs || 100);
      els.readDelayInput.value = String(d.readDelayMs || 350);
    }
    if (els.incrementalScanCheck) {
      els.incrementalScanCheck.checked = d.incrementalFavScan !== false;
    }
    if (document.activeElement !== els.importDelayInput) {
      els.importDelayInput.min = String(d.importDelayMinMs || 150);
      els.importDelayInput.value = String(d.importDelayMs || 400);
    }
    els.reverseOrderCheck.checked =
      d.importReverseOrder !== undefined ? Boolean(d.importReverseOrder) : true;
    els.skipImportedCheck.checked =
      d.importSkipExisting !== undefined ? Boolean(d.importSkipExisting) : true;

    if (document.activeElement !== els.tagDelayInput) {
      els.tagDelayInput.min = String(d.tagDelayMinMs || 200);
      els.tagDelayInput.value = String(d.tagDelayMs || 600);
    }

    // Sync advanced controls in Tab 3
    if (els.fileSettingsSourceText) {
      els.fileSettingsSourceText.textContent = `当前默认基准配置文件：${fileSource}（修改参数后需点击「保存设置」生效；也支持从本地 settings.json 重新加载或导出）。`;
    }
    if (els.setHighlightTags && document.activeElement !== els.setHighlightTags) {
      els.setHighlightTags.value = Array.isArray(d.highlightTags)
        ? d.highlightTags.join(', ')
        : DEFAULT_HIGHLIGHT_TAGS.join(', ');
    }
    if (els.setHighlightTagLabel && document.activeElement !== els.setHighlightTagLabel) {
      els.setHighlightTagLabel.value = highlightLabel;
    }
    if (els.setSampleGalleryPath && document.activeElement !== els.setSampleGalleryPath) {
      els.setSampleGalleryPath.value = d.sampleGalleryPath || DEFAULT_SAMPLE_GALLERY_PATH;
    }
    if (els.setApiBatchSize && document.activeElement !== els.setApiBatchSize) {
      els.setApiBatchSize.value = String(d.apiBatchSize || 25);
    }
    if (
      els.setTagCooldownEveryBatches &&
      document.activeElement !== els.setTagCooldownEveryBatches
    ) {
      els.setTagCooldownEveryBatches.value = String(
        d.tagCooldownEveryBatches !== undefined ? d.tagCooldownEveryBatches : 5
      );
    }
    if (els.setTagCooldownExtraMs && document.activeElement !== els.setTagCooldownExtraMs) {
      els.setTagCooldownExtraMs.value = String(
        d.tagCooldownExtraMs !== undefined ? d.tagCooldownExtraMs : 2000
      );
    }
    if (els.setRedirectDedupWindowMs && document.activeElement !== els.setRedirectDedupWindowMs) {
      els.setRedirectDedupWindowMs.value = String(d.redirectDedupWindowMs || 6000);
    }
    if (els.setCopyDedupWindowMs && document.activeElement !== els.setCopyDedupWindowMs) {
      els.setCopyDedupWindowMs.value = String(d.copyDedupWindowMs || 400);
    }
    if (els.setToastDurationMs && document.activeElement !== els.setToastDurationMs) {
      els.setToastDurationMs.value = String(d.toastDurationMs || 3200);
    }

    if (els.setEnableExCookieManager) {
      els.setEnableExCookieManager.checked =
        d.enableExCookieManager !== undefined ? Boolean(d.enableExCookieManager) : true;
    }
    if (els.setAutoSyncEhToExCookie) {
      els.setAutoSyncEhToExCookie.checked =
        d.autoSyncEhToExCookie !== undefined ? Boolean(d.autoSyncEhToExCookie) : true;
    }
    if (els.setAutoRedirectUnavailableToEx) {
      els.setAutoRedirectUnavailableToEx.checked =
        d.autoRedirectUnavailableToEx !== undefined
          ? Boolean(d.autoRedirectUnavailableToEx)
          : true;
    }
    if (els.setPreferExhentaiApi) {
      els.setPreferExhentaiApi.checked =
        d.preferExhentaiApi !== undefined ? Boolean(d.preferExhentaiApi) : true;
    }
    if (els.setSyncCookieToMirror) {
      els.setSyncCookieToMirror.checked = Boolean(d.syncCookieToMirror);
    }

    if (els.setExCookieMemberId && document.activeElement !== els.setExCookieMemberId) {
      els.setExCookieMemberId.value = d.exCookieMemberId || '';
    }
    if (els.setExCookiePassHash && document.activeElement !== els.setExCookiePassHash) {
      els.setExCookiePassHash.value = d.exCookiePassHash || '';
    }
    if (els.setExCookieIgneous && document.activeElement !== els.setExCookieIgneous) {
      els.setExCookieIgneous.value = d.exCookieIgneous || '';
    }
    if (els.setExCookieSk && document.activeElement !== els.setExCookieSk) {
      els.setExCookieSk.value = d.exCookieSk || '';
    }

    // Active runtime banners & stats reflect committed saved settings
    els.transferDisabledBanner.classList.toggle('hidden', Boolean(settings.enableFavTransfer));
    els.tagsDisabledBanner.classList.toggle('hidden', Boolean(settings.enableTagStats));

    if (!els.testerUrlInput.value) {
      els.testerUrlInput.value = buildPresetUrl('exhentai');
    }

    renderSaveBarState();
    refreshSiteSelectLabels();
    renderFavoritesView();
    refreshTagStatsView();
    runUrlTester();
  }

  function stageSettings(partial, noticeMsg) {
    const flat = flattenDraftInput(partial);
    draftSettings = {
      ...getDraftSettings(),
      ...flat
    };
    hasUnsavedChanges = true;
    renderSettingsControls();
    if (noticeMsg) {
      showSettingsNotice(noticeMsg);
    }
  }

  function syncFormInputsIntoDraft() {
    const next = { ...getDraftSettings() };
    if (els.setMirrorDomain) next.mirrorDomain = els.setMirrorDomain.value;
    if (els.setHighlightTags) {
      const parsedTags = els.setHighlightTags.value
        .split(/[,，\n]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (parsedTags.length > 0) next.highlightTags = Array.from(new Set(parsedTags));
    }
    if (els.setHighlightTagLabel && els.setHighlightTagLabel.value.trim()) {
      next.highlightTagLabel = els.setHighlightTagLabel.value.trim();
    }
    if (els.setSampleGalleryPath && els.setSampleGalleryPath.value.trim()) {
      next.sampleGalleryPath = els.setSampleGalleryPath.value.trim();
    }
    if (els.readDelayInput) next.readDelayMs = Number(els.readDelayInput.value);
    if (els.importDelayInput) next.importDelayMs = Number(els.importDelayInput.value);
    if (els.tagDelayInput) next.tagDelayMs = Number(els.tagDelayInput.value);
    if (els.setApiBatchSize) next.apiBatchSize = Number(els.setApiBatchSize.value);
    if (els.setTagCooldownEveryBatches) {
      next.tagCooldownEveryBatches = Number(els.setTagCooldownEveryBatches.value);
    }
    if (els.setTagCooldownExtraMs) {
      next.tagCooldownExtraMs = Number(els.setTagCooldownExtraMs.value);
    }
    if (els.setRedirectDedupWindowMs) {
      next.redirectDedupWindowMs = Number(els.setRedirectDedupWindowMs.value);
    }
    if (els.setCopyDedupWindowMs) {
      next.copyDedupWindowMs = Number(els.setCopyDedupWindowMs.value);
    }
    if (els.setToastDurationMs) {
      next.toastDurationMs = Number(els.setToastDurationMs.value);
    }
    if (els.setExCookieMemberId) next.exCookieMemberId = els.setExCookieMemberId.value.trim();
    if (els.setExCookiePassHash) next.exCookiePassHash = els.setExCookiePassHash.value.trim();
    if (els.setExCookieIgneous) next.exCookieIgneous = els.setExCookieIgneous.value.trim();
    if (els.setExCookieSk) next.exCookieSk = els.setExCookieSk.value.trim();
    draftSettings = next;
  }

  async function commitDraftSettings(options = {}) {
    syncFormInputsIntoDraft();
    const payload = cloneSettingsObj(getDraftSettings());
    const resp = await sendMessage({ type: 'EH_SAVE_SETTINGS', settings: payload });
    if (resp && resp.ok && resp.settings) {
      settings = resp.settings;
      draftSettings = cloneSettingsObj(settings);
      hasUnsavedChanges = false;
      if (resp.fileDefaults) fileDefaults = resp.fileDefaults;
      if (resp.fileSource) fileSource = resp.fileSource;

      if (options.applyCookiesNow && settings.exCookieMemberId && settings.exCookiePassHash) {
        const cResp = await sendMessage({
          type: 'EH_APPLY_MANUAL_COOKIES',
          exCookieMemberId: settings.exCookieMemberId,
          exCookiePassHash: settings.exCookiePassHash,
          exCookieIgneous: settings.exCookieIgneous,
          exCookieSk: settings.exCookieSk,
          alsoApplyToEh: true
        });
        if (cResp && cResp.cookieStatus) {
          latestCookieStatus = cResp.cookieStatus;
          renderCookieStatusSummary(latestCookieStatus);
        }
      } else {
        await refreshCookieStatusUI();
      }

      renderSettingsControls();
      const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const msg = `✓ 设置已于 ${timeStr} 保存并生效！`;
      renderSaveBarState(msg);
      showSettingsNotice(msg);
      return true;
    }
    return false;
  }

  function discardDraftSettings() {
    draftSettings = cloneSettingsObj(settings);
    hasUnsavedChanges = false;
    renderSettingsControls();
    renderSaveBarState('已还原未保存的更改。');
    showSettingsNotice('已还原未保存的更改。');
  }

  async function runUrlTester() {
    const urlStr = (els.testerUrlInput.value || '').trim();
    if (!urlStr) {
      els.testerRedirectOutput.textContent = '-';
      els.testerCopyOutput.textContent = '-';
      return;
    }
    const d = getDraftSettings();
    const resp = await sendMessage({
      type: 'EH_CONVERT_URL',
      url: urlStr,
      previewSettings: d
    });
    if (!resp || !resp.ok) return;

    if (resp.redirect && resp.redirect.targetUrl) {
      els.testerRedirectOutput.textContent = `${resp.redirect.targetUrl} (${resp.redirect.reason === 'mirror' ? '功能3 转镜像站' : '功能4B 表里站域名转换'})`;
    } else {
      els.testerRedirectOutput.textContent = '不触发跳转（保留原链接）';
    }

    if (d.enableShortcutCopy && resp.converted) {
      els.testerCopyOutput.textContent = resp.converted.unchanged
        ? `${resp.converted.convertedUrl} (当前已是目标域名，保留不变)`
        : resp.converted.convertedUrl;
    } else if (!d.enableShortcutCopy) {
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

    // Save & Discard buttons
    if (els.saveAllSettingsBtn) {
      els.saveAllSettingsBtn.addEventListener('click', () => {
        commitDraftSettings({ applyCookiesNow: true });
      });
    }
    if (els.topbarSaveSettingsBtn) {
      els.topbarSaveSettingsBtn.addEventListener('click', () => {
        commitDraftSettings({ applyCookiesNow: true });
      });
    }
    if (els.discardSettingsBtn) {
      els.discardSettingsBtn.addEventListener('click', () => {
        discardDraftSettings();
      });
    }

    window.addEventListener('beforeunload', (e) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // Disabled banners inline enable (stages into draft, requires Save Settings click)
    els.enableFavTransferInlineBtn.addEventListener('click', () => {
      stageSettings({ enableFavTransfer: true });
      appendImportLog('已勾选开启功能 1，请点击右上角「保存设置」按钮确认生效！', 'warn');
    });
    els.enableTagStatsInlineBtn.addEventListener('click', () => {
      stageSettings({ enableTagStats: true });
      els.tagResultNotice.textContent = '已勾选开启功能 2，请点击右上角「保存设置」按钮确认生效！';
    });

    // Stage Tab 1 & Tab 2 operational controls into draftSettings
    els.readDelayInput.addEventListener('change', () => {
      stageSettings({ readDelayMs: Number(els.readDelayInput.value) });
    });
    if (els.incrementalScanCheck) {
      els.incrementalScanCheck.addEventListener('change', () => {
        stageSettings({ incrementalFavScan: els.incrementalScanCheck.checked });
      });
    }
    els.importDelayInput.addEventListener('change', () => {
      stageSettings({ importDelayMs: Number(els.importDelayInput.value) });
    });
    els.reverseOrderCheck.addEventListener('change', () => {
      stageSettings({ importReverseOrder: els.reverseOrderCheck.checked });
    });
    els.skipImportedCheck.addEventListener('change', () => {
      stageSettings({ importSkipExisting: els.skipImportedCheck.checked });
    });
    els.tagDelayInput.addEventListener('change', () => {
      stageSettings({ tagDelayMs: Number(els.tagDelayInput.value) });
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

    // Tab 3 Settings (stage into draft; saved only when clicking Save Settings)
    const togglePairs = [
      ['setEnableFavTransfer', 'enableFavTransfer'],
      ['setEnableTagStats', 'enableTagStats'],
      ['setEnableMirrorRedirect', 'enableMirrorRedirect'],
      ['setEnableShortcutCopy', 'enableShortcutCopy'],
      ['setEnableDomainSwapRedirect', 'enableDomainSwapRedirect'],
      ['setIncrementalFavScan', 'incrementalFavScan'],
      ['setEnableFavCompactArchiver', 'enableFavCompactArchiver'],
      ['setRedirectExternalOnly', 'redirectExternalOnly'],
      ['setEnableExCookieManager', 'enableExCookieManager'],
      ['setAutoSyncEhToExCookie', 'autoSyncEhToExCookie'],
      ['setAutoRedirectUnavailableToEx', 'autoRedirectUnavailableToEx'],
      ['setPreferExhentaiApi', 'preferExhentaiApi'],
      ['setSyncCookieToMirror', 'syncCookieToMirror']
    ];
    togglePairs.forEach(([elId, key]) => {
      if (!els[elId]) return;
      els[elId].addEventListener('change', () => {
        stageSettings({ [key]: els[elId].checked });
      });
    });

    if (els.topbarCookieBadge) {
      els.topbarCookieBadge.addEventListener('click', () => {
        switchMainTab('settings');
        window.location.hash = 'cookies';
        if (els.cookieManagerCard && els.cookieManagerCard.scrollIntoView) {
          els.cookieManagerCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }

    if (els.syncEhToExCookieBtn) {
      els.syncEhToExCookieBtn.addEventListener('click', async () => {
        const resp = await sendMessage({ type: 'EH_SYNC_COOKIES_FROM_EH' });
        if (resp && resp.cookieStatus) {
          latestCookieStatus = resp.cookieStatus;
          renderCookieStatusSummary(latestCookieStatus);
          if (latestCookieStatus.exReady) {
            showCookieNotice(
              `已成功将登录 Cookie 同步至 exhentai.org (UID: ${latestCookieStatus.ex.memberId})！`
            );
          } else {
            showCookieNotice(
              '表站尚未登录，请先在 e-hentai.org 登录账号或在下方手动粘贴 Cookie。'
            );
          }
        }
      });
    }

    if (els.loadBrowserCookiesBtn) {
      els.loadBrowserCookiesBtn.addEventListener('click', async () => {
        const resp = await sendMessage({ type: 'EH_GET_COOKIE_STATUS' });
        const st = resp && resp.cookieStatus;
        if (!st || !st.supported) {
          showCookieNotice('无法读取浏览器 Cookie，请先在扩展管理页刷新插件。');
          return;
        }
        latestCookieStatus = st;
        renderCookieStatusSummary(st);
        const src = st.ex && st.ex.hasLogin ? st.ex : st.eh || {};
        if (!src.memberId && !src.passHash) {
          showCookieNotice('当前浏览器中尚未检测到 E-Hentai / ExHentai 登录 Cookie。');
          return;
        }
        els.setExCookieMemberId.value = src.memberId || '';
        els.setExCookiePassHash.value = src.passHash || '';
        els.setExCookieIgneous.value = src.hasValidIgneous ? src.igneous : '';
        els.setExCookieSk.value = src.sk || '';
        stageSettings({
          exCookieMemberId: src.memberId || '',
          exCookiePassHash: src.passHash || '',
          exCookieIgneous: src.hasValidIgneous ? src.igneous : '',
          exCookieSk: src.sk || ''
        });
        showCookieNotice('已读取当前 Cookie 到草稿，请点击「保存设置」或「保存并写入浏览器 Cookie」持久保存。');
      });
    }

    if (els.copyCurrentCookiesBtn) {
      els.copyCurrentCookiesBtn.addEventListener('click', async () => {
        const resp = await sendMessage({ type: 'EH_GET_COOKIE_STATUS' });
        const st = resp && resp.cookieStatus;
        if (st) {
          latestCookieStatus = st;
          renderCookieStatusSummary(st);
        }
        const headerStr = st && st.cookieHeaderString;
        if (!headerStr) {
          showCookieNotice('当前无可复制的有效登录 Cookie。');
          return;
        }
        await navigator.clipboard.writeText(headerStr);
        showCookieNotice('已复制 Cookie 字符串到剪贴板！');
      });
    }

    if (els.clearSadPandaBtn) {
      els.clearSadPandaBtn.addEventListener('click', async () => {
        const resp = await sendMessage({ type: 'EH_CLEAR_SAD_PANDA' });
        if (resp && resp.cookieStatus) {
          latestCookieStatus = resp.cookieStatus;
          renderCookieStatusSummary(latestCookieStatus);
          showCookieNotice(
            `已清理 ${resp.removedCount || 0} 个异常 Cookie (yay / mystery) 并重新尝试同步！`
          );
        }
      });
    }

    const applyParsedPaste = async (rawText) => {
      if (!rawText || !rawText.trim()) {
        showCookieNotice('请先在输入框粘贴 Cookie 字符串或 JSON。');
        return;
      }
      const resp = await sendMessage({ type: 'EH_PARSE_COOKIE_INPUT', raw: rawText });
      const p = resp && resp.parsed;
      if (!p || (!p.ipb_member_id && !p.ipb_pass_hash && !p.igneous && !p.sk)) {
        showCookieNotice('未识别出 ipb_member_id / ipb_pass_hash / igneous 字段，请检查格式。');
        return;
      }
      if (p.ipb_member_id) els.setExCookieMemberId.value = p.ipb_member_id;
      if (p.ipb_pass_hash) els.setExCookiePassHash.value = p.ipb_pass_hash;
      if (p.igneous) els.setExCookieIgneous.value = p.igneous;
      if (p.sk) els.setExCookieSk.value = p.sk;
      stageSettings({
        ...(p.ipb_member_id ? { exCookieMemberId: p.ipb_member_id } : {}),
        ...(p.ipb_pass_hash ? { exCookiePassHash: p.ipb_pass_hash } : {}),
        ...(p.igneous ? { exCookieIgneous: p.igneous } : {}),
        ...(p.sk ? { exCookieSk: p.sk } : {})
      });
      showCookieNotice('已解析填入下方字段，请点击「保存设置」或「保存并写入浏览器 Cookie」生效！');
    };

    if (els.parseCookiePasteBtn) {
      els.parseCookiePasteBtn.addEventListener('click', () => {
        applyParsedPaste(els.cookiePasteInput.value);
      });
    }

    if (els.cookiePasteInput) {
      els.cookiePasteInput.addEventListener('paste', (e) => {
        const text = e.clipboardData && e.clipboardData.getData('text');
        if (text) {
          setTimeout(() => applyParsedPaste(els.cookiePasteInput.value || text), 30);
        }
      });
    }

    if (els.togglePassHashVisBtn && els.setExCookiePassHash) {
      els.togglePassHashVisBtn.addEventListener('click', () => {
        const isPwd = els.setExCookiePassHash.type === 'password';
        els.setExCookiePassHash.type = isPwd ? 'text' : 'password';
        els.togglePassHashVisBtn.textContent = isPwd ? '隐藏' : '显示';
      });
    }

    [
      ['setExCookieMemberId', 'exCookieMemberId'],
      ['setExCookiePassHash', 'exCookiePassHash'],
      ['setExCookieIgneous', 'exCookieIgneous'],
      ['setExCookieSk', 'exCookieSk']
    ].forEach(([elId, key]) => {
      if (!els[elId]) return;
      els[elId].addEventListener('input', () => {
        stageSettings({ [key]: els[elId].value.trim() });
      });
    });

    if (els.applyManualCookiesBtn) {
      els.applyManualCookiesBtn.addEventListener('click', async () => {
        const memberId = (els.setExCookieMemberId.value || '').trim();
        const passHash = (els.setExCookiePassHash.value || '').trim();

        if (!memberId || !passHash) {
          showCookieNotice('请至少填写 ipb_member_id 和 ipb_pass_hash！');
          return;
        }

        const ok = await commitDraftSettings({ applyCookiesNow: true });
        if (ok) {
          els.cookiePasteInput.value = '';
          showCookieNotice('已保存全部设置并将 Cookie 写入 exhentai.org 与 e-hentai.org！');
        }
      });
    }

    if (els.clearManualCookiesBtn) {
      els.clearManualCookiesBtn.addEventListener('click', () => {
        els.setExCookieMemberId.value = '';
        els.setExCookiePassHash.value = '';
        els.setExCookieIgneous.value = '';
        els.setExCookieSk.value = '';
        els.cookiePasteInput.value = '';
        stageSettings({
          exCookieMemberId: '',
          exCookiePassHash: '',
          exCookieIgneous: '',
          exCookieSk: ''
        });
        showCookieNotice('已清空表单中的 Cookie 字段，请点击上方「保存设置」确认保存。');
      });
    }

    const selectPairs = [
      ['setMirrorSourceScope', 'mirrorSourceScope'],
      ['setDomainSwapRedirectMode', 'domainSwapRedirectMode'],
      ['setRedirectPriority', 'redirectPriority'],
      ['setCopyTargetDomain', 'copyTargetDomain'],
      ['setMirrorCopyTarget', 'mirrorCopyTarget']
    ];
    selectPairs.forEach(([elId, key]) => {
      els[elId].addEventListener('change', () => {
        stageSettings({ [key]: els[elId].value });
      });
    });

    let mirrorDebounce = null;
    els.setMirrorDomain.addEventListener('input', () => {
      clearTimeout(mirrorDebounce);
      mirrorDebounce = setTimeout(() => {
        stageSettings({ mirrorDomain: els.setMirrorDomain.value });
      }, 200);
    });
    els.setMirrorDomain.addEventListener('blur', () => {
      clearTimeout(mirrorDebounce);
      if (els.setMirrorDomain.value !== (getDraftSettings().mirrorDomain || '')) {
        stageSettings({ mirrorDomain: els.setMirrorDomain.value });
      }
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
      stageSettings({ customShortcut: shortcut });
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
      stageSettings({ customShortcut: { ...defaultShortcut } });
    });

    els.setOpenBrowserShortcutsBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });

    // Advanced & settings.json actions
    els.reloadFileSettingsBtn.addEventListener('click', async () => {
      const resp = await sendMessage({ type: 'EH_RELOAD_FILE_SETTINGS' });
      if (resp && resp.ok && resp.settings) {
        settings = resp.settings;
        draftSettings = cloneSettingsObj(settings);
        hasUnsavedChanges = false;
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
        showSettingsNotice(
          hasUnsavedChanges
            ? '已导出上次已保存的 settings.json（当前界面仍有未保存修改，如需导出最新修改请先点击「保存设置」）。'
            : '已导出 settings.json，可直接放入插件根目录覆盖原文件。'
        );
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
        stageSettings(
          parsed,
          `已从 ${file.name} 读取配置至界面，请检查后点击「保存设置」生效！`
        );
      } catch (err) {
        showSettingsNotice(`导入配置失败：${err.message}`);
      } finally {
        els.importSettingsJsonInput.value = '';
      }
    });

    els.setHighlightTags.addEventListener('input', () => {
      stageSettings({ highlightTags: els.setHighlightTags.value });
    });
    els.setHighlightTagLabel.addEventListener('input', () => {
      stageSettings({ highlightTagLabel: els.setHighlightTagLabel.value });
    });
    els.setSampleGalleryPath.addEventListener('change', () => {
      stageSettings({ sampleGalleryPath: els.setSampleGalleryPath.value });
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
      els[elId].addEventListener('input', () => {
        stageSettings({ [key]: Number(els[elId].value) });
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
        if (!hasUnsavedChanges) {
          draftSettings = cloneSettingsObj(settings);
        }
        renderSettingsControls();
      }
    });
  }

  async function init() {
    const resp = await sendMessage({ type: 'EH_GET_SETTINGS' });
    settings = resp && resp.settings ? resp.settings : {};
    draftSettings = cloneSettingsObj(settings);
    hasUnsavedChanges = false;
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

    const applyLocationHash = () => {
      const hash = (window.location.hash || '').replace('#', '');
      if (hash === 'cookies') {
        switchMainTab('settings');
        if (els.cookieManagerCard && els.cookieManagerCard.scrollIntoView) {
          setTimeout(() => {
            els.cookieManagerCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 50);
        }
      } else if (['transfer', 'tags', 'settings'].includes(hash)) {
        switchMainTab(hash);
      }
    };

    applyLocationHash();
    window.addEventListener('hashchange', applyLocationHash);

    await refreshCookieStatusUI();
    await detectOpenSite();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
