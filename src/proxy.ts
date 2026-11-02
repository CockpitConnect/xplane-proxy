import http from "node:http";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import type { LogFn } from "./relayLogger";
import { makeUpdateThrottle, logFromXPlane, logFromClient } from "./relayLogger";

export interface ProxyOptions {
    xplaneHost: string;
    xplanePort: number;
    log: LogFn;
}

export function createProxy({ xplaneHost, xplanePort, log }: ProxyOptions): http.Server {
    const server = http.createServer((req, res) => {
        const options: http.RequestOptions = {
            hostname: xplaneHost,
            port: xplanePort,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, host: `${xplaneHost}:${xplanePort}` },
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
        wss.handleUpgrade(req, socket as Socket, head, (client) => {
            wss.emit("connection", client, req);
        });
    });

    wss.on("connection", (client, req: http.IncomingMessage) => {
        const wsUrl = `ws://${xplaneHost}:${xplanePort}${req.url ?? "/api/v3"}`;
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

    return server;
}
