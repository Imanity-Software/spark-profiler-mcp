# spark-profiler-mcp

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

## Install

```bash
npm install
npm run build
```

## Use with Claude Code

```bash
claude mcp add spark-profiler -- node /absolute/path/to/spark-profiler-mcp/dist/index.js
```

Or in an MCP client config (`.mcp.json` / `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "spark-profiler": {
      "command": "node",
      "args": ["/absolute/path/to/spark-profiler-mcp/dist/index.js"]
    }
  }
}
```

Then ask: *"Load example.sparkprofile and tell me what to tune."* Assistant calls `load_profile` → `diagnose` → drills in.

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

## License

MIT. spark is © lucko, GPLv3. Only its `.proto` schemas are vendored here.
