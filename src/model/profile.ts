import { createHash } from "node:crypto";
import { resolveInput } from "../parser/input.js";
import { decodeProfile, type SparkFileType } from "../parser/decode.js";

/**
 * A decoded spark file held in memory. `data` is the raw protobuf object (camelCase
 * fields, per spark.proto); the analysis layer reads it directly. Common metadata is
 * surfaced for convenience.
 */
export interface LoadedProfile {
  id: string;
  type: SparkFileType;
  label: string;
  data: any;
  /** SamplerMetadata / HeapMetadata / HealthMetadata */
  metadata: any;
}

/** Load a spark file from a source (file path, URL, or bytebin key) into a LoadedProfile. */
export async function loadProfile(source: string): Promise<LoadedProfile> {
  const { bytes, type, label } = await resolveInput(source);
  const { type: decodedType, data } = decodeProfile(bytes, type);
  const id = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  return { id, type: decodedType, label, data, metadata: data.metadata ?? {} };
}

/** ----- small shared helpers over the decoded object ----- */

export function platform(p: LoadedProfile): any {
  return p.metadata.platformMetadata ?? {};
}

export function systemStats(p: LoadedProfile): any {
  return p.metadata.systemStatistics ?? {};
}

export function platformStats(p: LoadedProfile): any {
  return p.metadata.platformStatistics ?? {};
}

/** map<string, PluginOrModMetadata> of plugins/mods present on the server. */
export function sources(p: LoadedProfile): Record<string, any> {
  return p.metadata.sources ?? {};
}

export function serverConfigurations(p: LoadedProfile): Record<string, string> {
  return p.metadata.serverConfigurations ?? {};
}

export function sumArray(arr: number[] | undefined): number {
  if (!arr || arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s;
}
