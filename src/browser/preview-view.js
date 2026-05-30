function renderPreview() {
  if (state.preview) {
    previewOverlayEl.hidden = false;
    viewerTitleEl.textContent = previewTitle(state.preview);
    viewerSourceEl.textContent = state.preview.source;
    pageEl.replaceChildren(sanitizeSvgForPreview(state.preview.svg));
    return;
  }

  previewOverlayEl.hidden = true;
  viewerTitleEl.textContent = t("preview.title");
  viewerSourceEl.textContent = "";
  pageEl.textContent = "";
}

function closePreview() {
  state.preview = null;
  renderPreview();
  if (window.__HWP_SINGLE_HTML_READY__) {
    updateReadyState();
  }
}

async function showResultPreview(item, pageIndex = item.previewPage) {
  const targetPage = Number.isFinite(pageIndex) ? pageIndex : item.previewPage;

  if (item.previewByPage?.[targetPage]) {
    state.preview = item.previewByPage[targetPage];
    renderPreview();
    return;
  }

  const descriptor = descriptorForResult(item) || state.documents[item.documentIndex];
  if (!descriptor || targetPage < 0) {
    state.preview = null;
    renderPreview();
    return;
  }

  setStatus("preview", "busy");
  try {
    const bytes = await descriptor.getBytes();
    const doc = new state.rhwp.HwpDocument(bytes);
    try {
      const pageNumber = targetPage + 1;
      const pageOccurrences = item.occurrences.filter((occurrence) => occurrence.page === pageNumber);
      const pageMatch = Array.isArray(item.pageMatches)
        ? item.pageMatches.find((match) => Number(match.page) === pageNumber)
        : null;
      const hasCompleteStoredOccurrences = !pageMatch || Number(pageMatch.count) === pageOccurrences.length;
      const preview = {
        documentIndex: item.documentIndex,
        label: descriptor.label,
        page: pageNumber,
        pages: item.pages,
        source: descriptor.source === "folder" ? descriptor.path : descriptor.repoPath,
        svg: renderHighlightedPageSvg(doc, targetPage, item.query || searchEl.value, item.caseSensitive ?? caseEl.checked, hasCompleteStoredOccurrences ? pageOccurrences : []),
      };
      item.previewByPage ||= {};
      item.previewByPage[targetPage] = preview;
      state.preview = preview;
      renderPreview();
    } finally {
      doc.free();
    }
  } catch (error) {
    state.scanErrors.push({
      path: descriptor.path,
      error: error instanceof Error ? error.message : String(error),
    });
    renderMetrics();
  } finally {
    setStatus("ready");
  }
}

function previewTitle(preview) {
  if (preview.label && Number.isFinite(preview.page) && Number.isFinite(preview.pages)) {
    return t("preview.pageTitle", {
      label: preview.label,
      page: preview.page,
      pages: preview.pages,
    });
  }
  return preview.title || t("preview.title");
}

function renderHighlightedPageSvg(doc, page, query, caseSensitive, occurrences = []) {
  const svg = doc.renderPageSvg(page);
  const rects = buildDocumentHighlightRects(doc, page, query, caseSensitive, occurrences);
  if (rects.length === 0) {
    return svg;
  }

  const highlightLayer = '<g class="hwp-document-highlights" pointer-events="none">' + rects.map((rect) =>
    '<rect class="hwp-document-highlight" x="' + formatSvgNumber(rect.x) + '" y="' + formatSvgNumber(rect.y) + '" width="' + formatSvgNumber(rect.width) + '" height="' + formatSvgNumber(rect.height) + '" rx="' + formatSvgNumber(Math.min(3, rect.height * 0.18)) + '" fill="#fde047" fill-opacity="0.78" stroke="#f43f5e" stroke-opacity="0.95" stroke-width="2.2" vector-effect="non-scaling-stroke"/>'
  ).join("") + "</g>";
  const insertAt = svg.lastIndexOf("</svg>");
  if (insertAt === -1) {
    const openingEnd = svg.indexOf(">");
    return openingEnd === -1 ? svg : svg.slice(0, openingEnd + 1) + highlightLayer + svg.slice(openingEnd + 1);
  }
  return svg.slice(0, insertAt) + highlightLayer + svg.slice(insertAt);
}

const SAFE_SVG_ELEMENTS = new Set([
  "svg", "g", "path", "rect", "text", "tspan", "line", "polyline", "polygon",
  "ellipse", "circle", "defs", "clipPath", "linearGradient", "radialGradient",
  "stop", "pattern", "mask", "use", "image",
]);
const SAFE_SVG_ATTRIBUTES = new Set([
  "aria-hidden", "class", "clip-path", "cx", "cy", "d", "dx", "dy", "fill",
  "fill-opacity", "font-family", "font-size", "font-style", "font-weight",
  "height", "id", "mask", "opacity", "points", "pointer-events", "r", "rx",
  "ry", "stroke", "stroke-dasharray", "stroke-linecap", "stroke-linejoin",
  "stroke-opacity", "stroke-width", "text-anchor", "transform", "vector-effect",
  "viewBox", "width", "x", "x1", "x2", "xlink:href", "xmlns", "xmlns:xlink",
  "y", "y1", "y2",
]);

function sanitizeSvgForPreview(svg) {
  const template = document.createElement("template");
  const parser = new DOMParser();
  const parsed = parser.parseFromString(String(svg || ""), "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.localName === "parsererror" || root.localName !== "svg") {
    return template.content;
  }

  const imported = document.importNode(root, true);
  sanitizeSvgElement(imported);
  if (imported.parentNode) {
    imported.parentNode.removeChild(imported);
  }
  template.content.append(imported);
  return template.content;
}

function sanitizeSvgElement(element) {
  for (const child of Array.from(element.children)) {
    if (!SAFE_SVG_ELEMENTS.has(child.localName)) {
      child.remove();
      continue;
    }
    sanitizeSvgElement(child);
  }

  for (const attr of Array.from(element.attributes)) {
    if (attr.name.startsWith("on") || !SAFE_SVG_ATTRIBUTES.has(attr.name)) {
      element.removeAttribute(attr.name);
      continue;
    }
    if (isUnsafeSvgAttributeValue(attr.name, attr.value)) {
      element.removeAttribute(attr.name);
    }
  }
}

function isUnsafeSvgAttributeValue(name, value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.includes("javascript:") || normalized.includes("data:text/html")) {
    return true;
  }
  if (normalized.includes("url(") && !normalized.includes("url(#")) {
    return true;
  }
  if (name === "href" || name === "xlink:href") {
    return normalized.length > 0
      && !normalized.startsWith("#")
      && !/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/.test(normalized);
  }
  return false;
}

function buildDocumentHighlightRects(doc, page, query, caseSensitive, occurrences = []) {
  if (!query) {
    return [];
  }

  const layout = parsePageTextLayout(doc.getPageTextLayout(page));
  const rawRunInfos = [];
  let textStart = 0;
  for (const run of layout.runs || []) {
    if (typeof run.text !== "string") {
      continue;
    }
    const normalized = normalizeRunTextWithMap(run.text);
    if (!normalized.text) {
      continue;
    }
    rawRunInfos.push({
      run,
      text: normalized.text,
      map: normalized.map,
      textStart,
    });
    textStart += normalized.text.length;
  }

  const occurrenceMatches = occurrences
    .filter((occurrence) => Number.isFinite(Number(occurrence.index)))
    .map((occurrence) => ({
      index: Number(occurrence.index),
      length: Math.max(1, Number(occurrence.length) || query.length),
    }));

  if (occurrenceMatches.length > 0) {
    const runInfos = rawRunInfos.map((info) => ({
      ...info,
      start: info.textStart,
    }));
    return rectsForMatches(runInfos, occurrenceMatches);
  }

  let fullText = "";
  const fallbackRunInfos = rawRunInfos.map((info) => {
    const start = fullText.length;
    fullText += info.text;
    return { ...info, start };
  });
  const matches = findTextMatches(fullText, query, caseSensitive).map((match) => ({
    index: match.index,
    length: match.length,
  }));
  return rectsForMatches(fallbackRunInfos, matches);
}

function rectsForMatches(runInfos, matches) {
  const rects = [];
  for (const match of matches) {
    const start = match.index;
    const end = match.index + match.length;
    for (const info of runInfos) {
      const runStart = info.start;
      const runEnd = info.start + info.text.length;
      if (end <= runStart || start >= runEnd) {
        continue;
      }

      const cleanStart = Math.max(start - runStart, 0);
      const cleanEnd = Math.min(end - runStart, info.text.length);
      const originalStart = info.map[cleanStart] ?? cleanStart;
      const originalEnd = (info.map[cleanEnd - 1] ?? cleanEnd - 1) + 1;
      const rect = rectForRunRange(info.run, originalStart, originalEnd);
      if (rect) {
        rects.push(rect);
      }
    }
  }
  return rects;
}

function rectForRunRange(run, start, end) {
  const x = numberOr(run.x, 0);
  const y = numberOr(run.y, 0);
  const width = numberOr(run.w, 0);
  const height = Math.max(numberOr(run.h, 0), numberOr(run.fontSize, 12) * 1.05);
  const charX = Array.isArray(run.charX) ? run.charX : [];
  const textLength = typeof run.text === "string" ? run.text.length : 0;
  const startOffset = charOffsetAt(charX, start, width, textLength);
  const endOffset = charOffsetAt(charX, end, width, textLength);
  const rectWidth = Math.max(2, endOffset - startOffset);
  return {
    x: x + startOffset - 1.5,
    y: y - 1,
    width: rectWidth + 3,
    height: height + 2,
  };
}

function charOffsetAt(charX, index, width, textLength) {
  const direct = Number(charX[index]);
  if (Number.isFinite(direct)) {
    return direct;
  }
  if (textLength <= 0) {
    return 0;
  }
  return width * Math.max(0, Math.min(index, textLength)) / textLength;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatSvgNumber(value) {
  return String(Math.round(value * 1000) / 1000);
}
