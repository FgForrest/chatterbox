// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AttachmentShareChoice } from "@/components/meetings/attachment-disclosure";
import { RecordingShareBanner } from "@/components/meetings/recording-share-banner";
import {
    PersonInvitations,
    PersonSharingProvider,
} from "@/components/sharing/person-sharing";
import csMessages from "../../../messages/cs-CZ.json";
import enMessages from "../../../messages/en.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next-intl", async (original) => {
    const { createTranslator } = await original<typeof importNextIntl>();
    return {
        useLocale: () => "cs-CZ",
        useExtracted:
            () =>
            (source: string, values?: Record<string, string | number>) => {
                const translate = createTranslator({
                    locale: "cs-CZ",
                    messages: csMessages,
                });
                const keys = new Map(
                    Object.entries(enMessages).map(([key, text]) => [
                        text,
                        key,
                    ]),
                );
                const key = keys.get(source);
                return key
                    ? translate(key as keyof typeof csMessages, values)
                    : source;
            },
        useFormatter: () => ({ dateTime: () => "8. 11. 2026" }),
    };
});

import type * as importNextIntl from "next-intl";

vi.mock("@/lib/events/client", () => ({ subscribeEvents: () => () => {} }));

beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Response.json({
                people: [
                    { id: "person", name: "Petr Novák" },
                    { id: "unnamed", name: null },
                ],
            }),
        ),
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

it("renders nominative names and a person fallback in the Czech attachment choice", () => {
    render(
        <AttachmentShareChoice
            choice={{
                shown: true,
                checked: true,
                shareRecording: true,
                people: [
                    { id: "person", name: "Petr Novák" },
                    { id: "unnamed", name: null },
                ],
                onChange: vi.fn(),
            }}
        />,
    );
    expect(
        screen.getByRole("checkbox", {
            name: /Sdílet nahrávku i s těmito lidmi: Petr Novák, Někdo/,
        }),
    ).toBeTruthy();
});

it("renders nominative names and a person fallback in the Czech owner banner", async () => {
    render(
        <PersonSharingProvider value>
            <RecordingShareBanner
                agendaId="agenda"
                recordingId="recording"
                title="Plán projektu"
                userId="owner"
            />
        </PersonSharingProvider>,
    );
    expect(
        await screen.findByText(
            "Agendu „Plán projektu“ sdílíte s těmito lidmi: Petr Novák, Někdo. Nahrávku s nimi zatím nesdílíte.",
        ),
    ).toBeTruthy();
});

it("renders a nominative folder label in the Czech invitation shortcut", () => {
    render(
        <PersonSharingProvider value>
            <PersonInvitations
                notifications={false}
                folders={[]}
                initialInvitations={[
                    {
                        id: "share",
                        itemId: "recording",
                        kind: "audio",
                        title: "Záznam projektu",
                        ownerName: "Jitka Dvořáková",
                        ownerEmail: "author@example.com",
                        version: 0,
                        invitedAt: new Date(),
                        visibleInFolders: [],
                        suggestedFolder: { id: "folder", name: "Nový projekt" },
                    },
                ]}
            />
        </PersonSharingProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pozvánky (1)" }));
    expect(
        screen.getByRole("button", {
            name: "Přijmout do složky „Nový projekt“",
        }),
    ).toBeTruthy();
});
