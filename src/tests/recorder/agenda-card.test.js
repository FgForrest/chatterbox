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
    it("shows the live selection and Another agenda even if none is selected", async () => {
        const render = createAgendaCard(container, {
            tab: () => ({ id: 7 }),
            onFolder: vi.fn(),
        });
        await render(settings, {
            state: "recording",
            sessionId: "one",
            agendaId: null,
        });
        expect(container.hidden).toBe(false);
        expect(container.textContent).toContain("agendaNone");
        container.querySelectorAll("button")[1].click();
        expect(send.mock.calls[0][0].choose).toBe(true);
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
    it("adds only sidePanel permission and includes the panel in the Store packer", () => {
        const manifest = JSON.parse(
            readFileSync("extensions/recorder/manifest.json", "utf8"),
        );
        expect(manifest.version).toBe("0.8.0");
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
        expect(manifest.side_panel.default_path).toBe("agenda/agenda.html");
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
