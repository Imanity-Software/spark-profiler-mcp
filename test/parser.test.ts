import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { loadProfile } from "../src/model/profile.js";
import {
  getThreadView,
  listThreads,
  topSelfTime,
  searchTree,
  buildTree,
} from "../src/analysis/callTree.js";
import { sourcesBreakdown } from "../src/analysis/sources.js";
import { platformInfo, platformHealth, gcAnalysis } from "../src/analysis/stats.js";
import { diagnose } from "../src/analysis/diagnose.js";

const FILE = "example.sparkprofile";
const has = existsSync(FILE);
const d = has ? describe : describe.skip;

d("decode example.sparkprofile", () => {
  it("parses metadata correctly", async () => {
    const p = await loadProfile(FILE);
    expect(p.type).toBe("sampler");
    const pi = platformInfo(p);
    expect(pi.brand).toBe("Paper");
    expect(pi.minecraftVersion).toBe("1.21.5");
    expect(p.metadata.numberOfTicks).toBe(6008);
    expect(p.data.threads.length).toBe(107);
    expect(Object.keys(p.metadata.sources).length).toBe(26);
    expect(Object.keys(p.data.classSources).length).toBe(537);
  });

  it("builds the flattened call tree (Server thread)", async () => {
    const p = await loadProfile(FILE);
    const view = getThreadView(p.data)!;
    expect(view.name).toBe("Server thread");
    expect(view.pool.length).toBeGreaterThan(10000);
    expect(view.totalMs).toBeGreaterThan(0);
    // The main loop should be present and dominate total time.
    const runServer = searchTree(view, "MinecraftServer.runServer", 1)[0];
    expect(runServer).toBeTruthy();
    expect(runServer.totalPct).toBeGreaterThan(90);
    // Drill-down into the tick loop resolves a focus node.
    const tree = buildTree(view, { maxDepth: 2, minPercent: 1, rootPath: ["tickChildren"] });
    expect(tree.focus).toContain("tickChildren");
  });

  it("computes health metrics", async () => {
    const p = await loadProfile(FILE);
    const ph = platformHealth(p);
    expect(ph.tps.last1m).toBeCloseTo(20, 1);
    expect(ph.mspt.last1m!.median).toBeGreaterThan(0);
    expect(ph.heap.usedMb).toBeGreaterThan(0);
    expect(gcAnalysis(p).collectors.length).toBeGreaterThan(0);
  });

  it("redacts secrets from JVM args", async () => {
    const { systemSummary } = await import("../src/analysis/stats.js");
    const p = await loadProfile(FILE);
    const ss = systemSummary(p) as any;
    expect(ss.vmArgs).toContain("-DmongoKeyPass=<redacted>");
    expect(ss.vmArgs).not.toContain("wl8h39iMiKP0hnX9"); // the real password value
    expect(ss.vmArgs).toContain("-Xmx4G"); // non-secret flags are preserved
  });

  it("diagnoses the spike and flag findings", async () => {
    const p = await loadProfile(FILE);
    const dg = diagnose(p);
    const ids = dg.findings.map((f) => f.id);
    expect(ids).toContain("mspt_spiky"); // 147ms max vs ~4ms median
    expect(ids).toContain("aikar_flags");
    expect(dg.findings.every((f) => f.action && f.evidence)).toBe(true);
  });

  it("top self time excludes native idle and uses active denominator", async () => {
    const p = await loadProfile(FILE);
    const view = getThreadView(p.data)!;
    const top = topSelfTime(view, 5, { excludeNative: true });
    expect(top.length).toBeGreaterThan(0);
    expect(top[0].method).not.toContain("libc");
    const sb = sourcesBreakdown(p.data, view, 5, { excludeNative: true });
    expect(sb.length).toBeGreaterThan(0);
  });
});
