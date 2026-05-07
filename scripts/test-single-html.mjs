import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";

const htmlPath = path.resolve(process.argv[2] ?? "hwp-search.html");
const htmlDir = path.dirname(htmlPath);
const wasmPath = path.join(htmlDir, "rhwp_bg.wasm");
const wasmFallbackPath = path.join(htmlDir, "rhwp_bg.wasm.base64.js");
const htmlSource = await readFile(htmlPath, "utf8");
const embedsWasm = htmlSource.includes("\"rhwpWasmBase64\":\"");
if (embedsWasm) {
  if (htmlSource.includes("\"rhwpWasmUrl\":") || htmlSource.includes("\"rhwpWasmFallbackUrl\":")) {
    throw new Error("Standalone HTML should not reference external WASM assets");
  }
} else {
  const [wasmBytes, wasmFallbackSource] = await Promise.all([
    readFile(wasmPath),
    readFile(wasmFallbackPath, "utf8"),
  ]);
  if (!htmlSource.includes("\"rhwpWasmUrl\":\"rhwp_bg.wasm\"") || !htmlSource.includes("\"rhwpWasmFallbackUrl\":\"rhwp_bg.wasm.base64.js\"")) {
    throw new Error("Production HTML is missing external WASM asset references");
  }
  if (!wasmBytes.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) {
    throw new Error("rhwp_bg.wasm does not have a WASM magic header");
  }
  if (!wasmFallbackSource.includes("__HWP_SEARCH_RHWP_WASM_BASE64__")) {
    throw new Error("WASM fallback script is missing its global payload");
  }
}
const chromePath = findChrome();
const port = await getFreePort();
const userDataDir = await mkdtemp(path.join(tmpdir(), "hwp-html-chrome-"));
const chromeArgs = [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  pathToFileURL(htmlPath).href,
];
if (process.env.CI) {
  chromeArgs.splice(2, 0, "--no-sandbox", "--disable-dev-shm-usage");
}
const chrome = spawn(chromePath, chromeArgs, {
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
chrome.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});

try {
  const page = await waitForPage(port);
  const client = await connectCdp(page.webSocketDebuggerUrl);

  await client.send("Runtime.enable");
  await client.send("Log.enable");
  await client.send("Page.enable");

  const ready = await waitForReady(client);
  if (!ready.ok) {
    throw new Error(`App reported failure: ${ready.error ?? "unknown error"}`);
  }
  if (ready.sampleCount !== 0) {
    throw new Error(`Production app should not embed sample documents, saw ${ready.sampleCount}`);
  }
  if (ready.localCount !== 0 || ready.documentCount !== 0) {
    throw new Error(`Unexpected initial document counts: ${JSON.stringify(ready)}`);
  }
  if (ready.parsedOnLoad !== false || ready.searchResultCount !== 0) {
    throw new Error(`Documents should not be parsed before search: ${JSON.stringify(ready)}`);
  }
  const expectedWasmSources = embedsWasm ? ["embedded-base64"] : ["wasm-file", "wasm-fallback-script"];
  if (!expectedWasmSources.includes(ready.wasmSource)) {
    throw new Error(`App did not load rhwp through an external WASM path: ${JSON.stringify(ready)}`);
  }
  if (!ready.workerSupported || ready.maxWorkers < 1 || ready.cpuThreads < 1 || ready.autoWorkerLimit !== Math.max(1, Math.ceil(ready.cpuThreads * 0.5))) {
    throw new Error(`Worker support was not detected: ${JSON.stringify(ready)}`);
  }
  if (ready.themePreference !== "system" || !["light", "dark"].includes(ready.theme)) {
    throw new Error(`Initial system theme was not reported: ${JSON.stringify(ready)}`);
  }
  if (ready.language !== "en") {
    throw new Error(`Initial language was wrong: ${JSON.stringify(ready)}`);
  }
  const initialUi = await client.evaluate(`(() => ({
    menuGone: !document.querySelector(".menubar"),
    dropOverlayHidden: document.querySelector("#drop-overlay")?.hidden,
    queuedSelectorGone: !document.querySelector("#sample"),
    filterControlsGone: !document.querySelector("#filter-hwp, #filter-hwpx, #path-filter"),
    filterPanelLabelGone: !document.body.textContent.includes("Filters"),
    groupLevelValue: document.querySelector("#group-level")?.value,
    groupSliderValue: document.querySelector("#group-level-slider")?.dataset.value,
    groupSliderSelected: document.querySelector("[data-group-level='file']")?.getAttribute("aria-checked"),
    sortHeaderActive: document.querySelector("[data-sort-field='name']")?.getAttribute("aria-sort"),
    sortHeaderText: document.querySelector("[data-sort-field='name']")?.textContent?.trim(),
    themeButtonPreference: document.querySelector("#theme-button")?.dataset.themePreference,
    themeButtonText: document.querySelector("#theme-button-label")?.textContent,
  }))()`);
  if (!initialUi.menuGone || initialUi.dropOverlayHidden !== true || !initialUi.queuedSelectorGone || !initialUi.filterControlsGone || !initialUi.filterPanelLabelGone || initialUi.groupLevelValue !== "file" || initialUi.groupSliderValue !== "file" || initialUi.groupSliderSelected !== "true" || initialUi.sortHeaderActive !== "ascending" || !initialUi.sortHeaderText?.includes("Filename") || initialUi.themeButtonPreference !== "system" || initialUi.themeButtonText !== "Theme: System") {
    throw new Error(`Initial UI chrome was wrong: ${JSON.stringify(initialUi)}`);
  }
  const browserCoreSafety = await client.evaluate(`(() => {
    const maliciousSvg = '<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><foreignObject><div>bad</div></foreignObject><rect x="1" y="2" width="3" height="4" onclick="alert(2)" fill="url(https://example.com/paint)"/><circle cx="5" cy="5" r="2" fill="#000"/></svg>';
    const sanitized = window.__HWP_SINGLE_HTML_TEST__.sanitizeSvg(maliciousSvg);
    return {
      emptyMatches: window.__HWP_SINGLE_HTML_TEST__.findTextMatches("text", "", false).length,
      sanitized,
      keepsSafeShape: sanitized.includes("<circle"),
      keepsRoot: sanitized.includes("<svg"),
    };
  })()`);
  if (browserCoreSafety.emptyMatches !== 0 || !browserCoreSafety.keepsSafeShape || !browserCoreSafety.keepsRoot || /script|foreignObject|onload|onclick|https:\/\/example\.com|url\(https:/i.test(browserCoreSafety.sanitized)) {
    throw new Error(`Browser core safety checks failed: ${JSON.stringify(browserCoreSafety)}`);
  }

  const koreanLanguage = await client.evaluate(`(async () => {
    const state = await window.__HWP_SINGLE_HTML_TEST__.setLanguage("ko");
    return {
      ...state,
      htmlLang: document.documentElement.lang,
      searchButton: document.querySelector("#search-button")?.textContent,
      searchPlaceholder: document.querySelector("#search")?.getAttribute("placeholder"),
      status: document.querySelector("#status")?.textContent,
      summary: document.querySelector("#summary")?.textContent,
      groupLabel: document.querySelector("label[for='group-level']")?.textContent,
      sortHeaderText: document.querySelector("[data-sort-field='name']")?.textContent?.trim(),
    };
  })()`);
  if (koreanLanguage.language !== "ko" || koreanLanguage.htmlLang !== "ko" || koreanLanguage.searchButton !== "검색" || koreanLanguage.searchPlaceholder !== "검색어" || koreanLanguage.status !== "준비됨" || koreanLanguage.summary !== "대기 중" || koreanLanguage.groupLabel !== "그룹 단계" || !koreanLanguage.sortHeaderText?.includes("파일명")) {
    throw new Error(`Korean language did not apply: ${JSON.stringify(koreanLanguage)}`);
  }
  const englishLanguage = await client.evaluate(`(async () => {
    const state = await window.__HWP_SINGLE_HTML_TEST__.setLanguage("en");
    return {
      ...state,
      htmlLang: document.documentElement.lang,
      searchButton: document.querySelector("#search-button")?.textContent,
      searchPlaceholder: document.querySelector("#search")?.getAttribute("placeholder"),
      status: document.querySelector("#status")?.textContent,
      summary: document.querySelector("#summary")?.textContent,
    };
  })()`);
  if (englishLanguage.language !== "en" || englishLanguage.htmlLang !== "en" || englishLanguage.searchButton !== "Search" || englishLanguage.searchPlaceholder !== "Search text" || englishLanguage.status !== "Ready" || englishLanguage.summary !== "Idle") {
    throw new Error(`English language did not restore: ${JSON.stringify(englishLanguage)}`);
  }

  const themeButtonCycle = await client.evaluate(`(() => {
    const button = document.querySelector("#theme-button");
    const select = document.querySelector("#theme-select");
    button.click();
    const light = {
      preference: window.__HWP_SINGLE_HTML_TEST__.state().themePreference,
      selectValue: select?.value,
      buttonPreference: button?.dataset.themePreference,
      buttonText: document.querySelector("#theme-button-label")?.textContent,
    };
    button.click();
    const dark = {
      preference: window.__HWP_SINGLE_HTML_TEST__.state().themePreference,
      selectValue: select?.value,
      buttonPreference: button?.dataset.themePreference,
      buttonText: document.querySelector("#theme-button-label")?.textContent,
    };
    button.click();
    const system = {
      preference: window.__HWP_SINGLE_HTML_TEST__.state().themePreference,
      selectValue: select?.value,
      buttonPreference: button?.dataset.themePreference,
      buttonText: document.querySelector("#theme-button-label")?.textContent,
    };
    return { light, dark, system };
  })()`);
  if (themeButtonCycle.light.preference !== "light" || themeButtonCycle.light.selectValue !== "light" || themeButtonCycle.light.buttonPreference !== "light" || themeButtonCycle.light.buttonText !== "Theme: Light") {
    throw new Error(`Theme button did not switch to light: ${JSON.stringify(themeButtonCycle)}`);
  }
  if (themeButtonCycle.dark.preference !== "dark" || themeButtonCycle.dark.selectValue !== "dark" || themeButtonCycle.dark.buttonPreference !== "dark" || themeButtonCycle.dark.buttonText !== "Theme: Dark") {
    throw new Error(`Theme button did not switch to dark: ${JSON.stringify(themeButtonCycle)}`);
  }
  if (themeButtonCycle.system.preference !== "system" || themeButtonCycle.system.selectValue !== "system" || themeButtonCycle.system.buttonPreference !== "system" || themeButtonCycle.system.buttonText !== "Theme: System") {
    throw new Error(`Theme button did not switch to system: ${JSON.stringify(themeButtonCycle)}`);
  }

  const darkTheme = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.setTheme("dark")`);
  if (darkTheme.themePreference !== "dark" || darkTheme.theme !== "dark") {
    throw new Error(`Dark theme did not apply: ${JSON.stringify(darkTheme)}`);
  }
  const lightTheme = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.setTheme("light")`);
  if (lightTheme.themePreference !== "light" || lightTheme.theme !== "light") {
    throw new Error(`Light theme did not apply: ${JSON.stringify(lightTheme)}`);
  }
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  const systemDarkTheme = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.setTheme("system")`);
  if (systemDarkTheme.themePreference !== "system" || systemDarkTheme.theme !== "dark") {
    throw new Error(`System dark theme did not apply: ${JSON.stringify(systemDarkTheme)}`);
  }
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  const systemTheme = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.setTheme("system")`);
  if (systemTheme.themePreference !== "system" || systemTheme.theme !== "light") {
    throw new Error(`System theme did not apply: ${JSON.stringify(systemTheme)}`);
  }

  const virtualFiles = [
    {
      name: "local-line.hwp",
      relativePath: "contracts/2026/local-line.hwp",
      size: 2048,
      lastModified: Date.UTC(2024, 0, 5),
      base64: await readFile(path.resolve("samples/rhwp/lseg-01-basic.hwp"), "base64"),
    },
    {
      name: "local-ref.hwpx",
      relativePath: "contracts/references/local-ref.hwpx",
      size: 4096,
      lastModified: Date.UTC(2025, 6, 15),
      base64: await readFile(path.resolve("samples/rhwp/ref_text.hwpx"), "base64"),
    },
  ];
  const dragUi = await client.evaluate(`(() => {
    const app = document.querySelector(".app-window");
    const overlay = document.querySelector("#drop-overlay");
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["x"], "x.hwp"));
    app.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }));
    const shown = overlay && !overlay.hidden;
    app.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, dataTransfer }));
    return {
      shown,
      hiddenAfterLeave: overlay?.hidden,
    };
  })()`);
  if (!dragUi.shown || dragUi.hiddenAfterLeave !== true) {
    throw new Error(`Drag overlay did not toggle correctly: ${JSON.stringify(dragUi)}`);
  }

  const folderResult = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.dropFiles(${JSON.stringify(virtualFiles)})`);
  if (folderResult.localCount !== 2 || folderResult.documentCount !== 2 || folderResult.scanErrors !== 0 || folderResult.searchResultCount !== 0) {
    throw new Error(`Drag/drop import failed: ${JSON.stringify(folderResult)}`);
  }
  if (folderResult.fileStorage !== "indexeddb" || folderResult.storedFileCount !== 2) {
    throw new Error(`Drag/drop import did not use browser database storage: ${JSON.stringify(folderResult)}`);
  }
  if (folderResult.samples.some((sample) => sample.loaded !== false)) {
    throw new Error(`Drag/drop import parsed documents before search: ${JSON.stringify(folderResult)}`);
  }
  if (folderResult.sortField !== "name" || folderResult.sortDirection !== "asc" || folderResult.samples[0]?.name !== "local-line.hwp" || folderResult.samples[1]?.name !== "local-ref.hwpx") {
    throw new Error(`Default filename sort was wrong: ${JSON.stringify(folderResult)}`);
  }
  const noQueuedRows = await client.evaluate(`(() => ({
    rows: document.querySelectorAll(".result-card").length,
    names: document.querySelectorAll(".result-name").length,
    headerScrolls: document.querySelector("#file-detail-header").scrollWidth > document.querySelector("#file-detail-header").clientWidth,
    listScrollsX: document.querySelector("#results").scrollWidth > document.querySelector("#results").clientWidth,
  }))()`);
  if (noQueuedRows.rows !== 0 || noQueuedRows.names !== 0 || noQueuedRows.headerScrolls || noQueuedRows.listScrollsX) {
    throw new Error(`Queued files rendered before search or details header overflowed: ${JSON.stringify(noQueuedRows)}`);
  }

  const modifiedSort = await client.evaluate(`(() => {
    document.querySelector("[data-sort-field='modified']")?.click();
    document.querySelector("[data-sort-field='modified']")?.click();
    return {
      ...window.__HWP_SINGLE_HTML_TEST__.state(),
      modifiedHeader: document.querySelector("[data-sort-field='modified']")?.getAttribute("aria-sort"),
      rows: [...document.querySelectorAll(".result-name")].map((node) => node.textContent),
    };
  })()`);
  if (modifiedSort.sortField !== "modified" || modifiedSort.sortDirection !== "desc" || modifiedSort.samples[0]?.path !== "contracts/references/local-ref.hwpx" || modifiedSort.samples[1]?.path !== "contracts/2026/local-line.hwp" || modifiedSort.samples[0]?.lastModified <= modifiedSort.samples[1]?.lastModified) {
    throw new Error(`Modified-date sort was wrong: ${JSON.stringify(modifiedSort)}`);
  }
  const nameSort = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.setSort("name", "asc")`);
  if (nameSort.sortField !== "name" || nameSort.sortDirection !== "asc" || nameSort.samples[0]?.name !== "local-line.hwp" || nameSort.samples[1]?.name !== "local-ref.hwpx") {
    throw new Error(`Filename sort was wrong: ${JSON.stringify(nameSort)}`);
  }

  const hwpxSearchState = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.search("\\uC548\\uB155")`);
  if (hwpxSearchState.workerCount < 1 || hwpxSearchState.searchResultCount < 1 || !hwpxSearchState.results.some((result) => result.path.includes("local-ref.hwpx"))) {
    throw new Error(`HWPX search state was wrong: ${JSON.stringify(hwpxSearchState)}`);
  }

  const recursiveSearchState = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.search("\\uBB38")`);
  const expectedAutoWorkers = Math.max(1, Math.min(recursiveSearchState.autoWorkerLimit, recursiveSearchState.documentCount || 1));
  if (recursiveSearchState.workerCount !== expectedAutoWorkers || recursiveSearchState.searchResultCount < 1 || recursiveSearchState.totalMatches < 2 || recursiveSearchState.scanErrors !== 0) {
    throw new Error(`HWP search state was wrong: ${JSON.stringify(recursiveSearchState)}`);
  }

  const recursiveSearch = await client.evaluate(`(() => {
    const title = document.querySelector(".result-title");
    const pageList = document.querySelector(".page-match-list");
    return {
      resultCards: document.querySelectorAll(".result-card").length,
      marked: document.querySelectorAll("mark").length,
      summary: document.querySelector("#summary")?.textContent,
      status: document.querySelector("#status")?.textContent,
      docs: document.querySelector("#metric-docs")?.textContent,
      scanned: document.querySelector("#metric-scanned")?.textContent,
      matches: document.querySelector("#metric-matches")?.textContent,
      workers: document.querySelector("#metric-workers")?.textContent,
      pageRows: document.querySelectorAll(".page-match-row").length,
      occurrenceRows: document.querySelectorAll(".occurrence-row").length,
      groupLevel: document.querySelector("#group-level")?.value,
      titleExpanded: title?.getAttribute("aria-expanded"),
      pageListHidden: pageList?.hidden,
      pageListDisplay: pageList ? getComputedStyle(pageList).display : "",
      previewOpen: !document.querySelector("#preview-overlay")?.hidden,
      fileState: document.querySelector("#file-state")?.textContent,
      hasSvg: Boolean(document.querySelector("#page svg")),
      resultNames: [...document.querySelectorAll(".result-name")].map((node) => node.textContent),
      resultTitles: [...document.querySelectorAll(".result-name")].map((node) => node.getAttribute("title") || ""),
    };
  })()`);

  if (recursiveSearch.status !== "Ready" || recursiveSearch.docs !== "2" || recursiveSearch.scanned !== "2" || Number(recursiveSearch.workers) !== expectedAutoWorkers) {
    throw new Error(`Search metrics/status were wrong: ${JSON.stringify(recursiveSearch)}`);
  }
  if (recursiveSearch.resultCards < 1 || recursiveSearch.pageRows < 1 || recursiveSearch.occurrenceRows !== 0 || recursiveSearch.groupLevel !== "file" || recursiveSearch.titleExpanded !== "false" || recursiveSearch.pageListHidden !== true || recursiveSearch.pageListDisplay !== "none" || recursiveSearch.previewOpen || recursiveSearch.hasSvg || !recursiveSearch.resultNames.includes("local-line.hwp") || recursiveSearch.resultNames.some((name) => name.includes("/")) || !recursiveSearch.resultTitles.some((title) => title.includes("contracts/2026/local-line.hwp"))) {
    throw new Error(`Recursive search did not render imported nested files at collapsed file level: ${JSON.stringify(recursiveSearch)}`);
  }

  const fileLevel = await client.evaluate(`(() => {
    const select = document.querySelector("#group-level");
    select.value = "file";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const title = document.querySelector(".result-title");
    const pageList = document.querySelector(".page-match-list");
    return {
      value: select.value,
      sliderValue: document.querySelector("#group-level-slider")?.dataset.value,
      sliderChecked: document.querySelector("[data-group-level='file']")?.getAttribute("aria-checked"),
      expanded: title?.getAttribute("aria-expanded"),
      pageListHidden: pageList?.hidden,
      pageListDisplay: pageList ? getComputedStyle(pageList).display : "",
      occurrenceRows: document.querySelectorAll(".occurrence-row").length,
    };
  })()`);

  if (fileLevel.value !== "file" || fileLevel.sliderValue !== "file" || fileLevel.sliderChecked !== "true" || fileLevel.expanded !== "false" || fileLevel.pageListHidden !== true || fileLevel.pageListDisplay !== "none" || fileLevel.occurrenceRows !== 0) {
    throw new Error(`File-level grouping did not collapse result groups: ${JSON.stringify(fileLevel)}`);
  }

  const detailLevel = await client.evaluate(`(() => {
    document.querySelector("[data-group-level='detail']")?.click();
    const select = document.querySelector("#group-level");
    const title = document.querySelector(".result-title");
    const row = document.querySelector(".page-match-row");
    const detail = document.querySelector(".page-match-detail");
    return {
      value: select.value,
      sliderValue: document.querySelector("#group-level-slider")?.dataset.value,
      sliderChecked: document.querySelector("[data-group-level='detail']")?.getAttribute("aria-checked"),
      titleExpanded: title?.getAttribute("aria-expanded"),
      pageExpanded: row?.getAttribute("aria-expanded"),
      detailHidden: detail?.hidden,
      detailDisplay: detail ? getComputedStyle(detail).display : "",
      occurrenceRows: document.querySelectorAll(".occurrence-row").length,
      matches: document.querySelector("#metric-matches")?.textContent,
    };
  })()`);

  if (detailLevel.value !== "detail" || detailLevel.sliderValue !== "detail" || detailLevel.sliderChecked !== "true" || detailLevel.titleExpanded !== "true" || detailLevel.pageExpanded !== "true" || detailLevel.detailHidden !== false || detailLevel.detailDisplay === "none" || detailLevel.occurrenceRows !== Number(detailLevel.matches)) {
    throw new Error(`Detail-level grouping did not open snippets: ${JSON.stringify(detailLevel)}`);
  }

  await client.evaluate(`(() => {
    document.querySelector("[data-group-level='page']")?.click();
  })()`);

  const collapsedGroup = await client.evaluate(`(() => {
    const group = document.querySelector(".result-title");
    const pageList = document.querySelector(".page-match-list");
    group?.click();
    const collapsed = {
      expanded: group?.getAttribute("aria-expanded"),
      pageListHidden: pageList?.hidden,
      pageListDisplay: pageList ? getComputedStyle(pageList).display : "",
    };
    group?.click();
    collapsed.expandedAfterReopen = group?.getAttribute("aria-expanded");
    collapsed.pageListHiddenAfterReopen = pageList?.hidden;
    collapsed.pageListDisplayAfterReopen = pageList ? getComputedStyle(pageList).display : "";
    return collapsed;
  })()`);

  if (collapsedGroup.expanded !== "false" || collapsedGroup.pageListHidden !== true || collapsedGroup.pageListDisplay !== "none" || collapsedGroup.expandedAfterReopen !== "true" || collapsedGroup.pageListHiddenAfterReopen !== false || collapsedGroup.pageListDisplayAfterReopen === "none") {
    throw new Error(`Result group did not collapse and reopen correctly: ${JSON.stringify(collapsedGroup)}`);
  }

  const expandedSearch = await client.evaluate(`(() => {
    document.querySelector(".page-match-row")?.click();
    return {
      marked: document.querySelectorAll("mark").length,
      occurrenceRows: document.querySelectorAll(".occurrence-row").length,
      matches: document.querySelector("#metric-matches")?.textContent,
      expanded: document.querySelector(".page-match-row")?.getAttribute("aria-expanded"),
      previewOpen: !document.querySelector("#preview-overlay")?.hidden,
      hasSvg: Boolean(document.querySelector("#page svg")),
    };
  })()`);

  if (expandedSearch.expanded !== "true" || expandedSearch.occurrenceRows !== Number(expandedSearch.matches) || expandedSearch.marked < 1 || expandedSearch.previewOpen || expandedSearch.hasSvg) {
    throw new Error(`Page match details did not expand correctly: ${JSON.stringify(expandedSearch)}`);
  }

  const collapsedPage = await client.evaluate(`(() => {
    const row = document.querySelector(".page-match-row");
    const detail = document.querySelector(".page-match-detail");
    row?.click();
    return {
      expanded: row?.getAttribute("aria-expanded"),
      detailHidden: detail?.hidden,
      detailDisplay: detail ? getComputedStyle(detail).display : "",
      occurrenceRows: document.querySelectorAll(".occurrence-row").length,
      marked: document.querySelectorAll("mark").length,
    };
  })()`);

  if (collapsedPage.expanded !== "false" || collapsedPage.detailHidden !== true || collapsedPage.detailDisplay !== "none" || collapsedPage.occurrenceRows !== Number(expandedSearch.matches) || collapsedPage.marked < 1) {
    throw new Error(`Expanded page details did not visually collapse: ${JSON.stringify(collapsedPage)}`);
  }

  const reopenedPage = await client.evaluate(`(() => {
    const row = document.querySelector(".page-match-row");
    const detail = document.querySelector(".page-match-detail");
    row?.click();
    return {
      expanded: row?.getAttribute("aria-expanded"),
      detailHidden: detail?.hidden,
      detailDisplay: detail ? getComputedStyle(detail).display : "",
    };
  })()`);

  if (reopenedPage.expanded !== "true" || reopenedPage.detailHidden !== false || reopenedPage.detailDisplay === "none") {
    throw new Error(`Collapsed page details did not reopen: ${JSON.stringify(reopenedPage)}`);
  }

  const openedPreview = await client.evaluate(`(async () => {
    await window.__HWP_SINGLE_HTML_TEST__.setTheme("dark");
    const expectedHighlights = Number(/\\d+/.exec(document.querySelector(".page-match-count")?.textContent || "")?.[0] || 0);
    document.querySelector(".occurrence-row")?.click();
    const started = Date.now();
    while (Date.now() - started < 5000) {
      const svg = document.querySelector("#page svg");
      if (!document.querySelector("#preview-overlay")?.hidden && svg) {
        const highlight = document.querySelector(".hwp-document-highlight");
        const highlightStyle = highlight ? getComputedStyle(highlight) : null;
        return {
          previewOpen: true,
          hasSvg: true,
          highlights: document.querySelectorAll(".hwp-document-highlight").length,
          highlightLayerOnTop: svg.lastElementChild?.classList.contains("hwp-document-highlights"),
          documentFilter: getComputedStyle(svg).filter,
          highlightAnimation: highlightStyle?.animationName,
          highlightAnimationDuration: highlightStyle?.animationDuration,
          expectedHighlights,
          title: document.querySelector("#viewer-title")?.textContent,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      previewOpen: !document.querySelector("#preview-overlay")?.hidden,
      hasSvg: Boolean(document.querySelector("#page svg")),
      highlights: document.querySelectorAll(".hwp-document-highlight").length,
      highlightLayerOnTop: document.querySelector("#page svg")?.lastElementChild?.classList.contains("hwp-document-highlights"),
      documentFilter: document.querySelector("#page svg") ? getComputedStyle(document.querySelector("#page svg")).filter : "",
      highlightAnimation: document.querySelector(".hwp-document-highlight") ? getComputedStyle(document.querySelector(".hwp-document-highlight")).animationName : "",
      highlightAnimationDuration: document.querySelector(".hwp-document-highlight") ? getComputedStyle(document.querySelector(".hwp-document-highlight")).animationDuration : "",
      expectedHighlights,
      title: document.querySelector("#viewer-title")?.textContent,
    };
  })()`);

  if (!openedPreview.previewOpen || !openedPreview.hasSvg || openedPreview.highlights < Math.max(1, openedPreview.expectedHighlights) || openedPreview.highlightLayerOnTop !== true || openedPreview.documentFilter === "none" || openedPreview.highlightAnimation === "none" || openedPreview.highlightAnimationDuration === "0s" || !openedPreview.title?.includes("page")) {
    throw new Error(`Detail click did not open preview popup: ${JSON.stringify(openedPreview)}`);
  }

  const closedByButton = await client.evaluate(`(() => {
    document.querySelector("#preview-close")?.click();
    return {
      previewOpen: !document.querySelector("#preview-overlay")?.hidden,
      hasSvg: Boolean(document.querySelector("#page svg")),
    };
  })()`);

  if (closedByButton.previewOpen || closedByButton.hasSvg) {
    throw new Error(`Preview popup did not close from button: ${JSON.stringify(closedByButton)}`);
  }

  const closedByOutside = await client.evaluate(`(async () => {
    document.querySelector(".occurrence-row")?.click();
    const started = Date.now();
    while (Date.now() - started < 5000 && (document.querySelector("#preview-overlay")?.hidden || !document.querySelector("#page svg"))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    document.querySelector("#preview-overlay")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return {
      previewOpen: !document.querySelector("#preview-overlay")?.hidden,
      hasSvg: Boolean(document.querySelector("#page svg")),
    };
  })()`);

  if (closedByOutside.previewOpen || closedByOutside.hasSvg) {
    throw new Error(`Preview popup did not close from outside click: ${JSON.stringify(closedByOutside)}`);
  }

  const denseFiles = [
    {
      name: "dense-eng.hwp",
      relativePath: "dense/dense-eng.hwp",
      base64: await readFile(path.resolve("samples/rhwp-upstream/samples/exam_eng.hwp"), "base64"),
    },
  ];
  const denseImport = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.dropFiles(${JSON.stringify(denseFiles)})`);
  if (denseImport.localCount !== 1 || denseImport.documentCount !== 1 || denseImport.searchResultCount !== 0) {
    throw new Error(`Dense fixture import failed: ${JSON.stringify(denseImport)}`);
  }

  const denseSearchState = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.search("the")`);
  if (denseSearchState.searchResultCount !== 1 || denseSearchState.totalMatches < 100) {
    throw new Error(`Dense page search did not find enough matches: ${JSON.stringify(denseSearchState)}`);
  }

  const densePreview = await client.evaluate(`(async () => {
    const rows = [...document.querySelectorAll(".page-match-row")];
    const target = rows
      .map((row) => ({
        row,
        count: Number(/\\d+/.exec(row.querySelector(".page-match-count")?.textContent || "")?.[0] || 0),
      }))
      .find((item) => item.count >= 30);
    if (!target) {
      return { foundDensePage: false, expectedHighlights: 0, highlights: 0, previewOpen: false, hasSvg: false };
    }
    if (target.row.getAttribute("aria-expanded") !== "true") {
      target.row.click();
    }
    target.row.nextElementSibling?.querySelector(".occurrence-row")?.click();
    const started = Date.now();
    while (Date.now() - started < 8000) {
      const svg = document.querySelector("#page svg");
      if (!document.querySelector("#preview-overlay")?.hidden && svg) {
        return {
          foundDensePage: true,
          expectedHighlights: target.count,
          highlights: document.querySelectorAll(".hwp-document-highlight").length,
          highlightLayerOnTop: svg.lastElementChild?.classList.contains("hwp-document-highlights"),
          previewOpen: true,
          hasSvg: true,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      foundDensePage: true,
      expectedHighlights: target.count,
      highlights: document.querySelectorAll(".hwp-document-highlight").length,
      highlightLayerOnTop: document.querySelector("#page svg")?.lastElementChild?.classList.contains("hwp-document-highlights"),
      previewOpen: !document.querySelector("#preview-overlay")?.hidden,
      hasSvg: Boolean(document.querySelector("#page svg")),
    };
  })()`);

  if (!densePreview.foundDensePage || !densePreview.previewOpen || !densePreview.hasSvg || densePreview.highlights < densePreview.expectedHighlights || densePreview.highlightLayerOnTop !== true) {
    throw new Error(`Dense page preview did not highlight every visible match: ${JSON.stringify(densePreview)}`);
  }

  const kpsFiles = [
    {
      name: "kps-ai.hwp",
      relativePath: "samples/rhwp-upstream/rhwp-studio/public/samples/kps-ai.hwp",
      base64: await readFile(path.resolve("samples/rhwp-upstream/rhwp-studio/public/samples/kps-ai.hwp"), "base64"),
    },
  ];
  const kpsImport = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.dropFiles(${JSON.stringify(kpsFiles)})`);
  if (kpsImport.localCount !== 1 || kpsImport.documentCount !== 1 || kpsImport.searchResultCount !== 0) {
    throw new Error(`KPS fixture import failed: ${JSON.stringify(kpsImport)}`);
  }

  const kpsSearchState = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.search("aa")`);
  if (kpsSearchState.searchResultCount !== 1 || kpsSearchState.totalMatches !== 16) {
    throw new Error(`KPS aa search did not find the expected matches: ${JSON.stringify(kpsSearchState)}`);
  }

  const kpsPreview = await client.evaluate(`(async () => {
    const rows = [...document.querySelectorAll(".page-match-row")];
    const target = rows
      .map((row) => ({
        row,
        label: row.querySelector(".page-match-page")?.textContent || "",
        count: Number(/\\d+/.exec(row.querySelector(".page-match-count")?.textContent || "")?.[0] || 0),
      }))
      .find((item) => item.label.trim() === "page 47");
    if (!target) {
      return { foundPage47: false, expectedHighlights: 0, highlights: 0, previewOpen: false, hasSvg: false };
    }
    if (target.row.getAttribute("aria-expanded") !== "true") {
      target.row.click();
    }
    target.row.nextElementSibling?.querySelector(".occurrence-row")?.click();
    const started = Date.now();
    while (Date.now() - started < 8000) {
      const svg = document.querySelector("#page svg");
      if (!document.querySelector("#preview-overlay")?.hidden && svg) {
        return {
          foundPage47: true,
          expectedHighlights: target.count,
          highlights: document.querySelectorAll(".hwp-document-highlight").length,
          highlightLayerOnTop: svg.lastElementChild?.classList.contains("hwp-document-highlights"),
          previewOpen: true,
          hasSvg: true,
          title: document.querySelector("#viewer-title")?.textContent,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      foundPage47: true,
      expectedHighlights: target.count,
      highlights: document.querySelectorAll(".hwp-document-highlight").length,
      highlightLayerOnTop: document.querySelector("#page svg")?.lastElementChild?.classList.contains("hwp-document-highlights"),
      previewOpen: !document.querySelector("#preview-overlay")?.hidden,
      hasSvg: Boolean(document.querySelector("#page svg")),
      title: document.querySelector("#viewer-title")?.textContent,
    };
  })()`);

  if (!kpsPreview.foundPage47 || !kpsPreview.previewOpen || !kpsPreview.hasSvg || kpsPreview.expectedHighlights !== 8 || kpsPreview.highlights !== 8 || kpsPreview.highlightLayerOnTop !== true || !kpsPreview.title?.includes("page 47 of ")) {
    throw new Error(`KPS page 47 preview did not show visible highlight layer: ${JSON.stringify(kpsPreview)}`);
  }

  const controlCharFiles = [
    {
      name: "table-vpos-01.hwpx",
      relativePath: "samples/rhwp-upstream/samples/table-vpos-01.hwpx",
      base64: await readFile(path.resolve("samples/rhwp-upstream/samples/table-vpos-01.hwpx"), "base64"),
    },
  ];
  const controlCharImport = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.dropFiles(${JSON.stringify(controlCharFiles)})`);
  if (controlCharImport.localCount !== 1 || controlCharImport.documentCount !== 1 || controlCharImport.scanErrors !== 0) {
    throw new Error(`Control-character fixture import failed: ${JSON.stringify(controlCharImport)}`);
  }
  const controlCharSearch = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.search("anything")`);
  if (controlCharSearch.scanErrors !== 0 || controlCharSearch.scanned !== 1) {
    throw new Error(`Control-character fixture produced a JSON parse error: ${JSON.stringify(controlCharSearch)}`);
  }

  const hwp3Files = [
    {
      name: "legacy-hwp3.hwp",
      relativePath: "legacy/legacy-hwp3.hwp",
      base64: Buffer.from("HWP Document File V3.00 \\x1a\\x01\\x02\\x03\\x04\\x05\\x00\\x00").toString("base64"),
    },
  ];
  const hwp3Import = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.dropFiles(${JSON.stringify(hwp3Files)})`);
  if (hwp3Import.localCount !== 1 || hwp3Import.documentCount !== 1 || hwp3Import.scanErrors !== 0 || hwp3Import.samples[0]?.format !== "HWP 3.0") {
    throw new Error(`HWP 3.0-style fixture was blocked before rhwp search: ${JSON.stringify(hwp3Import)}`);
  }

  const invalidFiles = [
    {
      name: "broken.hwp",
      relativePath: "broken/input/broken.hwp",
      base64: Buffer.from("not an hwp document").toString("base64"),
    },
  ];
  const invalidImport = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.dropFiles(${JSON.stringify(invalidFiles)})`);
  if (invalidImport.localCount !== 0 || invalidImport.documentCount !== 0 || invalidImport.scanErrors !== 1 || invalidImport.errorDetailsOpen !== false) {
    throw new Error(`Invalid fixture was not rejected during import: ${JSON.stringify(invalidImport)}`);
  }
  const invalidSearch = await client.evaluate(`window.__HWP_SINGLE_HTML_TEST__.search("anything")`);
  if (invalidSearch.scanErrors !== 1 || invalidSearch.scanned !== 0 || invalidSearch.totalMatches !== 0 || invalidSearch.errorDetailsOpen !== false) {
    throw new Error(`Invalid fixture did not produce a closed error state: ${JSON.stringify(invalidSearch)}`);
  }
  const errorDetails = await client.evaluate(`(() => {
    const toggle = document.querySelector("#error-details-toggle");
    const panel = document.querySelector("#error-details");
    const before = {
      disabled: toggle?.disabled,
      expanded: toggle?.getAttribute("aria-expanded"),
      hidden: panel?.hidden,
      count: document.querySelector("#metric-errors")?.textContent,
    };
    toggle?.click();
    const open = {
      disabled: toggle?.disabled,
      expanded: toggle?.getAttribute("aria-expanded"),
      hidden: panel?.hidden,
      items: document.querySelectorAll(".error-detail-item").length,
      text: panel?.textContent || "",
      state: window.__HWP_SINGLE_HTML_TEST__.state(),
    };
    toggle?.click();
    const closed = {
      expanded: toggle?.getAttribute("aria-expanded"),
      hidden: panel?.hidden,
      state: window.__HWP_SINGLE_HTML_TEST__.state(),
    };
    return { before, open, closed };
  })()`);
  if (errorDetails.before.disabled !== false || errorDetails.before.expanded !== "false" || errorDetails.before.hidden !== true || errorDetails.before.count !== "1") {
    throw new Error(`Error details metric was not clickable: ${JSON.stringify(errorDetails)}`);
  }
  if (errorDetails.open.disabled !== false || errorDetails.open.expanded !== "true" || errorDetails.open.hidden !== false || errorDetails.open.items !== 1 || !errorDetails.open.text.includes("broken/input/broken.hwp") || !errorDetails.open.text.includes("Message") || errorDetails.open.state.errorDetailsOpen !== true) {
    throw new Error(`Error details did not open with path/message: ${JSON.stringify(errorDetails)}`);
  }
  if (errorDetails.closed.expanded !== "false" || errorDetails.closed.hidden !== true || errorDetails.closed.state.errorDetailsOpen !== false) {
    throw new Error(`Error details did not collapse: ${JSON.stringify(errorDetails)}`);
  }

  console.log(`Headless Chrome verified ${path.relative(process.cwd(), htmlPath)}: ${recursiveSearch.summary}`);
  await client.close();
} finally {
  await terminateChrome(chrome);
  await rm(userDataDir, { recursive: true, force: true });
}

async function terminateChrome(chrome) {
  if (hasExited(chrome)) {
    return;
  }

  chrome.kill("SIGTERM");
  const exitedGracefully = await waitForProcessExit(chrome, 3000);
  if (exitedGracefully || hasExited(chrome)) {
    return;
  }

  chrome.kill("SIGKILL");
  await waitForProcessExit(chrome, 3000);
}

function hasExited(childProcess) {
  return childProcess.exitCode !== null || childProcess.signalCode !== null;
}

function waitForProcessExit(childProcess, timeoutMs) {
  if (hasExited(childProcess)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      childProcess.off("exit", onExit);
    };

    childProcess.once("exit", onExit);
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (isPathLike(candidate)) {
      if (existsSync(candidate)) {
        return candidate;
      }
      continue;
    }

    const resolved = resolveCommand(candidate);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error(`Could not find Chrome or Chromium. Checked: ${candidates.join(", ")}`);
}

function isPathLike(value) {
  return path.isAbsolute(value) || value.includes("/") || value.includes("\\");
}

function resolveCommand(command) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status === 0) {
    const candidate = result.stdout.split(/\r?\n/).find(Boolean);
    if (candidate) {
      return candidate;
    }
  }

  return "";
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => {
        if (port) {
          resolve(port);
        } else {
          reject(new Error("Could not allocate a local port"));
        }
      });
    });
  });
}

async function waitForPage(port) {
  const deadline = Date.now() + 15000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) {
        return page;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }

  throw new Error(`Timed out waiting for Chrome DevTools. ${lastError ? String(lastError) : ""}\n${stderr}`);
}

async function waitForReady(client) {
  const deadline = Date.now() + 20000;

  while (Date.now() < deadline) {
    const value = await client.evaluate("window.__HWP_SINGLE_HTML_READY__ || null");
    if (value) {
      return value;
    }
    await delay(250);
  }

  throw new Error(`Timed out waiting for the single HTML app to initialize${client.diagnostics()}`);
}

function connectCdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const callbacks = new Map();
  const events = [];

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && callbacks.has(message.id)) {
      const { resolve, reject } = callbacks.get(message.id);
      callbacks.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
      return;
    }

    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      const location = [
        details?.url,
        Number.isInteger(details?.lineNumber) ? details.lineNumber + 1 : undefined,
        Number.isInteger(details?.columnNumber) ? details.columnNumber + 1 : undefined,
      ].filter(Boolean).join(":");
      events.push(`${details?.exception?.description || details?.text || "Runtime exception"}${location ? ` @ ${location}` : ""}`);
    } else if (message.method === "Log.entryAdded") {
      const entry = message.params?.entry;
      events.push([entry?.level, entry?.text].filter(Boolean).join(": "));
    } else if (message.method === "Runtime.consoleAPICalled") {
      const args = message.params?.args || [];
      events.push(args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
    }
  });

  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      resolve({
        send(method, params = {}) {
          const messageId = ++id;
          ws.send(JSON.stringify({ id: messageId, method, params }));
          return new Promise((innerResolve, innerReject) => {
            callbacks.set(messageId, { resolve: innerResolve, reject: innerReject });
          });
        },
        async evaluate(expression) {
          const result = await this.send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.text ?? "Runtime evaluation failed");
          }
          return result.result.value;
        },
        close() {
          ws.close();
        },
        diagnostics() {
          if (events.length === 0) {
            return "";
          }
          return `\nBrowser diagnostics:\n${events.slice(-8).join("\n")}`;
        },
      });
    });
    ws.addEventListener("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
