/**
 * End-to-end MCP smoke test: spawn the built server over stdio, connect a client,
 * and exercise the main tools against example.sparkprofile.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";

const FILE = process.argv[2] ?? "example.sparkprofile";

// The sample profile is not committed (it contained server data). Skip cleanly when absent
// — e.g. in CI — so this stays a no-op rather than a failure. Pass a path to run it locally.
if (!existsSync(FILE)) {
  console.log(`smoke: "${FILE}" not present — skipping (provide a .sparkprofile path to run).`);
  process.exit(0);
}

function text(res: any): any {
  const t = res.content?.[0]?.text ?? "";
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const loaded = text(await client.callTool({ name: "load_profile", arguments: { source: FILE } }));
console.log("\nload_profile ->", JSON.stringify(loaded, null, 2).slice(0, 900));
const id = loaded.id as string;

const diag = text(await client.callTool({ name: "diagnose", arguments: { profileId: id } }));
console.log("\ndiagnose -> overall:", diag.overall, "| ", diag.headline);
for (const f of diag.findings) console.log(`  [${f.severity}] ${f.title} — ${f.evidence}`);

const hot = text(await client.callTool({ name: "get_top_self_time", arguments: { profileId: id, topN: 5 } }));
console.log("\nget_top_self_time -> active", hot.activeMs, "ms / idle", hot.idleNativeMs, "ms");
for (const m of hot.methods) console.log(`  ${m.selfPct}%  ${m.method}`);

const tree = text(
  await client.callTool({
    name: "get_call_tree",
    arguments: { profileId: id, rootPath: ["runServer"], maxDepth: 3, minPercent: 2 },
  }),
);
console.log("\nget_call_tree(rootPath=runServer) focus:", tree.focus, "rootChildren:", tree.root?.[0]?.children?.length);

const search = text(await client.callTool({ name: "search_call_tree", arguments: { profileId: id, pattern: "tickChildren" } }));
console.log("\nsearch 'tickChildren':", search.matches?.length, "matches; top:", search.matches?.[0]?.method, search.matches?.[0]?.totalPct + "%");

// Error-path check
const badThread = text(await client.callTool({ name: "get_top_self_time", arguments: { profileId: id, thread: "DoesNotExist" } }));
console.log("\nerror-path (bad thread):", typeof badThread === "string" ? badThread : JSON.stringify(badThread).slice(0, 120));

await client.close();
console.log("\nSMOKE OK");
