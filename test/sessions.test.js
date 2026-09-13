// Pure-logic tests for session matching — no Chrome. The live Wikipedia
// wipe (window.name cleared to "") is the case these rules exist for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TAG_PREFIX, resolveBinding, urlsMatch } from "../src/sessions.js";

test("resolveBinding: targetId wins even when window.name was wiped", () => {
  const bindings = { demo: { targetId: "T1", url: "https://www.wikipedia.org/" } };
  const candidates = [
    { targetId: "OTHER", windowName: "", url: "about:blank" },
    { targetId: "T1", windowName: "", url: "https://www.wikipedia.org/" },
  ];
  const hit = resolveBinding(candidates, "demo", bindings);
  assert.equal(hit.targetId, "T1");
});

test("resolveBinding: falls back to window.name when targetId is stale", () => {
  const bindings = { demo: { targetId: "DEAD", url: "https://example.com/" } };
  const candidates = [
    { targetId: "NEW", windowName: `${TAG_PREFIX}demo`, url: "https://example.com/" },
  ];
  const hit = resolveBinding(candidates, "demo", bindings);
  assert.equal(hit.targetId, "NEW");
});

test("resolveBinding: unique URL matches after Chrome restart (new targetIds)", () => {
  const bindings = { demo: { targetId: "OLD", url: "https://httpbin.org/forms/post" } };
  const candidates = [
    { targetId: "A", windowName: "", url: "about:blank" },
    { targetId: "B", windowName: "", url: "https://httpbin.org/forms/post" },
  ];
  const hit = resolveBinding(candidates, "demo", bindings);
  assert.equal(hit.targetId, "B");
});

test("resolveBinding: refuses to guess when two tabs share the same URL", () => {
  const bindings = { demo: { targetId: "GONE", url: "https://example.com/" } };
  const candidates = [
    { targetId: "A", windowName: "", url: "https://example.com/" },
    { targetId: "B", windowName: "", url: "https://example.com/" },
  ];
  assert.equal(resolveBinding(candidates, "demo", bindings), null);
});

test("resolveBinding: unknown session → null, not the first tab", () => {
  const candidates = [{ targetId: "A", windowName: "", url: "https://example.com/" }];
  assert.equal(resolveBinding(candidates, "missing", {}), null);
});

test("urlsMatch: ignores query/hash, requires same origin+path", () => {
  assert.equal(urlsMatch("https://example.com/a?x=1", "https://example.com/a?x=2"), true);
  assert.equal(urlsMatch("https://example.com/a", "https://example.com/b"), false);
  assert.equal(urlsMatch("https://a.example.com/", "https://b.example.com/"), false);
});
