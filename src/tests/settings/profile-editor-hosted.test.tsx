// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductNameProvider } from "@/components/product-name-provider";
import { ProfileEditor } from "@/components/settings/profile-editor";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { defaultProfileSettings } from "@/lib/profiles/settings";

function translate(
    message: string | { message: string },
    values?: Record<string, string | number>,
) {
    const source = typeof message === "string" ? message : message.message;
    return translatedSourceMessage("en", source, values);
}

vi.mock("next-intl", () => ({
    useExtracted: () => translate,
    useLocale: () => "en",
}));
vi.mock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn() },
}));

describe("profile editor transcription fallback", () => {
    beforeEach(() => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL | Request) => {
                if (String(input).startsWith("/api/settings/ai/")) {
                    return Response.json({ providers: [] });
                }
                return Response.json({
                    profile: {
                        id: "audio-profile",
                        name: "Recordings",
                        description: null,
                        channel: "audio",
                        scope: "personal",
                        isDefault: true,
                        version: 1,
                        canEdit: true,
                        archivedAt: null,
                        updatedAt: "2026-10-15T00:00:00.000Z",
                        settings: defaultProfileSettings("audio"),
                    },
                    builtinPromptsVersion: "test",
                    builtins: {
                        focus: { en: "Focus", "cs-CZ": "Zaměření" },
                        outputFormat: { en: "Format", "cs-CZ": "Formát" },
                    },
                });
            }),
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it.each([
        [
            true,
            "Default uses your default transcription provider, then Mynah when available.",
        ],
        [
            false,
            "Default uses your default transcription provider, then the Organization default, then its oldest enabled transcription provider.",
        ],
    ])("hosted=%s explains the default as %s", async (isHosted, expected) => {
        render(
            <ProductNameProvider isHosted={isHosted}>
                <ProfileEditor
                    profileId="audio-profile"
                    open
                    onOpenChange={() => undefined}
                    onSaved={() => undefined}
                />
            </ProductNameProvider>,
        );

        expect(await screen.findByText(expected)).toBeTruthy();
        expect(document.body.textContent?.includes("Mynah")).toBe(isHosted);
    });
});
