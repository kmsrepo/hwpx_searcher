const MAX_STORED_OCCURRENCES_PER_PAGE = 100;
const MAX_STORED_OCCURRENCES_PER_FILE = 300;

function findTextMatches(text, query, caseSensitive) {
  return collectTextMatches(text, query, caseSensitive).matches;
}

function collectTextMatches(text, query, caseSensitive, maxStoredMatches = Number.POSITIVE_INFINITY) {
  if (query.length === 0) {
    return { count: 0, matches: [] };
  }

  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const haystack = caseSensitive ? text : text.toLocaleLowerCase();
  const matches = [];
  let count = 0;
  let index = 0;

  while (index <= haystack.length) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) {
      break;
    }
    count += 1;
    if (matches.length < maxStoredMatches) {
      matches.push({
        index: found,
        length: query.length,
        snippet: makeSnippet(text, found, query.length),
      });
    }
    index = found + Math.max(needle.length, 1);
  }

  return { count, matches };
}

function makeSnippet(text, index, length) {
  const radius = 64;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

function extractPageText(doc, page) {
  return extractTextFromLayout(parsePageTextLayout(doc.getPageTextLayout(page)));
}

function extractTextFromLayout(layout) {
  return (layout.runs || [])
    .map((run) => typeof run.text === "string" ? run.text : "")
    .join("")
    .replace(/\uFFFC/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function parsePageTextLayout(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (!isControlCharacterJsonError(error)) {
      throw error;
    }
    return JSON.parse(escapeRawControlCharactersInJsonStrings(raw));
  }
}

function isControlCharacterJsonError(error) {
  return error instanceof SyntaxError && /control character/i.test(error.message);
}

function escapeRawControlCharactersInJsonStrings(raw) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const code = char.charCodeAt(0);

    if (!inString) {
      output += char;
      if (char === '"') {
        inString = true;
      }
      continue;
    }

    if (escaped) {
      output += char;
      escaped = false;
    } else if (char === "\\") {
      output += char;
      escaped = true;
    } else if (char === '"') {
      output += char;
      inString = false;
    } else if (code <= 0x1f) {
      output += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      output += char;
    }
  }

  return output;
}

function normalizeRunTextWithMap(text) {
  let normalized = "";
  const map = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(char)) {
      continue;
    }
    normalized += char === "\uFFFC" ? " " : char;
    map.push(index);
  }
  return { text: normalized, map };
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
