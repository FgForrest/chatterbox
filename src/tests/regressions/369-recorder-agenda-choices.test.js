import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    agendaChoices,
    agendaFolder,
    matchAgendas,
} from "../../../extensions/recorder/lib/agendas.js";
import { formatMeetingTime } from "../../../extensions/recorder/lib/meeting-time.js";

vi.mock("../../../extensions/recorder/lib/token-vault.js", () => ({
    readToken: vi.fn(async () => "test-token"),
}));

const now = Date.parse("2026-11-09T12:00:00Z");
const hour = 3600000;
let local;
let matched;
let listed;

function agenda(id, start, end, own = false) {
    return {
        id,
        title: "Acme review",
        start: new Date(now + start * hour).toISOString(),
        end: end === null ? null : new Date(now + end * hour).toISOString(),
        own,
        timeSet: true,
        recorded: false,
    };
}

beforeEach(() => {
    local = {
        serverUrl: "https://recorder.example.com",
        encryptedApiKey: { ciphertext: "test" },
        dataUseAcknowledgedAt: "2026-11-08T12:00:00Z",
        serverDefaults: { agendas: true },
    };
    matched = [];
    listed = [];
    vi.stubGlobal("chrome", {
        i18n: { getMessage: (key) => key },
        storage: { local: { get: vi.fn(async () => structuredClone(local)) } },
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url) => {
            const rows = new URL(url).pathname.endsWith("/match")
                ? matched
                : listed;
            if (rows instanceof Error) throw rows;
            return Response.json({ data: rows });
        }),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("#369 manual agenda choices", () => {
    it("unions both endpoints, deduplicates and preserves Organization-only matches and folder paths", async () => {
        const running = agenda("running", -1, 1);
        matched = [running, agenda("organization-only", -0.5, 0.5)];
        listed = [
            {
                ...running,
                folders: [{ id: "folder-one", name: "Acme", scope: "org" }],
                folderPath: "Clients / Acme",
            },
            { ...agenda("missed", -2.5, -1.5, true), state: "held" },
            agenda("future", 1, 2),
        ];
        const rows = await agendaChoices(now);
        expect(rows.map((row) => row.id)).toEqual([
            "running",
            "organization-only",
            "future",
            "missed",
        ]);
        expect(agendaFolder(rows[0])).toEqual({
            folderId: "folder-one",
            folderLabel: "Clients / Acme",
            folderScope: "org",
        });
        const requests = fetch.mock.calls.map(([url]) => new URL(url));
        expect(requests).toHaveLength(2);
        expect(
            requests.find((url) => url.pathname.endsWith("/match")).search,
        ).toBe(`?${new URLSearchParams({ at: new Date(now).toISOString() })}`);
        const window = requests.find((url) => !url.pathname.endsWith("/match"));
        expect([...window.searchParams]).toEqual([
            ["from", new Date(now - 24 * hour).toISOString()],
            ["to", new Date(now + 24 * hour).toISOString()],
        ]);
    });

    it("puts running agendas before even closer missed or future own agendas", async () => {
        listed = [
            agenda("missed", -2, -0.01, true),
            agenda("future", 0.01, 1, true),
            agenda("running", -1, 1),
        ];
        expect((await agendaChoices(now))[0].id).toBe("running");
    });

    it.each([
        [-0.5, 1, ["missed", "future"]],
        [-1.5, 1, ["future", "missed"]],
    ])("compares a missed end at %sh with a future start at %sh", async (end, start, ids) => {
        listed = [agenda("missed", -3, end), agenda("future", start, 2)];
        expect((await agendaChoices(now)).map((row) => row.id)).toEqual(ids);
    });

    it("breaks equal distances by own, then earlier start, then id", async () => {
        listed = [
            agenda("own-z", 1, 2, true),
            agenda("other-missed", -3, -1),
            agenda("own-a", 1, 2, true),
            agenda("own-missed", -2, -1, true),
        ];
        expect((await agendaChoices(now)).map((row) => row.id)).toEqual([
            "own-missed",
            "own-a",
            "own-z",
            "other-missed",
        ]);
    });

    it("uses a two-hour interval when no end is set", async () => {
        listed = [
            agenda("missed", -3, null),
            agenda("future", 0.5, null),
            agenda("running", -1, null),
        ];
        expect((await agendaChoices(now)).map((row) => row.id)).toEqual([
            "running",
            "future",
            "missed",
        ]);
    });

    it("caps the sorted union at ten", async () => {
        listed = Array.from({ length: 15 }, (_, i) =>
            agenda(`future-${i}`, 15 - i, 16 - i),
        );
        const rows = await agendaChoices(now);
        expect(rows).toHaveLength(10);
        expect(rows.map((row) => row.id)).toEqual(
            Array.from({ length: 10 }, (_, i) => `future-${14 - i}`),
        );
    });

    it("restricts requested agendas before nearer unrelated agendas can fill the cap", async () => {
        matched = [
            agenda("requested-two", 1 / 6, 1),
            agenda("requested-one", 1 / 6, 1, true),
        ];
        listed = Array.from({ length: 10 }, (_, i) =>
            agenda(`unrelated-${i}`, -1, 1),
        );
        expect(
            (await agendaChoices(now, ["requested-two", "requested-one"])).map(
                (row) => row.id,
            ),
        ).toEqual(["requested-one", "requested-two"]);
    });

    it.each([
        "match",
        "list",
    ])("keeps the other endpoint's rows when %s fails", async (failed) => {
        const running = agenda("running", -1, 1);
        const missed = agenda("missed", -3, -1);
        matched =
            failed === "match" ? new Error("match unavailable") : [running];
        listed = failed === "list" ? new Error("list unavailable") : [missed];
        expect(await agendaChoices(now)).toEqual(
            failed === "match" ? [missed] : [running],
        );
    });

    it("falls back to current matches if the list route is unavailable on an older server", async () => {
        matched = [agenda("running", -1, 1)];
        const original = fetch.getMockImplementation();
        fetch.mockImplementation((url, init) =>
            new URL(url).pathname.endsWith("/match")
                ? original(url, init)
                : Promise.resolve(
                      Response.json({ error: "not found" }, { status: 404 }),
                  ),
        );
        expect(await agendaChoices(now)).toEqual(matched);
    });

    it("accepts an empty successful response even if the other request fails", async () => {
        matched = new Error("match unavailable");
        expect(await agendaChoices(now)).toEqual([]);
    });

    it("throws the existing match error when both endpoints fail", async () => {
        matched = new Error("match unavailable");
        listed = new Error("list unavailable");
        await expect(agendaChoices(now)).rejects.toThrow("match unavailable");
    });

    it("makes no requests without the existing agenda capability", async () => {
        local.serverDefaults = {};
        expect(await agendaChoices(now)).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it("keeps the automatic match limited to running agendas and starts within fifteen minutes", async () => {
        matched = [
            { ...agenda("missed", -3, -1), state: "held" },
            agenda("running", -1, 1),
            agenda("soon", 0.25, 1),
            agenda("later", 1, 2),
            agenda("ended", -1, 0),
        ];
        listed = matched;
        expect(
            (await matchAgendas(undefined, now)).map((row) => row.id),
        ).toEqual(["running", "soon"]);
        expect((await agendaChoices(now)).map((row) => row.id)).toEqual([
            "ended",
            "running",
            "soon",
            "missed",
            "later",
        ]);
    });
});

describe("#369 manual agenda time labels", () => {
    it.each([
        "en",
        "cs",
    ])("formats a cross-midnight interval at a year boundary in %s", (locale) => {
        const messages = JSON.parse(
            readFileSync(
                `extensions/recorder/_locales/${locale}/messages.json`,
                "utf8",
            ),
        );
        chrome.i18n.getUILanguage = () => locale;
        chrome.i18n.getMessage = (key) => messages[key]?.message ?? key;
        expect(
            formatMeetingTime(
                new Date(2026, 11, 31, 23, 30),
                new Date(2027, 0, 1, 0, 30),
                new Date(2027, 0, 1, 12).getTime(),
            ),
        ).toBe(
            `${messages.agendaYesterday.message} 23:30–${messages.agendaToday.message} 00:30`,
        );
    });
});
