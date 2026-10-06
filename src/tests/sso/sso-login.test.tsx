// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { oauth2 } = vi.hoisted(() => ({
    oauth2: vi.fn().mockResolvedValue({ data: { url: "x" }, error: null }),
}));
vi.mock("@/lib/auth-client", () => ({ signIn: { oauth2 } }));

import { SsoLogin } from "@/components/auth/sso-login";

afterEach(() => {
    cleanup();
    oauth2.mockClear();
});

describe("SsoLogin", () => {
    it("names the provider and starts its sign-in", () => {
        render(<SsoLogin providerName="Acme SSO" />);
        fireEvent.click(
            screen.getByRole("button", { name: "Sign in with Acme SSO" }),
        );
        expect(oauth2).toHaveBeenCalledWith({
            providerId: "oidc",
            callbackURL: "/dashboard",
            errorCallbackURL: "/login",
        });
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it.each([
        ["account_not_linked", "has not verified the address"],
        ["unable_to_link_account", "This identity cannot sign in"],
        ["ORG_ACCOUNT_SSO", "This identity cannot sign in"],
        ["email_is_missing", "did not share an email address"],
        ["access_denied", "cancelled at the identity provider"],
        ["anything_else", "Sign-in failed. Please try again."],
    ])("explains the %s error", (code, text) => {
        render(<SsoLogin providerName="Acme SSO" error={code} />);
        expect(screen.getByRole("alert").textContent).toContain(text);
    });
});
