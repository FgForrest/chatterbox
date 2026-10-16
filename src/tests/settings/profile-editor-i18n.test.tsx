// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileEditor } from "@/components/settings/profile-editor";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { defaultProfileSettings } from "@/lib/profiles/settings";
import csCzMessages from "../../../messages/cs-CZ.json";
import enMessages from "../../../messages/en.json";

function czechTranslate(
    message: string | { message: string },
    values?: Record<string, string | number>,
) {
    const source = typeof message === "string" ? message : message.message;
    const catalogEntry = Object.entries(enMessages).find(
        ([, value]) => value === source,
    );
    if (!catalogEntry || !(catalogEntry[0] in csCzMessages)) {
        return `MISSING_MESSAGE: ${source}`;
    }
    return translatedSourceMessage("cs-CZ", source, values);
}

vi.mock("next-intl", () => ({
    useExtracted: () => czechTranslate,
    useLocale: () => "cs-CZ",
}));
vi.mock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn() },
}));

const profiles = {
    audio: {
        id: "audio-profile",
        name: "Nahrávky",
        description: null,
        channel: "audio" as const,
        scope: "personal" as const,
        isDefault: true,
        version: 1,
        canEdit: true,
        archivedAt: null,
        updatedAt: "2026-10-15T00:00:00.000Z",
        settings: defaultProfileSettings("audio"),
    },
    mail: {
        id: "mail-profile",
        name: "Pošta",
        description: null,
        channel: "mail" as const,
        scope: "personal" as const,
        isDefault: false,
        version: 1,
        canEdit: true,
        archivedAt: null,
        updatedAt: "2026-10-15T00:00:00.000Z",
        settings: defaultProfileSettings("mail"),
    },
};

describe("profile editor Czech labels", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("renders every step and preset without a missing catalog message", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL | Request) => {
                const url = String(input);
                if (url === "/api/settings/ai/providers") {
                    return Response.json({ providers: [] });
                }
                if (url === "/api/settings/ai/organization-providers") {
                    return Response.json({ providers: [] });
                }
                const id = url.endsWith("mail-profile") ? "mail" : "audio";
                return Response.json({
                    profile: profiles[id],
                    builtinPromptsVersion: "test",
                    builtins: {
                        focus: { en: "Focus", "cs-CZ": "Zaměření" },
                        outputFormat: { en: "Format", "cs-CZ": "Formát" },
                    },
                });
            }),
        );

        const { rerender } = render(
            <ProfileEditor
                profileId="audio-profile"
                open
                onOpenChange={() => undefined}
                onSaved={() => undefined}
            />,
        );
        const dialog = await screen.findByRole("dialog", {
            name: "Upravit Nahrávky",
        });
        const descriptionId = dialog.getAttribute("aria-describedby");
        expect(descriptionId).toBeTruthy();
        expect(
            document.getElementById(descriptionId ?? "")?.textContent,
        ).toContain("AI");
        expect(
            screen.getAllByRole("switch", {
                name: "Spouštět automaticky",
            }),
        ).toHaveLength(5);
        fireEvent.click(screen.getByRole("tab", { name: "Pokročilé" }));
        expect(
            screen.getAllByRole("switch", {
                name: "Spouštět automaticky",
            }),
        ).toHaveLength(5);

        for (const label of [
            "Přepis",
            "Učení",
            "Název",
            "Témata",
            "Shrnutí",
            "Úkoly",
            "Výchozí název",
            "Schůzky",
            "Přednášky",
            "Telefonní hovory",
            "Audioblog",
            "Generátor nápadů",
            "Obecné shrnutí",
            "Zápis ze schůzky",
            "Klíčové body",
        ]) {
            expect(document.body.textContent).toContain(label);
        }
        expect(document.body.textContent).not.toContain("MISSING_MESSAGE");

        rerender(
            <ProfileEditor
                profileId="mail-profile"
                open
                onOpenChange={() => undefined}
                onSaved={() => undefined}
            />,
        );
        await screen.findByRole("dialog", { name: "Upravit Pošta" });
        fireEvent.click(screen.getByRole("tab", { name: "Pokročilé" }));
        expect(document.body.textContent).toContain("Shrnutí e-mailu");
        expect(document.body.textContent).not.toContain("MISSING_MESSAGE");
    });
});
