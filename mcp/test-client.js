#!/usr/bin/env node
// Real integration test — spawns mcp/server.js as a subprocess and drives it
// over actual stdio JSON-RPC, the same way Claude Code would. Not a mock.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["mcp/server.js"],
  cwd: process.cwd(),
});
const client = new Client({ name: "test-client", version: "0.1.0" });
await client.connect(transport);

console.log("=== tools/list ===");
const tools = await client.listTools();
for (const t of tools.tools) console.log(`  ${t.name} — ${t.description.slice(0, 70)}...`);

console.log("\n=== call: sessions ===");
const sessionsResult = await client.callTool({ name: "sessions", arguments: {} });
console.log(sessionsResult.content[0].text);

console.log("\n=== call: recipe_show ===");
const showResult = await client.callTool({ name: "recipe_show", arguments: { file: "recipes/github-repo-check.json" } });
console.log(showResult.content[0].text);

console.log("\n=== call: open + snapshot (self-contained — creates its own session) ===");
await client.callTool({ name: "open", arguments: { url: "https://example.com", session: "mcp-test-client" } });
const snapResult = await client.callTool({ name: "snapshot", arguments: { session: "mcp-test-client", interactive: true } });
const parsed = JSON.parse(snapResult.content[0].text);
console.log(`got ${parsed.nodes?.length ?? 0} interactive nodes, e.g.:`, parsed.nodes?.slice(0, 3));

await client.close();
process.exit(0);
