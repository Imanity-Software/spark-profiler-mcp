# spark-profiler-mcp

[![npm](https://img.shields.io/npm/v/spark-profiler-mcp)](https://www.npmjs.com/package/spark-profiler-mcp)
[![CI](https://github.com/Imanity-Software/spark-profiler-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Imanity-Software/spark-profiler-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/spark-profiler-mcp)](https://www.npmjs.com/package/spark-profiler-mcp)
[![license](https://img.shields.io/npm/l/spark-profiler-mcp)](LICENSE)

[MCP](https://modelcontextprotocol.io) server that reads [spark](https://spark.lucko.me) profiler files so an AI can give **accurate Minecraft server tuning advice**.

Parses spark's binary protobuf directly: no upload, no protoc. Ships a **diagnose** engine that knows TPS/MSPT/GC/heap thresholds and call-tree signatures (entity ticking, chunk gen, redstone, blocking I/O, plugin hogs, JVM flags), returns ranked findings with concrete fixes.

## Supported files

| File | spark command | Contents |
|------|---------------|----------|
| `.sparkprofile` | `/spark profiler --stop` | Sampler / call tree |
| `.sparkheap`    | `/spark heapsummary --save-to-file` | Memory (top retained types) |
| `.sparkhealth`  | `/spark health --save-to-file` | TPS/MSPT/CPU/entities over time |

Input = local path, `https://spark.lucko.me/<key>` / bytebin URL, or bare bytebin key. gzip and raw protobuf both auto-handled.

> Shared `spark.lucko.me` links expire (bytebin deletes them). For permanent analysis, `--save-to-file`.

Most tools (`diagnose`, `get_summary`, `get_platform_info`, `get_system_stats`, `get_health`) work on sampler **and** health files. `.sparkheap` → `get_heap_summary`. Call-tree tools = sampler only.

## Install (one line)

Published to npm — no clone, no build; `npx` fetches and runs it:

```bash
claude mcp add spark-profiler -- npx -y spark-profiler-mcp
```

Same thing as an MCP client config block (`.mcp.json` / `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "spark-profiler": { "command": "npx", "args": ["-y", "spark-profiler-mcp"] }
  }
}
```

Then ask: *"Load this.sparkprofile and tell me what to tune."* The assistant calls `load_profile` → `diagnose` → drills in.

### From source (dev / unpublished)

```bash
npm install && npm run build
claude mcp add spark-profiler -- node /absolute/path/to/spark-profiler-mcp/dist/index.js
```

## Tools

| Tool | Purpose |
|------|---------|
| `load_profile(source)` | Parse file/URL/key → `profileId` + headline. |
| `get_summary` | Version, TPS, MSPT, heap, GC%, entities, hot methods, top plugins, verdict. |
| `diagnose` | **Ranked findings**: evidence → diagnosis → action. |
| `get_platform_info` | Brand/version, plugins, config highlights (view/sim-distance, spawn limits). |
| `get_system_stats` | Host CPU/RAM/disk/OS, Java, JVM args (secrets redacted), GC, Aikar check. |
| `get_health` | TPS 1/5/15m, MSPT percentiles, ping, heap, per-minute time-series (`.sparkhealth`). |
| `get_world_stats` | Entities, top types, per-world totals, data packs, game rules. |
| `list_threads` | Sampled threads, busiest first. |
| `get_top_self_time` | Hottest methods by self time (idle/native excluded). |
| `get_sources_breakdown` | Self-time per plugin/mod. |
| `get_call_tree` | Pruned tree. `rootPath` jumps to any frame. |
| `search_call_tree` | Find frames by substring or `/regex/`. |
| `get_heap_summary` | `.sparkheap`: largest retained types. |

**Token-cheap by design.** Outputs = summaries + top-N. Full call tree never dumped. Reach it via `get_call_tree` (depth + `minPercent` capped) and `search_call_tree`. Parsed once, cached by `profileId`.

## How it reads spark files

- Vendored `proto/spark/*.proto` (from [lucko/spark](https://github.com/lucko/spark)) loaded at runtime by `protobufjs`: no codegen.
- `.sparkprofile` = `SamplerData`. Each thread = flattened call tree: `ThreadNode.children` is a flat pool, `children_refs` rebuild it. Self time = node total − Σ children. Native/idle frames flagged so the *active* hot path shows.
- `vmArgs` surfaced for JVM analysis. Credential-like `-D` props redacted.

## Development

```bash
npm run dev        # run from source (tsx)
npm test           # vitest: decode example, check analysis + diagnosis
npm run smoke      # end-to-end over stdio
npm run inspector  # @modelcontextprotocol/inspector
```

## Publishing (maintainer)

Releases are automated via GitHub Actions + **npm Trusted Publishing** (OIDC) — no npm token is
stored anywhere. One-time setup on npmjs.com: the package → **Settings → Trusted Publisher** →
GitHub Actions, with Organization `Imanity-Software`, Repository `spark-profiler-mcp`, Workflow
`publish.yml`. Then to cut a release:

```bash
# bump "version" in package.json, then:
git tag v0.1.1 && git push origin v0.1.1
```

`.github/workflows/publish.yml` builds, tests, and runs `npm publish` authenticated by OIDC, with
**provenance generated automatically**. (Needs Node ≥ 22.14 + npm ≥ 11.5.1; the workflow upgrades
npm itself.)

`files` ships only `dist/` + `proto/` (schemas are loaded at runtime, so they must be included);
the 24 MB example and tests are excluded.

Manual fallback (no provenance): `npm login && npm publish` — `prepublishOnly` builds + tests first.

Prefer not to use npm at all? `npx -y github:Imanity-Software/spark-profiler-mcp` also works — the
`prepare` hook builds it on install.

## License

MIT. spark is © lucko, GPLv3. Only its `.proto` schemas are vendored here.
