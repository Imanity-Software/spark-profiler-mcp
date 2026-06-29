import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadProfile } from "../model/profile.js";
import { putProfile, getProfile, listProfiles } from "../cache.js";
import { ok, err, buildSummary, type ToolResult } from "../format.js";
import {
  platformInfo,
  systemSummary,
  platformHealth,
  worldSummary,
  gcAnalysis,
  windowStats,
} from "../analysis/stats.js";
import {
  getThreadView,
  listThreads,
  topSelfTime,
  buildTree,
  searchTree,
  activeMs,
  nativeSelfMs,
} from "../analysis/callTree.js";
import { sourcesBreakdown } from "../analysis/sources.js";
import { diagnose } from "../analysis/diagnose.js";

/** Run a handler, converting thrown errors into MCP error results. */
function guard<A>(fn: (args: A) => ToolResult | Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  };
}

const profileIdArg = {
  profileId: z.string().describe("The id returned by load_profile."),
};

export function registerTools(server: McpServer): void {
  server.registerTool(
    "load_profile",
    {
      title: "Load a spark profile",
      description:
        "Load and parse a spark file from a local path, a bytebin/spark.lucko.me URL, or a bytebin key. " +
        "Supports .sparkprofile (sampler), .sparkheap (memory), and .sparkhealth (health) files. " +
        "Returns a profileId plus a headline summary; all other tools take that profileId.",
      inputSchema: {
        source: z
          .string()
          .describe("Local file path, a https://spark.lucko.me/<key> or bytebin URL, or a bare bytebin key."),
      },
    },
    guard(async (args: { source: string }) => {
      const p = await loadProfile(args.source);
      putProfile(p);
      return ok(buildSummary(p));
    }) as any,
  );

  server.registerTool(
    "list_profiles",
    {
      title: "List loaded profiles",
      description: "List the profiles currently loaded in memory (id, type, source).",
      inputSchema: {},
    },
    guard(async () => ok(listProfiles())) as any,
  );

  server.registerTool(
    "get_summary",
    {
      title: "Profile summary",
      description:
        "Headline health summary: server/MC version, TPS, MSPT, heap, GC%, entities, top hot methods & plugin sources, and the overall diagnosis verdict.",
      inputSchema: profileIdArg,
    },
    guard(async (a: { profileId: string }) => ok(buildSummary(getProfile(a.profileId)))) as any,
  );

  server.registerTool(
    "diagnose",
    {
      title: "Diagnose performance issues",
      description:
        "Apply the built-in interpretation knowledge base (TPS/MSPT/GC/heap/CPU thresholds, plugin dominance, " +
        "entity/chunk/redstone/IO signatures, JVM-flag checks) and return ranked findings, each with evidence, " +
        "diagnosis, and a concrete recommended action. This is the primary 'what should I tune' tool.",
      inputSchema: profileIdArg,
    },
    guard(async (a: { profileId: string }) => ok(diagnose(getProfile(a.profileId)))) as any,
  );

  server.registerTool(
    "get_platform_info",
    {
      title: "Platform & plugins",
      description:
        "Server brand/version, Minecraft version, the plugin/mod list with versions, config file names, and key config highlights (view/simulation-distance, spawn limits, etc.).",
      inputSchema: profileIdArg,
    },
    guard(async (a: { profileId: string }) => ok(platformInfo(getProfile(a.profileId)))) as any,
  );

  server.registerTool(
    "get_system_stats",
    {
      title: "System & JVM stats",
      description:
        "Host CPU/RAM/disk/OS, Java version, JVM args (secrets redacted), detected GC, Xmx/Xms, and an Aikar's-flags check.",
      inputSchema: profileIdArg,
    },
    guard(async (a: { profileId: string }) => ok(systemSummary(getProfile(a.profileId)))) as any,
  );

  server.registerTool(
    "get_health",
    {
      title: "TPS / MSPT / GC health",
      description:
        "Tick health: TPS (1m/5m/15m), MSPT percentiles (mean/median/p95/max), ping, heap, GC analysis, and — " +
        "for .sparkhealth reports (and the windows inside a sampler) — the per-minute time series with the worst windows highlighted.",
      inputSchema: {
        ...profileIdArg,
        windowLimit: z.number().int().min(1).max(500).default(120).describe("Max time-series windows to return."),
      },
    },
    guard(async (a: { profileId: string; windowLimit?: number }) => {
      const p = getProfile(a.profileId);
      if (p.type === "heap") throw new Error(`Profile "${a.profileId}" is a heap dump; use get_heap_summary.`);
      const windows = windowStats(p, a.windowLimit ?? 120);
      return ok({ ...platformHealth(p), gc: gcAnalysis(p), timeWindows: windows });
    }) as any,
  );

  server.registerTool(
    "get_world_stats",
    {
      title: "World & entities",
      description: "World/entity statistics: total entities, top entity types by count, per-world entity totals, data packs, non-default game rules.",
      inputSchema: {
        ...profileIdArg,
        topN: z.number().int().min(1).max(100).default(15).describe("Top entity types to return."),
      },
    },
    guard(async (a: { profileId: string; topN?: number }) =>
      ok(worldSummary(getProfile(a.profileId), a.topN ?? 15)),
    ) as any,
  );

  server.registerTool(
    "list_threads",
    {
      title: "List sampled threads",
      description: "List the sampled threads (name, total sampled ms, node count), busiest first. Use a name with the call-tree tools.",
      inputSchema: profileIdArg,
    },
    guard(async (a: { profileId: string }) => {
      const p = getProfile(a.profileId);
      if (p.type !== "sampler") throw new Error(`Profile "${a.profileId}" is a ${p.type} file (no threads).`);
      return ok(listThreads(p.data));
    }) as any,
  );

  server.registerTool(
    "get_top_self_time",
    {
      title: "Hottest methods (self time)",
      description:
        "Top methods by self-time on a thread (default 'Server thread'). excludeNative drops idle/native wait frames to reveal the hottest Java methods.",
      inputSchema: {
        ...profileIdArg,
        thread: z.string().optional().describe("Thread name (default 'Server thread')."),
        topN: z.number().int().min(1).max(100).default(15),
        excludeNative: z.boolean().default(true).describe("Exclude native/idle frames (recommended)."),
      },
    },
    guard(async (a: { profileId: string; thread?: string; topN?: number; excludeNative?: boolean }) => {
      const p = getProfile(a.profileId);
      if (p.type !== "sampler") throw new Error(`Profile "${a.profileId}" is a ${p.type} file (no threads).`);
      const view = getThreadView(p.data, a.thread);
      if (!view) throw new Error(`Thread not found: ${a.thread ?? "Server thread"}`);
      return ok({
        thread: view.name,
        totalMs: Math.round(view.totalMs),
        activeMs: Math.round(activeMs(view)),
        idleNativeMs: Math.round(nativeSelfMs(view)),
        methods: topSelfTime(view, a.topN ?? 15, { excludeNative: a.excludeNative ?? true }),
      });
    }) as any,
  );

  server.registerTool(
    "get_sources_breakdown",
    {
      title: "Per-plugin breakdown",
      description:
        "Self-time grouped by plugin/mod source (spark 'sources' view) on a thread. excludeNative drops idle frames. Shows which plugin/mod owns the work.",
      inputSchema: {
        ...profileIdArg,
        thread: z.string().optional().describe("Thread name (default 'Server thread')."),
        topN: z.number().int().min(1).max(100).default(15),
        excludeNative: z.boolean().default(true),
      },
    },
    guard(async (a: { profileId: string; thread?: string; topN?: number; excludeNative?: boolean }) => {
      const { p, view } = withThread(a.profileId, a.thread);
      return ok({
        thread: view.name,
        activeMs: Math.round(activeMs(view)),
        sources: sourcesBreakdown(p.data, view, a.topN ?? 15, { excludeNative: a.excludeNative ?? true }),
      });
    }) as any,
  );

  server.registerTool(
    "get_call_tree",
    {
      title: "Drill into the call tree",
      description:
        "Pruned call tree for a thread. Children below minPercent of the thread total are dropped and depth is capped. " +
        "Pass rootPath (an array of 'Class.method' labels/substrings) to descend into a specific subtree before expanding.",
      inputSchema: {
        ...profileIdArg,
        thread: z.string().optional().describe("Thread name (default 'Server thread')."),
        maxDepth: z.number().int().min(1).max(30).default(6),
        minPercent: z.number().min(0).max(100).default(1).describe("Drop frames below this % of thread total."),
        rootPath: z.array(z.string()).optional().describe("Descend into this frame path first, e.g. ['runServer','tickChildren']."),
      },
    },
    guard(async (a: { profileId: string; thread?: string; maxDepth?: number; minPercent?: number; rootPath?: string[] }) => {
      const { view } = withThread(a.profileId, a.thread);
      return ok({
        thread: view.name,
        totalMs: Math.round(view.totalMs),
        ...buildTree(view, {
          maxDepth: a.maxDepth ?? 6,
          minPercent: a.minPercent ?? 1,
          rootPath: a.rootPath,
        }),
      });
    }) as any,
  );

  server.registerTool(
    "search_call_tree",
    {
      title: "Search the call tree",
      description: "Find stack frames whose Class.method matches a substring or /regex/, returned with total/self time. Useful to check whether a suspected plugin/mechanic appears and how heavy it is.",
      inputSchema: {
        ...profileIdArg,
        pattern: z.string().describe("Substring (case-insensitive) or /regex/."),
        thread: z.string().optional().describe("Thread name (default 'Server thread')."),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    guard(async (a: { profileId: string; pattern: string; thread?: string; limit?: number }) => {
      const { view } = withThread(a.profileId, a.thread);
      return ok({ thread: view.name, matches: searchTree(view, a.pattern, a.limit ?? 20) });
    }) as any,
  );

  server.registerTool(
    "get_heap_summary",
    {
      title: "Heap summary (.sparkheap)",
      description: "For a .sparkheap file: the largest retained types by size, with instance counts.",
      inputSchema: {
        ...profileIdArg,
        topN: z.number().int().min(1).max(200).default(25),
      },
    },
    guard(async (a: { profileId: string; topN?: number }) => {
      const p = getProfile(a.profileId);
      if (p.type !== "heap") throw new Error(`Profile "${a.profileId}" is a ${p.type} file, not a heap dump.`);
      const entries: any[] = p.data.entries ?? [];
      const total = entries.reduce((s, e) => s + (e.size ?? 0), 0);
      const top = [...entries]
        .sort((x, y) => (y.size ?? 0) - (x.size ?? 0))
        .slice(0, a.topN ?? 25)
        .map((e) => ({
          order: e.order,
          type: e.type,
          instances: e.instances,
          sizeMb: +((e.size ?? 0) / (1024 * 1024)).toFixed(2),
          pct: +(((e.size ?? 0) / (total || 1)) * 100).toFixed(1),
        }));
      return ok({ totalTypes: entries.length, totalMb: +(total / (1024 * 1024)).toFixed(0), top });
    }) as any,
  );
}

/** Shared: fetch a sampler profile + a thread view (throws a friendly error otherwise). */
function withThread(id: string, thread?: string) {
  const p = getProfile(id);
  if (p.type !== "sampler") throw new Error(`Profile "${id}" is a ${p.type} file (no call tree).`);
  const view = getThreadView(p.data, thread);
  if (!view) throw new Error(`Thread not found: ${thread ?? "Server thread"}`);
  return { p, view };
}
