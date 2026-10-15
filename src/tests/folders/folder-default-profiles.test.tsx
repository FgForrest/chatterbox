// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderDefaultProfiles } from "@/components/dashboard/folder-default-profiles";

describe("folder default profile picker", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("shows inherited defaults and saves an own channel default", async () => {
        const fetchMock = vi.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                if (url.endsWith("/api/folders/folder/default-profiles")) {
                    if (init?.method === "PUT") {
                        return Response.json({ ok: true });
                    }
                    return Response.json({
                        scope: "personal",
                        canEdit: true,
                        defaults: {
                            audio: {
                                own: null,
                                ownManualOnly: false,
                                effective: {
                                    id: "inherited-audio",
                                    name: "Team recordings",
                                    scope: "organization",
                                },
                                effectiveManualOnly: false,
                                inheritedFromFolderId: "parent",
                                inheritedFromFolderName: "Meetings",
                                inherited: {
                                    id: "inherited-audio",
                                    name: "Team recordings",
                                    scope: "organization",
                                },
                                inheritedManualOnly: false,
                                accountDefault: {
                                    id: "personal-audio",
                                    name: "My recordings",
                                    scope: "personal",
                                },
                            },
                            mail: {
                                own: null,
                                ownManualOnly: false,
                                effective: {
                                    id: "inherited-mail",
                                    name: "Team mail",
                                    scope: "organization",
                                },
                                effectiveManualOnly: false,
                                inheritedFromFolderId: "parent",
                                inheritedFromFolderName: "Meetings",
                                inherited: {
                                    id: "inherited-mail",
                                    name: "Team mail",
                                    scope: "organization",
                                },
                                inheritedManualOnly: false,
                                accountDefault: {
                                    id: "personal-mail",
                                    name: "My mail",
                                    scope: "personal",
                                },
                            },
                        },
                    });
                }
                if (
                    url === "/api/settings/profiles?channel=audio&pageSize=100"
                ) {
                    return Response.json({
                        profiles: [
                            {
                                id: "inherited-audio",
                                name: "Team recordings",
                                scope: "organization",
                            },
                            {
                                id: "personal-audio",
                                name: "My recordings",
                                scope: "personal",
                            },
                        ],
                    });
                }
                if (
                    url === "/api/settings/profiles?channel=mail&pageSize=100"
                ) {
                    return Response.json({
                        profiles: [
                            {
                                id: "inherited-mail",
                                name: "Team mail",
                                scope: "organization",
                            },
                            {
                                id: "personal-mail",
                                name: "My mail",
                                scope: "personal",
                            },
                        ],
                    });
                }
                throw new Error(`Unexpected request: ${url}`);
            },
        );
        vi.stubGlobal("fetch", fetchMock);

        render(<FolderDefaultProfiles folderId="folder" />);

        fireEvent.pointerDown(
            await screen.findByRole("button", { name: "Default profiles" }),
            { button: 0, ctrlKey: false },
        );
        expect(
            await screen.findByText("Default profile for recordings"),
        ).toBeTruthy();
        expect(
            screen.getByText("Team recordings · Organization (inherited)"),
        ).toBeTruthy();
        expect(screen.getByText("Default profile for mail")).toBeTruthy();

        fireEvent.click(screen.getByText("Default profile for recordings"));
        expect(
            await screen.findByRole("menuitemradio", {
                name: "Inherit from Meetings: Team recordings · Organization",
            }),
        ).toBeTruthy();
        expect(
            screen.getByRole("menuitemradio", {
                name: "Nothing automatic",
            }),
        ).toBeTruthy();
        fireEvent.click(await screen.findByText("My recordings"));

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/folders/folder/default-profiles",
                expect.objectContaining({
                    method: "PUT",
                    body: JSON.stringify({
                        channel: "audio",
                        profileId: "personal-audio",
                    }),
                }),
            );
        });

        fireEvent.pointerDown(
            screen.getByRole("button", { name: "Default profiles" }),
            { button: 0, ctrlKey: false },
        );
        fireEvent.click(screen.getByText("Default profile for mail"));
        expect(
            await screen.findByRole("menuitemradio", {
                name: "Inherit from Meetings: Team mail · Organization",
            }),
        ).toBeTruthy();
        fireEvent.click(
            screen.getByRole("menuitemradio", {
                name: "Nothing automatic",
            }),
        );
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/folders/folder/default-profiles",
                expect.objectContaining({
                    method: "PUT",
                    body: JSON.stringify({
                        channel: "mail",
                        profileId: null,
                        manualOnly: true,
                    }),
                }),
            );
        });
    });

    it("shows each member's default for an Organization folder without a folder default", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith("/api/folders/org-folder/default-profiles")) {
                return Response.json({
                    scope: "org",
                    canEdit: true,
                    defaults: {
                        audio: {
                            own: null,
                            ownManualOnly: false,
                            effective: null,
                            effectiveManualOnly: false,
                            inheritedFromFolderId: null,
                            inherited: null,
                            inheritedManualOnly: false,
                            accountDefault: null,
                        },
                        mail: {
                            own: null,
                            ownManualOnly: false,
                            effective: null,
                            effectiveManualOnly: false,
                            inheritedFromFolderId: null,
                            inherited: null,
                            inheritedManualOnly: false,
                            accountDefault: null,
                        },
                    },
                });
            }
            if (url.includes("/api/settings/profiles?channel=")) {
                return Response.json({ profiles: [] });
            }
            throw new Error(`Unexpected request: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);

        render(<FolderDefaultProfiles folderId="org-folder" />);

        fireEvent.pointerDown(
            await screen.findByRole("button", { name: "Default profiles" }),
            { button: 0, ctrlKey: false },
        );
        expect(
            await screen.findAllByText("Each person's default"),
        ).toHaveLength(2);

        fireEvent.click(screen.getByText("Default profile for recordings"));
        expect(
            await screen.findByRole("menuitemradio", {
                name: "Inherit (each person's default)",
            }),
        ).toBeTruthy();
    });
});
