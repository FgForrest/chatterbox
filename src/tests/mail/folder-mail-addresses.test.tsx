// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderMailAddresses } from "@/components/mail/folder-mail-addresses";

vi.mock("next-intl", () => ({
    useExtracted: () => (message: string) => message,
    useLocale: () => "en",
}));

vi.mock("sonner", () => ({
    toast: { error: vi.fn(), success: vi.fn() },
}));

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("folder mail addresses", () => {
    it("hides address edit controls when the folder is not writable", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                Response.json({
                    writable: false,
                    addresses: [
                        {
                            id: "current",
                            kind: "folder",
                            address: "weekly@example.com",
                            label: null,
                            primary: true,
                            folderId: "folder",
                            baseAddressId: null,
                            lastReceivedAt: "2026-10-16T10:00:00.000Z",
                            createdAt: "2026-10-16T10:00:00.000Z",
                        },
                        {
                            id: "older",
                            kind: "folder",
                            address: "weekly-old@example.com",
                            label: null,
                            primary: false,
                            folderId: "folder",
                            baseAddressId: null,
                            lastReceivedAt: null,
                            createdAt: "2026-10-16T09:00:00.000Z",
                        },
                    ],
                }),
            ),
        );

        render(<FolderMailAddresses folderId="folder" />);

        expect(
            await screen.findByRole("button", {
                name: "Copy {address}",
            }),
        ).toBeTruthy();
        expect(
            screen.queryByRole("button", {
                name: "Change the folder's address",
            }),
        ).toBeNull();
        expect(
            screen.queryByRole("button", {
                name: "Stop {address}",
            }),
        ).toBeNull();
        expect(screen.queryByText(/last mail/)).toBeNull();
    });
});
