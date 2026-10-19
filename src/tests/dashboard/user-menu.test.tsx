// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserMenu } from "@/components/dashboard/user-menu";

vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted: () => (source: string, values?: Record<string, string>) => {
        if (!values) return source;
        return Object.entries(values).reduce(
            (message, [key, value]) => message.replace(`{${key}}`, value),
            source,
        );
    },
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/help/help-provider", () => ({
    useHelp: () => ({ openHelp: vi.fn() }),
}));
vi.mock("@/hooks/use-theme", () => ({
    useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));
vi.mock("@/lib/auth-client", () => ({ signOut: vi.fn() }));
vi.mock("posthog-js", () => ({
    default: { capture: vi.fn(), reset: vi.fn() },
}));

function renderMenu(onOpenOnboarding = vi.fn()) {
    render(
        <UserMenu
            isAdmin={false}
            initialTheme="system"
            userEmail="person@example.com"
            onOpenSettings={vi.fn()}
            onOpenShortcuts={vi.fn()}
            onOpenOnboarding={onOpenOnboarding}
            lastSyncTime={new Date("2026-10-16T10:27:00.000Z")}
            nextSyncTime={new Date("2026-10-16T10:32:00.000Z")}
            isAutoSyncing={false}
            lastSyncResult={{ success: true }}
            onSync={vi.fn()}
        />,
    );
    fireEvent.pointerDown(
        screen.getByRole("button", { name: "Account menu" }),
        {
            button: 0,
            ctrlKey: false,
            pointerType: "mouse",
        },
    );
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T10:30:00.000Z"));
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("user menu setup and sync status", () => {
    it("opens onboarding from the menu", () => {
        const onOpenOnboarding = vi.fn();
        renderMenu(onOpenOnboarding);
        fireEvent.click(screen.getByText("Re-run setup"));
        expect(onOpenOnboarding).toHaveBeenCalledOnce();
    });

    it("shows compact relative times, full timestamps, and updates while open", () => {
        renderMenu();
        const status = screen.getByText(/Synced .*next/);
        expect(status.textContent).toContain("3 min");
        expect(status.textContent).toContain("2 min");
        expect(status.parentElement?.getAttribute("title")).toContain(
            "Last synced",
        );

        act(() => vi.advanceTimersByTime(60_000));
        expect(status.textContent).toContain("4 min");
        expect(status.textContent).toContain("1 min");
    });
});
