# xplane-proxy

Expose X-Plane's local-only WebSocket API on your local network so any machine can connect to it.

## Why

X-Plane 12's built-in WebSocket server (`/api/v3`) only binds to `127.0.0.1`. If your cockpit software — hardware bridges, EFBs, autopilots, logging tools — runs on a **different machine** than X-Plane, it has no way to reach the API directly.

`xplane-proxy` runs on the same PC as X-Plane, connects to the local WebSocket and HTTP REST API, and re-exposes them on `0.0.0.0` so any machine on your LAN can connect as if it were localhost.

## Download

Pre-built single-file binaries are on the [Releases](../../releases/latest) page — nothing to install.

| Platform | Binary |
|---|---|
| Windows (x64) | `xplane-proxy-win-x64.exe` |
| Linux (x64) | `xplane-proxy-linux-x64` |
| Linux (ARM64) | `xplane-proxy-linux-arm64` |

## Usage

Run the proxy on the **same machine as X-Plane**, then point your client at the proxy's IP and port instead of X-Plane's.

**Windows**
```powershell
.\xplane-proxy-win-x64.exe
```

**Linux**
```sh
chmod +x xplane-proxy-linux-x64
./xplane-proxy-linux-x64
```

**Example output**
```
[2026-05-29T10:00:00.000Z] X-Plane proxy listening on 0.0.0.0:8087
[2026-05-29T10:00:00.000Z] Forwarding to X-Plane at 127.0.0.1:8086
[2026-05-29T10:00:01.200Z] Client connected — opening ws://127.0.0.1:8086/api/v3
[2026-05-29T10:00:01.215Z] X-Plane WebSocket connected
[2026-05-29T10:00:01.220Z] → X-Plane: dataref_subscribe_values — 3 dataref(s) [1042, 1043, 1107]
[2026-05-29T10:00:01.250Z] → Client: dataref_update_values (3 key(s))
```

> **Windows Firewall** will prompt you to allow the connection on first run. Accept it, or add an inbound rule manually for TCP port 8087.

## Configuration

All settings are environment variables. The defaults work for a standard X-Plane 12 installation.

| Variable | Default | Description |
|---|---|---|
| `XPLANE_HOST` | `127.0.0.1` | Host where X-Plane is running |
| `XPLANE_PORT` | `8086` | Port X-Plane's WebSocket server listens on |
| `PROXY_PORT` | `8087` | Port the proxy exposes on the network |

**Linux**
```sh
XPLANE_PORT=8088 PROXY_PORT=9000 ./xplane-proxy-linux-x64
```

**Windows (PowerShell)**
```powershell
$env:XPLANE_PORT = "8088"
$env:PROXY_PORT  = "9000"
.\xplane-proxy-win-x64.exe
```

## What is proxied

- **WebSocket** — All paths are forwarded. Each incoming client connection gets its own upstream connection to X-Plane. Messages that arrive before X-Plane's handshake completes are buffered and flushed automatically.
- **HTTP** — All requests are forwarded transparently, including REST API calls such as dataref ID lookups (`/api/v1/datarefs`).

## Building from source

Node.js 24 or later is required.

```sh
npm install
node build-sea.mjs
```

Binaries are written to `releases/`. The build script downloads the Node runtime for each target platform and produces self-contained executables using [Node.js SEA](https://nodejs.org/api/single-executable-applications.html).

For development with live TypeScript:

```sh
npm run dev
```

## License

MIT
