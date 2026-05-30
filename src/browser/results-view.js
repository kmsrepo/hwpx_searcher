const VIRTUAL_PAGE_MATCH_THRESHOLD = 120;
const VIRTUAL_PAGE_MATCH_ESTIMATE = 38;
const VIRTUAL_PAGE_MATCH_MAX_HEIGHT = 520;
let activeResultVirtualizers = [];

function renderResultList(query, caseSensitive) {
  cleanupResultVirtualizers();
  resultsEl.textContent = "";
  state.resultVirtualized = false;
  const groupLevel = currentGroupLevel();
  const filesOpen = groupLevel !== GROUP_LEVEL.file;
  const detailsOpen = groupLevel === GROUP_LEVEL.detail;
  for (const item of state.searchResults) {
    const card = document.createElement("article");
    card.className = "result-card";

    const title = document.createElement("button");
    title.type = "button";
    title.className = "result-title";
    title.setAttribute("aria-expanded", String(filesOpen));

    const disclosure = document.createElement("span");
    disclosure.className = "result-disclosure";
    disclosure.setAttribute("aria-hidden", "true");
    disclosure.textContent = filesOpen ? "-" : "+";

    const name = document.createElement("span");
    name.className = "result-name";
    name.textContent = displayFileName(item);
    name.title = item.path || item.name;

    title.append(
      disclosure,
      name,
      metadataCell(displayResultFormat(item), "result-type"),
      metadataCell(formatModifiedDate(item.lastModified), "result-modified"),
      metadataCell(formatFileSize(item.size), "result-size"),
      metadataCell(String(item.count), "result-count"),
    );

    const pageList = document.createElement("div");
    pageList.className = "page-match-list";
    pageList.hidden = !filesOpen;
    title.addEventListener("click", () => {
      const shouldOpen = pageList.hidden;
      pageList.hidden = !shouldOpen;
      title.setAttribute("aria-expanded", String(shouldOpen));
      disclosure.textContent = shouldOpen ? "-" : "+";
    });

    card.append(title, pageList);
    resultsEl.append(card);

    const pageGroups = groupOccurrencesByPage(item);
    if (shouldVirtualizePageGroups(pageGroups)) {
      renderVirtualPageMatchList(pageList, pageGroups, item, query, caseSensitive, detailsOpen);
    } else {
      renderPageMatchGroups(pageList, pageGroups, item, query, caseSensitive, detailsOpen);
    }

  }
}

function cleanupResultVirtualizers() {
  for (const virtualizer of activeResultVirtualizers) {
    virtualizer.cleanup?.();
  }
  activeResultVirtualizers = [];
}

function shouldVirtualizePageGroups(pageGroups) {
  return pageGroups.length > VIRTUAL_PAGE_MATCH_THRESHOLD && Boolean(state.tanstackVirtualCore?.Virtualizer);
}

function renderPageMatchGroups(pageList, pageGroups, item, query, caseSensitive, detailsOpen) {
  for (const pageGroup of pageGroups) {
    const { row, detail } = createPageMatchGroupElements(pageGroup, item, query, caseSensitive, detailsOpen);
    pageList.append(row, detail);
  }
}

function renderVirtualPageMatchList(pageList, pageGroups, item, query, caseSensitive, detailsOpen) {
  const core = state.tanstackVirtualCore;
  pageList.classList.add("virtualized-page-match-list");
  pageList.style.maxHeight = Math.min(VIRTUAL_PAGE_MATCH_MAX_HEIGHT, Math.max(160, pageGroups.length * VIRTUAL_PAGE_MATCH_ESTIMATE)) + "px";
  pageList.tabIndex = 0;
  state.resultVirtualized = true;

  const spacer = document.createElement("div");
  spacer.className = "virtual-page-match-spacer";
  pageList.append(spacer);

  const virtualizer = new core.Virtualizer({
    count: pageGroups.length,
    getScrollElement: () => pageList,
    estimateSize: () => VIRTUAL_PAGE_MATCH_ESTIMATE,
    overscan: 8,
    observeElementRect: core.observeElementRect,
    observeElementOffset: core.observeElementOffset,
    scrollToFn: core.elementScroll,
    getItemKey: (index) => pageGroups[index]?.page ?? index,
    onChange: () => renderVisibleVirtualPageRows(),
  });
  activeResultVirtualizers.push(virtualizer);

  function renderVisibleVirtualPageRows() {
    spacer.style.height = virtualizer.getTotalSize() + "px";
    spacer.textContent = "";
    for (const virtualItem of virtualizer.getVirtualItems()) {
      const pageGroup = pageGroups[virtualItem.index];
      if (!pageGroup) {
        continue;
      }
      const container = document.createElement("div");
      container.className = "virtual-page-match-row";
      container.dataset.index = String(virtualItem.index);
      container.style.transform = `translateY(${virtualItem.start}px)`;

      const { row, detail } = createPageMatchGroupElements(pageGroup, item, query, caseSensitive, detailsOpen, () => {
        requestAnimationFrame(() => virtualizer.measureElement(container));
      });
      container.append(row, detail);
      spacer.append(container);
      virtualizer.measureElement(container);
    }
  }

  virtualizer._willUpdate();
  renderVisibleVirtualPageRows();
}

function createPageMatchGroupElements(pageGroup, item, query, caseSensitive, detailsOpen, afterToggle = null) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "page-match-row";
  row.setAttribute("aria-expanded", "false");

  const page = document.createElement("span");
  page.className = "page-match-page";
  page.textContent = t("result.page", { page: pageGroup.page });

  const count = document.createElement("span");
  count.className = "page-match-count";
  count.textContent = t("result.matchCount", { count: pageGroup.count });

  const hint = document.createElement("span");
  hint.className = "page-match-hint";
  hint.textContent = t("result.showDetails");

  const detail = document.createElement("div");
  detail.className = "page-match-detail";
  detail.hidden = true;

  row.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePageDetails(row, detail, hint, pageGroup, item, query, caseSensitive);
    afterToggle?.();
  });

  row.append(page, count, hint);
  if (detailsOpen) {
    setPageDetailsOpen(row, detail, hint, pageGroup, item, query, caseSensitive, true);
  }
  return { row, detail };
}

function renderQueuedFileList() {
  cleanupResultVirtualizers();
  state.resultVirtualized = false;
  resultsEl.textContent = "";
  for (const item of state.documents) {
    const card = document.createElement("article");
    card.className = "result-card queued-file-card";

    const row = document.createElement("div");
    row.className = "result-title queued-file-row";

    const spacer = document.createElement("span");
    spacer.className = "result-disclosure";
    spacer.setAttribute("aria-hidden", "true");

    const name = document.createElement("span");
    name.className = "result-name";
    name.textContent = displayFileName(item);
    name.title = item.path || item.name;

    row.append(
      spacer,
      name,
      metadataCell(displayResultFormat(item), "result-type"),
      metadataCell(formatModifiedDate(item.lastModified), "result-modified"),
      metadataCell(formatFileSize(item.size), "result-size"),
      metadataCell("", "result-count"),
    );
    card.append(row);
    resultsEl.append(card);
  }
}

function currentGroupLevel() {
  return Object.values(GROUP_LEVEL).includes(groupLevelEl.value) ? groupLevelEl.value : GROUP_LEVEL.file;
}

function groupOccurrencesByPage(item) {
  const grouped = new Map();
  for (const occurrence of item.occurrences || []) {
    if (!grouped.has(occurrence.page)) {
      grouped.set(occurrence.page, []);
    }
    grouped.get(occurrence.page).push(occurrence);
  }

  if (Array.isArray(item.pageMatches) && item.pageMatches.length > 0) {
    return item.pageMatches.map((pageMatch) => {
      const page = Number(pageMatch.page);
      const count = Number(pageMatch.count) || 0;
      const items = grouped.get(page) || [];
      return {
        page,
        count,
        items,
        truncated: count > items.length,
      };
    });
  }

  return [...grouped.entries()].map(([page, items]) => ({
    page,
    count: items.length,
    items,
    truncated: false,
  }));
}

function togglePageDetails(row, detail, hint, pageGroup, item, query, caseSensitive) {
  setPageDetailsOpen(row, detail, hint, pageGroup, item, query, caseSensitive, detail.hidden);
}

function setPageDetailsOpen(row, detail, hint, pageGroup, item, query, caseSensitive, shouldOpen) {
  row.setAttribute("aria-expanded", String(shouldOpen));
  detail.hidden = !shouldOpen;
  hint.textContent = shouldOpen ? t("result.openDocument") : t("result.showDetails");
  if (!shouldOpen || detail.childElementCount > 0) {
    return;
  }

  pageGroup.items.forEach((occurrence, index) => {
    const occurrenceRow = document.createElement("button");
    occurrenceRow.type = "button";
    occurrenceRow.className = "occurrence-row";
    occurrenceRow.addEventListener("click", (event) => {
      event.stopPropagation();
      void showResultPreview(item, pageGroup.page - 1);
    });

    const number = document.createElement("span");
    number.className = "occurrence-index";
    number.textContent = "#" + (index + 1);

    const text = document.createElement("span");
    text.className = "occurrence-text";
    text.innerHTML = highlight(occurrence.snippet, query, caseSensitive);

    occurrenceRow.append(number, text);
    detail.append(occurrenceRow);
  });

  if (pageGroup.truncated) {
    detail.append(renderTruncatedNotice(pageGroup, item));
  }
}

function renderTruncatedNotice(pageGroup, item) {
  const notice = document.createElement("div");
  notice.className = "occurrence-limit-notice";

  const text = document.createElement("span");
  text.textContent = t("result.limitedDetails", {
    shown: pageGroup.items.length,
    total: pageGroup.count,
  });

  const button = document.createElement("button");
  button.type = "button";
  button.className = "page-preview-button";
  button.textContent = t("result.openPagePreview");
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void showResultPreview(item, pageGroup.page - 1);
  });

  notice.append(text, button);
  return notice;
}

function displayResultFormat(item) {
  if (item.source === "folder") {
    return t("result.localFormat", { format: item.rawFormat || item.format.replace(/\s+·\s+local$/, "") });
  }
  return item.format;
}

function displayFileName(item) {
  const value = String(item.name || item.path || "");
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || value;
}

function metadataCell(text, className) {
  const cell = document.createElement("span");
  cell.className = "result-meta " + className;
  cell.textContent = text;
  return cell;
}

function formatFileSize(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }
  if (bytes < 1024) {
    return Math.round(bytes) + " B";
  }
  if (bytes < 1024 * 1024) {
    return Math.round(bytes / 1024) + " KB";
  }
  return (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + " MB";
}

function formatModifiedDate(lastModified) {
  const timestamp = Number(lastModified);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }
  return new Date(timestamp).toLocaleDateString(I18n.getLanguage(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function highlight(text, query, caseSensitive) {
  const escapedText = escapeHtml(text);
  const escapedQuery = escapeRegExp(escapeHtml(query));
  const flags = caseSensitive ? "g" : "gi";
  return escapedText.replace(new RegExp(escapedQuery, flags), (match) => `<mark>${match}</mark>`);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
