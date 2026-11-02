// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/components/auth/login-form";
import { SsoLogin } from "@/components/auth/sso-login";
import {
    clearSsoReturnPath,
    rememberSsoReturnPath,
} from "@/lib/auth/return-path";

const { email, oauth2, push, refresh } = vi.hoisted(() => ({
    email: vi.fn().mockResolvedValue({ data: {}, error: null }),
    oauth2: vi.fn().mockResolvedValue({ data: {}, error: null }),
    push: vi.fn(),
    refresh: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({ signIn: { email, oauth2 } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("posthog-js", () => ({ default: { __loaded: false } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    clearSsoReturnPath();
});

describe("login return destination", () => {
    it.each([
        ["/dashboard?x=1", "/dashboard?x=1"],
        ["//evil.example", "/dashboard"],
    ])("returns password login to the validated path %s", async (returnTo, destination) => {
        render(<LoginForm returnTo={returnTo} />);
        fireEvent.change(screen.getByLabelText("Email"), {
            target: { value: "jitka@example.com" },
        });
        fireEvent.change(screen.getByLabelText("Password"), {
            target: { value: "test-password" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
        await waitFor(() => expect(push).toHaveBeenCalledWith(destination));
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("passes the return path to the SSO callback and keeps it for retries", () => {
        render(<SsoLogin providerName="Acme" returnTo="/tasks?x=1#notes" />);
        fireEvent.click(
            screen.getByRole("button", { name: "Sign in with Acme" }),
        );
        expect(oauth2).toHaveBeenCalledWith({
            providerId: "oidc",
            callbackURL: `${window.location.origin}/tasks?x=1#notes`,
            errorCallbackURL: `${window.location.origin}/login?returnTo=%2Ftasks%3Fx%3D1%23notes`,
        });
    });

    it("refuses an external SSO callback", () => {
        render(
            <SsoLogin providerName="Acme" returnTo="https://evil.example" />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Sign in with Acme" }),
        );
        expect(oauth2).toHaveBeenCalledWith(
            expect.objectContaining({
                callbackURL: `${window.location.origin}/dashboard`,
            }),
        );
    });
    it("keeps the destination when provider cancellation omits returnTo", async () => {
        const first = render(
            <SsoLogin providerName="Acme" returnTo="/tasks?x=1#notes" />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Sign in with Acme" }),
        );
        await waitFor(() => expect(oauth2).toHaveBeenCalledOnce());
        first.unmount();
        render(<SsoLogin providerName="Acme" error="access_denied" />);
        fireEvent.click(
            screen.getByRole("button", { name: "Sign in with Acme" }),
        );
        expect(oauth2).toHaveBeenLastCalledWith(
            expect.objectContaining({
                callbackURL: `${window.location.origin}/tasks?x=1#notes`,
            }),
        );
    });

    it("validates a tampered stored destination before retrying", () => {
        rememberSsoReturnPath("/tasks");
        const key = window.sessionStorage.key(0);
        if (!key) throw new Error("Missing retry storage key");
        window.sessionStorage.setItem(key, "//evil.example");
        render(<SsoLogin providerName="Acme" error="access_denied" />);
        fireEvent.click(
            screen.getByRole("button", { name: "Sign in with Acme" }),
        );
        expect(oauth2).toHaveBeenLastCalledWith(
            expect.objectContaining({
                callbackURL: `${window.location.origin}/dashboard`,
            }),
        );
    });

    it("starts sign-in even when tab storage is unavailable", () => {
        const get = vi
            .spyOn(Storage.prototype, "getItem")
            .mockImplementation(() => {
                throw new Error("Unavailable");
            });
        const set = vi
            .spyOn(Storage.prototype, "setItem")
            .mockImplementation(() => {
                throw new Error("Unavailable");
            });
        render(<SsoLogin providerName="Acme" error="access_denied" />);
        fireEvent.click(
            screen.getByRole("button", { name: "Sign in with Acme" }),
        );
        expect(oauth2).toHaveBeenCalledWith(
            expect.objectContaining({
                callbackURL: `${window.location.origin}/dashboard`,
            }),
        );
        get.mockRestore();
        set.mockRestore();
    });
});
