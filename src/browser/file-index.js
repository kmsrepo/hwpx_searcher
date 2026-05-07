function filesFromTestItems(items) {
  return items.map((item) => ({
    name: item.name,
    webkitRelativePath: item.relativePath || item.name,
    size: item.size ?? Math.floor((item.base64?.length || 0) * 3 / 4),
    lastModified: item.lastModified ?? 0,
    arrayBuffer: async () => base64ToBytes(item.base64).buffer,
  }));
}

function installFolderPicker({ button, input }) {
  if (!button || !input) {
    return;
  }
  input.addEventListener("change", async () => {
    await loadSelectedFiles(Array.from(input.files || []));
  });

  button.addEventListener("click", async () => {
    try {
      input.click();
    } catch (error) {
      state.scanErrors = [{
        path: "file-picker",
        error: error instanceof Error ? error.message : String(error),
      }];
      fileStateEl.textContent = t("index.dropFailed");
      setStatus("error", "error");
      renderMetrics();
      updateReadyState();
    }
  });
}

async function loadSelectedFiles(files) {
  state.localDocuments = [];
  state.scanErrors = [];
  state.searchResults = [];
  state.preview = null;
  state.scanned = 0;
  state.totalMatches = 0;
  state.storedFileCount = 0;

  const resolvedFiles = await resolveSearchableFiles(files);
  const hwpFiles = resolvedFiles
    .sort((a, b) => filePathOf(a).localeCompare(filePathOf(b)));

  if (hwpFiles.length === 0) {
    await clearStoredFiles();
    fileStateEl.textContent = t("index.noHwpFiles");
    syncDocuments();
    renderPreview();
    renderIdleSummary();
    updateReadyState();
    return;
  }

  state.localDocuments = await createDocumentDescriptors(hwpFiles);

  syncDocuments();
  setStatus("ready");
  fileStateEl.textContent = t("summary.queued", { count: state.localDocuments.length });
  renderPreview();
  renderIdleSummary();
  updateReadyState();
}

async function resolveSearchableFiles(files) {
  const output = [];
  for (const file of files) {
    if (!isHwpLikeFile(file)) {
      continue;
    }
    const detectedFormat = await detectDocumentFormat(file);
    if (!detectedFormat) {
      state.scanErrors.push({
        path: filePathOf(file),
        error: "Unsupported HWP/HWPX signature",
      });
      continue;
    }
    output.push(fileWithDetectedFormat(file, detectedFormat));
  }
  return output;
}

function handleDragEnter(event) {
  if (!isFileDrag(event)) {
    return;
  }
  event.preventDefault();
  state.dragDepth += 1;
  showDropOverlay(true);
}

function handleDragOver(event) {
  if (!isFileDrag(event)) {
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
  showDropOverlay(true);
}

function handleDragLeave(event) {
  if (!isFileDrag(event)) {
    return;
  }
  event.preventDefault();
  state.dragDepth = Math.max(0, state.dragDepth - 1);
  if (state.dragDepth === 0) {
    showDropOverlay(false);
  }
}

async function handleDrop(event) {
  if (!isFileDrag(event)) {
    return;
  }
  event.preventDefault();
  state.dragDepth = 0;
  showDropOverlay(false);
  await loadDroppedDataTransfer(event.dataTransfer);
}

function isFileDrag(event) {
  const types = Array.from(event.dataTransfer?.types || []);
  return types.includes("Files") || (event.dataTransfer?.files?.length ?? 0) > 0;
}

function showDropOverlay(active) {
  dropOverlayEl.hidden = !active;
}

async function loadDroppedDataTransfer(dataTransfer) {
  try {
    setStatus("indexing", "busy");
    const files = await collectDroppedFiles(dataTransfer);
    await loadSelectedFiles(files);
  } catch (error) {
    state.scanErrors = [{
      path: "drag-drop",
      error: error instanceof Error ? error.message : String(error),
    }];
    fileStateEl.textContent = t("index.dropFailed");
    setStatus("error", "error");
    renderMetrics();
    updateReadyState();
  }
}

async function collectDroppedFiles(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  const handleItems = items
    .map((item) => typeof item.getAsFileSystemHandle === "function" ? item.getAsFileSystemHandle() : null)
    .filter(Boolean);
  if (handleItems.length > 0) {
    const files = [];
    for (const handlePromise of handleItems) {
      const handle = await handlePromise;
      await collectFileSystemHandleFiles(handle, "", files);
    }
    if (files.length > 0) {
      return files;
    }
  }

  const entryItems = items
    .map((item) => typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null)
    .filter(Boolean);

  if (entryItems.length > 0) {
    const files = [];
    for (const entry of entryItems) {
      await collectEntryFiles(entry, "", files);
    }
    if (files.length > 0) {
      return files;
    }
  }

  const itemFiles = items
    .map((item) => item.kind === "file" && typeof item.getAsFile === "function" ? item.getAsFile() : null)
    .filter(Boolean);
  if (itemFiles.length > 0) {
    return itemFiles;
  }

  return Array.from(dataTransfer?.files || []);
}

async function collectFileSystemHandleFiles(handle, prefix, output) {
  if (!handle) {
    return;
  }
  if (handle.kind === "file") {
    const file = await handle.getFile();
    output.push(fileWithRelativePath(file, prefix + handle.name));
    return;
  }
  if (handle.kind !== "directory") {
    return;
  }

  const directoryPrefix = prefix + handle.name + "/";
  for await (const childHandle of handle.values()) {
    await collectFileSystemHandleFiles(childHandle, directoryPrefix, output);
  }
}

async function collectEntryFiles(entry, prefix, output) {
  if (entry.isFile) {
    await new Promise((resolve, reject) => {
      entry.file((file) => {
        output.push(fileWithRelativePath(file, prefix + file.name));
        resolve();
      }, reject);
    });
    return;
  }

  if (!entry.isDirectory) {
    return;
  }

  const reader = entry.createReader();
  const directoryPrefix = prefix + entry.name + "/";
  while (true) {
    const entries = await readDirectoryEntries(reader);
    if (entries.length === 0) {
      break;
    }
    for (const child of entries) {
      await collectEntryFiles(child, directoryPrefix, output);
    }
  }
}

function readDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

async function createDocumentDescriptors(files) {
  const records = files.map((file) => ({
    id: "folder:" + filePathOf(file),
    name: file.name,
    label: filePathOf(file),
    format: fileFormatOf(file),
    path: filePathOf(file),
    repoPath: filePathOf(file),
    source: "folder",
    size: file.size ?? 0,
    lastModified: file.lastModified ?? 0,
    file,
  }));

  if (!BrowserFileStore.isSupported()) {
    state.fileStorage = "memory";
    state.storedFileCount = 0;
    return records.map((record) => memoryDescriptor(record));
  }

  try {
    const stored = await BrowserFileStore.replaceFiles(records);
    state.fileStorage = "indexeddb";
    state.storedFileCount = stored.length;
    return stored.map((record) => indexedDbDescriptor(record));
  } catch (error) {
    state.fileStorage = "memory";
    state.storedFileCount = 0;
    state.scanErrors.push({
      path: "indexeddb",
      error: error instanceof Error ? error.message : String(error),
    });
    return records.map((record) => memoryDescriptor(record));
  }
}

function indexedDbDescriptor(record) {
  return {
    ...record,
    getBytes: async () => BrowserFileStore.getBytes(record.id),
  };
}

function memoryDescriptor(record) {
  const { file, ...metadata } = record;
  return {
    ...metadata,
    getBytes: async () => new Uint8Array(await file.arrayBuffer()),
  };
}

async function clearStoredFiles() {
  if (!BrowserFileStore.isSupported()) {
    state.fileStorage = "memory";
    state.storedFileCount = 0;
    return;
  }

  try {
    await BrowserFileStore.clear();
    state.fileStorage = "indexeddb";
    state.storedFileCount = 0;
  } catch {
    state.fileStorage = "memory";
    state.storedFileCount = 0;
  }
}

function fileWithRelativePath(file, relativePath) {
  if (!relativePath) {
    return file;
  }
  return {
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    webkitRelativePath: relativePath,
    blob: file,
    arrayBuffer: () => file.arrayBuffer(),
  };
}

function isHwpLikeFile(file) {
  const ext = extensionOf(file.name || filePathOf(file));
  return ext === "hwp" || ext === "hwpx";
}

async function detectDocumentFormat(file) {
  const head = await readFileHead(file, 32);
  if (hasCfbSignature(head)) {
    return "HWP";
  }
  if (hasZipSignature(head)) {
    return "HWPX";
  }
  if (hasHwp3Signature(head)) {
    return "HWP 3.0";
  }
  return null;
}

function readFileHead(file, size) {
  const source = file?.blob instanceof Blob
    ? file.blob
    : (file instanceof Blob ? file : null);
  if (source) {
    return source.slice(0, size).arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return file.arrayBuffer().then((buffer) => new Uint8Array(buffer).slice(0, size));
}

function hasCfbSignature(bytes) {
  return bytes[0] === 0xd0
    && bytes[1] === 0xcf
    && bytes[2] === 0x11
    && bytes[3] === 0xe0
    && bytes[4] === 0xa1
    && bytes[5] === 0xb1
    && bytes[6] === 0x1a
    && bytes[7] === 0xe1;
}

function hasZipSignature(bytes) {
  return bytes[0] === 0x50
    && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
    && (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08);
}

function hasHwp3Signature(bytes) {
  const signature = "HWP Document File";
  if (bytes.length < signature.length) {
    return false;
  }

  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function fileWithDetectedFormat(file, format) {
  const sourceBlob = file?.blob instanceof Blob ? file.blob : file;
  return {
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    webkitRelativePath: file.webkitRelativePath || "",
    blob: sourceBlob,
    arrayBuffer: () => sourceBlob.arrayBuffer(),
    __detectedFormat: format,
  };
}

function fileFormatOf(file) {
  return file.__detectedFormat || extensionOf(file.name).toUpperCase();
}

function filePathOf(file) {
  return file.webkitRelativePath || file.name || "untitled";
}

function extensionOf(fileName) {
  const lastDot = fileName.lastIndexOf(".");
  return lastDot >= 0 ? fileName.slice(lastDot + 1).toLocaleLowerCase() : "";
}
