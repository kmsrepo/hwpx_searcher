let rhwp = null;

self.onmessage = async (event) => {
  const message = event.data || {};
  try {
    if (message.type === "init") {
      installMeasureTextWidth();
      const moduleUrl = URL.createObjectURL(new Blob([message.rhwpJs], { type: "text/javascript" }));
      rhwp = await import(moduleUrl);
      URL.revokeObjectURL(moduleUrl);
      await rhwp.default({ module_or_path: new Uint8Array(message.rhwpWasmBytes) });
      self.postMessage({ type: "ready" });
      return;
    }

    if (message.type === "search") {
      const result = searchDocument(message.task);
      self.postMessage({ type: "result", id: message.id, result });
    }
  } catch (error) {
    self.postMessage({
      type: message.type === "init" ? "init-error" : "error",
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

function searchDocument(task) {
  const descriptor = task.descriptor;
  const doc = createHwpDocument(task.bytes);
  try {
    const pages = doc.pageCount();
    const occurrences = [];
    const pageMatches = [];
    let count = 0;
    let previewPage = -1;

    for (let page = 0; page < pages; page += 1) {
      const text = extractPageText(doc, page);
      const remainingStoredMatches = Math.max(0, MAX_STORED_OCCURRENCES_PER_FILE - occurrences.length);
      const storedMatchLimit = Math.min(MAX_STORED_OCCURRENCES_PER_PAGE, remainingStoredMatches);
      const pageResult = collectTextMatches(text, task.query, task.caseSensitive, storedMatchLimit);
      if (pageResult.count > 0 && previewPage === -1) {
        previewPage = page;
      }
      count += pageResult.count;
      if (pageResult.count > 0) {
        pageMatches.push({
          page: page + 1,
          count: pageResult.count,
          stored: pageResult.matches.length,
        });
      }
      for (const match of pageResult.matches) {
        occurrences.push({
          page: page + 1,
          index: match.index,
          length: match.length,
          snippet: match.snippet,
        });
      }
    }

    return {
      documentIndex: task.documentIndex,
      descriptorId: descriptor.id,
      name: descriptor.name,
      format: descriptor.format,
      rawFormat: descriptor.format,
      size: descriptor.size,
      lastModified: descriptor.lastModified,
      path: descriptor.path,
      source: descriptor.source,
      pages,
      count,
      occurrences,
      pageMatches,
      previewPage,
    };
  } finally {
    doc.free();
  }
}


function createHwpDocument(bytes) {
  try {
    return new rhwp.HwpDocument(new Uint8Array(bytes));
  } catch (error) {
    throw normalizeRhwpDecodeError(error);
  }
}

function normalizeRhwpDecodeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid\s+utf-?16\s*:\s*lone surrogate found/i.test(message)) {
    return new Error(`DocInfo UTF-16 decoding failure: ${message}`);
  }
  return error instanceof Error ? error : new Error(message);
}

function installMeasureTextWidth() {
  let context = null;
  globalThis.measureTextWidth = (font, text) => {
    if (typeof OffscreenCanvas !== "undefined") {
      context ||= new OffscreenCanvas(1, 1).getContext("2d");
      context.font = font;
      return context.measureText(text).width;
    }
    let width = 0;
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] || 12);
    for (const char of text) {
      width += char.codePointAt(0) > 0x2e80 ? size * 0.95 : size * 0.55;
    }
    return width;
  };
}
