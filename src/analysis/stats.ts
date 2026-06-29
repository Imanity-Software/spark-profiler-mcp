import {
  type LoadedProfile,
  platform,
  systemStats,
  platformStats,
  sources,
  serverConfigurations,
} from "../model/profile.js";

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

function bytesToMb(b?: number): number | undefined {
  return b == null ? undefined : Math.round(b / MB);
}
function pct(part?: number, whole?: number): number | undefined {
  if (part == null || !whole) return undefined;
  return +((part / whole) * 100).toFixed(1);
}
function fmtDuration(ms?: number): string | undefined {
  if (ms == null) return undefined;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

export function platformInfo(p: LoadedProfile) {
  const pm = platform(p);
  const plugins = Object.entries(sources(p)).map(([name, meta]: [string, any]) => ({
    name,
    version: meta?.version,
    builtin: meta?.builtin || undefined,
  }));
  return {
    type: pm.type,
    server: pm.name,
    brand: pm.brand,
    serverVersion: pm.version,
    minecraftVersion: pm.minecraftVersion,
    sparkVersion: pm.sparkVersion,
    pluginCount: plugins.length,
    plugins: plugins.sort((a, b) => (a.name > b.name ? 1 : -1)),
    configFiles: Object.keys(serverConfigurations(p)),
    configHighlights: configHighlights(p),
  };
}

/** ----- GC ----- */
export interface GcRow {
  collector: string;
  collections: number;
  avgTimeMs: number;
  avgFreqSecs?: number;
  totalTimeMs: number;
}

export function gcAnalysis(p: LoadedProfile) {
  const ps = platformStats(p);
  const uptime = ps.uptime ?? systemStats(p).uptime;
  const gcMap: Record<string, any> = ps.gc ?? systemStats(p).gc ?? {};
  const rows: GcRow[] = Object.entries(gcMap).map(([collector, g]: [string, any]) => ({
    collector,
    collections: g.total ?? 0,
    avgTimeMs: +(g.avgTime ?? 0).toFixed(1),
    avgFreqSecs: g.avgFrequency ? +(g.avgFrequency / 1000).toFixed(1) : undefined,
    totalTimeMs: Math.round((g.total ?? 0) * (g.avgTime ?? 0)),
  }));
  const totalGcMs = rows.reduce((s, r) => s + r.totalTimeMs, 0);
  return {
    collectors: rows.sort((a, b) => b.totalTimeMs - a.totalTimeMs),
    totalGcTimeMs: totalGcMs,
    uptimeMs: uptime,
    // Approximate share of wall-clock spent in GC over the server's uptime.
    gcTimePctApprox: pct(totalGcMs, uptime),
    maxPauseAvgMs: rows.reduce((m, r) => Math.max(m, r.avgTimeMs), 0),
  };
}

/** ----- System (host/JVM) ----- */
export function systemSummary(p: LoadedProfile) {
  const s = systemStats(p);
  const cpu = s.cpu ?? {};
  const mem = s.memory ?? {};
  return {
    os: s.os ? `${s.os.name} ${s.os.version} (${s.os.arch})` : undefined,
    cpuModel: cpu.modelName,
    cpuThreads: cpu.threads,
    cpuProcessPct: cpu.processUsage ? +(cpu.processUsage.last1m * 100).toFixed(1) : undefined,
    cpuSystemPct: cpu.systemUsage ? +(cpu.systemUsage.last1m * 100).toFixed(1) : undefined,
    physicalMemUsedMb: bytesToMb(mem.physical?.used),
    physicalMemTotalMb: bytesToMb(mem.physical?.total),
    physicalMemPct: pct(mem.physical?.used, mem.physical?.total),
    swapUsedMb: bytesToMb(mem.swap?.used),
    diskUsedGb: s.disk?.used ? +(s.disk.used / GB).toFixed(1) : undefined,
    diskTotalGb: s.disk?.total ? +(s.disk.total / GB).toFixed(1) : undefined,
    java: s.java ? `${s.java.vendor ?? ""} ${s.java.version ?? ""}`.trim() : undefined,
    jvm: s.jvm?.name,
    uptime: fmtDuration(s.uptime),
    ...jvmFlags(p),
    gcInUse: detectGcFromCollectors(p),
  };
}

/** The actual GC, inferred from the live collector names (works even when -XX:+UseXxxGC
 * isn't passed explicitly, e.g. G1 is the JVM default). */
export function detectGcFromCollectors(p: LoadedProfile): string {
  const names = Object.keys(platformStats(p).gc ?? systemStats(p).gc ?? {}).join(" ");
  if (/ZGC|ZGC Cycles/i.test(names)) return "ZGC";
  if (/Shenandoah/i.test(names)) return "Shenandoah";
  if (/\bG1\b/.test(names)) return "G1GC";
  if (/PS |Parallel|Scavenge/i.test(names)) return "ParallelGC";
  if (/Copy|MarkSweep|ConcurrentMarkSweep/i.test(names)) return "Serial/CMS";
  return "unknown";
}

/** ----- Heap (in-process) + TPS/MSPT ----- */
export function platformHealth(p: LoadedProfile) {
  const ps = platformStats(p);
  const heap = ps.memory?.heap ?? {};
  const tps = ps.tps ?? {};
  const mspt = ps.mspt ?? {};
  const m1 = mspt.last1m ?? {};
  const m5 = mspt.last5m ?? {};
  return {
    tps: {
      last1m: round2(tps.last1m),
      last5m: round2(tps.last5m),
      last15m: round2(tps.last15m),
      target: tps.gameTargetTps || 20,
    },
    mspt: {
      idealMax: mspt.gameMaxIdealMspt || 50,
      last1m: rollup(m1),
      last5m: rollup(m5),
    },
    pingLast15m: ps.ping?.last15m ? rollup(ps.ping.last15m) : undefined,
    playerCount: ps.playerCount,
    onlineMode: ps.onlineMode,
    heap: {
      usedMb: bytesToMb(heap.used),
      maxMb: bytesToMb(heap.max),
      usedPct: pct(heap.used, heap.max),
    },
  };
}

function round2(n?: number): number | undefined {
  return n == null ? undefined : +n.toFixed(2);
}

/** ----- Windowed time-series (health reports, and the windows inside a sampler) ----- */
export interface WindowRow {
  window: number;
  ticks?: number;
  tps?: number;
  msptMedian?: number;
  msptMax?: number;
  cpuProcessPct?: number;
  cpuSystemPct?: number;
  players?: number;
  entities?: number;
  tileEntities?: number;
  chunks?: number;
  durationMs?: number;
}

export function windowStats(p: LoadedProfile, limit = 120) {
  const map: Record<string, any> = p.data.timeWindowStatistics ?? {};
  const keys = Object.keys(map)
    .map(Number)
    .sort((a, b) => a - b);
  if (!keys.length) return { available: false as const };
  const windows: WindowRow[] = keys.map((k) => {
    const w = map[String(k)] ?? map[k];
    return {
      window: k,
      ticks: w.ticks,
      tps: round2(w.tps),
      msptMedian: round2(w.msptMedian),
      msptMax: round2(w.msptMax),
      cpuProcessPct: w.cpuProcess != null ? +(w.cpuProcess * 100).toFixed(1) : undefined,
      cpuSystemPct: w.cpuSystem != null ? +(w.cpuSystem * 100).toFixed(1) : undefined,
      players: w.players,
      entities: w.entities,
      tileEntities: w.tileEntities,
      chunks: w.chunks,
      durationMs: w.duration,
    };
  });
  const tpsVals = windows.map((w) => w.tps).filter((n): n is number => n != null);
  const worstMspt = [...windows].sort((a, b) => (b.msptMax ?? 0) - (a.msptMax ?? 0))[0];
  const lowestTps = [...windows].sort((a, b) => (a.tps ?? 99) - (b.tps ?? 99))[0];
  return {
    available: true as const,
    count: windows.length,
    tpsMin: tpsVals.length ? Math.min(...tpsVals) : undefined,
    tpsAvg: tpsVals.length ? +(tpsVals.reduce((s, v) => s + v, 0) / tpsVals.length).toFixed(2) : undefined,
    worstMsptWindow: worstMspt ? { window: worstMspt.window, msptMax: worstMspt.msptMax } : undefined,
    lowestTpsWindow: lowestTps ? { window: lowestTps.window, tps: lowestTps.tps } : undefined,
    windows: windows.slice(0, limit),
    truncated: windows.length > limit ? windows.length - limit : undefined,
  };
}

/** Tick health that prefers the live snapshot (PlatformStatistics) but falls back to the
 * windowed series — so health reports without a snapshot still yield TPS/MSPT. */
export function effectiveTickHealth(p: LoadedProfile): {
  tps?: number;
  msptMedian?: number;
  msptMax?: number;
  source: "snapshot" | "windows" | "none";
} {
  const ph = platformHealth(p);
  const med = ph.mspt.last1m?.median ?? ph.mspt.last5m?.median;
  const max = Math.max(ph.mspt.last1m?.max ?? 0, ph.mspt.last5m?.max ?? 0) || undefined;
  const snapTps = ph.tps.last1m ?? ph.tps.last5m ?? ph.tps.last15m;
  if (med != null || snapTps != null) {
    return { tps: snapTps, msptMedian: med, msptMax: max, source: "snapshot" };
  }
  const ws = windowStats(p);
  if (ws.available) {
    const medFromWin = ws.windows
      .map((w) => w.msptMedian)
      .filter((n): n is number => n != null)
      .sort((a, b) => b - a)[0];
    return {
      tps: ws.tpsMin,
      msptMedian: medFromWin,
      msptMax: ws.worstMsptWindow?.msptMax,
      source: "windows",
    };
  }
  return { source: "none" };
}
function rollup(r: any) {
  if (!r) return undefined;
  return {
    mean: round2(r.mean),
    median: round2(r.median),
    p95: round2(r.percentile95),
    max: round2(r.max),
    min: round2(r.min),
  };
}

/** ----- World ----- */
export function worldSummary(p: LoadedProfile, topN = 15) {
  const w = platformStats(p).world;
  if (!w) return { available: false };
  const entityCounts: Record<string, number> = w.entityCounts ?? {};
  const topEntities = Object.entries(entityCounts)
    .map(([type, count]) => ({ type, count: count as number }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
  const worlds = (w.worlds ?? []).map((world: any) => ({
    name: world.name,
    entities: world.totalEntities,
    regions: (world.regions ?? []).length,
  }));
  return {
    available: true,
    totalEntities: w.totalEntities,
    topEntities,
    worlds,
    dataPackCount: (w.dataPacks ?? []).length,
    nonDefaultGameRules: (w.gameRules ?? [])
      .filter((g: any) => g.worldValues && Object.keys(g.worldValues).length)
      .map((g: any) => ({ name: g.name, default: g.defaultValue, values: g.worldValues }))
      .slice(0, 20),
  };
}

/** ----- JVM flags / Aikar's flags ----- */
const AIKAR_FLAGS = [
  "-XX:+UseG1GC",
  "-XX:+ParallelRefProcEnabled",
  "-XX:+UnlockExperimentalVMOptions",
  "-XX:+AlwaysPreTouch",
  "-XX:G1NewSizePercent",
  "-XX:G1MaxNewSizePercent",
  "-XX:G1HeapRegionSize",
  "-XX:G1ReservePercent",
  "-XX:MaxGCPauseMillis",
];

/** Mask values of -D system properties whose name hints at a credential. vmArgs are
 * surfaced to the AI/context, and servers routinely pass DB passwords/tokens here. */
export function redactVmArgs(vmArgs: string): string {
  return vmArgs.replace(
    /(-D[^\s=]*(?:pass|password|secret|token|key|credential|pwd)[^\s=]*=)(\S+)/gi,
    (_m, p1) => `${p1}<redacted>`,
  );
}

export function jvmFlags(p: LoadedProfile) {
  const vmArgs: string = redactVmArgs(systemStats(p).java?.vmArgs ?? "");
  const xmx = vmArgs.match(/-Xmx(\d+)([kmgKMG])/);
  const xms = vmArgs.match(/-Xms(\d+)([kmgKMG])/);
  const usesG1 = /-XX:\+UseG1GC/.test(vmArgs);
  const usesZgc = /-XX:\+UseZGC/.test(vmArgs);
  const usesShenandoah = /-XX:\+UseShenandoahGC/.test(vmArgs);
  const presentAikar = AIKAR_FLAGS.filter((f) => vmArgs.includes(f));
  const missingAikar = AIKAR_FLAGS.filter((f) => !vmArgs.includes(f));
  return {
    vmArgs: vmArgs || undefined,
    xmx: xmx ? `${xmx[1]}${xmx[2].toUpperCase()}` : undefined,
    xms: xms ? `${xms[1]}${xms[2].toUpperCase()}` : undefined,
    gc: usesZgc ? "ZGC" : usesShenandoah ? "Shenandoah" : usesG1 ? "G1GC" : "default/other",
    aikarFlagsPresent: presentAikar.length,
    aikarFlagsTotal: AIKAR_FLAGS.length,
    aikarFlagsMissing: missingAikar,
    usesAikarFlags: presentAikar.length >= 6,
  };
}

/** ----- Server config highlights (view/simulation distance, spawn limits) ----- */
const HIGHLIGHT_KEYS = [
  "view-distance",
  "simulation-distance",
  "view distance",
  "simulation distance",
  "no-tick-view-distance",
  "spawn-limits",
  "spawn-limit",
  "ticks-per",
  "entity-tracking-range",
  "max-tick-time",
  "network-compression-threshold",
  "merge-radius",
];

export function configHighlights(p: LoadedProfile): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [file, raw] of Object.entries(serverConfigurations(p))) {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Some configs are stored as plain text (e.g. server.properties); scan lines.
      for (const line of String(raw).split(/\r?\n/)) {
        const m = line.match(/^([a-z0-9.\-]+)\s*=\s*(.+)$/i);
        if (m && HIGHLIGHT_KEYS.some((k) => m[1].toLowerCase().includes(k))) {
          out[`${file}:${m[1]}`] = m[2].trim();
        }
      }
      continue;
    }
    collectHighlights(parsed, file, out);
  }
  return out;
}

function collectHighlights(node: any, pathStr: string, out: Record<string, unknown>, depth = 0) {
  if (depth > 6 || node == null) return;
  if (typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    const key = k.toLowerCase();
    if (HIGHLIGHT_KEYS.some((h) => key.includes(h)) && typeof v !== "object") {
      out[`${pathStr}.${k}`] = v;
    } else if (typeof v === "object" && v !== null) {
      collectHighlights(v, `${pathStr}.${k}`, out, depth + 1);
    }
  }
}
