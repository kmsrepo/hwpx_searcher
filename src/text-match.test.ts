import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { searchHwpFile } from "./search.js";
import { findTextMatches } from "./text-match.js";

test("finds case-insensitive matches with snippets", () => {
  const matches = findTextMatches("Alpha beta ALPHA", "alpha", false, 6);
  assert.equal(matches.length, 2);
  assert.equal(matches[0]?.index, 0);
  assert.equal(matches[0]?.length, 5);
  assert.equal(matches[1]?.index, 11);
  assert.match(matches[1]?.snippet ?? "", /ALPHA/);
});

test("honors case-sensitive mode", () => {
  const matches = findTextMatches("Alpha alpha", "Alpha", true);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.index, 0);
});

test("returns no matches for empty query", () => {
  assert.deepEqual(findTextMatches("text", "", false), []);
});

test("searches layout JSON containing raw control characters", async () => {
  const result = await searchHwpFile(
    resolve("samples/rhwp-upstream/samples/table-vpos-01.hwpx"),
    "anything",
    {
      caseSensitive: false,
      maxSnippetsPerFile: 5,
      snippetRadius: 32,
    },
  );

  assert.ok(result.pages > 0);
  assert.equal(result.matches, 0);
});

test("searches HWP 3.0 documents", async () => {
  const result = await searchHwpFile(
    resolve("samples/rhwp/hwp3-sample.hwp"),
    "Virtual Servers",
    {
      caseSensitive: false,
      maxSnippetsPerFile: 3,
      snippetRadius: 32,
    },
  );

  assert.ok(result.pages > 0);
  assert.ok(result.matches > 0);
  assert.match(result.occurrences[0]?.snippet ?? "", /Virtual Servers/i);
});
