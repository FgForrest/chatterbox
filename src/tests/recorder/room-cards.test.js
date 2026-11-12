// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ request: vi.fn(), fields: [] }));
vi.mock("../../../extensions/recorder/lib/agendas.js", () => ({
    agendaRequest: h.request,
}));
vi.mock("../../../extensions/recorder/generated/folders.js", () => ({
    createFolderField: (options) => {
        const field = {
            ...options,
            reset: vi.fn(),
            saved: async () => {},
            destroy: vi.fn(),
        };
        h.fields.push(field);
        return field;
    },
}));

import { mountRoomCards } from "../../../extensions/recorder/lib/room-cards.js";

const messages = JSON.parse(
    readFileSync("extensions/recorder/_locales/en/messages.json", "utf8"),
);
let root, cards, accepted, failed, refreshed;
beforeEach(() => {
    h.fields.length = 0;
    h.request.mockReset().mockResolvedValue({ data: [] });
    vi.stubGlobal("chrome", {
        i18n: {
            getUILanguage: () => "en",
            getMessage(key, values) {
                let result = messages[key]?.message ?? key;
                for (const [i, part] of [values ?? ""].flat().entries())
                    result = result.replaceAll(`$${i + 1}`, part);
                return result;
            },
        },
        runtime: {
            sendMessage: vi.fn(async () => ({ ok: true, folders: [] })),
        },
    });
    root = document.createElement("div");
    document.body.append(root);
    accepted = vi.fn();
    failed = vi.fn();
    refreshed = vi.fn();
    cards = mountRoomCards(root, {
        defaultFolder: () => ({
            folderId: "private",
            folderScope: "personal",
            folderLabel: "Meetings",
        }),
        onAccepted: accepted,
        onError: failed,
        onRefresh: refreshed,
    });
});
afterEach(() => {
    cards.destroy();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});
const invitation = {
    id: "share",
    agendaId: "agenda",
    title: "Acme review",
    sharerName: "Jitka Dvořáková",
    version: 4,
    start: "2026-11-11T12:00:00Z",
    end: "2026-11-11T13:00:00Z",
};
const settle = () => vi.waitFor(() => expect(h.request).toHaveBeenCalled());

describe("room agenda cards", () => {
    it("shows only a restricted explanation and keeps its hint free of private names and agenda IDs", () => {
        cards.render({ restricted: true });
        expect(root.textContent).toContain(
            "There is an agenda for this meeting in Chatterbox that has not been shared with you. Its owner can share it with you, and the invitation will appear here.",
        );
        expect(root.textContent).toContain("record without an agenda");
        expect(root.querySelector(".room-locked")).not.toBeNull();
        expect(root.textContent).not.toContain(invitation.title);
        expect(root.textContent).not.toContain(invitation.sharerName);
    });
    it("shows owner people, initials, separate row actions and a final Share with all action", () => {
        cards.render({
            agendaId: "agenda",
            people: [
                { id: "one", name: "Alex Rowan" },
                { id: "two", name: "Robin Vale" },
            ],
        });
        expect(
            [...root.querySelectorAll("button")].map(
                (button) => button.textContent,
            ),
        ).toEqual(["Share", "Share", "Share with all (2)"]);
        expect(root.querySelector(".room-avatar").textContent).toBe("AR");
        expect(root.textContent).toContain(
            "Only Chatterbox people with the panel open",
        );
    });
    it("changes a row to pending after Share and hides Share with all when one remains", async () => {
        cards.render({
            agendaId: "agenda",
            people: [
                { id: "one", name: "Alex Rowan" },
                { id: "two", name: "Robin Vale" },
            ],
        });
        root.querySelector("button").click();
        await settle();
        await vi.waitFor(() =>
            expect(root.textContent).toContain(
                "Invitation sent, waiting for acceptance",
            ),
        );
        expect(h.request).toHaveBeenCalledWith(
            "/agenda/people",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ receiverIds: ["one"] }),
            }),
        );
        expect(root.querySelector(".room-share-all")).toBeNull();
    });
    it("shares all eligible people and disappears when the next refresh finds nobody", async () => {
        cards.render({
            agendaId: "agenda",
            people: [
                { id: "one", name: "Alex Rowan" },
                { id: "two", name: "Robin Vale" },
            ],
        });
        root.querySelector(".room-share-all").click();
        await settle();
        expect(JSON.parse(h.request.mock.calls[0][1].body).receiverIds).toEqual(
            ["one", "two"],
        );
        cards.render({ people: [] });
        expect(root.hidden).toBe(true);
    });
    it("keeps pending invitees visible without a second Share action", () => {
        cards.render({
            agendaId: "agenda",
            people: [{ id: "one", name: "Alex Rowan", pending: true }],
        });
        expect(root.querySelector("button")).toBeNull();
        expect(root.textContent).toContain("waiting for acceptance");
    });
    it("shows sharer, title, time, a folder chip and Decline before Accept", () => {
        cards.render({ restricted: true, invitations: [invitation] });
        expect(root.textContent).toContain(
            "Jitka Dvořáková shared an agenda with you",
        );
        expect(root.querySelector("h3").textContent).toBe("Acme review");
        expect(root.textContent).toContain("Save to");
        expect(
            [...root.querySelectorAll("button")].map(
                (button) => button.textContent,
            ),
        ).toEqual(["Decline", "Accept"]);
        expect(h.fields[0].variant).toBe("pill");
        expect(h.fields[0].reset).toHaveBeenCalledWith({
            folderId: "private",
            folderScope: "personal",
            folderLabel: "Meetings",
        });
        expect(root.querySelector(".room-locked")).toBeNull();
    });
    it.each([
        "accept",
        "decline",
    ])("%ss in the panel and files only an accepted invitation", async (response) => {
        cards.render({ invitations: [invitation] });
        await h.fields[0].save({ folderId: "chosen", folderScope: "personal" });
        root.querySelectorAll(".room-actions button")[
            response === "accept" ? 1 : 0
        ].click();
        await settle();
        expect(h.request).toHaveBeenCalledWith(
            "/invitations/share",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({
                    action: response,
                    version: 4,
                    ...(response === "accept" ? { folderId: "chosen" } : {}),
                }),
            }),
        );
        await vi.waitFor(() =>
            expect(accepted).toHaveBeenCalledWith(
                response === "accept" ? "agenda" : null,
            ),
        );
    });
    it("preserves the chosen filing folder across identical polling refreshes", async () => {
        cards.render({ invitations: [invitation] });
        await h.fields[0].save({ folderId: "chosen" });
        cards.render({ invitations: [invitation] });
        expect(h.fields).toHaveLength(1);
        root.querySelectorAll(".room-actions button")[1].click();
        await settle();
        expect(JSON.parse(h.request.mock.calls[0][1].body).folderId).toBe(
            "chosen",
        );
    });
    it("keeps a failed invitation actionable and shows the existing error", async () => {
        h.request.mockRejectedValueOnce(new Error("offline"));
        cards.render({ invitations: [invitation] });
        root.querySelectorAll(".room-actions button")[1].click();
        await vi.waitFor(() => expect(failed).toHaveBeenCalled());
        expect(accepted).not.toHaveBeenCalled();
        expect(
            [...root.querySelectorAll("button")].every(
                (button) => !button.disabled,
            ),
        ).toBe(true);
    });
});

it("#403 keeps all sharing batches on the clicked agenda and refreshes after a panel switch", async () => {
    const people = Array.from({ length: 21 }, (_, i) => ({
        id: `person-${i}`,
        name: `Member ${i}`,
        pending: false,
    }));
    let release;
    h.request.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                release = resolve;
            }),
    );
    cards.render({ agendaId: "agenda-a", people });
    root.querySelector(".room-share-all").click();
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledTimes(1));
    const nextPeople = structuredClone(people);
    cards.render({ agendaId: "agenda-b", people: nextPeople });
    people.push({ id: "late-person", name: "Late arrival" });
    release({ data: [] });
    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
    expect(h.request.mock.calls.map((call) => call[0])).toEqual([
        "/agenda-a/people",
        "/agenda-a/people",
    ]);
    expect(
        JSON.parse(h.request.mock.calls[0][1].body).receiverIds,
    ).toHaveLength(20);
    expect(JSON.parse(h.request.mock.calls[1][1].body).receiverIds).toEqual([
        "person-20",
    ]);
    expect(nextPeople.every((person) => !person.pending)).toBe(true);
    expect(root.querySelectorAll(".room-sent")).toHaveLength(0);
    expect(root.querySelector(".room-share-all").textContent).toBe(
        "Share with all (21)",
    );
});
it("#403 shows the acceptance hint with an invitation and hides an empty owner card", () => {
    cards.render({ restricted: true, invitations: [invitation] });
    expect(root.textContent).toContain(
        "After accepting you will see the agenda",
    );
    cards.render({ agendaId: "unbound", people: [] });
    expect(root.hidden).toBe(true);
    expect(root.querySelector(".room-owner")).toBeNull();
});
