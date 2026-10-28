// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgendaCard } from "../../../extensions/recorder/lib/agenda-card.js";

let send;
let container;
const settings = {
    serverUrl: "https://recorder.example.com",
    hasApiKey: true,
    dataUseAcknowledgedAt: "now",
    serverDefaults: { agendas: true },
};
const agenda = {
    id: "agenda-one",
    title: "Acme review",
    start: new Date().toISOString(),
    folders: [{ id: "folder-one", name: "Acme" }],
};
beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("section");
    document.body.append(container);
    send = vi.fn(async (message) =>
        message.type === "match-agendas"
            ? { ok: true, agendas: [agenda] }
            : { ok: true, agenda },
    );
    vi.stubGlobal("chrome", {
        i18n: { getMessage: (key) => key },
        runtime: { sendMessage: send },
    });
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
});

describe("popup agenda card", () => {
    it("preselects one agenda's folder once and sends its panel request directly from the click", async () => {
        const onFolder = vi.fn();
        const render = createAgendaCard(container, {
            tab: () => ({ id: 7, windowId: 3 }),
            onFolder,
        });
        await render(settings, { state: "idle" });
        await render(settings, { state: "idle" });
        expect(onFolder).toHaveBeenCalledExactlyOnceWith(agenda);
        expect(render.choice()).toEqual({ agendaId: "agenda-one" });
        expect(send).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain("Acme review");
        container.querySelector("button").click();
        expect(send).toHaveBeenLastCalledWith({
            type: "open-agenda",
            agendaId: "agenda-one",
            tabId: 7,
            matchTabId: 7,
            windowId: 3,
            choose: false,
        });
    });
    it("does not silently choose between two time matches", async () => {
        send.mockResolvedValueOnce({
            ok: true,
            agendas: [agenda, { ...agenda, id: "two" }],
        });
        const onFolder = vi.fn();
        const render = createAgendaCard(container, {
            tab: () => ({ id: 7 }),
            onFolder,
        });
        await render(settings, { state: "idle" });
        expect(onFolder).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(1);
        expect(render.choice()).toEqual({});
        container.querySelector("button").click();
        expect(send.mock.calls[1][0].choose).toBe(true);
    });
    it("hides the recording card without a selection or a matching agenda", async () => {
        send.mockResolvedValueOnce({
            ok: true,
            agendas: [],
            selectedAgenda: agenda,
        });
        const render = createAgendaCard(container, {
            tab: () => ({ id: 7 }),
            onFolder: vi.fn(),
        });
        await render(settings, {
            state: "recording",
            sessionId: "one",
            agendaId: null,
        });
        expect(container.hidden).toBe(true);
        expect(render.choice()).toEqual({});
    });
    it.each([
        1, 2,
    ])("offers one picker button for %s recording matches without selecting one", async (count) => {
        send.mockResolvedValueOnce({
            ok: true,
            agendas: Array.from({ length: count }, (_, i) => ({
                ...agenda,
                id: `agenda-${i}`,
            })),
        });
        const onFolder = vi.fn();
        const render = createAgendaCard(container, {
            tab: () => ({ id: 8 }),
            onFolder,
        });
        await render(settings, {
            state: "recording",
            sessionId: "one",
            tabId: 7,
            agendaId: null,
        });
        expect(send).toHaveBeenCalledWith({ type: "match-agendas", tabId: 7 });
        expect(container.hidden).toBe(false);
        expect(container.querySelectorAll("button:not([hidden])")).toHaveLength(
            1,
        );
        expect(container.querySelector("button").textContent).toBe(
            "agendaChoose",
        );
        container.querySelector("button").click();
        expect(send).toHaveBeenLastCalledWith(
            expect.objectContaining({
                type: "open-agenda",
                choose: true,
                tabId: 8,
                matchTabId: 7,
            }),
        );
        expect(onFolder).not.toHaveBeenCalled();
        expect(render.choice()).toEqual({});
    });
    it("shows a selected recording agenda without matching and offers another agenda", async () => {
        const render = createAgendaCard(container, {
            tab: () => ({ id: 8 }),
            onFolder: vi.fn(),
        });
        await render(settings, {
            state: "recording",
            sessionId: "one",
            tabId: 7,
            agendaId: agenda.id,
            agendaTitle: agenda.title,
        });
        expect(container.hidden).toBe(false);
        expect(container.textContent).toContain(agenda.title);
        expect(container.querySelectorAll("button:not([hidden])")).toHaveLength(
            2,
        );
        expect(send).not.toHaveBeenCalled();
        container.querySelectorAll("button")[1].click();
        expect(send).toHaveBeenLastCalledWith(
            expect.objectContaining({ choose: true, tabId: 8, matchTabId: 7 }),
        );
        send.mockResolvedValueOnce({ ok: true, agendas: [] });
        await render(settings, {
            state: "recording",
            sessionId: "one",
            agendaId: null,
        });
        expect(container.hidden).toBe(true);
    });
    it("does not reselect an explicitly cleared agenda on popup reopen", async () => {
        send.mockResolvedValueOnce({
            ok: true,
            agendas: [agenda],
            selectedAgenda: null,
        });
        const onFolder = vi.fn();
        const render = createAgendaCard(container, {
            tab: () => ({ id: 7 }),
            onFolder,
        });
        await render(settings, { state: "idle" });
        expect(onFolder).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(1);
        expect(render.choice()).toEqual({ agendaId: null });
    });
    it("does not confirm a match still loading when Record is pressed", async () => {
        let release;
        send.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const render = createAgendaCard(container, {
            tab: () => ({ id: 7 }),
            onFolder: vi.fn(),
        });
        const loading = render(settings, { state: "idle" });
        expect(render.choice()).toEqual({});
        await render(settings, { state: "recording", sessionId: "one" });
        release({ ok: true, agendas: [agenda] });
        await loading;
        expect(render.choice()).toEqual({});
        expect(
            send.mock.calls.every(([input]) => input.type !== "select-agenda"),
        ).toBe(true);
    });
    it("hides all agenda UI and sends no messages on a released server", async () => {
        const render = createAgendaCard(container, {
            tab: () => ({ id: 7 }),
            onFolder: vi.fn(),
        });
        await render(
            { ...settings, serverDefaults: {} },
            { state: "recording" },
        );
        expect(container.hidden).toBe(true);
        expect(send).not.toHaveBeenCalled();
    });
    it.each([
        "rejection",
        "error response",
    ])("retries a match %s without initializing or flooding recording updates", async (failure) => {
        if (failure === "rejection")
            send.mockRejectedValueOnce(new Error("offline"));
        else send.mockResolvedValueOnce({ ok: false, error: "offline" });
        const render = createAgendaCard(container, {
            tab: () => ({ id: 8 }),
            onFolder: vi.fn(),
        });
        const state = { state: "recording", sessionId: "one", tabId: 7 };
        await render(settings, state);
        expect(container.hidden).toBe(true);
        expect(render.choice()).toEqual({});
        for (let i = 0; i < 10; i++) await render(settings, { ...state });
        await vi.advanceTimersByTimeAsync(999);
        expect(send).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenLastCalledWith({
            type: "match-agendas",
            tabId: 7,
        });
        expect(container.hidden).toBe(false);
    });
    it("caps retry delays at ten seconds and cancels retries when agendas become unsupported", async () => {
        send.mockResolvedValue({ ok: false });
        const render = createAgendaCard(container, {
            tab: () => ({ id: 7 }),
            onFolder: vi.fn(),
        });
        await render(settings, { state: "recording", sessionId: "one" });
        for (const delay of [1000, 2000, 4000, 8000, 10000, 10000]) {
            const before = send.mock.calls.length;
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(send).toHaveBeenCalledTimes(before);
            await vi.advanceTimersByTimeAsync(1);
            expect(send).toHaveBeenCalledTimes(before + 1);
        }
        await render(
            { ...settings, serverDefaults: {} },
            { state: "recording", sessionId: "one" },
        );
        const before = send.mock.calls.length;
        await vi.advanceTimersByTimeAsync(60000);
        expect(send).toHaveBeenCalledTimes(before);
    });
    it("expires successful empty matches while the popup remains open", async () => {
        send.mockResolvedValueOnce({ ok: true, agendas: [] });
        const render = createAgendaCard(container, {
            tab: () => ({ id: 7 }),
            onFolder: vi.fn(),
        });
        await render(settings, { state: "recording", sessionId: "one" });
        await vi.advanceTimersByTimeAsync(59999);
        expect(send).toHaveBeenCalledTimes(1);
        expect(container.hidden).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(send).toHaveBeenCalledTimes(2);
        expect(container.hidden).toBe(false);
    });
    it.each([
        ["en", 1, "Agendas at this time: 1"],
        ["en", 2, "Agendas at this time: 2"],
        ["cs", 1, "Agendy v tomto čase: 1"],
        ["cs", 2, "Agendy v tomto čase: 2"],
    ])("renders real %s wording for %s recording matches", async (locale, count, expected) => {
        const catalog = JSON.parse(
            readFileSync(
                `extensions/recorder/_locales/${locale}/messages.json`,
                "utf8",
            ),
        );
        chrome.i18n.getMessage = (key, substitutions) => {
            let message = catalog[key].message;
            for (const [i, value] of [substitutions ?? ""].flat().entries())
                message = message.replaceAll(`$${i + 1}`, value);
            return message;
        };
        send.mockResolvedValueOnce({
            ok: true,
            agendas: Array.from({ length: count }, (_, i) => ({
                ...agenda,
                id: `agenda-${i}`,
            })),
        });
        const render = createAgendaCard(container, {
            tab: () => ({ id: 7 }),
            onFolder: vi.fn(),
        });
        await render(settings, { state: "recording", sessionId: "one" });
        expect(container.querySelector("strong").textContent).toBe(expected);
        expect(container.querySelector("button").textContent).toBe(
            catalog.agendaChoose.message,
        );
    });
    it("keeps permissions unchanged and packages a panel without a global default", () => {
        const manifest = JSON.parse(
            readFileSync("extensions/recorder/manifest.json", "utf8"),
        );
        expect(manifest.version).toBe("0.8.1");
        expect(manifest.permissions).toEqual([
            "offscreen",
            "storage",
            "desktopCapture",
            "tabCapture",
            "tabs",
            "notifications",
            "scripting",
            "alarms",
            "sidePanel",
        ]);
        expect(manifest.side_panel).toBeUndefined();
        expect(readFileSync("extensions/recorder/pack.mjs", "utf8")).toContain(
            '"agenda"',
        );
        const en = JSON.parse(
            readFileSync(
                "extensions/recorder/_locales/en/messages.json",
                "utf8",
            ),
        );
        const cs = JSON.parse(
            readFileSync(
                "extensions/recorder/_locales/cs/messages.json",
                "utf8",
            ),
        );
        expect(Object.keys(cs).sort()).toEqual(Object.keys(en).sort());
        expect(cs.appName.message).toBe("Klepna");
        expect(
            Object.values(cs).every(
                (value) =>
                    value.message && !value.message.includes("Chatterbox"),
            ),
        ).toBe(true);
    });
});
