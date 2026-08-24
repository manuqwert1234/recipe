// Phase 4 — record. Captures XHR/Fetch traffic via CDP Network.* events,
// filtered to the ~5% of requests that are actually application data
// (P0c in the design doc flags this filtering as the real hard part of
// record, not the replay mechanism).

export async function captureNetwork(page, { durationMs = 15_000 } = {}) {
  const client = await page.context().newCDPSession(page);
  await client.send("Network.enable");

  const pending = new Map(); // requestId -> partial entry
  const entries = [];

  client.on("Network.requestWillBeSent", (e) => {
    if (!["XHR", "Fetch"].includes(e.type)) return;
    pending.set(e.requestId, {
      requestId: e.requestId,
      url: e.request.url,
      method: e.request.method,
      requestHeaders: e.request.headers,
      postData: e.request.postData,
      timestamp: e.timestamp,
      type: e.type,
    });
  });

  client.on("Network.responseReceived", (e) => {
    const entry = pending.get(e.requestId);
    if (!entry) return;
    entry.status = e.response.status;
    entry.responseHeaders = e.response.headers;
    entry.mimeType = e.response.mimeType;
  });

  client.on("Network.loadingFinished", async (e) => {
    const entry = pending.get(e.requestId);
    if (!entry) return;
    try {
      const body = await client.send("Network.getResponseBody", {
        requestId: e.requestId,
      });
      entry.responseBody = body.base64Encoded
        ? Buffer.from(body.body, "base64").toString("utf8")
        : body.body;
    } catch {
      entry.responseBody = null; // body already evicted or not text — fine, keep the shape
    }
    entries.push(entry);
    pending.delete(e.requestId);
  });

  await new Promise((r) => setTimeout(r, durationMs));
  await client.send("Network.disable");

  return entries;
}
