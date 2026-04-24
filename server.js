#!/usr/bin/env node
// ROCm GPU Monitor MCP server for Claude Desktop (Linux + AMD GPUs).
// Pure Node, no npm deps. Shells out to rocm-smi (and optionally amdgpu_top).
// Strictly read-only: no process killing, no clock/power overrides, no fan control.
// https://github.com/LukeLamb/claude-rocm-mcp — MIT License.

'use strict';

const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

// ─── System-dep discovery ────────────────────────────────────────────────
function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
const BIN = {
  rocmSmi: which('rocm-smi'),
  amdgpuTop: which('amdgpu_top'),
  dpkg: which('dpkg'),
  lsmod: which('lsmod'),
};

// ─── Logging (stderr) ─────────────────────────────────────────────────────
function log(...args) {
  try {
    process.stderr.write('[rocm-mcp] ' + args.map(a =>
      typeof a === 'string' ? a : JSON.stringify(a)
    ).join(' ') + '\n');
  } catch (_) {}
}

// ─── JSON-RPC plumbing ────────────────────────────────────────────────────
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }
function error(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined && { data }) } });
}
function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}
function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function requireRocmSmi() {
  if (!BIN.rocmSmi) {
    return 'rocm-smi is not installed. Install with: sudo apt install rocm-smi (or a full ROCm stack). See https://rocm.docs.amd.com/ for installation options.';
  }
  return null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    child.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    child.stderr.on('data', (d) => { err = Buffer.concat([err, d]); });
    child.stdin.end();
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }));
    child.on('close', (code) => resolve({
      code,
      stdout: out.toString('utf8'),
      stderr: err.toString('utf8'),
    }));
  });
}

// rocm-smi prints "WARNING: No JSON data to report" to stdout when a query
// returns no data (e.g. unsupported metric on a given card). Detect that
// and return null so callers can distinguish "nothing to report" from a
// real parse failure.
function parseRocmJson(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return null;
  if (/No JSON data to report/i.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return null;
  }
}

// Extract a numeric value from a rocm-smi string field. Returns null for
// "N/A", empty, or non-numeric values.
function numOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s || s === 'N/A' || s === 'None' || s.toLowerCase() === 'nan') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Object.keys filtered to card* entries. rocm-smi JSON uses "card0", "card1", ...
// as top-level keys alongside a "system" key.
function cardKeys(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj).filter((k) => /^card\d+$/i.test(k)).sort();
}

// ─── Tool: gpu_status ─────────────────────────────────────────────────────
async function gpuStatus() {
  const missing = requireRocmSmi();
  if (missing) return errorResult(missing);

  const r = await run(BIN.rocmSmi, ['-a', '--json']);
  if (r.code !== 0 && !r.stdout) {
    return errorResult(`rocm-smi failed (code ${r.code}): ${r.stderr || 'no output'}`);
  }
  const data = parseRocmJson(r.stdout);
  if (!data) return errorResult(`rocm-smi returned no parseable JSON. stderr: ${r.stderr || '<empty>'}`);

  // VRAM in bytes needs a separate call — showallinfo only gives VRAM %.
  const vramRaw = parseRocmJson((await run(BIN.rocmSmi, ['--showmeminfo', 'vram', '--json'])).stdout) || {};

  const cards = cardKeys(data).map((k) => {
    const c = data[k];
    const v = vramRaw[k] || {};
    return {
      card: k,
      name: c['Card Series'] || c['Card Model'] || c['Device Name'] || null,
      gfx_version: c['GFX Version'] || null,
      pci_bus: c['PCI Bus'] || null,
      utilization_percent: numOrNull(c['GPU use (%)']),
      vram_percent: numOrNull(c['GPU Memory Allocated (VRAM%)']),
      vram_used_bytes: numOrNull(v['VRAM Total Used Memory (B)']),
      vram_total_bytes: numOrNull(v['VRAM Total Memory (B)']),
      temp_edge_c: numOrNull(c['Temperature (Sensor edge) (C)']),
      temp_junction_c: numOrNull(c['Temperature (Sensor junction) (C)']),
      temp_memory_c: numOrNull(c['Temperature (Sensor memory) (C)']),
      power_avg_w: numOrNull(c['Average Graphics Package Power (W)']),
      power_max_w: numOrNull(c['Max Graphics Package Power (W)']),
      fan_percent: numOrNull(c['Fan speed (%)']),
      fan_rpm: numOrNull(c['Fan RPM']),
    };
  });

  return textResult({
    timestamp: new Date().toISOString(),
    card_count: cards.length,
    cards,
  });
}

// ─── Tool: gpu_metrics ────────────────────────────────────────────────────
async function gpuMetrics() {
  const missing = requireRocmSmi();
  if (missing) return errorResult(missing);

  const r = await run(BIN.rocmSmi, ['-a', '--json']);
  if (r.code !== 0 && !r.stdout) {
    return errorResult(`rocm-smi failed (code ${r.code}): ${r.stderr || 'no output'}`);
  }
  const data = parseRocmJson(r.stdout);
  if (!data) return errorResult(`rocm-smi returned no parseable JSON. stderr: ${r.stderr || '<empty>'}`);

  return textResult({
    timestamp: new Date().toISOString(),
    source: 'rocm-smi -a --json',
    data,
  });
}

// ─── Tool: gpu_processes ──────────────────────────────────────────────────
async function gpuProcesses() {
  const missing = requireRocmSmi();
  if (missing) return errorResult(missing);

  const r = await run(BIN.rocmSmi, ['--showpids', '--json']);
  const data = parseRocmJson(r.stdout);

  // When no processes are running, rocm-smi emits "No JSON data to report"
  // or a non-JSON human-readable "No KFD PIDs currently running". Both
  // legitimately mean: the process list is empty.
  if (!data) {
    return textResult({
      timestamp: new Date().toISOString(),
      processes: [],
      note: 'No GPU compute processes currently running (or rocm-smi reports no data on this card).',
    });
  }

  // rocm-smi --showpids --json emits one of two shapes depending on version:
  //   (a) {"system": {"PID19971": "python, 1, 1139888128, 0, unknown"}, ...}
  //   (b) {"system": {"19971": {"GPU use": "...", "VRAM": "...", ...}}, ...}
  // The CSV string in (a) is:
  //   "<process_name>, <gpu_count>, <vram_bytes>, <sdma_bytes>, <cu_occupancy>"
  const PID_KEY_RE = /^(?:PID)?(\d+)$/;
  const processes = [];
  for (const [k, v] of Object.entries(data)) {
    if (!v || typeof v !== 'object') continue;
    for (const [rawKey, info] of Object.entries(v)) {
      const m = rawKey.match(PID_KEY_RE);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      let entry;
      if (typeof info === 'string') {
        const parts = info.split(',').map((s) => s.trim());
        const [process_name, gpu_count, vram_bytes, sdma_bytes, cu_occupancy] = parts;
        entry = {
          pid,
          scope: k,
          process_name: process_name ?? null,
          gpu_count: gpu_count !== undefined ? parseInt(gpu_count, 10) : null,
          vram_bytes: vram_bytes !== undefined ? parseInt(vram_bytes, 10) : null,
          sdma_bytes: sdma_bytes !== undefined ? parseInt(sdma_bytes, 10) : null,
          cu_occupancy: cu_occupancy && cu_occupancy.toLowerCase() !== 'unknown'
            ? cu_occupancy
            : null,
        };
      } else if (info && typeof info === 'object') {
        entry = { pid, scope: k, ...info };
      } else {
        continue;
      }
      processes.push(entry);
    }
  }

  return textResult({
    timestamp: new Date().toISOString(),
    count: processes.length,
    processes,
  });
}

// ─── Tool: gpu_watch ──────────────────────────────────────────────────────
async function gpuWatch(args) {
  const missing = requireRocmSmi();
  if (missing) return errorResult(missing);

  const samples = Math.max(2, Math.min(60, Math.floor(args.samples ?? 5)));
  const intervalMs = Math.max(100, Math.min(10000, Math.floor(args.interval_ms ?? 1000)));

  const snapshots = [];
  for (let i = 0; i < samples; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
    const r = await run(BIN.rocmSmi, ['-a', '--json']);
    const data = parseRocmJson(r.stdout);
    const vram = parseRocmJson((await run(BIN.rocmSmi, ['--showmeminfo', 'vram', '--json'])).stdout) || {};
    const frame = { timestamp: new Date().toISOString(), cards: [] };
    if (data) {
      for (const k of cardKeys(data)) {
        const c = data[k];
        const v = vram[k] || {};
        frame.cards.push({
          card: k,
          utilization_percent: numOrNull(c['GPU use (%)']),
          vram_used_bytes: numOrNull(v['VRAM Total Used Memory (B)']),
          temp_edge_c: numOrNull(c['Temperature (Sensor edge) (C)']),
          power_avg_w: numOrNull(c['Average Graphics Package Power (W)']),
          fan_rpm: numOrNull(c['Fan RPM']),
        });
      }
    }
    snapshots.push(frame);
  }

  // Compute per-card deltas (min/max/avg of utilization and temp) as a
  // convenience so the caller doesn't have to aggregate themselves.
  const summary = {};
  for (const frame of snapshots) {
    for (const c of frame.cards) {
      if (!summary[c.card]) {
        summary[c.card] = { utilization: [], temp: [], power: [], vram: [] };
      }
      if (c.utilization_percent !== null) summary[c.card].utilization.push(c.utilization_percent);
      if (c.temp_edge_c !== null) summary[c.card].temp.push(c.temp_edge_c);
      if (c.power_avg_w !== null) summary[c.card].power.push(c.power_avg_w);
      if (c.vram_used_bytes !== null) summary[c.card].vram.push(c.vram_used_bytes);
    }
  }
  function stats(arr) {
    if (!arr.length) return null;
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    return { min, max, avg: Math.round(avg * 100) / 100, samples: arr.length };
  }
  const perCard = {};
  for (const [card, s] of Object.entries(summary)) {
    perCard[card] = {
      utilization_percent: stats(s.utilization),
      temp_edge_c: stats(s.temp),
      power_avg_w: stats(s.power),
      vram_used_bytes: stats(s.vram),
    };
  }

  return textResult({
    samples,
    interval_ms: intervalMs,
    total_duration_ms: intervalMs * (samples - 1),
    snapshots,
    per_card_stats: perCard,
  });
}

// ─── Tool: rocm_info ──────────────────────────────────────────────────────
async function rocmInfo() {
  const info = {
    rocm_smi_installed: !!BIN.rocmSmi,
    rocm_smi_path: BIN.rocmSmi,
    amdgpu_top_installed: !!BIN.amdgpuTop,
    amdgpu_top_path: BIN.amdgpuTop,
  };

  if (BIN.rocmSmi) {
    const v = await run(BIN.rocmSmi, ['--version']);
    info.rocm_smi_version = (v.stdout || v.stderr || '').trim().split('\n').slice(0, 3).join(' | ') || null;

    const d = parseRocmJson((await run(BIN.rocmSmi, ['--showdriverversion', '--json'])).stdout);
    info.driver_version = d && d.system ? d.system['Driver version'] : null;
  }

  if (BIN.lsmod) {
    const m = await run(BIN.lsmod);
    info.amdgpu_loaded = /^amdgpu\s/m.test(m.stdout || '');
  }

  if (BIN.dpkg) {
    const p = await run(BIN.dpkg, ['-l']);
    const pkgs = (p.stdout || '').split('\n')
      .filter((l) => /^ii\s+(rocm|hip|hsa|amdgpu)/i.test(l))
      .map((l) => {
        const parts = l.split(/\s+/);
        return { name: parts[1], version: parts[2] };
      });
    info.rocm_packages = pkgs;
    info.rocm_packages_count = pkgs.length;
  }

  return textResult(info);
}

// ─── Tool registry ────────────────────────────────────────────────────────
// Every tool is strictly read-only: readOnlyHint=true, destructiveHint=false,
// openWorldHint=false. No tool spawns long-lived processes or mutates state.
const TOOLS = [
  {
    name: 'gpu_status',
    description: 'One-shot summary of all AMD GPUs: product name, GPU utilization %, VRAM used/total bytes and %, edge/junction/memory temperatures, average and max power, fan speed % and RPM. Returns one entry per card. Fields that the card does not support are returned as null (not omitted).',
    annotations: { title: 'GPU status summary', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gpu_metrics',
    description: 'Full rocm-smi -a --json output for every GPU (clocks, voltages, PCIe link width/speed, firmware versions, per-engine activity, throttle status, energy counters). Use when gpu_status is not enough. The shape is rocm-smi’s native JSON, unmodified.',
    annotations: { title: 'Full GPU metrics', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gpu_processes',
    description: 'List compute processes using the GPU (KFD PIDs) with their VRAM usage and card index. Returns an empty list when no compute workloads are running.',
    annotations: { title: 'List GPU processes', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gpu_watch',
    description: 'Take N snapshots of gpu_status at a fixed interval and return both the raw frames and per-card min/max/avg statistics for utilization, temperature, power, and VRAM usage. Useful for answering “is this training run stable?”. Default: 5 samples at 1000ms intervals.',
    annotations: { title: 'Watch GPU over time', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        samples: { type: 'integer', minimum: 2, maximum: 60, description: 'Number of samples to take (2–60). Default: 5.' },
        interval_ms: { type: 'integer', minimum: 100, maximum: 10000, description: 'Milliseconds between samples (100–10000). Default: 1000.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'rocm_info',
    description: 'Report the rocm-smi version, kernel driver version, whether the amdgpu module is loaded, installed ROCm/HIP/HSA packages (from dpkg), and whether amdgpu_top is available. Useful for checking ROCm install health before running workloads.',
    annotations: { title: 'ROCm install info', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const HANDLERS = {
  gpu_status: gpuStatus,
  gpu_metrics: gpuMetrics,
  gpu_processes: gpuProcesses,
  gpu_watch: gpuWatch,
  rocm_info: rocmInfo,
};

// ─── JSON-RPC dispatch ────────────────────────────────────────────────────
async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'rocm-mcp', version: '0.1.1' },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') { respond(id, {}); return; }
  if (method === 'tools/list') { respond(id, { tools: TOOLS }); return; }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    const handler = HANDLERS[name];
    if (!handler) { error(id, -32601, `unknown tool: ${name}`); return; }
    try {
      const result = await Promise.resolve(handler(args));
      respond(id, result);
    } catch (e) {
      log('tool error:', name, e.message, e.stack);
      respond(id, errorResult(`tool ${name} threw: ${e.message}`));
    }
    return;
  }

  if (id !== undefined && id !== null) error(id, -32601, `method not found: ${method}`);
}

// ─── Main loop ────────────────────────────────────────────────────────────
let inflight = 0;
let stdinClosed = false;
function maybeExit() { if (stdinClosed && inflight === 0) process.exit(0); }

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch (e) { log('bad JSON on stdin:', e.message); return; }
  inflight++;
  handle(msg)
    .catch((e) => {
      log('handler crash:', e.message, e.stack);
      if (msg && msg.id !== undefined) error(msg.id, -32603, e.message);
    })
    .finally(() => { inflight--; maybeExit(); });
});
rl.on('close', () => { stdinClosed = true; maybeExit(); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

log(
  'server started, pid', process.pid,
  'rocm-smi=' + (BIN.rocmSmi || 'MISSING'),
  'amdgpu_top=' + (BIN.amdgpuTop || 'not-installed')
);
