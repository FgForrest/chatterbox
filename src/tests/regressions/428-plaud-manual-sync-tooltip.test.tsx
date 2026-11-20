// @vitest-environment jsdom
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SyncButton } from "@/components/sync-button";
import { useAutoSync } from "@/hooks/use-auto-sync";

vi.mock("next-intl", () => ({
    useExtracted: () => (message: string) => message,
    useLocale: () => "en",
}));
vi.mock("@/components/ui/tooltip", () => ({
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
    TooltipContent: ({ children }: { children: React.ReactNode }) => (
        <div role="tooltip">{children}</div>
    ),
}));
vi.mock("@/hooks/use-dashboard-refresh", () => ({
    useDashboardRefresh: () => () => {},
}));

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
});

function SyncFixture() {
    const sync = useAutoSync({ enabled: false });
    return (
        <>
            <SyncButton {...sync} onSync={sync.manualSync} />
            {sync.lastSyncResult?.needsReconnect && (
                <span>Reconnect needed</span>
            )}
        </>
    );
}

it("uses the existing retry tooltip for a whole-run failure and preserves reconnect", async () => {
    const error =
        "Plaud rejected the stored token. Reconnect your Plaud account.";
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Response.json(
                {
                    success: false,
                    error,
                    code: "PLAUD_INVALID_TOKEN",
                    needsReconnect: true,
                },
                { status: 401 },
            ),
        ),
    );
    render(<SyncFixture />);

    await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Sync device" })),
    );

    expect(screen.getByRole("button", { name: "Retry sync" })).toBeTruthy();
    expect(screen.getByRole("tooltip").textContent).toContain(error);
    expect(screen.getByText("Reconnect needed")).toBeTruthy();
    expect(localStorage.getItem("riffado_last_sync")).toBeNull();
});
