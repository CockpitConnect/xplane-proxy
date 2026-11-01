import type WebSocket from "ws";

export type LogFn = (msg: string) => void;

export function tryParse(data: WebSocket.RawData): unknown {
    try {
        return JSON.parse(data.toString());
    } catch {
        return null;
    }
}

// Dataref updates arrive at simulator frequency (~20 Hz). Log the first one
// immediately, then emit a rolling summary every 10 s so the console stays readable.
export function makeUpdateThrottle(log: LogFn) {
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

export function logFromXPlane(data: WebSocket.RawData, recordUpdate: (keyCount: number) => void) {
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

export function logFromClient(data: WebSocket.RawData, log: LogFn) {
    const msg = tryParse(data);
    if (!msg || typeof msg !== "object") {
        return;
    }
    const { type, params } = msg as Record<string, unknown>;
    if (type === "dataref_subscribe_values") {
        const datarefs = (params as any)?.datarefs ?? [];
        const ids = datarefs.map((d: any) => d.id).join(", ");
        log(`→ X-Plane: dataref_subscribe_values — ${datarefs.length} dataref(s) [${ids}]`);
    } else if (type === "command_set_is_active") {
        // Commands travel as numeric ids, so the name the operator would recognise is not on the
        // wire. The id is still what X-Plane echoes back in any error, which is what makes it the
        // useful thing to log.
        const commands = (params as any)?.commands ?? [];
        const ids = commands.map((c: any) => c.id).join(", ");
        log(`→ X-Plane: command_set_is_active — ${commands.length} command(s) [${ids}]`);
    } else if (type === "dataref_set_values") {
        const datarefs = (params as any)?.datarefs ?? [];
        log(`→ X-Plane: dataref_set_values — ${datarefs.length} dataref(s)`);
    }
}
