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
                        canEdit: true,
                        defaults: {
                            audio: {
                                own: null,
                                effective: {
                                    id: "inherited-audio",
                                    name: "Team recordings",
                                    scope: "organization",
                                },
                                inheritedFromFolderId: "parent",
                            },
                            mail: {
                                own: null,
                                effective: null,
                                inheritedFromFolderId: null,
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
        expect(screen.getByText("Team recordings (inherited)")).toBeTruthy();
        expect(screen.getByText("Default profile for mail")).toBeTruthy();

        fireEvent.click(screen.getByText("Default profile for recordings"));
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
    });
});
