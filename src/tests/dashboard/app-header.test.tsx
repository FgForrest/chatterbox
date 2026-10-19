// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { ReactNode, RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AlmanacLayout from "@/app/(app)/almanac/layout";
import TasksLayout from "@/app/(app)/tasks/layout";
import {
    type AppChromeConfig,
    AppChromeProvider,
    useAppChrome,
} from "@/components/app-chrome-provider";
import { AppHeader } from "@/components/app-header";
import { CommandPalette } from "@/components/dashboard/command-palette";
import { HelpProvider } from "@/components/help/help-provider";
import type { AppSearchResults } from "@/lib/search/types";
import { INITIAL_SETTINGS_DEFAULTS } from "@/lib/settings/initial-settings";

const mocks = vi.hoisted(() => ({
    pathname: "/dashboard",
    push: vi.fn(),
    refresh: vi.fn(),
    signOut: vi.fn(),
    sync: vi.fn(),
}));
vi.mock("next/navigation", () => ({
    usePathname: () => mocks.pathname,
    useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("next-intl", () => ({
    useLocale: () => "en",
    useExtracted: () => (source: string | { message: string }) =>
        typeof source === "string" ? source : source.message,
    useFormatter: () => ({
        dateTime: (date: Date) => date.toISOString().slice(0, 10),
    }),
}));
vi.mock("@/components/learn/review-events", () => ({
    usePendingReviews: () => 0,
}));
vi.mock("@/components/tasks/use-pending-tasks", () => ({
    usePendingTasks: () => 0,
}));
vi.mock("@/components/product-name-provider", () => ({
    useProductName: () => "Chatterbox",
}));
vi.mock("@/components/almanac/almanac-tabs", () => ({
    AlmanacTabs: () => null,
}));
vi.mock("@/components/app-upload-button", () => ({
    AppUploadButton: ({
        buttonRef,
    }: {
        buttonRef?: RefObject<HTMLButtonElement | null>;
    }) => (
        <button ref={buttonRef} type="button" aria-label="Upload">
            Upload
        </button>
    ),
}));
vi.mock("@/components/help/help-drawer", () => ({
    HelpDrawer: ({ target }: { target: unknown }) =>
        target ? (
            <div role="dialog" aria-label="Help">
                User guide
            </div>
        ) : null,
}));
vi.mock("@/components/settings-dialog", () => ({
    SettingsDialog: ({
        open,
        accessManagement,
    }: {
        open: boolean;
        accessManagement: boolean;
    }) =>
        open ? (
            <div role="dialog" aria-label="Settings">
                {accessManagement ? "Organization access" : "Personal settings"}
            </div>
        ) : null,
}));
vi.mock("@/components/onboarding-dialog", () => ({
    OnboardingDialog: ({ open }: { open: boolean }) =>
        open ? (
            <div role="dialog" aria-label="Setup">
                Setup
            </div>
        ) : null,
}));
vi.mock("@/components/dashboard/shortcuts-dialog", () => ({
    ShortcutsDialog: ({ open }: { open: boolean }) =>
        open ? (
            <div role="dialog" aria-label="Keyboard shortcuts">
                Shortcuts
            </div>
        ) : null,
}));
vi.mock("@/hooks/use-auto-sync", () => ({
    useAutoSync: () => ({
        manualSync: mocks.sync,
        isAutoSyncing: false,
        lastSyncResult: null,
        lastSyncTime: null,
        nextSyncTime: null,
    }),
}));
vi.mock("@/hooks/use-google-connection", () => ({
    useGoogleConnectOutcome: vi.fn(),
}));
vi.mock("@/hooks/use-theme", () => ({
    useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));
vi.mock("@/lib/auth-client", () => ({ signOut: mocks.signOut }));
vi.mock("posthog-js", () => ({ default: { __loaded: false } }));

const config: AppChromeConfig = {
    initialSettings: {
        ...INITIAL_SETTINGS_DEFAULTS,
        onboardingCompleted: true,
        autoSyncEnabled: false,
    },
    isAdmin: false,
    userEmail: "alice@example.com",
    isHosted: false,
    mailEnabled: false,
    accessManagement: false,
    onboardingCapabilities: {
        googleConfigured: false,
        mailAvailable: false,
        mcpConnectorUrl: null,
        recorderStoreUrl: "https://store.example",
    },
};
const empty: AppSearchResults = {
    chatter: [],
    almanac: [],
    tasks: [],
    limited: false,
};
const hits: AppSearchResults = {
    ...empty,
    chatter: [
        {
            id: "audio",
            title: "Alpha recording",
            snippet: "A transcript",
            href: "/dashboard?recording=audio",
        },
    ],
    almanac: [
        {
            id: "alpha",
            name: "Alpha",
            kind: "entity",
            typeKey: "product",
            typeLabel: "Product or system",
            description: "Description",
            scope: "personal",
            heard: null,
            href: "/almanac/things/alpha",
        },
        {
            id: "beta",
            name: "Beta",
            kind: "person",
            typeKey: "person",
            typeLabel: "Person",
            description: null,
            scope: "org",
            heard: null,
            href: "/almanac/beta",
        },
    ],
    tasks: [
        {
            id: "task",
            text: "Alpha task",
            dueDate: "2026-10-23",
            status: "open",
            recording: {
                id: "audio",
                title: "Alpha recording",
                view: "private",
            },
            href: "/tasks/task",
        },
    ],
};

function DashboardPalette() {
    const chrome = useAppChrome();
    return (
        <CommandPalette
            open={chrome.paletteOpen}
            onOpenChange={chrome.setPaletteOpen}
            currentTheme="system"
            dateTimeFormat="relative"
            onSetTheme={vi.fn()}
            onSync={mocks.sync}
            onUpload={vi.fn()}
            onOpenSettings={() => chrome.setSettingsOpen(true)}
            onOpenShortcuts={() => chrome.setShortcutsOpen(true)}
        />
    );
}

function renderPage(
    pathname: string,
    overrides: Partial<AppChromeConfig> = {},
) {
    mocks.pathname = pathname;
    window.history.replaceState({}, "", pathname);
    let content: ReactNode = (
        <>
            <AppHeader />
            <DashboardPalette />
        </>
    );
    if (pathname.startsWith("/almanac"))
        content = <AlmanacLayout>People filter stays here</AlmanacLayout>;
    if (pathname.startsWith("/tasks"))
        content = <TasksLayout>Task filters stay here</TasksLayout>;
    return render(
        <HelpProvider>
            <AppChromeProvider {...config} {...overrides}>
                {content}
            </AppChromeProvider>
        </HelpProvider>,
    );
}

function openMenu() {
    fireEvent.pointerDown(
        screen.getByRole("button", { name: "Account menu" }),
        { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
}
function openPalette(metaKey = true) {
    fireEvent.keyDown(window, { key: "k", metaKey, ctrlKey: !metaKey });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            if (url.startsWith("/api/settings/ai/providers"))
                return new Response(JSON.stringify({ providers: [] }));
            return new Response(JSON.stringify(empty));
        }),
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const pages = [
    {
        pathname: "/dashboard",
        scope: "chatter",
        label: "Search Klepy",
        pill: "Chatter",
    },
    {
        pathname: "/almanac/things",
        scope: "almanac",
        label: "Search the Almanac",
        pill: "Almanac",
    },
    {
        pathname: "/tasks",
        scope: "tasks",
        label: "Search tasks",
        pill: "Tasks",
    },
];

describe.each(pages)("shared header on $pathname", ({
    pathname,
    scope,
    label,
    pill,
}) => {
    it("renders one header with named icon actions and the current section label on mobile", () => {
        renderPage(pathname);
        expect(screen.getAllByRole("banner")).toHaveLength(1);
        expect(screen.getByRole("button", { name: label })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Upload" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Help" })).toBeNull();
        const current = screen
            .getByRole("navigation", { name: "Sections" })
            .querySelector('[aria-current="page"]');
        expect(current?.textContent).toBe(pill);
        expect(current?.querySelector("span")?.className).toBe("inline");
    });
    it("opens Settings from the menu", async () => {
        renderPage(pathname);
        openMenu();
        fireEvent.click(screen.getByText("Settings"));
        expect(
            await screen.findByRole("dialog", { name: "Settings" }),
        ).toBeTruthy();
    });
    it("opens Help from the menu", async () => {
        renderPage(pathname);
        openMenu();
        fireEvent.click(screen.getByText("Help"));
        expect(
            await screen.findByRole("dialog", { name: "Help" }),
        ).toBeTruthy();
    });
    it("re-runs setup from the menu", async () => {
        renderPage(pathname);
        openMenu();
        fireEvent.click(screen.getByText("Re-run setup"));
        expect(
            await screen.findByRole("dialog", { name: "Setup" }),
        ).toBeTruthy();
    });
    it("logs out from the menu", async () => {
        renderPage(pathname);
        openMenu();
        fireEvent.click(screen.getByText("Log out"));
        await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
        expect(mocks.push).toHaveBeenCalledWith("/");
        expect(mocks.refresh).toHaveBeenCalledOnce();
    });
    it.each([
        true,
        false,
    ])("opens with Command/Ctrl K (meta=%s), defaults to the page, switches with Tab, and closes with Esc", async (meta) => {
        renderPage(pathname);
        openPalette(meta);
        expect(
            screen.getByRole("dialog", { name: "Command palette" }),
        ).toBeTruthy();
        expect(
            screen
                .getByRole("button", { name: pill })
                .getAttribute("aria-pressed"),
        ).toBe("true");
        await waitFor(() =>
            expect(fetch).toHaveBeenCalledWith(
                `/api/app-search?scope=${scope}&q=`,
                expect.objectContaining({ signal: expect.any(AbortSignal) }),
            ),
        );
        const input = screen.getByRole("combobox");
        fireEvent.keyDown(input, { key: "Tab" });
        expect(
            screen
                .getByRole("button", { name: "Everywhere" })
                .getAttribute("aria-pressed"),
        ).toBe("true");
        fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
        expect(
            screen
                .getByRole("button", { name: pill })
                .getAttribute("aria-pressed"),
        ).toBe("true");
        fireEvent.keyDown(input, { key: "Escape" });
        await waitFor(() =>
            expect(
                screen.queryByRole("dialog", { name: "Command palette" }),
            ).toBeNull(),
        );
        openPalette(meta);
        expect(
            screen
                .getByRole("button", { name: pill })
                .getAttribute("aria-pressed"),
        ).toBe("true");
    });
    it("opens from the search button", () => {
        renderPage(pathname);
        fireEvent.click(screen.getByRole("button", { name: label }));
        expect(
            screen.getByRole("dialog", { name: "Command palette" }),
        ).toBeTruthy();
    });
    it("preserves applicable administrator and Organization settings", async () => {
        renderPage(pathname, { isAdmin: true, accessManagement: true });
        openMenu();
        expect(screen.getByText("Admin dashboard")).toBeTruthy();
        fireEvent.click(screen.getByText("Settings"));
        expect(await screen.findByText("Organization access")).toBeTruthy();
    });
});

describe("palette results and request lifetime", () => {
    it("keeps a deep transcript match in the local recording row with its quick action", async () => {
        vi.mocked(fetch).mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({
                        ...empty,
                        chatter: [
                            {
                                ...hits.chatter[0],
                                snippet: "needle in the transcript",
                            },
                        ],
                    }),
                ),
        );
        const transcribe = vi.fn();
        const select = vi.fn();
        render(
            <CommandPalette
                open
                onOpenChange={vi.fn()}
                currentTheme="system"
                dateTimeFormat="relative"
                recordings={[
                    {
                        id: "audio",
                        filename: "Alpha recording",
                        startTime: "2026-10-19T12:00:00Z",
                        duration: 1000,
                        filesize: 1000,
                        deviceSn: "uploaded",
                    },
                ]}
                onSelectRecording={select}
                onTranscribeRecording={transcribe}
                onSetTheme={vi.fn()}
                onSync={vi.fn()}
                onUpload={vi.fn()}
                onOpenSettings={vi.fn()}
                onOpenShortcuts={vi.fn()}
            />,
        );
        const input = screen.getByRole("combobox");
        fireEvent.change(input, { target: { value: "needle" } });
        expect(
            await screen.findByText("needle in the transcript"),
        ).toBeTruthy();
        expect(screen.getAllByText("Alpha recording")).toHaveLength(1);
        fireEvent.click(
            screen.getByRole("button", { name: "Transcribe {name}" }),
        );
        expect(transcribe).toHaveBeenCalledWith("audio");
        fireEvent.keyDown(input, { key: "ArrowDown" });
        fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
        expect(transcribe).toHaveBeenCalledTimes(2);
        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() =>
            expect(select).toHaveBeenCalledWith(
                expect.objectContaining({ id: "audio" }),
            ),
        );
    });

    it.each(pages)("selects the first $scope match with Enter", async ({
        pathname,
        scope,
    }) => {
        vi.mocked(fetch).mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({
                        ...empty,
                        [scope]: hits[scope as keyof typeof hits],
                    }),
                ),
        );
        renderPage(pathname);
        openPalette();
        const input = screen.getByRole("combobox");
        fireEvent.change(input, { target: { value: "Alpha" } });
        await waitFor(() =>
            expect(
                screen
                    .getAllByRole("option")
                    .some(
                        (option) =>
                            option.getAttribute("data-selected") === "true",
                    ),
            ).toBe(true),
        );
        expect(screen.queryByText("No matches.")).toBeNull();
        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    });
    it.each(
        pages,
    )("uses arrows and Enter to open the selected $scope result", async ({
        pathname,
        scope,
    }) => {
        vi.mocked(fetch).mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({
                        ...empty,
                        [scope]: hits[scope as keyof typeof hits],
                    }),
                ),
        );
        renderPage(pathname);
        openPalette();
        const input = screen.getByRole("combobox");
        fireEvent.change(input, { target: { value: "Alpha" } });
        await screen.findByText(
            scope === "almanac"
                ? "Alpha"
                : scope === "tasks"
                  ? "Alpha task"
                  : "Alpha recording",
        );
        const options = screen.getAllByRole("option");
        fireEvent.keyDown(input, { key: "ArrowDown" });
        fireEvent.keyDown(input, { key: "ArrowUp" });
        const selected = options.find(
            (option) => option.getAttribute("data-selected") === "true",
        );
        expect(selected).toBeTruthy();
        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() => expect(mocks.push).toHaveBeenCalled());
        expect(mocks.push.mock.calls[0]?.[0]).toMatch(
            scope === "almanac"
                ? /^\/almanac\//
                : scope === "tasks"
                  ? /^\/tasks\//
                  : /^\/dashboard\?recording=/,
        );
    });
    it("debounces, aborts stale requests, and ignores late responses", async () => {
        const requests: {
            signal: AbortSignal;
            resolve: (response: Response) => void;
            url: string;
        }[] = [];
        vi.mocked(fetch).mockImplementation(
            (url, options) =>
                new Promise<Response>((resolve) =>
                    requests.push({
                        url: String(url),
                        signal: options?.signal as AbortSignal,
                        resolve,
                    }),
                ),
        );
        renderPage("/almanac");
        openPalette();
        const input = screen.getByRole("combobox");
        fireEvent.change(input, { target: { value: "a" } });
        fireEvent.change(input, { target: { value: "alpha" } });
        await waitFor(() => expect(requests).toHaveLength(1));
        expect(requests[0]?.url).toBe("/api/app-search?scope=almanac&q=alpha");
        fireEvent.change(input, { target: { value: "beta" } });
        expect(requests[0]?.signal.aborted).toBe(true);
        await waitFor(() => expect(requests).toHaveLength(2));
        await act(async () => {
            requests[1]?.resolve(
                new Response(
                    JSON.stringify({ ...empty, almanac: [hits.almanac[1]] }),
                ),
            );
        });
        expect(await screen.findByText("Beta")).toBeTruthy();
        await act(async () => {
            requests[0]?.resolve(
                new Response(
                    JSON.stringify({ ...empty, almanac: [hits.almanac[0]] }),
                ),
            );
        });
        expect(screen.queryByText("Alpha")).toBeNull();
        fireEvent.keyDown(input, { key: "Escape" });
        expect(requests[1]?.signal.aborted).toBe(true);
    });
    it("groups Everywhere results by section and shows vocabulary, dates and sources", async () => {
        vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(hits)));
        renderPage("/tasks");
        openPalette();
        fireEvent.keyDown(screen.getByRole("combobox"), { key: "Tab" });
        expect(await screen.findByText("Almanac · Things")).toBeTruthy();
        expect(
            screen.getByText("Product or system · Description"),
        ).toBeTruthy();
        expect(screen.getByText("Tasks · Open tasks")).toBeTruthy();
        expect(screen.getByText("2026-10-23")).toBeTruthy();
        expect(screen.getAllByText("Alpha recording")).toHaveLength(2);
    });
});
