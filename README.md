# HWP Recursive Search

Single-file browser app and small CLI for recursively searching `.hwp` and `.hwpx` files with [`@rhwp/core`](https://github.com/edwardkim/rhwp).

It is built with npm, but running a search does not require an npm dev server or long-running npm process.

## Setup

```bash
npm install
npm run build
```

## Usage

```bash
node dist/cli.js "검색어" /path/to/folder
```

After `npm link`, the same command is available as:

```bash
hwp-search "검색어" /path/to/folder
```

Useful options:

```bash
hwp-search "검색어" ./docs --json --include-errors
hwp-search "ExactCase" ./docs --case-sensitive
hwp-search "keyword" ./docs --max-snippets 20
```

The scanner skips common generated directories such as `.git`, `node_modules`, `dist`, and `coverage`.

## Single HTML App

Build the browser app with `@rhwp/core` and a sibling WASM asset:

```bash
npm run html:build
open hwp-search.html
```

The build writes `hwp-search.html`, `rhwp_bg.wasm`, and a `rhwp_bg.wasm.base64.js` fallback. Keep those files together. The WASM files are generated from the configured `@rhwp/core` dependency during build time rather than maintained manually. Browsers can load `rhwp_bg.wasm` directly when the app is hosted over HTTP; the fallback keeps the same production HTML working when opened directly from `file://`, where Chrome blocks local WASM fetches.

Release builds are fully standalone HTML files with the WASM runtime embedded:

```bash
npm run html:build:release
open release/hwp-search.html
```

The manual GitHub release workflow uploads that standalone HTML file directly, so release users do not need a zip or sibling WASM files.

The app starts with no documents loaded. Folder selection or drag-and-drop queues nested `.hwp` and `.hwpx` files into IndexedDB without parsing them first, so large file sets do not stay attached to live `File` objects in memory. Search runs through a bounded Web Worker pool, so multiple files can be scanned in parallel while only the active worker batch is opened in memory. The Auto worker setting uses about 50% of detected CPU threads, clamped to the number of matching documents.

The browser UI follows a desktop document-search workspace: search bar, filter/index rail, dense results pane, and popup document preview.
Matches are grouped under collapsible file results, then by page. Selecting a page expands the snippets for that page; selecting a snippet opens the document page in a popup preview with animated color-changing keyword highlights in the rendered document. The popup closes from the X button, Escape, or an outside click.
Queued files and search results use a file-explorer-style details view with sortable filename, type, modified date, size, and match-count columns. Result rows show file type, size, and modified date when the browser provides that metadata.
The Errors metric becomes clickable when a file fails to scan and expands the path plus parser/worker message for troubleshooting.
The Group level slider controls the initial result expansion level after each search: file groups, page groups, or detail rows.
The theme button cycles through System, Light, and Dark modes; System follows the browser `prefers-color-scheme` setting and explicit choices are saved locally. In dark mode, popup document pages are inverted for easier reading.
The language selector supports English and Korean UI text. The app starts in English by default, saves explicit choices locally, and also accepts `?lang=ko` or `?lang=en` when opened from `file://` or HTTP.

Test samples come from `edwardkim/rhwp` commit `b3e16ef212af81ef37d973ddb86d6816d3804642`:

- `samples/lseg-01-basic.hwp`
- `samples/hwpx/ref/ref_text.hwpx`
- `samples/hwp3-sample.hwp`

The broader upstream sample folders are vendored at `samples/rhwp-upstream/` for recursive search testing.

Headless browser smoke test:

```bash
npm run html:test
```

Browser app source is split for maintainability, then inlined into the production HTML by `scripts/build-single-html.mjs`:

- `src/browser/app-body.html` - application markup
- `src/browser/hwp-search.css` - UI and document-preview styles
- `src/browser/i18n.js` - English/Korean UI strings and runtime translation helpers
- `src/browser/search-core.js` - shared text extraction and match helpers used by the app and worker
- `src/browser/wasm-loader.js` - rhwp WASM asset loading and `file://` fallback handling
- `src/browser/worker-client.js` - main-thread Web Worker client/message protocol
- `src/browser/file-store.js` - IndexedDB-backed local file storage for large imports
- `src/browser/file-index.js` - local folder selection, drag/drop traversal, and file descriptors
- `src/browser/results-view.js` - grouped result rendering, collapse state, and match snippets
- `src/browser/preview-view.js` - document preview popup and page-level highlight overlays
- `src/browser/app.js` - main browser runtime
- `src/browser/search-worker.js` - Web Worker search runtime
- `src/browser/theme-bootstrap.js` - early theme bootstrap to avoid theme flash

## Notes

- HWP/HWPX parsing and page text extraction come from `@rhwp/core`.
- The CLI uses a lightweight Node text-width fallback so `rhwp` can paginate documents without a browser canvas.
- Search results are based on visible page text runs returned by `getPageTextLayout`, so snippets are page-oriented rather than source-line-oriented.
