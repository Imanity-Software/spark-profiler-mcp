import { sumArray } from "../model/profile.js";

/**
 * Spark stores each thread's call tree in a *flattened* form:
 *   ThreadNode.children      -> flat pool of every StackTraceNode in the thread
 *   ThreadNode.children_refs -> indices (into the pool) of the ROOT frames
 *   StackTraceNode.children_refs -> indices (into the same pool) of that node's children
 * A node's `times[]` is its TOTAL (inclusive) time per time-window, in milliseconds.
 * Self time = total(node) - Σ total(child).
 */

export interface ThreadView {
  name: string;
  pool: any[];
  rootRefs: number[];
  totalMs: number;
}

export interface TreeNode {
  name: string;
  className: string;
  methodName: string;
  line?: number;
  totalMs: number;
  totalPct: number;
  selfMs: number;
  selfPct: number;
  childrenCount: number;
  children?: TreeNode[];
  truncated?: boolean;
}

export function nodeTotal(n: any): number {
  return sumArray(n.times);
}

export function nodeLabel(n: any): string {
  const line = n.lineNumber ? `:${n.lineNumber}` : "";
  return `${n.className ?? "?"}.${n.methodName ?? "?"}${line}`;
}

/**
 * Native / library frames (async-profiler reports these as the JVM parks/waits or runs
 * native code). On an idle server thread these dominate self-time (the wait between
 * ticks), so they can be excluded to reveal the hottest *Java* methods.
 */
export function isNativeFrame(n: any): boolean {
  const c: string = n.className ?? "";
  const m: string = n.methodName ?? "";
  return (
    c === "native" ||
    c.startsWith("/") ||
    /\.so(\.\d+)*$/.test(c) ||
    c.includes(".so.") ||
    m.startsWith("/") ||
    m.includes(".so")
  );
}

/** Self-time (ms) spent in native/idle frames across a thread — a proxy for idle/wait. */
export function nativeSelfMs(view: ThreadView): number {
  return sumSelfWhere(view, isNativeFrame);
}

/** Sum the self-time (ms) of every frame matching a predicate. */
export function sumSelfWhere(view: ThreadView, test: (n: any) => boolean): number {
  let ms = 0;
  for (const n of view.pool) {
    if (n && test(n)) ms += nodeSelf(view.pool, n);
  }
  return ms;
}

/** Active (non-idle) main-thread time in ms. */
export function activeMs(view: ThreadView): number {
  return Math.max(0, view.totalMs - nativeSelfMs(view));
}

function childRefs(n: any): number[] {
  return n.childrenRefs ?? [];
}

export function nodeSelf(pool: any[], n: any): number {
  let self = nodeTotal(n);
  for (const r of childRefs(n)) {
    const c = pool[r];
    if (c) self -= nodeTotal(c);
  }
  return self < 0 ? 0 : self;
}

export function listThreads(data: any): { name: string; totalMs: number; nodes: number }[] {
  const threads: any[] = data.threads ?? [];
  return threads
    .map((t) => ({
      name: t.name ?? "(unnamed)",
      totalMs: sumArray(t.times),
      nodes: (t.children ?? []).length,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/** Pick a thread by name (case-insensitive). Default: "Server thread", else busiest. */
export function getThreadView(data: any, name?: string): ThreadView | null {
  const threads: any[] = data.threads ?? [];
  if (threads.length === 0) return null;
  let t: any;
  if (name) {
    t = threads.find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
    if (!t) t = threads.find((x) => (x.name ?? "").toLowerCase().includes(name.toLowerCase()));
  } else {
    t =
      threads.find((x) => x.name === "Server thread") ??
      [...threads].sort((a, b) => sumArray(b.times) - sumArray(a.times))[0];
  }
  if (!t) return null;
  const pool: any[] = t.children ?? [];
  const rootRefs: number[] = t.childrenRefs ?? [];
  // Prefer the thread's own times[]; fall back to summing the root frames.
  let totalMs = sumArray(t.times);
  if (totalMs === 0) {
    for (const r of rootRefs) if (pool[r]) totalMs += nodeTotal(pool[r]);
  }
  return { name: t.name ?? "(unnamed)", pool, rootRefs, totalMs };
}

/** Aggregate self-time by method across an entire thread. */
export function topSelfTime(
  view: ThreadView,
  topN: number,
  opts: { excludeNative?: boolean } = {},
): { method: string; selfMs: number; selfPct: number }[] {
  const agg = new Map<string, number>();
  for (const n of view.pool) {
    if (!n) continue;
    if (opts.excludeNative && isNativeFrame(n)) continue;
    const self = nodeSelf(view.pool, n);
    if (self <= 0) continue;
    const key = `${n.className ?? "?"}.${n.methodName ?? "?"}`;
    agg.set(key, (agg.get(key) ?? 0) + self);
  }
  // When native/idle is excluded, percentages are of ACTIVE time so they're meaningful.
  const total = (opts.excludeNative ? activeMs(view) : view.totalMs) || 1;
  return [...agg.entries()]
    .map(([method, selfMs]) => ({
      method,
      selfMs: Math.round(selfMs),
      selfPct: +((selfMs / total) * 100).toFixed(2),
    }))
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, topN);
}

function toTreeNode(pool: any[], idx: number, threadTotal: number): TreeNode {
  const n = pool[idx];
  const total = nodeTotal(n);
  const self = nodeSelf(pool, n);
  return {
    name: nodeLabel(n),
    className: n.className ?? "",
    methodName: n.methodName ?? "",
    line: n.lineNumber || undefined,
    totalMs: Math.round(total),
    totalPct: +((total / (threadTotal || 1)) * 100).toFixed(2),
    selfMs: Math.round(self),
    selfPct: +((self / (threadTotal || 1)) * 100).toFixed(2),
    childrenCount: childRefs(n).length,
  };
}

/**
 * Build a pruned drill-down tree. Children below `minPercent` of the thread total are
 * dropped; depth is capped at `maxDepth`. `rootPath` (array of "Class.method" labels or
 * substrings) descends into a specific subtree before expanding.
 */
export function buildTree(
  view: ThreadView,
  opts: { maxDepth: number; minPercent: number; rootPath?: string[] },
): { root: TreeNode[]; focus?: string } {
  const { pool, totalMs } = view;
  const minMs = (opts.minPercent / 100) * totalMs;

  const expand = (idx: number, depth: number): TreeNode => {
    const tn = toTreeNode(pool, idx, totalMs);
    const refs = childRefs(pool[idx]);
    if (depth >= opts.maxDepth) {
      if (refs.length) tn.truncated = true;
      return tn;
    }
    const kids = refs
      .map((r) => ({ r, total: nodeTotal(pool[r]) }))
      .filter((x) => pool[x.r] && x.total >= minMs)
      .sort((a, b) => b.total - a.total)
      .map((x) => expand(x.r, depth + 1));
    if (kids.length) tn.children = kids;
    else if (refs.length) tn.truncated = true;
    return tn;
  };

  // Find the first node (by descending self/total order) within the subtree of any of
  // `fromRefs` whose label matches `seg` (exact or case-insensitive substring).
  const findInSubtree = (fromRefs: number[], seg: string): number | undefined => {
    const segLc = seg.toLowerCase();
    const seen = new Set<number>();
    const stack = [...fromRefs];
    // Prefer a direct match in the frontier first.
    for (const r of fromRefs) {
      if (pool[r] && nodeLabel(pool[r]).toLowerCase().includes(segLc)) return r;
    }
    while (stack.length) {
      const r = stack.pop()!;
      if (seen.has(r) || !pool[r]) continue;
      seen.add(r);
      const lbl = nodeLabel(pool[r]).toLowerCase();
      if (lbl === segLc || lbl.includes(segLc)) return r;
      for (const c of childRefs(pool[r])) stack.push(c);
    }
    return undefined;
  };

  // Determine starting refs: either the thread roots, or descend rootPath.
  let startRefs = view.rootRefs.filter((r) => pool[r]);
  let focus: string | undefined;
  if (opts.rootPath && opts.rootPath.length) {
    let frontier = startRefs;
    let matched = -1;
    for (const seg of opts.rootPath) {
      const m = findInSubtree(frontier, seg);
      if (m === undefined) {
        throw new Error(
          `rootPath segment not found: "${seg}". Use search_call_tree to find an exact frame name.`,
        );
      }
      matched = m;
      focus = nodeLabel(pool[m]);
      frontier = childRefs(pool[m]).filter((r) => pool[r]);
    }
    // After descending, expand the matched node itself.
    return { root: [expand(matched, 0)], focus };
  }

  const root = startRefs
    .map((r) => ({ r, total: nodeTotal(pool[r]) }))
    .sort((a, b) => b.total - a.total)
    .map((x) => expand(x.r, 0));
  return { root };
}

/** Find frames whose class/method matches `pattern` (case-insensitive substring or /regex/). */
export function searchTree(
  view: ThreadView,
  pattern: string,
  limit: number,
): { method: string; line?: number; totalMs: number; totalPct: number; selfMs: number }[] {
  let test: (s: string) => boolean;
  const m = pattern.match(/^\/(.*)\/([a-z]*)$/);
  if (m) {
    const re = new RegExp(m[1], m[2].includes("i") ? "i" : "i");
    test = (s) => re.test(s);
  } else {
    const p = pattern.toLowerCase();
    test = (s) => s.toLowerCase().includes(p);
  }
  const results: { method: string; line?: number; totalMs: number; totalPct: number; selfMs: number }[] =
    [];
  for (const n of view.pool) {
    if (!n) continue;
    const label = nodeLabel(n);
    if (test(label)) {
      results.push({
        method: `${n.className ?? "?"}.${n.methodName ?? "?"}`,
        line: n.lineNumber || undefined,
        totalMs: Math.round(nodeTotal(n)),
        totalPct: +((nodeTotal(n) / (view.totalMs || 1)) * 100).toFixed(2),
        selfMs: Math.round(nodeSelf(view.pool, n)),
      });
    }
  }
  return results.sort((a, b) => b.totalMs - a.totalMs).slice(0, limit);
}
