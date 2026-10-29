// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from "@testing-library/react";
import type { TranslationValues } from "use-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AdminBillingPage from "@/app/(hosted)/admin/(gated)/billing/page";
import { HelpDrawer } from "@/components/help/help-drawer";
import { KnownFacts, OtherNames } from "@/components/people/known-facts";
import { PersonDetail } from "@/components/people/person-detail";
import { TemplateList } from "@/components/settings/template-list";
import { SettingsNavSidebar } from "@/components/settings-nav-sidebar";
import { AccessSection } from "@/components/settings-sections/access-section";
import { PlaudAccountSection } from "@/components/settings-sections/plaud-account-section";
import { TaskDetail } from "@/components/tasks/task-detail";
import { translatedSourceMessage } from "@/lib/i18n/messages";
import { task } from "@/tests/meetings/ui-fixtures";

const translate = (text: string, values?: TranslationValues) =>
    translatedSourceMessage("en", text, values);
vi.mock("next-intl", () => ({
    useExtracted: () => translate,
    useLocale: () => "en",
    useFormatter: () => ({ dateTime: (date: Date) => date.toISOString() }),
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/auth-client", () => ({ signIn: { oauth2: vi.fn() } }));
vi.mock("@/components/confirm-dialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("@/components/plaud-connect-tabs", () => ({
    PlaudConnectTabs: () => null,
}));
vi.mock("@/db/queries/admin-billing", () => ({
    billingOverview: async () => ({
        counts: {},
        activeMrrByCurrency: [],
        unknownLivePriceGroups: [],
    }),
    listGraceUsers: async () => [
        {
            userId: "user",
            email: "robin@example.com",
            plan: "free",
            deletionAt: new Date().toISOString(),
        },
    ],
    listSubscriptions: async () => ({ total: 2, rows: [] }),
}));

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

it("uses the shared block count for billing sections", async () => {
    render(await AdminBillingPage({ searchParams: Promise.resolve({}) }));
    for (const [title, count] of [
        ["Accounts in grace", "1"],
        ["Subscriptions", "2"],
    ]) {
        const heading = screen.getByRole("heading", {
            name: new RegExp(title),
        });
        const badge = heading.querySelector('[data-slot="heading-count"]');
        expect(badge?.textContent).toBe(count);
        expect(heading.textContent).not.toContain("(");
    }
});

it("uses the shared block count for a person's recordings", () => {
    render(
        <PersonDetail
            person={{
                id: "person",
                displayName: "Robin Fern",
                primaryEmail: null,
                notes: null,
            }}
            appearances={[]}
            canManage={false}
        />,
    );
    const count = screen.getByText("Recordings").nextElementSibling;
    expect(count?.getAttribute("data-slot")).toBe("heading-count");
    expect(count?.textContent).toBe("0");
    expect(count?.parentElement?.classList.contains("justify-between")).toBe(
        false,
    );
});

it.each([
    "audio",
    "mail",
] as const)("keeps %s source-link icons neutral", (kind) => {
    render(
        <KnownFacts
            name="Robin Fern"
            relations={[
                {
                    key: "leads",
                    label: "leads",
                    facts: [
                        {
                            id: "fact",
                            direction: "subject",
                            other: { kind: "literal", text: "Example" },
                            scope: "personal",
                            origin: "recording",
                            evidence: [
                                {
                                    recordingId: "recording",
                                    kind,
                                    audioAvailable: false,
                                    title: "Source",
                                    recordedAt: "2026-10-01T10:00:00Z",
                                    startMs: null,
                                    quoted: false,
                                    view: "private",
                                },
                            ],
                        },
                    ],
                },
            ]}
        />,
    );
    expect(
        screen
            .getByRole("link", { name: "Source" })
            .querySelector("svg")
            ?.classList.contains("text-muted-foreground"),
    ).toBe(true);
});

it("keeps the full-guide action icon neutral", () => {
    render(
        <HelpDrawer
            target={{ page: "summaries-and-tasks" }}
            onClose={vi.fn()}
        />,
    );
    expect(
        screen
            .getByRole("link", { name: "Open full guide" })
            .querySelector("svg")
            ?.classList.contains("text-muted-foreground"),
    ).toBe(true);
});

it("keeps developer navigation neutral while another section is open", () => {
    render(
        <SettingsNavSidebar
            activeSection="providers"
            keyboardSelectedIndex={0}
            onSectionChange={vi.fn()}
            isHosted={false}
        />,
    );
    const nav = screen.getByRole("button", {
        name: "Developer Tools settings",
    });
    expect(nav.className).not.toMatch(/(?:^| )text-red-|dark:text-red-/);
    expect(nav.querySelector("svg")?.getAttribute("class")).not.toMatch(
        /text-red-/,
    );
});

it("keeps disconnect neutral at rest and red on hover/focus", async () => {
    vi.stubGlobal(
        "fetch",
        vi
            .fn()
            .mockResolvedValue(
                Response.json({ connected: true, server: "global" }),
            ),
    );
    render(<PlaudAccountSection />);
    const trigger = await screen.findByRole("button", { name: "Disconnect" });
    expect(trigger.classList.contains("text-destructive")).toBe(false);
    expect(trigger.classList.contains("text-muted-foreground")).toBe(true);
    expect(trigger.classList.contains("hover:text-red-600")).toBe(true);
    expect(trigger.classList.contains("focus-visible:text-red-600")).toBe(true);
});

it("keeps template deletion neutral, including the disabled last template", () => {
    render(
        <TemplateList
            field="summaryPrompt"
            kind={{ presets: {}, fallbackId: "custom" }}
            presetCopy={{}}
            initialConfig={{
                selectedPrompt: "custom",
                templates: [
                    {
                        id: "custom",
                        name: "Example template",
                        prompt: "Summarize",
                        createdAt: "2026-10-01T00:00:00Z",
                    },
                ],
            }}
            heading="Templates"
            promptHelp="Instructions"
        />,
    );
    const trigger = screen.getByRole("button", {
        name: "Delete Example template",
    });
    expect(trigger).toHaveProperty("disabled", true);
    expect(
        trigger.querySelector("svg")?.classList.contains("text-destructive"),
    ).toBe(false);
    expect(trigger.classList.contains("text-muted-foreground")).toBe(true);
    expect(trigger.classList.contains("focus-visible:text-red-600")).toBe(true);
});

it("presses the access-detail selector and closes it on a second click", async () => {
    const person = {
        subject: "subject",
        name: "Robin Fern",
        username: "robin",
        email: "robin@example.com",
        enabled: true,
        effective: [],
        managed: [],
        local: null,
    };
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
            Response.json(
                url.includes("pending-revocations")
                    ? { people: [] }
                    : url.includes("subjects?")
                      ? { rows: [person], hasMore: false }
                      : {
                            access: {
                                ...person,
                                revision: "revision",
                                self: false,
                                inherited: [],
                            },
                            history: [],
                        },
            ),
        ),
    );
    render(<AccessSection />);
    const trigger = await screen.findByRole("button", { name: /Robin Fern/ });
    expect(trigger.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(trigger);
    await screen.findByRole("button", { name: "Reload" });
    expect(trigger.getAttribute("aria-pressed")).toBe("true");
    expect(trigger.classList.contains("aria-pressed:bg-accent")).toBe(true);
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    fireEvent.click(trigger);
    await screen.findByRole("button", { name: "Reload" });
});

it("uses the Tasks colour for links into the task desk", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(Response.json({ folders: [] })),
    );
    render(<TaskDetail initialTask={task("Follow up", null)} />);
    await act(async () => {});
    expect(
        screen
            .getByRole("link", { name: "Tasks" })
            .classList.contains("text-tasks"),
    ).toBe(true);
});

it.each([
    "Cancel",
    "Escape",
    "Add",
])("keeps Add a nickname inactive and restores focus after %s", async (action) => {
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(Response.json({ success: true })),
    );
    render(
        <OtherNames names={[]} editing={{ target: { personId: "person" } }} />,
    );
    const trigger = screen.getByRole("button", { name: "Add a nickname" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    const input = screen.getByRole("textbox", { name: "New nickname" });
    fireEvent.change(input, { target: { value: "Robin" } });
    fireEvent.click(trigger);
    expect(screen.getByDisplayValue("Robin")).toBeTruthy();
    await act(async () => {
        if (action === "Escape") fireEvent.keyDown(input, { key: "Escape" });
        else fireEvent.click(screen.getByRole("button", { name: action }));
    });
    expect(screen.queryByRole("textbox", { name: "New nickname" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
});
