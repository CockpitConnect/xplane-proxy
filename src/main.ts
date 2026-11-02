import { log } from "./log";
import { createProxy } from "./proxy";

const XPLANE_HOST = process.env.XPLANE_HOST ?? "127.0.0.1";
const XPLANE_PORT = parseInt(process.env.XPLANE_PORT ?? "8086", 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT ?? "8087", 10);

const server = createProxy({ xplaneHost: XPLANE_HOST, xplanePort: XPLANE_PORT, log });

server.listen(PROXY_PORT, "0.0.0.0", () => {
    log(`X-Plane proxy listening on 0.0.0.0:${PROXY_PORT}`);
    log(`Forwarding to X-Plane at ${XPLANE_HOST}:${XPLANE_PORT}`);
});
