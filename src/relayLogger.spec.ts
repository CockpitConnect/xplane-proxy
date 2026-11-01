import { tryParse, makeUpdateThrottle, logFromXPlane, logFromClient } from "./relayLogger";

function rawData(value: unknown): any {
    return Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
}

describe("tryParse", () => {
    it("parses valid JSON", () => {
        expect(tryParse(rawData({ type: "command" }))).toEqual({ type: "command" });
    });

    it("returns null for invalid JSON", () => {
        expect(tryParse(rawData("not json"))).toBeNull();
    });
});

describe("makeUpdateThrottle", () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("logs the first update immediately", () => {
        const log = jest.fn();
        const record = makeUpdateThrottle(log);

        record(3);

        expect(log).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith("→ Client: dataref_update_values (3 key(s))");
    });

    it("batches subsequent updates into a rolling 10s summary instead of logging each one", () => {
        const log = jest.fn();
        const record = makeUpdateThrottle(log);

        record(2);
        record(5);
        record(1);
        expect(log).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(10_000);

        expect(log).toHaveBeenCalledTimes(2);
        expect(log).toHaveBeenLastCalledWith("→ Client: dataref_update_values — 8 value(s) forwarded in last 10 s");
    });

    it("skips the summary tick when nothing arrived since the last flush", () => {
        const log = jest.fn();
        const record = makeUpdateThrottle(log);

        record(1);
        jest.advanceTimersByTime(10_000);
        expect(log).toHaveBeenCalledTimes(2);

        jest.advanceTimersByTime(10_000);
        expect(log).toHaveBeenCalledTimes(2);
    });
});

describe("logFromXPlane", () => {
    it("forwards the key count for dataref_update_values messages", () => {
        const recordUpdate = jest.fn();

        logFromXPlane(rawData({ type: "dataref_update_values", data: { a: 1, b: 2 } }), recordUpdate);

        expect(recordUpdate).toHaveBeenCalledWith(2);
    });

    it("ignores unrelated message types", () => {
        const recordUpdate = jest.fn();

        logFromXPlane(rawData({ type: "something_else" }), recordUpdate);

        expect(recordUpdate).not.toHaveBeenCalled();
    });

    it("ignores unparseable data", () => {
        const recordUpdate = jest.fn();

        logFromXPlane(rawData("not json"), recordUpdate);

        expect(recordUpdate).not.toHaveBeenCalled();
    });
});

describe("logFromClient", () => {
    it("logs dataref subscriptions with dataref ids", () => {
        const log = jest.fn();

        logFromClient(
            rawData({
                type: "dataref_subscribe_values",
                params: { datarefs: [{ id: "sim/cockpit/gear" }, { id: "sim/cockpit/flaps" }] },
            }),
            log,
        );

        expect(log).toHaveBeenCalledWith(
            "→ X-Plane: dataref_subscribe_values — 2 dataref(s) [sim/cockpit/gear, sim/cockpit/flaps]",
        );
    });

    // X-Plane's Web API has no `command` operation — it is `command_set_is_active`, addressing a
    // numeric id. The old shape was rejected by the simulator with "Invalid operation type".
    it("logs commands", () => {
        const log = jest.fn();

        logFromClient(
            rawData({
                type: "command_set_is_active",
                params: { commands: [{ id: 88491, is_active: true, duration: 0.1 }] },
            }),
            log,
        );

        expect(log).toHaveBeenCalledWith("→ X-Plane: command_set_is_active — 1 command(s) [88491]");
    });

    it("logs dataref_set_values", () => {
        const log = jest.fn();

        logFromClient(
            rawData({ type: "dataref_set_values", params: { datarefs: [{ id: "a" }, { id: "b" }, { id: "c" }] } }),
            log,
        );

        expect(log).toHaveBeenCalledWith("→ X-Plane: dataref_set_values — 3 dataref(s)");
    });

    it("ignores unrelated message types", () => {
        const log = jest.fn();

        logFromClient(rawData({ type: "something_else" }), log);

        expect(log).not.toHaveBeenCalled();
    });

    it("ignores unparseable data", () => {
        const log = jest.fn();

        logFromClient(rawData("not json"), log);

        expect(log).not.toHaveBeenCalled();
    });
});
