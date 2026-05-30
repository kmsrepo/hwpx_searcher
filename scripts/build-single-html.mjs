import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const browserDir = path.join(rootDir, "src/browser");
const options = parseArgs(process.argv.slice(2));
const outputPath = path.resolve(rootDir, options.outputPath);
const outputDir = path.dirname(outputPath);
const wasmFileName = "rhwp_bg.wasm";
const wasmFallbackFileName = "rhwp_bg.wasm.base64.js";
const wasmOutputPath = path.join(outputDir, wasmFileName);
const wasmFallbackOutputPath = path.join(outputDir, wasmFallbackFileName);

const [rhwpJs, rhwpWasm, tanstackVirtualCore, themeBootstrapJs, css, bodyHtml] = await Promise.all([
  readFile(require.resolve("@rhwp/core/rhwp.js"), "utf8"),
  readFile(require.resolve("@rhwp/core/rhwp_bg.wasm")),
  readTanStackVirtualCore(),
  readFile(path.join(browserDir, "theme-bootstrap.js"), "utf8"),
  readFile(path.join(browserDir, "hwp-search.css"), "utf8"),
  readFile(path.join(browserDir, "app-body.html"), "utf8"),
]);
const appJs = await readBrowserBundle(["i18n.js", "search-core.js", "virtual-core-loader.js", "wasm-loader.js", "worker-client.js", "file-store.js", "file-index.js", "results-view.js", "preview-view.js", "app.js"]);
const workerJs = await readBrowserBundle(["search-core.js", "search-worker.js"]);
const payload = options.embedWasm
  ? {
    rhwpJs,
    rhwpWasmBase64: rhwpWasm.toString("base64"),
    tanstackVirtualCore,
    workerJs,
  }
  : {
    rhwpJs,
    rhwpWasmUrl: wasmFileName,
    rhwpWasmFallbackUrl: wasmFallbackFileName,
    tanstackVirtualCore,
    workerJs,
  };

const html = renderHtml({
  payload,
  themeBootstrapJs,
  css,
  bodyHtml,
  appJs,
});

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, html);
console.log(`Wrote ${outputPath} (${Buffer.byteLength(html)} bytes)`);
if (!options.embedWasm) {
  const wasmFallbackJs = renderWasmFallbackScript(rhwpWasm);
  await writeFile(wasmOutputPath, rhwpWasm);
  await writeFile(wasmFallbackOutputPath, wasmFallbackJs);
  console.log(`Wrote ${wasmOutputPath} (${rhwpWasm.byteLength} bytes)`);
  console.log(`Wrote ${wasmFallbackOutputPath} (${Buffer.byteLength(wasmFallbackJs)} bytes)`);
}

function parseArgs(args) {
  const parsed = {
    embedWasm: false,
    outputPath: "hwp-search.html",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--embed-wasm") {
      parsed.embedWasm = true;
    } else if (arg === "--output") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--output requires a path");
      }
      parsed.outputPath = value;
      index += 1;
    } else {
      throw new Error("Unknown option: " + arg);
    }
  }

  return parsed;
}

function renderHtml({ payload, themeBootstrapJs, css, bodyHtml, appJs }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HWP Search</title>
  <script>
${indent(themeBootstrapJs.trim(), 4)}
  </script>
  <style>
${indent(css.trim(), 4)}
  </style>
</head>
<body>
${indent(bodyHtml.trim(), 2)}
  <script id="payload" type="application/json">${escapeJsonForScript(JSON.stringify(payload))}</script>
  <script type="module">
${indent(appJs.trim(), 4)}
  </script>
</body>
</html>
`;
}

async function readTanStackVirtualCore() {
  const packageDir = path.dirname(require.resolve("@tanstack/virtual-core/package.json"));
  const esmDir = path.join(packageDir, "dist", "esm");
  const [utilsJs, lazyMeasurementsJs, indexJs] = await Promise.all([
    readFile(path.join(esmDir, "utils.js"), "utf8"),
    readFile(path.join(esmDir, "lazy-measurements.js"), "utf8"),
    readFile(path.join(esmDir, "index.js"), "utf8"),
  ]);
  return {
    utilsJs: browserSafeModuleSource(utilsJs),
    lazyMeasurementsJs: browserSafeModuleSource(lazyMeasurementsJs),
    indexJs: browserSafeModuleSource(indexJs),
  };
}

function browserSafeModuleSource(source) {
  return source.replace(/process\.env\.NODE_ENV/g, JSON.stringify("production"));
}

async function readBrowserBundle(files) {
  const sources = await Promise.all(files.map((file) => readFile(path.join(browserDir, file), "utf8")));
  return sources.map((source, index) => `// ${files[index]}\n${source.trim()}`).join("\n\n");
}

function indent(value, spaces) {
  const padding = " ".repeat(spaces);
  return value.split("\n").map((line) => line ? padding + line : line).join("\n");
}

function escapeJsonForScript(value) {
  return value
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function renderWasmFallbackScript(wasm) {
  return `globalThis.__HWP_SEARCH_RHWP_WASM_BASE64__ = "${wasm.toString("base64")}";\n`;
}
