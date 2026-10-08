import { describe, expect, it, vi } from "vitest";
import {
    createRecorderExtensionClient,
    type RecorderExtensionClientDeps,
} from "@/lib/recorder-extension/client";

const ORIGIN = "https://riffado.example.com";
const ID = "abcdefghijklmnopabcdefghijklmnop";

type Listener = (event: { data: unknown; origin: string }) => void;

/** A fake page whose content script (if any) is scripted per test. */
function fakePage(options: {
    external?: (message: unknown) => unknown | undefined;
    content?: (message: unknown) => unknown | undefined;
    probe?: boolean;
}) {
    const listeners = new Set<Listener>();
    const deliver = (data: unknown) => {
        for (const listener of listeners) listener({ data, origin: ORIGIN });
    };
    const deps: RecorderExtensionClientDeps = {
        origin: ORIGIN,
        externalSendMessage: options.external
            ? (_id, message, callback) => {
                  const reply = options.external?.(message);
                  setTimeout(() => callback(reply), 0);
              }
            : undefined,
        externalLastError: () => undefined,
        postMessage: (data) => {
            const reply = options.content?.(data);
            if (reply !== undefined) setTimeout(() => deliver(reply), 0);
        },
        addMessageListener: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        probeImage: vi.fn(async () => options.probe ?? false),
    };
    return { deps, deliver };
}

describe("detectRecorderExtension", () => {
    it("reports not installed when nothing answers and the probe fails", async () => {
        const { deps } = fakePage({ probe: false });
        const client = createRecorderExtensionClient(deps);
        expect(await client.detect(ID, 30)).toEqual({ kind: "not-installed" });
    });

    it("reports installed-unreachable when only the probe succeeds", async () => {
        const { deps } = fakePage({ probe: true });
        const client = createRecorderExtensionClient(deps);
        expect(await client.detect(ID, 30)).toEqual({
            kind: "installed-unreachable",
        });
    });

    it("prefers the external channel and reads pairing state", async () => {
        const { deps } = fakePage({
            external: () => ({
                installed: true,
                paired: true,
                pairedTo: ORIGIN,
                version: "0.2.0",
            }),
            content: () => ({
                type: "riffado-recorder-present",
                installed: true,
            }),
        });
        const client = createRecorderExtensionClient(deps);
        expect(await client.detect(ID, 30)).toEqual({
            kind: "reachable",
            channel: "external",
            paired: true,
            pairedTo: ORIGIN,
            pairedHere: true,
            version: "0.2.0",
        });
    });

    it("falls back to the content-script handshake", async () => {
        const { deps } = fakePage({
            content: (message) =>
                (message as { type?: string }).type === "riffado-recorder-ping"
                    ? {
                          type: "riffado-recorder-present",
                          installed: true,
                          paired: false,
                      }
                    : undefined,
        });
        const client = createRecorderExtensionClient(deps);
        expect(await client.detect(ID, 30)).toEqual({
            kind: "reachable",
            channel: "content",
            paired: false,
            version: undefined,
        });
    });

    it("marks a pairing to another server as not paired here", async () => {
        const { deps } = fakePage({
            external: () => ({
                installed: true,
                paired: true,
                pairedTo: "https://other.example.com",
            }),
        });
        const client = createRecorderExtensionClient(deps);
        const state = await client.detect(ID, 30);
        expect(state.kind).toBe("reachable");
        if (state.kind === "reachable" && state.paired) {
            expect(state.pairedHere).toBe(false);
        }
    });
});

describe("pairRecorderExtension", () => {
    it("pairs over the external channel", async () => {
        const external = vi.fn(() => ({ ok: true }));
        const { deps } = fakePage({ external });
        const client = createRecorderExtensionClient(deps);
        const result = await client.pair(
            ID,
            "external",
            { serverUrl: ORIGIN, apiKey: "op_x" },
            50,
        );
        expect(result).toEqual({ ok: true });
        expect(external).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "riffado-recorder-pair",
                serverUrl: ORIGIN,
                apiKey: "op_x",
            }),
        );
    });

    it("relays a refusal from the content channel", async () => {
        const { deps } = fakePage({
            content: (message) =>
                (message as { type?: string }).type === "riffado-recorder-pair"
                    ? {
                          type: "riffado-recorder-pair-result",
                          ok: false,
                          error: "origin mismatch",
                      }
                    : undefined,
        });
        const client = createRecorderExtensionClient(deps);
        const result = await client.pair(
            ID,
            "content",
            { serverUrl: ORIGIN, apiKey: "op_x" },
            50,
        );
        expect(result).toEqual({ ok: false, error: "origin mismatch" });
    });

    it("times out when nothing answers", async () => {
        const { deps } = fakePage({});
        const client = createRecorderExtensionClient(deps);
        const result = await client.pair(
            ID,
            "content",
            { serverUrl: ORIGIN, apiKey: "op_x" },
            20,
        );
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/timed out/i);
    });
});
