import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it, vi } from "vitest";

function panelWorker(stored, hydration = Promise.resolve({ ...stored })) {
    const source = readFileSync(
        "extensions/recorder/service-worker.js",
        "utf8",
    );
    const init = source.slice(
        source.indexOf("const agendaTabs ="),
        source.indexOf("async function routeAgendaTab"),
    );
    const action = source.slice(
        source.indexOf("chrome.action.onClicked.addListener"),
        source.indexOf("chrome.commands.onCommand.addListener"),
    );
    const listeners = {};
    const event = (name) => ({
        addListener: (fn) => {
            listeners[name] = fn;
        },
    });
    const open = vi.fn(async () => "panel:7");
    const close = vi.fn(async () => {});
    const capture = vi.fn();
    const ctx = {
        URL,
        chrome: {
            storage: {
                session: {
                    get: () => hydration,
                    set: vi.fn(async (patch) => Object.assign(stored, patch)),
                },
            },
            runtime: {
                id: "test",
                getURL: (path) => `chrome-extension://test/${path}`,
                onConnect: event("connect"),
            },
            sidePanel: {
                setOptions: vi.fn(async () => {}),
                open,
                close,
                onOpened: event("opened"),
                onClosed: event("closed"),
            },
            action: { onClicked: event("click") },
        },
        openAgendaPanelNow: open,
        openAgendaPanel: open,
        startFromInvocation: capture,
        agendaPanelKey: (id) => `panel:${id}`,
    };
    vm.runInNewContext(init + action, ctx);
    return { listeners, open, close, capture };
}

it.each([
    false,
    true,
])("closes the previously open panel on the first click after a worker restart (before hydration=%s)", async (cold) => {
    const stored = {
        "agenda-route:7": { agendaIds: ["agenda"], tabId: 7 },
        "agenda-open:7": true,
    };
    let deliver;
    const hydration = new Promise((resolve) => {
        deliver = resolve;
    });
    const h = panelWorker(stored, hydration);
    if (!cold) {
        deliver({ ...stored });
        await hydration;
    }
    h.listeners.click({ id: 7 });
    if (cold) {
        expect(h.open).toHaveBeenCalledOnce();
        deliver({ ...stored });
    } else expect(h.open).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.close).toHaveBeenCalledWith({ tabId: 7 });
    expect(stored["agenda-open:7"]).toBe(false);
    expect(h.capture).not.toHaveBeenCalled();
});

it("persists panel port and native open/close events, preserving a disconnect that precedes hydration", async () => {
    const stored = { "agenda-open:7": true };
    let deliver;
    const hydration = new Promise((resolve) => {
        deliver = resolve;
    });
    const h = panelWorker(stored, hydration);
    let disconnect;
    h.listeners.connect({
        name: "agenda-panel",
        sender: {
            id: "test",
            url: "chrome-extension://test/agenda/agenda.html?tab=7",
        },
        onDisconnect: {
            addListener: (fn) => {
                disconnect = fn;
            },
        },
    });
    expect(stored["agenda-open:7"]).toBe(true);
    disconnect();
    expect(stored["agenda-open:7"]).toBe(false);
    deliver({
        "agenda-open:7": true,
        "agenda-route:7": { agendaIds: ["agenda"], tabId: 7 },
    });
    await hydration;
    h.listeners.click({ id: 7 });
    expect(h.open).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stored["agenda-open:7"]).toBe(true);
    h.listeners.closed({ tabId: 7 });
    expect(stored["agenda-open:7"]).toBe(false);
    h.listeners.opened({ tabId: 7 });
    expect(stored["agenda-open:7"]).toBe(true);
});

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
