import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { detectType, type SparkFileType } from "./decode.js";

const BYTEBIN_HOST = "https://bytebin.lucko.me";
// A bytebin key is a short alphanumeric token, e.g. "xRoFP2RKwh".
const BYTEBIN_KEY_RE = /^[a-zA-Z0-9]{6,16}$/;
const SPARK_CONTENT_TYPES = [
  "application/x-spark-sampler",
  "application/x-spark-heap",
  "application/x-spark-health",
];

export interface ResolvedInput {
  bytes: Uint8Array;
  type: SparkFileType | null;
  label: string;
}

/** GZIP magic number. Profiles fetched from bytebin (or shared online) are gzip-compressed. */
function maybeGunzip(buf: Buffer): Buffer {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return gunzipSync(buf);
  }
  return buf;
}

function asBytebinUrl(source: string): string | null {
  let s = source.trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      // spark.lucko.me/<key> is the viewer; the data lives at bytebin.lucko.me/<key>.
      if (u.hostname === "spark.lucko.me" || u.hostname === "www.spark.lucko.me") {
        const key = u.pathname.replace(/^\/+/, "").split("/")[0];
        return key ? `${BYTEBIN_HOST}/${key}` : null;
      }
      return s; // assume it is already a direct (bytebin or other) URL
    } catch {
      return null;
    }
  }
  // Bare bytebin key.
  if (BYTEBIN_KEY_RE.test(s)) return `${BYTEBIN_HOST}/${s}`;
  return null;
}

/**
 * Resolve a user-supplied source (local file path, bytebin URL, spark.lucko.me URL,
 * or bare bytebin key) into raw, decompressed spark protobuf bytes + a detected type.
 */
export async function resolveInput(source: string): Promise<ResolvedInput> {
  // 1. Local file takes priority if it exists on disk.
  if (existsSync(source)) {
    const buf = maybeGunzip(await readFile(source));
    return { bytes: buf, type: detectType({ hint: source }), label: source };
  }

  // 2. URL / bytebin key.
  const url = asBytebinUrl(source);
  if (url) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "spark-profiler-mcp",
        // Match the spark-viewer: advertise the spark content types so bytebin serves
        // the stored object. (undici auto-decompresses Content-Encoding: gzip; if the
        // body is raw gzip with no header, maybeGunzip handles it below.)
        Accept: SPARK_CONTENT_TYPES.join(","),
      },
      redirect: "follow",
    });
    if (!res.ok) {
      const hint =
        res.status === 404
          ? " The profile may have expired — spark share links (spark.lucko.me/<key>) are stored temporarily on bytebin and are deleted after a while. Re-run /spark profiler and use the fresh link, or load a saved .sparkprofile file."
          : "";
      throw new Error(`Failed to fetch ${url}: HTTP ${res.status} ${res.statusText}.${hint}`);
    }
    const contentType = res.headers.get("content-type") ?? undefined;
    const buf = maybeGunzip(Buffer.from(await res.arrayBuffer()));
    return { bytes: buf, type: detectType({ hint: url, contentType }), label: url };
  }

  throw new Error(
    `Source not found: "${source}". Provide a local file path, a bytebin/spark.lucko.me URL, or a bytebin key.`,
  );
}
