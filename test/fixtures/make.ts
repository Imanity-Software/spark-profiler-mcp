import { sparkRoot } from "../../src/parser/decode.js";

/**
 * Build synthetic .sparkhealth / .sparkheap protobuf bytes for tests. These mirror what
 * `/spark health` and `/spark heapsummary` produce, with deliberately UNHEALTHY values so
 * the diagnose engine has something to flag.
 */

const platformMetadata = {
  type: 0,
  name: "Paper",
  version: "1.21.4-120",
  minecraftVersion: "1.21.4",
  sparkVersion: 2,
  brand: "Paper",
};

const systemStatistics = {
  cpu: {
    threads: 8,
    processUsage: { last1m: 0.97, last15m: 0.95 },
    systemUsage: { last1m: 0.98, last15m: 0.96 },
    modelName: "Test CPU @ 3.5GHz",
  },
  memory: {
    physical: { used: 31_500_000_000, total: 32_000_000_000 }, // ~98% host RAM
    swap: { used: 2_000_000_000, total: 8_000_000_000 },
  },
  gc: { "G1 Young Generation": { total: 4000, avgTime: 180, avgFrequency: 800 } },
  disk: { used: 400_000_000_000, total: 500_000_000_000 },
  os: { arch: "amd64", name: "Linux", version: "6.2.0" },
  java: {
    vendor: "Eclipse Adoptium",
    version: "21.0.1",
    vmArgs: "-Xms2G -Xmx4G -XX:MaxGCPauseMillis=50 -DdbPassword=supersecret123 -Dname=test",
  },
  jvm: { name: "OpenJDK 64-Bit Server VM", vendor: "Adoptium", version: "21.0.1+12" },
  uptime: 600_000,
};

const platformStatistics = {
  memory: { heap: { used: 3_900_000_000, committed: 4_000_000_000, max: 4_000_000_000 } }, // ~98% heap
  gc: { "G1 Young Generation": { total: 4000, avgTime: 180, avgFrequency: 800 } },
  uptime: 600_000,
  tps: { last1m: 11.5, last5m: 14.0, last15m: 17.5, gameTargetTps: 20 },
  mspt: {
    last1m: { mean: 95, max: 420, min: 40, median: 88, percentile95: 160 },
    last5m: { mean: 70, max: 420, min: 35, median: 62, percentile95: 130 },
    gameMaxIdealMspt: 50,
  },
  ping: { last15m: { mean: 60, max: 120, min: 20, median: 55, percentile95: 100 } },
  playerCount: 40,
  world: {
    totalEntities: 9000,
    entityCounts: {
      "minecraft:zombie": 3500,
      "minecraft:item": 2800,
      "minecraft:armor_stand": 1200,
      "minecraft:villager": 900,
    },
    worlds: [{ name: "world", totalEntities: 7000, regions: [] }],
  },
  onlineMode: 2,
};

const sharedMetaTail = {
  generatedTime: 1_700_000_000_000,
  serverConfigurations: {
    "server.properties": "view-distance=16\nsimulation-distance=12\nmax-players=60",
  },
  sources: { laggyplugin: { name: "laggyplugin", version: "3.2.1" } },
};

export function makeHealthBytes(): Uint8Array {
  const HealthData = sparkRoot().lookupType("spark.HealthData");
  const obj = {
    metadata: {
      creator: { type: 1, name: "admin", uniqueId: "00000000-0000-0000-0000-000000000001" },
      platformMetadata,
      platformStatistics,
      systemStatistics,
      ...sharedMetaTail,
    },
    timeWindowStatistics: {
      // a healthy minute and a badly degraded minute
      "29712320": { ticks: 1200, cpuProcess: 0.4, cpuSystem: 0.5, tps: 19.9, msptMedian: 42, msptMax: 95, players: 38, entities: 8200, tileEntities: 400, chunks: 1500, duration: 60000 },
      "29712321": { ticks: 700, cpuProcess: 0.98, cpuSystem: 0.99, tps: 11.2, msptMedian: 89, msptMax: 420, players: 40, entities: 9000, tileEntities: 520, chunks: 1600, duration: 60000 },
    },
  };
  return HealthData.encode(HealthData.fromObject(obj)).finish();
}

export function makeHeapBytes(): Uint8Array {
  const HeapData = sparkRoot().lookupType("spark.HeapData");
  const obj = {
    metadata: {
      creator: { type: 1, name: "admin", uniqueId: "00000000-0000-0000-0000-000000000001" },
      platformMetadata,
      platformStatistics,
      systemStatistics,
      ...sharedMetaTail,
    },
    entries: [
      { order: 1, instances: 1_500_000, size: 520_000_000, type: "byte[]" },
      { order: 2, instances: 60_000, size: 240_000_000, type: "net.minecraft.world.entity.monster.Zombie" },
      { order: 3, instances: 900_000, size: 130_000_000, type: "java.lang.String" },
      { order: 4, instances: 12_000, size: 40_000_000, type: "com.laggyplugin.BigCache$Entry" },
    ],
  };
  return HeapData.encode(HeapData.fromObject(obj)).finish();
}
