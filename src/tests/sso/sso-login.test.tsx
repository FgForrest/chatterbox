// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

const { social } = vi.hoisted(() => ({
    social: vi.fn().mockResolvedValue({ data: { url: "x" }, error: null }),
}));
vi.mock("@/lib/auth-client", () => ({ signIn: { social } }));

import { SsoLogin } from "@/components/auth/sso-login";

afterEach(() => {
    cleanup();
    social.mockClear();
});

describe("SsoLogin", () => {
    it("names the provider and starts its sign-in", () => {
        render(<SsoLogin providerName="Acme SSO" />);
        fireEvent.click(
            screen.getByRole("button", { name: "Sign in with Acme SSO" }),
        );
        expect(social).toHaveBeenCalledWith({
            provider: "oidc",
            callbackURL: `${window.location.origin}/dashboard`,
            errorCallbackURL: `${window.location.origin}/login`,
        });
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("shows the unavailable message when discovery prevents starting sign-in", async () => {
        const errorToast = vi
            .spyOn(toast, "error")
            .mockImplementation(() => "toast");
        social.mockResolvedValueOnce({
            data: null,
            error: { code: "SSO_UNAVAILABLE" },
        });
        try {
            render(<SsoLogin providerName="Acme SSO" />);
            fireEvent.click(
                screen.getByRole("button", { name: "Sign in with Acme SSO" }),
            );
            await waitFor(() =>
                expect(errorToast).toHaveBeenCalledWith(
                    "Your access could not be verified with the identity provider right now. Try again shortly.",
                ),
            );
            expect(
                screen
                    .getByRole("button", { name: "Sign in with Acme SSO" })
                    .hasAttribute("disabled"),
            ).toBe(false);
        } finally {
            errorToast.mockRestore();
        }
    });

    it.each([
        ["account_not_linked", "has not verified the address"],
        ["unable_to_link_account", "This identity cannot sign in"],
        ["ORG_ACCOUNT_SSO", "This identity cannot sign in"],
        ["signup_disabled", "does not accept new accounts"],
        ["email_is_missing", "did not share an email address"],
        ["email_not_found", "did not share an email address"],
        ["access_denied", "cancelled at the identity provider"],
        ["SSO_ACCESS_DENIED", "has no access to this application"],
        ["SSO_UNAVAILABLE", "could not be verified with the identity provider"],
        ["SSO_TOKEN_INVALID", "answer could not be verified"],
        ["SSO_ISSUER_MISMATCH", "belongs to a different identity provider"],
        ["SSO_SESSION_ENDED", "Your session has ended"],
        ["anything_else", "Sign-in failed. Please try again."],
    ])("explains the %s error", (code, text) => {
        render(<SsoLogin providerName="Acme SSO" error={code} />);
        expect(screen.getByRole("alert").textContent).toContain(text);
    });
});
