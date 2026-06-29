import { type LoadedProfile } from "../model/profile.js";
import {
  platformInfo,
  systemSummary,
  platformHealth,
  gcAnalysis,
  worldSummary,
  windowStats,
  effectiveTickHealth,
} from "./stats.js";
import { getThreadView, activeMs, sumSelfWhere, isNativeFrame } from "./callTree.js";
import { sourcesBreakdown } from "./sources.js";
import {
  THRESHOLDS as T,
  SIGNATURES,
  bandAbove,
  bandBelow,
  severityRank,
  type Severity,
} from "./knowledgeBase.js";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  evidence: string;
  diagnosis: string;
  action: string;
}

export interface Diagnosis {
  profileType: string;
  overall: Severity;
  headline: string;
  findings: Finding[];
}

const worse = (a: Severity, b: Severity): Severity => (severityRank(a) <= severityRank(b) ? a : b);

export function diagnose(p: LoadedProfile): Diagnosis {
  if (p.type === "heap") return diagnoseHeap(p);
  const findings: Finding[] = [];
  const ph = platformHealth(p);
  const ss = systemSummary(p) as any;
  const gc = gcAnalysis(p);
  const pi = platformInfo(p);
  const eth = effectiveTickHealth(p);
  const ws = windowStats(p);

  // ---- TPS ---- (snapshot if present, else derived from the windowed series)
  const tpsSnap = [ph.tps.last1m, ph.tps.last5m, ph.tps.last15m].filter(
    (v): v is number => v != null,
  );
  const tps = tpsSnap.length ? Math.min(...tpsSnap) : eth.tps;
  if (tps != null) {
    const sev = bandBelow(tps, T.tps);
    if (sev !== "ok")
      findings.push({
        id: "tps_low",
        severity: sev,
        title: "TPS below 20",
        evidence: tpsSnap.length
          ? `TPS 1m/5m/15m = ${ph.tps.last1m}/${ph.tps.last5m}/${ph.tps.last15m} (target ${ph.tps.target})`
          : `Lowest windowed TPS = ${tps} (target 20)`,
        diagnosis:
          "The server cannot complete ticks fast enough to keep 20 TPS — the main thread is overloaded.",
        action:
          "Use get_top_self_time/get_sources_breakdown to find the dominant work, then act on the specific finding(s) below (entities, chunks, a plugin, GC).",
      });
  }

  // ---- MSPT (median + spikes) ----
  const med = eth.msptMedian;
  const p95 = ph.mspt.last1m?.p95 ?? ph.mspt.last5m?.p95;
  const max = eth.msptMax ?? 0;
  if (med != null) {
    const sev = bandAbove(med, T.msptMedian);
    if (sev !== "ok")
      findings.push({
        id: "mspt_high",
        severity: sev,
        title: "High average tick time (MSPT)",
        evidence: `MSPT median=${med}ms, p95=${p95}ms, max=${max}ms (ideal ≤${ph.mspt.idealMax}ms)`,
        diagnosis: "Ticks routinely take longer than the 50ms budget; TPS will drop accordingly.",
        action: "Identify the hot work via the call-tree / sources tools and the findings below.",
      });
    // Spiky but healthy-on-average.
    if (sev === "ok" && max >= T.msptSpikeMax) {
      findings.push({
        id: "mspt_spiky",
        severity: "warning",
        title: "Lag spikes despite healthy average",
        evidence: `MSPT median=${med}ms but max=${max}ms (p95=${p95}ms)`,
        diagnosis:
          "Average ticks are fine, but occasional ticks spike far above budget — averages hide them.",
        action:
          "Capture the spikes specifically: `/spark profiler --only-ticks-over 100` (or 150), then profile again to see what runs only during the bad ticks (saves, GC, periodic plugin tasks, chunk loads).",
      });
    }
  }

  // ---- Windowed degradation (a specific minute dropped, even if the average is fine) ----
  if (ws.available && ws.tpsMin != null && ws.tpsMin < T.tps.warning) {
    const lw = ws.lowestTpsWindow;
    const wm = ws.worstMsptWindow;
    findings.push({
      id: "window_degraded",
      severity: bandBelow(ws.tpsMin, T.tps),
      title: "A time window degraded",
      evidence: `Lowest window TPS=${ws.tpsMin}${lw ? ` (window ${lw.window})` : ""}; worst window MSPT max=${wm?.msptMax}ms. Avg TPS ${ws.tpsAvg} across ${ws.count} windows.`,
      diagnosis: "At least one minute-long window dropped below healthy TPS — intermittent load, not constant.",
      action:
        "Correlate the bad window with what happened then (player join/teleport, scheduled task, world save, mob event). get_health returns the full series; a `--only-ticks-over` sampler isolates the cause.",
    });
  }

  // ---- GC ----
  if (gc.gcTimePctApprox != null) {
    const sev = bandAbove(gc.gcTimePctApprox, T.gcPct);
    if (sev !== "ok")
      findings.push({
        id: "gc_time",
        severity: sev,
        title: "High time spent in garbage collection",
        evidence: `~${gc.gcTimePctApprox}% of wall-clock in GC; ${gc.collectors
          .map((c) => `${c.collector}: ${c.collections}×${c.avgTimeMs}ms`)
          .join(", ")}`,
        diagnosis:
          "GC pressure is stealing main-thread time — usually heap too small for allocation rate, a leak, or poor GC flags.",
        action: ss.usesAikarFlags
          ? "Consider raising heap (Xmx) if host RAM allows; investigate allocation-heavy plugins via a heap summary (/spark heapsummary)."
          : "Apply Aikar's G1GC flags (get_system_stats lists which are missing) and right-size the heap.",
      });
  }
  if (gc.maxPauseAvgMs && gc.maxPauseAvgMs >= T.gcPauseAvgMs.warning) {
    findings.push({
      id: "gc_pause",
      severity: bandAbove(gc.maxPauseAvgMs, T.gcPauseAvgMs),
      title: "Long average GC pauses",
      evidence: `Worst collector averages ${gc.maxPauseAvgMs}ms per collection`,
      diagnosis: "Individual GC pauses are long enough to cause visible tick stalls.",
      action:
        "Tune G1 (Aikar's flags target ~200ms pauses); avoid an over-large young gen and excessive MaxGCPauseMillis values.",
    });
  }
  // MaxGCPauseMillis set very aggressively low can increase GC frequency.
  const pauseTarget = (ss.vmArgs as string | undefined)?.match(/-XX:MaxGCPauseMillis=(\d+)/);
  if (ss.gcInUse === "G1GC" && pauseTarget && Number(pauseTarget[1]) < 100) {
    findings.push({
      id: "gc_pause_target_low",
      severity: "info",
      title: "Very low MaxGCPauseMillis target",
      evidence: `-XX:MaxGCPauseMillis=${pauseTarget[1]} with G1GC`,
      diagnosis:
        "A sub-100ms pause target makes G1 collect more frequently (smaller young gen), which can raise overall GC overhead on Minecraft workloads.",
      action: "Aikar's flags recommend MaxGCPauseMillis=200 (some use 150). Raise it unless you have a specific reason.",
    });
  }
  if (!ss.usesAikarFlags && ss.gcInUse !== "ZGC" && ss.gcInUse !== "Shenandoah") {
    findings.push({
      id: "aikar_flags",
      severity: "info",
      title: "Not using Aikar's G1GC flags",
      evidence: `Detected GC: ${ss.gcInUse}; ${ss.aikarFlagsPresent}/${ss.aikarFlagsTotal} Aikar flags present`,
      diagnosis:
        "Aikar's tuned G1GC flags give more consistent pause times and are the de-facto standard for Minecraft servers.",
      action:
        "Adopt Aikar's flags (https://docs.papermc.io/paper/aikars-flags) sized to your heap; keep Xms == Xmx and add -XX:+AlwaysPreTouch.",
    });
  }

  // ---- Heap / memory ----
  if (ph.heap.usedPct != null) {
    const sev = bandAbove(ph.heap.usedPct, T.heapPct);
    if (sev !== "ok")
      findings.push({
        id: "heap_high",
        severity: sev,
        title: "Heap usage high",
        evidence: `Heap ${ph.heap.usedMb}/${ph.heap.maxMb} MB (${ph.heap.usedPct}%)`,
        diagnosis: "Little headroom before OOM; GC will run harder as the heap fills.",
        action:
          "Raise Xmx if host RAM allows, or reduce memory pressure (entities, plugin caches). A heap summary identifies the biggest consumers.",
      });
  }
  if (ss.xms && ss.xmx && ss.xms !== ss.xmx) {
    findings.push({
      id: "xms_xmx",
      severity: "info",
      title: "Xms and Xmx differ",
      evidence: `Xms=${ss.xms}, Xmx=${ss.xmx}`,
      diagnosis: "A growing heap causes extra resizing/GC churn; MC servers should pin the heap.",
      action: "Set Xms == Xmx and use -XX:+AlwaysPreTouch so the heap is committed up front.",
    });
  }
  if (ss.physicalMemPct != null) {
    const sev = bandAbove(ss.physicalMemPct, T.physicalMemPct);
    if (sev !== "ok")
      findings.push({
        id: "host_mem",
        severity: sev,
        title: "Host memory nearly exhausted",
        evidence: `Physical RAM ${ss.physicalMemUsedMb}/${ss.physicalMemTotalMb} MB (${ss.physicalMemPct}%), swap used ${ss.swapUsedMb} MB`,
        diagnosis: "Low free RAM risks swapping, which is catastrophic for tick latency.",
        action: "Reduce Xmx or other processes on the host; ensure the server is not swapping.",
      });
  }

  // ---- CPU ----
  if (ss.cpuProcessPct != null) {
    const sev = bandAbove(ss.cpuProcessPct, T.cpuProcessPct);
    if (sev !== "ok")
      findings.push({
        id: "cpu_high",
        severity: sev,
        title: "High process CPU usage",
        evidence: `Process CPU ${ss.cpuProcessPct}% (system ${ss.cpuSystemPct}%, ${ss.cpuThreads} threads)`,
        diagnosis: "The JVM is CPU-bound; the main thread competes for cores.",
        action:
          "Single-thread MC tick work is the bottleneck — reduce per-tick load (below). More cores rarely helps the main thread directly.",
      });
  }

  // ---- Call-tree driven findings (sampler only) ----
  if (p.type === "sampler") {
    const view = getThreadView(p.data);
    if (view) {
      const active = activeMs(view) || 1;

      // Plugin dominance.
      const bySource = sourcesBreakdown(p.data, view, 8, { excludeNative: true });
      const HEURISTIC = new Set([
        "Minecraft (vanilla)",
        "JDK / JVM",
        "Server (Paper/Bukkit)",
        "Native (JVM/OS, incl. idle wait)",
        "Unknown / other",
      ]);
      const topPlugin = bySource.find((s) => !HEURISTIC.has(s.source));
      if (topPlugin) {
        const pctActive = +((topPlugin.selfMs / active) * 100).toFixed(1);
        if (pctActive >= T.sourceDominancePct) {
          findings.push({
            id: "plugin_dominates",
            severity: "warning",
            title: `Plugin "${topPlugin.source}" dominates main-thread work`,
            evidence: `${topPlugin.source}${topPlugin.version ? " v" + topPlugin.version : ""} = ${pctActive}% of active main-thread time (${topPlugin.selfMs}ms)`,
            diagnosis: "A single plugin accounts for a large share of per-tick CPU work.",
            action: `Review ${topPlugin.source}'s config/usage (limits, intervals, scope), update it, or replace it with a lighter alternative. Use get_call_tree to see exactly what it runs.`,
          });
        }
      }

      // Category signatures.
      for (const sig of SIGNATURES) {
        const pats = sig.patterns.map((s) => s.toLowerCase());
        const ms = sumSelfWhere(
          view,
          (n) =>
            !isNativeFrame(n) &&
            pats.some((pp) => `${n.className ?? ""}.${n.methodName ?? ""}`.toLowerCase().includes(pp)),
        );
        const pctActive = +((ms / active) * 100).toFixed(1);
        if (pctActive >= T.signatureActivePct) {
          findings.push({
            id: `sig_${sig.id}`,
            severity: pctActive >= 30 ? "warning" : "info",
            title: `${sig.label} is significant`,
            evidence: `~${pctActive}% of active main-thread time (${ms}ms) in ${sig.label.toLowerCase()} frames`,
            diagnosis: `${sig.label} is a notable share of per-tick work.`,
            action: sig.advice,
          });
        }
      }
    }
  }

  // ---- Config sanity ----
  const ch = pi.configHighlights as Record<string, any>;
  const vd = numFrom(ch, "view-distance");
  const sd = numFrom(ch, "simulation-distance");
  const players = ph.playerCount ?? 0;
  if (vd != null && vd > T.viewDistanceHigh) {
    findings.push({
      id: "view_distance",
      severity: "info",
      title: "High view-distance",
      evidence: `view-distance=${vd}${players ? `, players=${players}` : ""}`,
      diagnosis: "Larger view-distance loads/keeps more chunks, increasing memory and main-thread work.",
      action: "8–10 is typical; lower it (and prefer Paper's no-tick-view-distance for visual range) if the server is loaded.",
    });
  }
  if (sd != null && sd > T.simulationDistanceHigh) {
    findings.push({
      id: "sim_distance",
      severity: "info",
      title: "High simulation-distance",
      evidence: `simulation-distance=${sd}`,
      diagnosis: "Simulation-distance drives how many chunks tick entities/redstone/blocks — a big CPU lever.",
      action: "Reduce to 6–8 to cut entity/block ticking load substantially.",
    });
  }

  // ---- Server brand ----
  const brand = (pi.brand ?? "").toLowerCase();
  const modern = ["paper", "purpur", "folia", "pufferfish", "leaf", "leaves", "fabric", "neoforge"];
  if (brand && !modern.some((m) => brand.includes(m)) && (pi.type === "SERVER" || pi.type === undefined)) {
    findings.push({
      id: "server_brand",
      severity: "info",
      title: `Server brand: ${pi.brand}`,
      evidence: `Running ${pi.server} ${pi.serverVersion}`,
      diagnosis: "Spigot/CraftBukkit/Vanilla lack many performance patches present in Paper and forks.",
      action: "Migrating to Paper (or Purpur/Pufferfish) typically improves performance with no gameplay change.",
    });
  }

  // ---- Overall ----
  let overall: Severity = "ok";
  for (const f of findings) overall = worse(overall, f.severity);
  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const idealMax = ph.mspt.idealMax || 50;
  const headline = buildHeadline(overall, eth.tps, med, idealMax, findings, worldSummary(p));
  return { profileType: p.type, overall, headline, findings };
}

function buildHeadline(
  overall: Severity,
  tps: number | undefined,
  med: number | undefined,
  idealMax: number,
  findings: Finding[],
  world: any,
): string {
  const tpsStr = tps != null ? `TPS ${tps}` : "TPS n/a";
  const medStr = med != null ? `MSPT median ${med}ms` : "MSPT n/a";
  const ents = world?.available ? `, ${world.totalEntities} entities` : "";
  if (overall === "ok") {
    const headroom =
      med != null
        ? ` Main thread uses ~${med}ms of the 50ms budget (~${Math.max(0, Math.round((1 - med / idealMax) * 100))}% headroom).`
        : "";
    return `Healthy: ${tpsStr}, ${medStr}${ents}.${headroom} No issues detected.`;
  }
  const crit = findings.filter((f) => f.severity === "critical").length;
  const warn = findings.filter((f) => f.severity === "warning").length;
  return `${overall.toUpperCase()}: ${tpsStr}, ${medStr}${ents}. ${crit} critical, ${warn} warning finding(s) — see below.`;
}

function numFrom(obj: Record<string, any>, key: string): number | null {
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase().endsWith(key) && typeof v !== "object") {
      const n = Number(v);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}

function diagnoseHeap(p: LoadedProfile): Diagnosis {
  const entries: any[] = p.data.entries ?? [];
  const totalBytes = entries.reduce((s, e) => s + (e.size ?? 0), 0);
  const top = [...entries].sort((a, b) => (b.size ?? 0) - (a.size ?? 0)).slice(0, 5);
  const findings: Finding[] = top.map((e, i) => ({
    id: `heap_top_${i}`,
    severity: "info" as Severity,
    title: `#${e.order ?? i + 1} ${e.type}`,
    evidence: `${(e.size / (1024 * 1024)).toFixed(1)} MB across ${e.instances} instances`,
    diagnosis: "Largest retained types — disproportionate plugin types here point to caching/leaks.",
    action: "If a plugin type dominates unexpectedly, check that plugin for unbounded caches or entity references.",
  }));
  return {
    profileType: "heap",
    overall: "info",
    headline: `Heap summary: ${entries.length} types, ${(totalBytes / (1024 * 1024)).toFixed(0)} MB retained. Top consumers below.`,
    findings,
  };
}
