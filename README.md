# Claude ROCm GPU Monitor

Read-only AMD GPU monitoring for [Claude Desktop](https://claude.ai/download) on Linux. Lets Claude answer questions like _"is my training run healthy?"_, _"how hot is the GPU?"_, _"how much VRAM is left?"_, and _"which process is using the card?"_ — all without the ability to kill processes, change clocks, or otherwise perturb a running workload.

It shells out to `rocm-smi` (and optionally `amdgpu_top`) and exposes five strictly read-only tools. No process killing, no clock/power overrides, no fan control. For those, use a tool like [gpu-kill](https://github.com/treadiehq/gpu-kill).

## Requirements

- **Linux** with an AMD GPU (RDNA2/3/4 consumer cards — RX 6000/7000/9000, R9700 — and CDNA data-center cards).
- **`amdgpu` kernel module** loaded (standard on modern Ubuntu/Debian/Fedora).
- **`rocm-smi` installed:**
  ```bash
  sudo apt install rocm-smi            # minimal
  # or a full ROCm stack:
  # https://rocm.docs.amd.com/projects/install-on-linux/
  ```

Some metrics (clocks, power, detailed temperatures) require newer ROCm releases. If a metric isn't supported by your card/driver, the tool returns it as `null` rather than failing.

## Install (Claude Desktop)

1. Download the latest `ROCm.mcpb` from the [Releases](https://github.com/LukeLamb/claude-rocm-mcp/releases) page.
2. In Claude Desktop, open **Settings → Extensions**.
3. Scroll to **Extension Developer** at the bottom, click **Install Extension**, and pick the `.mcpb` file.
4. Enable the extension. The tools appear prefixed with `rocm-gpu-monitor:` in Claude's tool picker.

## Tools

| Tool | What it does |
|---|---|
| `gpu_status` | One-shot summary: name, utilization %, VRAM used/total, temps (edge/junction/memory), power avg/max, fan %/RPM. |
| `gpu_metrics` | Full `rocm-smi -a --json` dump — clocks, voltages, PCIe link, firmware versions, per-engine activity. |
| `gpu_processes` | Compute processes using the GPU (KFD PIDs) with VRAM usage and card index. |
| `gpu_watch` | Take N samples at a fixed interval and return raw frames plus per-card min/max/avg stats. |
| `rocm_info` | Installed ROCm/HIP packages, driver version, `amdgpu` module load status, `amdgpu_top` availability. |

All tools carry the MCP `readOnlyHint: true` / `destructiveHint: false` / `openWorldHint: false` annotations.

## Example prompts

> _"Is my training run stable? Watch the GPU for 20 seconds."_
>
> _"How much VRAM is my current PyTorch process using?"_
>
> _"Is the GPU thermal-throttling? What's the junction temperature?"_
>
> _"What ROCm version is installed and is the driver loaded?"_

## Privacy policy

This extension runs entirely on your local machine and shells out only to the following programs, always read-only:

- `rocm-smi` — queries the AMD kernel driver for device metrics.
- `amdgpu_top` (if installed) — optional richer metrics.
- `dpkg -l` — enumerates installed ROCm-related packages by name/version.
- `lsmod` — checks whether the `amdgpu` kernel module is loaded.
- `which` — locates the above binaries at startup.

**No data leaves your machine.** This extension performs no network I/O, opens no sockets, and writes no files outside of standard process stdout/stderr (captured by Claude Desktop's log directory). It cannot modify GPU state (clocks, power, fan), kill processes, or otherwise perturb a running workload — every tool is strictly read-only.

The information visible to Claude includes GPU model and firmware versions, current VRAM usage, temperature/clock/power readings, running GPU-using process PIDs and their VRAM usage, and a list of installed ROCm-related packages. If you consider any of that sensitive (for example the list of running process PIDs on a shared machine), do not enable this extension.

## Troubleshooting

**"rocm-smi is not installed"** — install it (`sudo apt install rocm-smi`). If you're using a non-Debian distro, follow AMD's ROCm install instructions.

**Many fields come back as `null` on a new GPU** — some metrics (clocks, power, temperature) depend on firmware support exposed through `rocm-smi`. On very new cards (e.g. RDNA4/R9700), individual `rocm-smi --showclocks`/`--showpower` may report "No JSON data to report" even though `-a --json` returns the data. This extension uses `-a --json` as the primary source to maximize coverage. If a specific field is unsupported on your card, it'll be `null` rather than an error.

**Permission errors** — `rocm-smi` normally runs without root. If you see permission errors, check that the user running Claude Desktop is in the `render` and `video` groups:
```bash
sudo usermod -aG render,video $USER
# log out and back in
```

## Development

The server is a single ~300-line Node.js script with zero npm dependencies. To rebuild the `.mcpb`:

```bash
cd bundle-source
zip -j ../ROCm.mcpb manifest.json package.json server.js README.md LICENSE icon.png
```

## License

MIT. See [LICENSE](LICENSE).

## Related

- [claude-terminal-mcp](https://github.com/LukeLamb/claude-terminal-mcp) — shell, filesystem, and background jobs.
- [claude-linux-mcp](https://github.com/LukeLamb/claude-linux-mcp) — X11 desktop control (screenshot, mouse, keyboard, windows, clipboard).
