import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Loads the vendored spark .proto schemas (from lucko/spark) at runtime and decodes
 * the three spark binary formats. No protoc / codegen step — protobufjs reads the
 * .proto files directly.
 */

// proto/ sits at the package root, next to dist/ (and src/ when run via tsx).
const PROTO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "proto");

let cachedRoot: protobuf.Root | null = null;

function getRoot(): protobuf.Root {
  if (cachedRoot) return cachedRoot;
  const root = new protobuf.Root();
  // spark_*.proto files `import "spark/spark.proto"`; resolve every import relative
  // to PROTO_DIR so the `spark/` package directory layout is honoured.
  root.resolvePath = (_origin, target) =>
    path.isAbsolute(target) ? target : path.join(PROTO_DIR, target);
  root.loadSync([
    path.join(PROTO_DIR, "spark", "spark_sampler.proto"),
    path.join(PROTO_DIR, "spark", "spark_heap.proto"),
    // spark.proto is pulled in transitively and contains HealthData.
  ]);
  cachedRoot = root;
  return root;
}

/** The loaded protobuf Root (for advanced use / encoding test fixtures). */
export function sparkRoot(): protobuf.Root {
  return getRoot();
}

export type SparkFileType = "sampler" | "heap" | "health";

const TYPE_TO_MESSAGE: Record<SparkFileType, string> = {
  sampler: "spark.SamplerData",
  heap: "spark.HeapData",
  health: "spark.HealthData",
};

const CONTENT_TYPE_TO_TYPE: Record<string, SparkFileType> = {
  "application/x-spark-sampler": "sampler",
  "application/x-spark-heap": "heap",
  "application/x-spark-health": "health",
};

const EXT_TO_TYPE: Record<string, SparkFileType> = {
  ".sparkprofile": "sampler",
  ".sparkheap": "heap",
  ".sparkhealth": "health",
};

/** Best-effort detection of spark file type from a filename / URL hint or HTTP content-type. */
export function detectType(opts: { hint?: string; contentType?: string }): SparkFileType | null {
  const ct = opts.contentType?.split(";")[0]?.trim().toLowerCase();
  if (ct && CONTENT_TYPE_TO_TYPE[ct]) return CONTENT_TYPE_TO_TYPE[ct];
  if (opts.hint) {
    const ext = path.extname(opts.hint.split("?")[0]).toLowerCase();
    if (EXT_TO_TYPE[ext]) return EXT_TO_TYPE[ext];
  }
  return null;
}

/**
 * Decode spark protobuf bytes into a plain JS object.
 * If `type` is unknown, tries each message type and returns the first that yields
 * a populated `metadata` field (sampler/heap/health all carry one).
 */
export function decodeProfile(
  bytes: Uint8Array,
  type: SparkFileType | null,
): { type: SparkFileType; data: any } {
  const root = getRoot();
  const toObjectOpts: protobuf.IConversionOptions = {
    longs: Number,
    enums: String,
    defaults: false,
    arrays: true,
    objects: true,
    bytes: String,
  };

  // Distinctive top-level fields that disambiguate the three formats during a blind sniff.
  const distinctive: Record<SparkFileType, (o: any) => boolean> = {
    sampler: (o) => Array.isArray(o.threads) && o.threads.length > 0,
    heap: (o) => Array.isArray(o.entries) && o.entries.length > 0,
    health: (o) => o.timeWindowStatistics && Object.keys(o.timeWindowStatistics).length > 0,
  };

  const tryDecode = (t: SparkFileType, strict = false): any | null => {
    const Message = root.lookupType(TYPE_TO_MESSAGE[t]);
    try {
      const msg = Message.decode(bytes);
      const obj = Message.toObject(msg, toObjectOpts);
      // A valid spark file always has a metadata block.
      if (!obj || !obj.metadata || Object.keys(obj.metadata).length === 0) return null;
      // During a blind sniff, also require the format's distinctive field so a heap/health
      // file isn't mis-read as the (field-compatible) sampler message.
      if (strict && !distinctive[t](obj)) return null;
      return obj;
    } catch {
      return null;
    }
  };

  if (type) {
    const obj = tryDecode(type);
    if (obj) return { type, data: obj };
    throw new Error(`Failed to decode as ${type}: bytes are not a valid spark ${type} file.`);
  }

  // Unknown: sniff by trial. First pass requires the distinctive field; second pass is
  // lenient (e.g. an empty profile) and falls back to sampler.
  for (const t of ["sampler", "heap", "health"] as SparkFileType[]) {
    const obj = tryDecode(t, true);
    if (obj) return { type: t, data: obj };
  }
  for (const t of ["sampler", "heap", "health"] as SparkFileType[]) {
    const obj = tryDecode(t, false);
    if (obj) return { type: t, data: obj };
  }
  throw new Error("Could not decode bytes as any known spark format (sampler/heap/health).");
}
