// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    renderHook,
    screen,
    waitFor,
} from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "@/app/(auth)/login/page";
import { useSettingsNav } from "@/hooks/use-settings-nav";
import {
    clearSsoReturnPath,
    LOGIN_RETURN_PATH_HEADER,
} from "@/lib/auth/return-path";
import { requireApiSession, requireAuth } from "@/lib/auth-server";
import type { SessionAccess } from "@/lib/authz/session-access";
import {
    SSO_ACCESS_DENIED_ERROR,
    SSO_SESSION_ENDED_ERROR,
    SSO_UNAVAILABLE_ERROR,
} from "@/lib/sso/constants";

const {
    requestHeaders,
    getSession,
    sessionAccess,
    social,
    email,
    push,
    refresh,
    redirect,
    ssoEnabled,
    mockEnv,
} = vi.hoisted(() => ({
    requestHeaders: new Headers(),
    getSession: vi.fn(),
    sessionAccess: vi.fn<() => Promise<SessionAccess>>(),
    social: vi.fn().mockResolvedValue({ data: {}, error: null }),
    email: vi.fn().mockResolvedValue({ data: {}, error: null }),
    push: vi.fn(),
    refresh: vi.fn(),
    redirect: vi.fn((path: string): never => {
        throw new Error(path);
    }),
    ssoEnabled: vi.fn(),
    mockEnv: {
        IS_HOSTED: false,
        DISABLE_REGISTRATION: false,
        OIDC_PROVIDER_NAME: "Acme",
    },
}));

vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("next/navigation", () => ({
    redirect,
    useRouter: () => ({ push, refresh }),
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/authz/session-access", () => ({ sessionAccess }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/settings/user-settings", () => ({ getUserSettings: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ signIn: { social, email } }));
vi.mock("@/lib/sso/config", () => ({ isSsoEnabled: ssoEnabled }));
vi.mock("@/lib/smtp", () => ({ isSmtpConfigured: () => false }));
vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("next-intl/server", () => ({
    getExtracted: async () => (message: string) => message,
    getLocale: async () => "en",
}));
vi.mock("@/components/auth/auth-chrome", () => ({
    SelfHostAuthChrome: ({ children }: PropsWithChildren) => children,
    HostedAuthChrome: ({ children }: PropsWithChildren) => children,
}));
vi.mock("posthog-js", () => ({ default: { __loaded: false } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue(null);
    ssoEnabled.mockReturnValue(false);
    mockEnv.IS_HOSTED = false;
    requestHeaders.delete(LOGIN_RETURN_PATH_HEADER);
    window.history.replaceState({}, "", "/");
    localStorage.clear();
});

afterEach(() => {
    cleanup();
    clearSsoReturnPath();
});

async function openLogin(path: string, fragment = "") {
    requestHeaders.set(LOGIN_RETURN_PATH_HEADER, path);
    await expect(requireAuth()).rejects.toThrow(/^\/login/);
    const target = redirect.mock.lastCall?.[0];
    if (!target) throw new Error("Missing login redirect");
    window.history.replaceState({}, "", `${target}${fragment}`);
    const params = new URLSearchParams(window.location.search);
    render(
        await LoginPage({
            searchParams: Promise.resolve({
                returnTo: params.get("returnTo") ?? undefined,
                error: params.get("error") ?? undefined,
            }),
        }),
    );
    return target;
}

async function signIn() {
    if (ssoEnabled()) {
        fireEvent.click(
            screen.getByRole("button", { name: "Sign in with Acme" }),
        );
        await waitFor(() => expect(social).toHaveBeenCalledOnce());
        const callbackURL = social.mock.lastCall?.[0].callbackURL as string;
        const url = new URL(callbackURL);
        return `${url.pathname}${url.search}${url.hash}`;
    }
    fireEvent.change(screen.getByLabelText("Email"), {
        target: { value: "example@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
        target: { value: "example-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    await waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(refresh).toHaveBeenCalledOnce();
    return push.mock.lastCall?.[0] as string;
}

describe.each([
    { mode: "self-host password", hosted: false, sso: false },
    { mode: "hosted password", hosted: true, sso: false },
    { mode: "SSO", hosted: false, sso: true },
])("cold deep links through $mode", ({ hosted, sso }) => {
    beforeEach(() => {
        mockEnv.IS_HOSTED = hosted;
        ssoEnabled.mockReturnValue(sso);
    });

    it.each([
        "/dashboard?meeting=example",
        "/tasks/example",
        "/almanac/example",
    ])("returns to %s after signing in", async (path) => {
        expect(await openLogin(path)).toBe(
            `/login?returnTo=${encodeURIComponent(path)}`,
        );
        expect(await signIn()).toBe(path);
    });

    it("opens the inherited notifications section ahead of saved settings", async () => {
        localStorage.setItem("settings-last-section", "storage");
        await openLogin("/settings", "#notifications");
        const destination = await signIn();
        expect(destination).toBe("/settings#notifications");
        window.history.replaceState({}, "", destination);
        const { result } = renderHook(() =>
            useSettingsNav(true, () => {}, hosted),
        );
        expect(result.current.activeSection).toBe("notifications");
        expect(window.location.hash).toBe("#notifications");
        expect(localStorage.getItem("settings-last-section")).toBe(
            "notifications",
        );
    });

    it("keeps an existing returnTo fragment", async () => {
        await openLogin("/settings#storage", "#notifications");
        expect(await signIn()).toBe("/settings#storage");
    });

    it("keeps a plain dashboard open bare and ignores an unrelated fragment", async () => {
        expect(await openLogin("/dashboard", "#notifications")).toBe("/login");
        expect(await signIn()).toBe("/dashboard");
    });
});

describe("server login redirect", () => {
    it.each([
        ["ended", SSO_SESSION_ENDED_ERROR],
        ["not-granted", SSO_ACCESS_DENIED_ERROR],
        ["unavailable", SSO_UNAVAILABLE_ERROR],
        ["org-account", SSO_SESSION_ENDED_ERROR],
    ] as const)("keeps the destination and error for %s", async (reason, code) => {
        getSession.mockResolvedValue({
            user: { id: "example-user" },
            session: { id: "example-session" },
        });
        sessionAccess.mockResolvedValue({ ok: false, reason });
        requestHeaders.set(
            LOGIN_RETURN_PATH_HEADER,
            "/dashboard?meeting=example",
        );
        await expect(requireAuth()).rejects.toThrow(
            `/login?error=${code}&returnTo=%2Fdashboard%3Fmeeting%3Dexample`,
        );
    });

    it.each([
        "//evil.example",
        "/%2fevil.example",
        "https://evil.example",
    ])("rejects a hostile forwarded destination %s", async (path) => {
        expect(await openLogin(path)).toBe("/login");
        expect(await signIn()).toBe("/dashboard");
    });

    it("falls back to bare login without a forwarding header", async () => {
        await expect(requireAuth()).rejects.toThrow(/^\/login$/);
    });

    it("keeps signed-out API requests unauthorized", async () => {
        await expect(
            requireApiSession(
                new Request("https://example.com/api/recordings"),
            ),
        ).rejects.toMatchObject({ statusCode: 401 });
        expect(redirect).not.toHaveBeenCalled();
    });
});
