// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toast, oauth2 } = vi.hoisted(() => ({
    oauth2: vi.fn().mockResolvedValue({}),
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/auth-client", () => ({ signIn: { oauth2 } }));
vi.mock("@/components/confirm-dialog", () => ({
    useConfirm: () => async (options: { onConfirm: () => Promise<void> }) => {
        await options.onConfirm();
        return true;
    },
}));

import { AccessSection } from "@/components/settings-sections/access-section";

const PAT = {
    subject: "pat-sub",
    username: "pat",
    email: "pat@example.test",
    name: "Pat Example",
    enabled: true,
    effective: ["use", "org.curate"],
    managed: ["use"],
    local: {
        userId: "u-pat",
        email: "pat@example.test",
        name: "Pat",
        lastSsoLoginAt: null,
    },
};

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

const PENDING = {
    at: "2026-10-13T10:00:00.000Z",
    correlationId: "c1",
    action: "change",
    requested: { remove: ["use"] },
    outcome: "applied",
    revocation: "pending",
};

const PAT_SESSIONS_OPEN = {
    subject: "pat-sub",
    username: "pat",
    email: "pat@example.test",
    name: "Pat Example",
};

let fetchMock: ReturnType<typeof vi.fn>;
let effective: string[];
let history: unknown[];
let unfinished: unknown[];

beforeEach(() => {
    effective = PAT.effective;
    history = [PENDING];
    unfinished = [];
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/access/subjects?")) {
            return json({ rows: [{ ...PAT, effective }], hasMore: false });
        }
        if (url === "/api/access/pending-revocations") {
            return json({ people: unfinished });
        }
        if (
            url === "/api/access/subjects/pat-sub/revoke-sessions" &&
            init?.method === "POST"
        ) {
            unfinished = [];
            history = [
                {
                    at: "2026-10-13T12:00:00.000Z",
                    correlationId: "c9",
                    action: "revoke-sessions",
                    requested: {},
                    outcome: "applied",
                    revocation: "done",
                },
                PENDING,
            ];
            return json({ revocation: "done", correlationId: "c9" });
        }
        if (url === "/api/access/subjects/pat-sub" && !init?.method) {
            return json({
                access: {
                    ...PAT,
                    effective,
                    inherited: [
                        { capability: "org.curate", sources: ["direct-role"] },
                    ],
                    revision: "rev-1",
                    self: false,
                },
                history,
            });
        }
        if (
            url === "/api/access/subjects/pat-sub" &&
            init?.method === "PATCH"
        ) {
            return json(
                {
                    error: "Provider refused",
                    code: "PROVIDER_DENIED",
                },
                403,
            );
        }
        throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("AccessSection", () => {
    it("lists people, explains inherited access and keeps it switched on and locked", async () => {
        render(<AccessSection />);
        fireEvent.click(await screen.findByText("Pat Example"));
        const curate = await screen.findByRole("switch", {
            name: "Curates the Organization",
        });
        expect(curate.getAttribute("aria-checked")).toBe("true");
        expect(curate.hasAttribute("disabled")).toBe(true);
        expect(
            screen.getByText(/Also granted through a role assigned directly/),
        ).toBeTruthy();
        expect(document.body.innerHTML).not.toMatch(/secret|eyJ/i);
        expect(screen.queryByText("Sessions still open")).toBeNull();
    });

    it("names the people whose provider sessions are still open until they are ended", async () => {
        effective = ["org.curate"];
        unfinished = [PAT_SESSIONS_OPEN];
        render(<AccessSection />);
        expect(
            await screen.findByText(
                /these people's sessions at the identity provider are still open/,
            ),
        ).toBeTruthy();
        expect(await screen.findByText("Sessions still open")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Pat Example" }));
        fireEvent.click(
            await screen.findByRole("button", { name: "End sessions" }),
        );
        await waitFor(() =>
            expect(toast.success).toHaveBeenCalledWith("Sessions ended"),
        );
        await waitFor(() =>
            expect(
                screen.queryByText(
                    /these people's sessions at the identity provider are still open/,
                ),
            ).toBeNull(),
        );
        expect(screen.queryByText("Sessions still open")).toBeNull();
        expect(
            screen.queryByText(
                /ending the sessions at the identity provider is pending/,
            ),
        ).toBeNull();
    });

    it("offers to end sessions while the newest revocation is pending and access is gone", async () => {
        effective = ["org.curate"];
        render(<AccessSection />);
        fireEvent.click(await screen.findByText("Pat Example"));
        expect(
            await screen.findByText(
                /ending the sessions at the identity provider is pending/,
            ),
        ).toBeTruthy();
        expect(screen.getByText(/Access to Chatterbox · done$/)).toBeTruthy();
    });

    it("drops the retry once a later revocation ended the sessions", async () => {
        effective = ["org.curate"];
        history = [
            {
                at: "2026-10-13T11:00:00.000Z",
                correlationId: "c2",
                action: "revoke-sessions",
                requested: {},
                outcome: "applied",
                revocation: "done",
            },
            {
                at: "2026-10-13T10:30:00.000Z",
                correlationId: "c3",
                action: "change",
                requested: { remove: ["access.manage"] },
                outcome: "self-lockout",
                revocation: "not-needed",
            },
            PENDING,
        ];
        render(<AccessSection />);
        fireEvent.click(await screen.findByText("Pat Example"));
        expect(
            await screen.findByText(/refused: your own access$/),
        ).toBeTruthy();
        expect(
            screen.queryByText(
                /ending the sessions at the identity provider is pending/,
            ),
        ).toBeNull();
    });

    it("drops the retry once access is given back", async () => {
        render(<AccessSection />);
        fireEvent.click(await screen.findByText("Pat Example"));
        await screen.findByText(/Access to Chatterbox · done$/);
        expect(
            screen.queryByText(
                /ending the sessions at the identity provider is pending/,
            ),
        ).toBeNull();
    });

    it("sends only a capability and the revision, and explains a provider refusal", async () => {
        render(<AccessSection />);
        fireEvent.click(await screen.findByText("Pat Example"));
        const admin = await screen.findByRole("switch", {
            name: "Manages access",
        });
        fireEvent.click(admin);
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                expect.stringContaining(
                    "The identity provider refused this change",
                ),
            ),
        );
        const patch = fetchMock.mock.calls.find(
            ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
        );
        expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
            add: ["access.manage"],
            revision: "rev-1",
        });
    });
    it("offers a fresh provider authentication after an expired admin login", async () => {
        render(<AccessSection />);
        fireEvent.click(await screen.findByText("Pat Example"));
        const admin = await screen.findByRole("switch", {
            name: "Manages access",
        });
        fetchMock.mockResolvedValueOnce(
            json(
                { code: "REAUTHENTICATION_REQUIRED", error: "Sign in again" },
                401,
            ),
        );
        fireEvent.click(admin);
        fireEvent.click(
            await screen.findByRole("button", {
                name: "Sign in again to manage access.",
            }),
        );
        await waitFor(() =>
            expect(oauth2).toHaveBeenCalledWith({
                providerId: "oidc",
                callbackURL: "http://localhost:3000/settings#access",
                errorCallbackURL: "/login",
                additionalData: { reauthenticate: true },
            }),
        );
    });
});
