import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it, vi } from "vitest";

it.each([
    "idle",
    "recording",
])("routes a cold %s agenda click without invoking capture", async (state) => {
    const source = readFileSync(
        "extensions/recorder/service-worker.js",
        "utf8",
    );
    const init = source.slice(
        source.indexOf("const agendaTabs ="),
        source.indexOf("chrome.runtime.onConnect?"),
    );
    const action = source.slice(
        source.indexOf("chrome.action.onClicked.addListener"),
        source.indexOf("chrome.commands.onCommand.addListener"),
    );
    let deliver;
    let listener;
    const hydration = new Promise((resolve) => {
        deliver = resolve;
    });
    const open = vi.fn(async () => {});
    const capture = vi.fn();
    const ctx = {
        chrome: {
            storage: { session: { get: () => hydration, set: async () => {} } },
            sidePanel: { setOptions: async () => {}, open },
            action: {
                onClicked: {
                    addListener: (f) => {
                        listener = f;
                    },
                },
            },
        },
        openAgendaPanel: open,
        startFromInvocation: capture,
        agendaPanelKey: (id) => `panel:${id}`,
        closeAgendaPanel: async () => {},
    };
    vm.runInNewContext(init + action, ctx);
    listener({ id: 7 });
    expect(capture).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    deliver({
        recordingState: { state, tabId: 7 },
        "agenda-route:7": { agendaIds: ["agenda"], tabId: 7 },
    });
    await hydration;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(capture).not.toHaveBeenCalled();
});

it.each(
    ["idle", "recording"].flatMap((state) =>
        [false, true].map((refused) => ({ state, refused })),
    ),
)("continues the non-agenda auto-mode invocation after a cold $state wake (refused=$refused)", async ({
    state,
    refused,
}) => {
    const source = readFileSync(
        "extensions/recorder/service-worker.js",
        "utf8",
    );
    const init = source.slice(
        source.indexOf("const agendaTabs ="),
        source.indexOf("chrome.runtime.onConnect?"),
    );
    const invocation = source.slice(
        source.indexOf("async function startFromInvocation(tab)"),
        source.indexOf("chrome.commands.onCommand.addListener"),
    );
    let deliver;
    let listener;
    const hydration = new Promise((resolve) => {
        deliver = resolve;
    });
    const open = vi.fn(async () => {});
    const close = vi.fn(async () => {
        if (refused) throw new Error("Panel unavailable");
    });
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const ctx = {
        Promise,
        chrome: {
            storage: { session: { get: () => hydration, set: async () => {} } },
            sidePanel: { setOptions: async () => {}, open },
            action: {
                onClicked: {
                    addListener: (f) => {
                        listener = f;
                    },
                },
            },
        },
        openAgendaPanel: open,
        closeAgendaPanel: close,
        STATE: {
            recording: "recording",
            idle: "idle",
            awaitingPicker: "picker",
            finalizing: "finalizing",
        },
        getState: async () => ({ state, tabId: 7 }),
        stopRecording: stop,
        startRecording: start,
        getSettings: async () => ({
            dataUseAcknowledgedAt: "yes",
            autoModeAcknowledgedAt: "yes",
        }),
        detectMeetingPlatform: () => ({ id: "meet" }),
        getArmed: async () => ({ 7: { mode: "auto" } }),
    };
    vm.runInNewContext(init + invocation, ctx);
    listener({ id: 7, url: "https://meet.google.com/abc-defg-hij" });
    expect(open).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    deliver({ recordingState: { state, tabId: 7 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(close).toHaveBeenCalledOnce();
    expect(state === "idle" ? start : stop).toHaveBeenCalledOnce();
    expect(state === "idle" ? stop : start).not.toHaveBeenCalled();
});
