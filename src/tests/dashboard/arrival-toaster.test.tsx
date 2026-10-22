// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Toaster, toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppLayout from "@/app/(app)/layout";
import { ArrivalNotice } from "@/components/dashboard/arrival-notice";

vi.mock("@/components/app-chrome-provider", () => ({
    AppChromeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/help/help-provider", () => ({
    HelpProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/footer", () => ({ Footer: () => null }));
vi.mock("@/components/rebrand-banner", () => ({ RebrandBanner: () => null }));
vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: false } }));
vi.mock("@/lib/settings/app-chrome", () => ({
    appChromeConfig: async () => ({}),
}));

afterEach(() => {
    toast.dismiss();
    cleanup();
});

describe("Arrival toaster ownership", () => {
    it("confirms two unnamed Sonner mounts render a toast twice", async () => {
        render(
            <>
                <Toaster />
                <Toaster />
            </>,
        );
        act(() => {
            toast.custom(() => <div>Orbit arrival</div>, {
                id: "duplicate-probe",
                duration: Infinity,
            });
        });
        await waitFor(() =>
            expect(screen.getAllByText("Orbit arrival")).toHaveLength(2),
        );
    });

    it("renders only one notice with the root toaster and app layout", async () => {
        const app = await AppLayout({
            children: <button type="button">Dashboard</button>,
        });
        render(
            <>
                <Toaster />
                {app}
            </>,
        );
        const dashboard = screen.getByRole("button", { name: "Dashboard" });
        dashboard.focus();
        const recording = {
            id: "meadow",
            filename: "Meadow arrival",
            duration: 65_000,
            startTime: "2026-10-22T10:00:00Z",
            filesize: 1000,
            deviceSn: "uploaded",
        };
        const showNotice = (filename: string) =>
            toast.custom(
                () => (
                    <ArrivalNotice
                        recording={{ ...recording, filename }}
                        more={0}
                        dateTimeFormat="iso"
                        onOpen={vi.fn()}
                        onClose={vi.fn()}
                    />
                ),
                { id: "new-item", duration: Infinity },
            );
        act(() => {
            showNotice("Meadow arrival");
        });
        await waitFor(() =>
            expect(screen.getAllByText("Meadow arrival")).toHaveLength(1),
        );
        expect(document.activeElement).toBe(dashboard);
        act(() => {
            showNotice("Orbit arrival");
        });
        await waitFor(() =>
            expect(screen.getAllByText("Orbit arrival")).toHaveLength(1),
        );
        expect(screen.queryByText("Meadow arrival")).toBeNull();
        expect(document.activeElement).toBe(dashboard);
    });
});
