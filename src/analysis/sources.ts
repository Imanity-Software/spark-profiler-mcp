import type { ThreadView } from "./callTree.js";
import { nodeSelf, isNativeFrame, activeMs } from "./callTree.js";

/**
 * Spark attributes each sampled class to the plugin/mod that loaded it via
 * `SamplerData.class_sources` (className -> source name). We fall back to a package
 * heuristic so vanilla / JVM / server frames are still grouped sensibly.
 */

export interface SourceMaps {
  classSources: Record<string, string>;
  methodSources: Record<string, string>;
  lineSources: Record<string, string>;
}

export function getSourceMaps(data: any): SourceMaps {
  return {
    classSources: data.classSources ?? {},
    methodSources: data.methodSources ?? {},
    lineSources: data.lineSources ?? {},
  };
}

function heuristicSource(className: string): string {
  const c = className ?? "";
  if (
    c.startsWith("java.") ||
    c.startsWith("jdk.") ||
    c.startsWith("sun.") ||
    c.startsWith("javax.")
  )
    return "JDK / JVM";
  if (c.startsWith("net.minecraft.")) return "Minecraft (vanilla)";
  if (
    c.startsWith("org.bukkit.") ||
    c.startsWith("org.spigotmc.") ||
    c.startsWith("io.papermc.") ||
    c.startsWith("com.destroystokyo.paper") ||
    c.startsWith("ca.spottedleaf.")
  )
    return "Server (Paper/Bukkit)";
  return "Unknown / other";
}

/** Resolve the plugin/mod (or heuristic group) responsible for a stack frame. */
export function resolveSource(maps: SourceMaps, node: any): string {
  const cn = node.className ?? "";
  const fromClass = maps.classSources[cn];
  if (fromClass) return fromClass;
  if (isNativeFrame(node)) return "Native (JVM/OS, incl. idle wait)";
  return heuristicSource(cn);
}

export interface SourceBreakdownRow {
  source: string;
  version?: string;
  selfMs: number;
  selfPct: number;
}

/**
 * Per-source self-time breakdown for a thread (the spark "sources" view), restricted
 * to real plugin/mod sources by default plus the heuristic groups.
 */
export function sourcesBreakdown(
  data: any,
  view: ThreadView,
  topN: number,
  opts: { excludeNative?: boolean } = {},
): SourceBreakdownRow[] {
  const maps = getSourceMaps(data);
  const pluginMeta: Record<string, any> = data.metadata?.sources ?? {};
  const agg = new Map<string, number>();

  for (const n of view.pool) {
    if (!n) continue;
    if (opts.excludeNative && isNativeFrame(n)) continue;
    const self = nodeSelf(view.pool, n);
    if (self <= 0) continue;
    const src = resolveSource(maps, n);
    agg.set(src, (agg.get(src) ?? 0) + self);
  }

  const total = (opts.excludeNative ? activeMs(view) : view.totalMs) || 1;
  return [...agg.entries()]
    .map(([source, selfMs]) => ({
      source,
      version: pluginMeta[source]?.version,
      selfMs: Math.round(selfMs),
      selfPct: +((selfMs / total) * 100).toFixed(2),
    }))
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, topN);
}

/** Names of the plugin/mod sources that own at least one sampled class (real attribution). */
export function attributedPlugins(data: any): Set<string> {
  const set = new Set<string>();
  for (const v of Object.values(data.classSources ?? {})) set.add(v as string);
  return set;
}
