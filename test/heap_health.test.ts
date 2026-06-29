import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeHealthBytes, makeHeapBytes } from "./fixtures/make.js";
import { loadProfile } from "../src/model/profile.js";
import { platformInfo, windowStats, systemSummary, worldSummary } from "../src/analysis/stats.js";
import { diagnose } from "../src/analysis/diagnose.js";

let healthPath: string;
let heapPath: string;

beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "spark-fix-"));
  healthPath = path.join(dir, "test.sparkhealth");
  heapPath = path.join(dir, "test.sparkheap");
  writeFileSync(healthPath, makeHealthBytes());
  writeFileSync(heapPath, makeHeapBytes());
});

describe(".sparkhealth", () => {
  it("decodes as health with platform + windows", async () => {
    const p = await loadProfile(healthPath);
    expect(p.type).toBe("health");
    expect(platformInfo(p).brand).toBe("Paper");
    const ws = windowStats(p);
    expect(ws.available).toBe(true);
    if (ws.available) {
      expect(ws.count).toBe(2);
      expect(ws.tpsMin).toBeCloseTo(11.2, 1);
      expect(ws.worstMsptWindow?.msptMax).toBeCloseTo(420, 0);
    }
  });

  it("redacts JVM secrets and reads world stats", async () => {
    const p = await loadProfile(healthPath);
    const ss = systemSummary(p) as any;
    expect(ss.vmArgs).toContain("-DdbPassword=<redacted>");
    expect(ss.vmArgs).not.toContain("supersecret123");
    const w = worldSummary(p);
    expect(w.available).toBe(true);
    if (w.available) expect(w.totalEntities).toBe(9000);
  });

  it("diagnoses the unhealthy server", async () => {
    const p = await loadProfile(healthPath);
    const d = diagnose(p);
    expect(d.overall).toBe("critical");
    const ids = d.findings.map((f) => f.id);
    expect(ids).toContain("tps_low");
    expect(ids).toContain("mspt_high");
    expect(ids).toContain("window_degraded");
    expect(ids).toContain("host_mem");
    expect(ids).toContain("cpu_high");
    expect(ids).toContain("heap_high");
    expect(ids).toContain("sim_distance");
    // every finding is actionable
    expect(d.findings.every((f) => f.action && f.evidence && f.diagnosis)).toBe(true);
  });
});

describe(".sparkheap", () => {
  it("decodes as heap and summarizes largest types", async () => {
    const p = await loadProfile(heapPath);
    expect(p.type).toBe("heap");
    const entries: any[] = p.data.entries;
    expect(entries.length).toBe(4);
    const top = [...entries].sort((a, b) => b.size - a.size)[0];
    expect(top.type).toBe("byte[]");
  });

  it("diagnoses heap with top consumers", async () => {
    const p = await loadProfile(heapPath);
    const d = diagnose(p);
    expect(d.profileType).toBe("heap");
    expect(d.headline).toMatch(/MB retained/);
    expect(d.findings.length).toBeGreaterThan(0);
    expect(d.findings[0].title).toContain("byte[]");
  });
});
