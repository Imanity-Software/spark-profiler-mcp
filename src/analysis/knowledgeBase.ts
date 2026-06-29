/**
 * Interpretation knowledge base: thresholds + frame signatures used by the diagnose
 * engine. Sourced from spark docs/community practice (Aikar's flags, view/sim-distance,
 * TPS/MSPT/GC health bands). Tuning these in one place keeps the rules engine honest.
 */

export type Severity = "critical" | "warning" | "info" | "ok";

export const THRESHOLDS = {
  tps: { warning: 19.5, critical: 15 }, // below these
  msptMedian: { warning: 50, critical: 100 }, // above these (ms)
  msptSpikeMax: 100, // p95/max above this with healthy median => spiky
  gcPct: { warning: 5, critical: 15 }, // % of wall-clock in GC
  gcPauseAvgMs: { warning: 150, critical: 300 }, // avg pause per collection
  heapPct: { warning: 80, critical: 92 }, // heap used / max
  physicalMemPct: { warning: 90, critical: 97 },
  cpuProcessPct: { warning: 85, critical: 96 },
  sourceDominancePct: 30, // single plugin/mod % of ACTIVE main-thread time
  signatureActivePct: 15, // a category > this % of active main-thread time is notable
  viewDistanceHigh: 12,
  simulationDistanceHigh: 10,
} as const;

/** Frame signatures: category -> substrings matched against "Class.method" labels. */
export const SIGNATURES: { id: string; label: string; patterns: string[]; advice: string }[] = [
  {
    id: "chunk_gen",
    label: "Chunk loading / world generation",
    patterns: [
      "worldgen",
      "chunk.generat",
      "chunkgenerat",
      "noisechunk",
      "ChunkMap.",
      "ChunkHolder",
      "ServerChunkCache",
      "chunk.status",
      "PoiManager",
    ],
    advice:
      "Lower view-distance/simulation-distance, pre-generate the world (e.g. Chunky), and avoid teleport/elytra-induced chunk floods. Keep no-tick-view-distance modest.",
  },
  {
    id: "entity_tick",
    label: "Entity ticking / mob AI",
    patterns: [
      "Entity.tick",
      "tickNonPassenger",
      "tickPassenger",
      "aiStep",
      "Mob.",
      "PathNavigation",
      "PathFinder",
      "Goal.",
      "Brain.",
      "EntitySection",
      "LivingEntity.tick",
      "Sensor.",
    ],
    advice:
      "Reduce mob spawn limits (bukkit.yml spawn-limits), lower simulation-distance, cap per-chunk/entity counts, and review farms. Paper's entity activation/tracking ranges help.",
  },
  {
    id: "redstone",
    label: "Redstone",
    patterns: ["Redstone", "Comparator", "Repeater", "RedStoneWire", "updateNeighbor", "updatePower"],
    advice:
      "Audit large redstone contraptions / clocks; Paper's redstone implementation options and reducing update-heavy machines lowers this.",
  },
  {
    id: "main_thread_io",
    label: "Blocking I/O on the main thread",
    patterns: [
      "java.sql",
      "jdbc",
      "mongo",
      "Socket.read",
      "SocketInputStream",
      "FileInputStream.read",
      "FileOutputStream.write",
      "HttpURLConnection",
      "okhttp",
      "DriverManager",
    ],
    advice:
      "Move database/network/file work off the server thread (async). A plugin doing synchronous SQL/HTTP during ticks is a common, fixable stall source.",
  },
  {
    id: "world_save",
    label: "World saving",
    patterns: [
      "ChunkSerializer",
      "SectionStorage.write",
      "RegionFile",
      "ChunkMap.save",
      "level.save",
      "IOWorker",
    ],
    advice:
      "If save spikes correlate with lag, stagger/auto-save tuning helps; on Paper most chunk I/O is already async via IOWorker.",
  },
  {
    id: "pathfinding",
    label: "Pathfinding",
    patterns: ["PathFinder", "PathNavigation", "Node.", "NodeEvaluator", "findPath"],
    advice:
      "Heavy pathfinding usually means too many mobs or mobs targeting players across distance; reduce mob counts / activation range.",
  },
];

export function severityRank(s: Severity): number {
  return { critical: 0, warning: 1, info: 2, ok: 3 }[s];
}

export function bandAbove(value: number, t: { warning: number; critical: number }): Severity {
  if (value >= t.critical) return "critical";
  if (value >= t.warning) return "warning";
  return "ok";
}

export function bandBelow(value: number, t: { warning: number; critical: number }): Severity {
  if (value <= t.critical) return "critical";
  if (value <= t.warning) return "warning";
  return "ok";
}

/** Aikar's recommended G1GC flags, for advice output. */
export const AIKAR_FLAGS_REFERENCE = [
  "-XX:+UseG1GC",
  "-XX:+ParallelRefProcEnabled",
  "-XX:MaxGCPauseMillis=200",
  "-XX:+UnlockExperimentalVMOptions",
  "-XX:+DisableExplicitGC",
  "-XX:+AlwaysPreTouch",
  "-XX:G1NewSizePercent=30",
  "-XX:G1MaxNewSizePercent=40",
  "-XX:G1HeapRegionSize=8M",
  "-XX:G1ReservePercent=20",
  "-XX:G1HeapWastePercent=5",
  "-XX:G1MixedGCCountTarget=4",
  "-XX:InitiatingHeapOccupancyPercent=15",
  "-XX:G1MixedGCLiveThresholdPercent=90",
  "-XX:G1RSetUpdatingPauseTimePercent=5",
  "-XX:SurvivorRatio=32",
  "-XX:+PerfDisableSharedMem",
  "-XX:MaxTenuringThreshold=1",
];
