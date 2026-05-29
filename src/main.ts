import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const XPLANE_HOST = process.env.XPLANE_HOST ?? "127.0.0.1";
const XPLANE_PORT = parseInt(process.env.XPLANE_PORT ?? "8086", 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT ?? "8087", 10);

function log(msg: string) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

function tryParse(data: WebSocket.RawData): unknown {
    try {
        return JSON.parse(data.toString());
    } catch {
        return null;
    }
}

// Dataref updates arrive at simulator frequency (~20 Hz). Log the first one
// immediately, then emit a rolling summary every 10 s so the console stays readable.
function makeUpdateThrottle() {
    let count = 0;
    let timer: NodeJS.Timeout | null = null;

    return function record(keyCount: number) {
        count += keyCount;
        if (timer === null) {
            log(`→ Client: dataref_update_values (${keyCount} key(s))`);
            timer = setInterval(() => {
                if (count > 0) {
                    log(`→ Client: dataref_update_values — ${count} value(s) forwarded in last 10 s`);
                    count = 0;
                }
            }, 10_000);
        }
    };
}

function logFromXPlane(data: WebSocket.RawData, recordUpdate: (keyCount: number) => void) {
    const msg = tryParse(data);
    if (!msg || typeof msg !== "object") {
        return;
    }
    const { type } = msg as Record<string, unknown>;
    if (type === "dataref_update_values") {
        const keys = Object.keys((msg as any).data ?? {}).length;
        recordUpdate(keys);
    }
}

function logFromClient(data: WebSocket.RawData) {
    const msg = tryParse(data);
    if (!msg || typeof msg !== "object") {
        return;
    }
    const { type, params } = msg as Record<string, unknown>;
    if (type === "dataref_subscribe_values") {
        const datarefs = (params as any)?.datarefs ?? [];
        const ids = datarefs.map((d: any) => d.id).join(", ");
        log(`→ X-Plane: dataref_subscribe_values — ${datarefs.length} dataref(s) [${ids}]`);
    } else if (type === "command") {
        log(`→ X-Plane: command — ${(params as any)?.command ?? "?"}`);
    } else if (type === "dataref_set_values") {
        const datarefs = (params as any)?.datarefs ?? [];
        log(`→ X-Plane: dataref_set_values — ${datarefs.length} dataref(s)`);
    }
}

const server = http.createServer((req, res) => {
    const options: http.RequestOptions = {
        hostname: XPLANE_HOST,
        port: XPLANE_PORT,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `${XPLANE_HOST}:${XPLANE_PORT}` },
    };

    const upstream = http.request(options, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
    });

    upstream.on("error", (err) => {
        log(`HTTP proxy error: ${err.message}`);
        if (!res.headersSent) {
            res.writeHead(502).end("Bad Gateway");
        }
    });

    req.pipe(upstream);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket as import("net").Socket, head, (client) => {
        wss.emit("connection", client, req);
    });
});

wss.on("connection", (client, req) => {
    const wsUrl = `ws://${XPLANE_HOST}:${XPLANE_PORT}${req.url ?? "/api/v3"}`;
    const upstream = new WebSocket(wsUrl);
    // Buffer messages that arrive from the client before X-Plane's WS handshake
    // completes. Clients often send subscriptions immediately on their own open
    // event, which fires as soon as this proxy accepts the upgrade — before the
    // upstream handshake finishes. Without the buffer those messages are dropped
    // and X-Plane never receives them.
    const pendingFromClient: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
    const recordUpdate = makeUpdateThrottle();
    log(`Client connected — opening ${wsUrl}`);

    upstream.on("open", () => {
        log("X-Plane WebSocket connected");
        for (const { data, isBinary } of pendingFromClient) {
            logFromClient(data);
            upstream.send(data, { binary: isBinary });
        }
        pendingFromClient.length = 0;
    });

    upstream.on("message", (data, isBinary) => {
        logFromXPlane(data, recordUpdate);
        if (client.readyState === WebSocket.OPEN) {
            client.send(data, { binary: isBinary });
        }
    });

    upstream.on("close", (code, reason) => {
        log(`X-Plane WebSocket closed (${code})`);
        if (client.readyState === WebSocket.OPEN) {
            client.close(code, reason);
        }
    });

    upstream.on("error", (err) => {
        log(`X-Plane WebSocket error: ${err.message}`);
        if (client.readyState === WebSocket.OPEN) {
            client.close(1011, "upstream error");
        }
    });

    client.on("message", (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) {
            logFromClient(data);
            upstream.send(data, { binary: isBinary });
        } else {
            pendingFromClient.push({ data, isBinary });
        }
    });

    client.on("close", (code) => {
        log(`Client disconnected (${code})`);
        upstream.close();
    });

    client.on("error", (err) => {
        log(`Client WebSocket error: ${err.message}`);
        upstream.close();
    });
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
    log(`X-Plane proxy listening on 0.0.0.0:${PROXY_PORT}`);
    log(`Forwarding to X-Plane at ${XPLANE_HOST}:${XPLANE_PORT}`);
});
