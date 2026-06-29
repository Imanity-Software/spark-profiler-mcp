import type { LoadedProfile } from "./model/profile.js";
import {
  platformInfo,
  platformHealth,
  gcAnalysis,
  worldSummary,
  windowStats,
  effectiveTickHealth,
} from "./analysis/stats.js";
import { getThreadView, topSelfTime } from "./analysis/callTree.js";
import { sourcesBreakdown } from "./analysis/sources.js";
import { diagnose } from "./analysis/diagnose.js";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Wrap a JS value as MCP text content (pretty JSON — the AI reads it directly). */
export function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, replacer, 2) }] };
}

export function err(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

// Drop undefined/empty so outputs stay compact.
function replacer(_k: string, v: unknown) {
  if (v === undefined || v === null) return undefined;
  return v;
}

/** Headline summary used by load_profile and get_summary. Token-efficient: a few top-N lists. */
export function buildSummary(p: LoadedProfile) {
  const pi = platformInfo(p);
  if (p.type === "heap") {
    const d = diagnose(p);
    return { id: p.id, type: p.type, server: `${pi.server} ${pi.serverVersion}`, headline: d.headline };
  }
  const ph = platformHealth(p);
  const gc = gcAnalysis(p);
  const world = worldSummary(p, 5);
  const eth = effectiveTickHealth(p);
  const ws = windowStats(p);
  const d = diagnose(p);

  let hotMethods: unknown[] = [];
  let topSources: unknown[] = [];
  if (p.type === "sampler") {
    const view = getThreadView(p.data);
    if (view) {
      hotMethods = topSelfTime(view, 5, { excludeNative: true });
      topSources = sourcesBreakdown(p.data, view, 5, { excludeNative: true });
    }
  }

  return {
    id: p.id,
    type: p.type,
    server: `${pi.server} ${pi.serverVersion}`,
    minecraftVersion: pi.minecraftVersion,
    pluginCount: pi.pluginCount,
    players: ph.playerCount,
    tps: eth.tps,
    msptMedianMs: eth.msptMedian,
    msptMaxMs: eth.msptMax,
    metricsSource: eth.source, // "snapshot" | "windows" | "none"
    timeWindowCount: ws.available ? ws.count : undefined,
    heap: ph.heap,
    gcTimePctApprox: gc.gcTimePctApprox,
    totalEntities: world.available ? world.totalEntities : undefined,
    hotMethods,
    topSources,
    diagnosis: { overall: d.overall, headline: d.headline, findingCount: d.findings.length },
    hint:
      p.type === "health"
        ? "Call get_health for the per-window time series; diagnose for findings."
        : "Call diagnose for full findings; get_call_tree / get_top_self_time / get_sources_breakdown to drill in.",
  };
}
