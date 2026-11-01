import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { log } from "./log";
import { makeUpdateThrottle, logFromXPlane, logFromClient } from "./relayLogger";

const XPLANE_HOST = process.env.XPLANE_HOST ?? "127.0.0.1";
const XPLANE_PORT = parseInt(process.env.XPLANE_PORT ?? "8086", 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT ?? "8087", 10);

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
    // and X-Plane never receives the subscription.
    const pendingFromClient: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
    const recordUpdate = makeUpdateThrottle(log);
    log(`Client connected — opening ${wsUrl}`);

    upstream.on("open", () => {
        log("X-Plane WebSocket connected");
        for (const { data, isBinary } of pendingFromClient) {
            logFromClient(data, log);
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
            logFromClient(data, log);
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
