// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginPage from "@/app/(auth)/login/page";
import {
    clearSsoReturnPath,
    rememberSsoReturnPath,
} from "@/lib/auth/return-path";

const { social, email, push, refresh, redirect, getSession, ssoEnabled } =
    vi.hoisted(() => ({
        social: vi.fn().mockResolvedValue({ data: {}, error: null }),
        email: vi.fn().mockResolvedValue({ data: {}, error: null }),
        push: vi.fn(),
        refresh: vi.fn(),
        redirect: vi.fn(() => {
            throw new Error("NEXT_REDIRECT");
        }),
        getSession: vi
            .fn<() => Promise<{ user: { id: string } } | null>>()
            .mockResolvedValue(null),
        ssoEnabled: vi.fn().mockReturnValue(true),
    }));

vi.mock("@/lib/auth-client", () => ({ signIn: { social, email } }));
vi.mock("@/lib/auth-server", () => ({ getSession }));
vi.mock("@/lib/sso/config", () => ({ isSsoEnabled: ssoEnabled }));
vi.mock("@/lib/smtp", () => ({ isSmtpConfigured: () => false }));
vi.mock("@/lib/env", () => ({
    env: {
        IS_HOSTED: false,
        DISABLE_REGISTRATION: false,
        OIDC_PROVIDER_NAME: "Acme",
    },
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push, refresh }),
    redirect,
}));
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

afterEach(() => {
    cleanup();
    clearSsoReturnPath();
    vi.clearAllMocks();
    getSession.mockResolvedValue(null);
    ssoEnabled.mockReturnValue(true);
});

describe("login page return destination wiring", () => {
    it.each([
        [undefined, "/tasks?x=1#notes"],
        [
            "/recordings?view=recent#selected",
            "/recordings?view=recent#selected",
        ],
        ["/dashboard", "/dashboard"],
        ["//evil.example", "/dashboard"],
    ])("retries provider cancellation with returnTo=%s", async (returnTo, destination) => {
        rememberSsoReturnPath("/tasks?x=1#notes");
        render(
            await LoginPage({
                searchParams: Promise.resolve({
                    error: "access_denied",
                    ...(returnTo === undefined ? {} : { returnTo }),
                }),
            }),
        );
        expect(screen.getByRole("alert").textContent).toContain(
            "Sign-in was cancelled at the identity provider.",
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Sign in with Acme" }),
        );
        expect(social).toHaveBeenCalledWith(
            expect.objectContaining({
                callbackURL: `${window.location.origin}${destination}`,
            }),
        );
    });

    it.each([
        [undefined, "/dashboard"],
        ["/tasks?x=1#notes", "/tasks?x=1#notes"],
        ["//evil.example", "/dashboard"],
    ])("redirects a signed-in visitor with returnTo=%s", async (returnTo, destination) => {
        getSession.mockResolvedValue({ user: { id: "example-user" } });
        await expect(
            LoginPage({ searchParams: Promise.resolve({ returnTo }) }),
        ).rejects.toThrow("NEXT_REDIRECT");
        expect(redirect).toHaveBeenCalledWith(destination);
    });

    it.each([
        [undefined, "/dashboard"],
        ["/tasks?x=1#notes", "/tasks?x=1#notes"],
    ])("returns password login with returnTo=%s", async (returnTo, destination) => {
        ssoEnabled.mockReturnValue(false);
        render(
            await LoginPage({
                searchParams: Promise.resolve({ returnTo }),
            }),
        );
        fireEvent.change(screen.getByLabelText("Email"), {
            target: { value: "jitka@example.com" },
        });
        fireEvent.change(screen.getByLabelText("Password"), {
            target: { value: "test-password" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
        await waitFor(() => expect(push).toHaveBeenCalledWith(destination));
        expect(refresh).toHaveBeenCalledOnce();
    });
});
