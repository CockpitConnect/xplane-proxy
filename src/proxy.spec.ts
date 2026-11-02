import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { createProxy } from "./proxy";

interface Harness {
    proxyUrl: string;
    xplane: FakeXPlane;
    log: jest.Mock;
}

interface FakeXPlane {
    port: number;
    requests: Array<{ method?: string; url?: string; host?: string; body: string }>;
    sockets: WebSocket[];
    upgradePaths: string[];
    /** Delay applied before completing the WS handshake, to simulate a slow simulator. */
    handshakeDelayMs: number;
    nextSocket(): Promise<WebSocket>;
}

const servers: http.Server[] = [];
const openSockets = new Set<Socket>();

function listen(server: http.Server): Promise<number> {
    servers.push(server);
    server.on("connection", (socket) => {
        openSockets.add(socket);
        socket.on("close", () => openSockets.delete(socket));
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
}

async function startFakeXPlane(): Promise<FakeXPlane> {
    const waiters: Array<(ws: WebSocket) => void> = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            fake.requests.push({ method: req.method, url: req.url, host: req.headers.host, body });
            res.writeHead(201, { "content-type": "application/json", "x-xplane": "yes" });
            res.end(JSON.stringify({ ok: true, echo: body }));
        });
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
        fake.upgradePaths.push(req.url ?? "");
        setTimeout(() => {
            wss.handleUpgrade(req, socket as Socket, head, (ws) => {
                fake.sockets.push(ws);
                waiters.shift()?.(ws);
            });
        }, fake.handshakeDelayMs);
    });

    const fake: FakeXPlane = {
        port: 0,
        requests: [],
        sockets: [],
        upgradePaths: [],
        handshakeDelayMs: 0,
        nextSocket: () => new Promise((resolve) => waiters.push(resolve)),
    };
    fake.port = await listen(server);
    return fake;
}

async function startHarness(): Promise<Harness> {
    const xplane = await startFakeXPlane();
    const log = jest.fn();
    const proxy = createProxy({ xplaneHost: "127.0.0.1", xplanePort: xplane.port, log });
    const port = await listen(proxy);
    return { proxyUrl: `127.0.0.1:${port}`, xplane, log };
}

/** Reserve a port, then free it, so connecting to it is refused. */
async function unusedPort(): Promise<number> {
    const server = http.createServer();
    const port = await new Promise<number>((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
    );
    await new Promise((resolve) => server.close(resolve));
    return port;
}

function request(
    url: string,
    options: http.RequestOptions = {},
    body?: string,
): Promise<{ status?: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(url, options, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on("error", reject);
        req.end(body);
    });
}

function connect(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
    });
}

function nextMessage(ws: WebSocket): Promise<{ data: WebSocket.RawData; isBinary: boolean }> {
    return new Promise((resolve) => ws.once("message", (data, isBinary) => resolve({ data, isBinary })));
}

function collectMessages(ws: WebSocket, count: number): Promise<string[]> {
    return new Promise((resolve) => {
        const received: string[] = [];
        ws.on("message", (data) => {
            received.push(data.toString());
            if (received.length === count) {
                resolve(received);
            }
        });
    });
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
}

afterEach(async () => {
    for (const socket of openSockets) {
        socket.destroy();
    }
    openSockets.clear();
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

describe("HTTP proxying", () => {
    it("forwards method, path and body, and relays status, headers and body back", async () => {
        const { proxyUrl, xplane } = await startHarness();

        const res = await request(
            `http://${proxyUrl}/api/v3/datarefs?limit=5`,
            { method: "POST", headers: { "content-type": "application/json" } },
            '{"hello":"sim"}',
        );

        expect(xplane.requests).toEqual([
            { method: "POST", url: "/api/v3/datarefs?limit=5", host: expect.any(String), body: '{"hello":"sim"}' },
        ]);
        expect(res.status).toBe(201);
        expect(res.headers["x-xplane"]).toBe("yes");
        expect(JSON.parse(res.body)).toEqual({ ok: true, echo: '{"hello":"sim"}' });
    });

    // X-Plane only accepts connections addressed to itself, so the client's Host header
    // (pointing at the proxy) must be replaced.
    it("rewrites the Host header to point at X-Plane", async () => {
        const { proxyUrl, xplane } = await startHarness();

        await request(`http://${proxyUrl}/api/capabilities`);

        expect(xplane.requests[0].host).toBe(`127.0.0.1:${xplane.port}`);
    });

    it("returns 502 and logs when X-Plane is unreachable", async () => {
        const log = jest.fn();
        const proxy = createProxy({ xplaneHost: "127.0.0.1", xplanePort: await unusedPort(), log });
        const port = await listen(proxy);

        const res = await request(`http://127.0.0.1:${port}/api/capabilities`);

        expect(res.status).toBe(502);
        expect(res.body).toBe("Bad Gateway");
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/^HTTP proxy error: .*ECONNREFUSED/));
    });
});

describe("WebSocket proxying", () => {
    it("opens the upstream socket on the same path the client requested", async () => {
        const { proxyUrl, xplane, log } = await startHarness();
        const upstreamReady = xplane.nextSocket();

        const client = await connect(`ws://${proxyUrl}/api/v2`);
        await upstreamReady;

        expect(xplane.upgradePaths).toEqual(["/api/v2"]);
        expect(log).toHaveBeenCalledWith(`Client connected — opening ws://127.0.0.1:${xplane.port}/api/v2`);
        client.close();
    });

    it("relays text messages in both directions", async () => {
        const { proxyUrl, xplane } = await startHarness();
        const upstreamReady = xplane.nextSocket();
        const client = await connect(`ws://${proxyUrl}/api/v3`);
        const upstream = await upstreamReady;

        const toXPlane = nextMessage(upstream);
        client.send('{"req_id":1,"type":"dataref_subscribe_values"}');
        const fromClient = await toXPlane;
        expect(fromClient.data.toString()).toBe('{"req_id":1,"type":"dataref_subscribe_values"}');
        expect(fromClient.isBinary).toBe(false);

        const toClient = nextMessage(client);
        upstream.send('{"type":"result","req_id":1,"success":true}');
        const fromXPlane = await toClient;
        expect(fromXPlane.data.toString()).toBe('{"type":"result","req_id":1,"success":true}');
        expect(fromXPlane.isBinary).toBe(false);

        client.close();
    });

    it("preserves binary frames in both directions", async () => {
        const { proxyUrl, xplane } = await startHarness();
        const upstreamReady = xplane.nextSocket();
        const client = await connect(`ws://${proxyUrl}/api/v3`);
        const upstream = await upstreamReady;

        const toXPlane = nextMessage(upstream);
        client.send(Buffer.from([1, 2, 3]));
        const fromClient = await toXPlane;
        expect(fromClient.isBinary).toBe(true);
        expect(Buffer.from(fromClient.data as Buffer)).toEqual(Buffer.from([1, 2, 3]));

        const toClient = nextMessage(client);
        upstream.send(Buffer.from([9, 8, 7]));
        const fromXPlane = await toClient;
        expect(fromXPlane.isBinary).toBe(true);
        expect(Buffer.from(fromXPlane.data as Buffer)).toEqual(Buffer.from([9, 8, 7]));

        client.close();
    });

    // Clients typically subscribe in their own `open` handler, which fires before the proxy's
    // upstream handshake has finished. Those messages must be queued, not dropped.
    it("buffers client messages sent before X-Plane's handshake completes and delivers them in order", async () => {
        const { proxyUrl, xplane, log } = await startHarness();
        xplane.handshakeDelayMs = 100;
        const upstreamReady = xplane.nextSocket();

        const client = await connect(`ws://${proxyUrl}/api/v3`);
        client.send(
            JSON.stringify({
                req_id: 1,
                type: "dataref_subscribe_values",
                params: { datarefs: [{ id: 101 }] },
            }),
        );
        client.send("second");
        client.send("third");

        const upstream = await upstreamReady;
        const received = await collectMessages(upstream, 3);

        expect(received).toEqual([
            '{"req_id":1,"type":"dataref_subscribe_values","params":{"datarefs":[{"id":101}]}}',
            "second",
            "third",
        ]);
        expect(log).toHaveBeenCalledWith("→ X-Plane: dataref_subscribe_values — 1 dataref(s) [101]");
        client.close();
    });

    it("closes the client with X-Plane's close code and reason when X-Plane disconnects", async () => {
        const { proxyUrl, xplane, log } = await startHarness();
        const upstreamReady = xplane.nextSocket();
        const client = await connect(`ws://${proxyUrl}/api/v3`);
        const upstream = await upstreamReady;

        const closed = nextClose(client);
        upstream.close(4001, "sim quitting");

        expect(await closed).toEqual({ code: 4001, reason: "sim quitting" });
        expect(log).toHaveBeenCalledWith("X-Plane WebSocket closed (4001)");
    });

    it("closes the X-Plane socket when the client disconnects", async () => {
        const { proxyUrl, xplane, log } = await startHarness();
        const upstreamReady = xplane.nextSocket();
        const client = await connect(`ws://${proxyUrl}/api/v3`);
        const upstream = await upstreamReady;

        const upstreamClosed = nextClose(upstream);
        client.close(1000);

        await upstreamClosed;
        expect(log).toHaveBeenCalledWith("Client disconnected (1000)");
    });

    it("closes the client with 1011 when X-Plane is unreachable", async () => {
        const log = jest.fn();
        const proxy = createProxy({ xplaneHost: "127.0.0.1", xplanePort: await unusedPort(), log });
        const port = await listen(proxy);

        const client = await connect(`ws://127.0.0.1:${port}/api/v3`);
        const closed = await nextClose(client);

        expect(closed).toEqual({ code: 1011, reason: "upstream error" });
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/^X-Plane WebSocket error: .*ECONNREFUSED/));
    });

    it("keeps each client connection independent", async () => {
        const { proxyUrl, xplane } = await startHarness();
        const firstReady = xplane.nextSocket();
        const clientA = await connect(`ws://${proxyUrl}/api/v3`);
        const upstreamA = await firstReady;
        const secondReady = xplane.nextSocket();
        const clientB = await connect(`ws://${proxyUrl}/api/v3`);
        const upstreamB = await secondReady;

        const toB = nextMessage(clientB);
        const aReceived = jest.fn();
        clientA.on("message", aReceived);
        upstreamB.send("only for B");

        expect((await toB).data.toString()).toBe("only for B");
        expect(aReceived).not.toHaveBeenCalled();
        expect(upstreamA).not.toBe(upstreamB);

        clientA.close();
        clientB.close();
    });
});
