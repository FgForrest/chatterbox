// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/components/auth/login-form";
import { NewsletterForm } from "@/components/marketing/newsletter-form";
import { PlaudConnectTabs } from "@/components/plaud-connect-tabs";
import { FolderCombobox } from "@/components/recordings/folder-combobox";
import { ProviderFormDialog } from "@/components/settings/provider-form-dialog";
import { Input } from "@/components/ui/input";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { Textarea } from "@/components/ui/textarea";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/auth-client", () => ({ signIn: { email: vi.fn() } }));
vi.mock("posthog-js", () => ({ default: { __loaded: false } }));

const optOutAttributes = {
    "data-bwignore": "true",
    "data-1p-ignore": "true",
    "data-lpignore": "true",
    "data-form-type": "other",
};

function expectOptOut(field: Element, autoComplete = "off") {
    expect(field.getAttribute("autocomplete")).toBe(autoComplete);
    for (const [attribute, value] of Object.entries(optOutAttributes)) {
        expect(field.getAttribute(attribute)).toBe(value);
    }
}

function expectCredential(field: Element, autoComplete: string) {
    expect(field.getAttribute("autocomplete")).toBe(autoComplete);
    for (const attribute of Object.keys(optOutAttributes)) {
        expect(field.hasAttribute(attribute)).toBe(false);
    }
}

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("password manager field defaults", () => {
    it("opts ordinary Input and Textarea fields out", () => {
        render(
            <>
                <Input aria-label="Name" />
                <Textarea aria-label="Notes" />
            </>,
        );
        expectOptOut(screen.getByRole("textbox", { name: "Name" }));
        expectOptOut(screen.getByRole("textbox", { name: "Notes" }));
    });

    it("opts non-credential input types out by default", () => {
        const { container } = render(
            <>
                <Input type="email" aria-label="Person email" />
                <Input type="password" aria-label="API key" />
            </>,
        );
        for (const field of container.querySelectorAll("input")) {
            expectOptOut(field);
        }
    });

    it.each([
        "off",
        "new-password",
        "current-password",
    ])("keeps non-login secrets opted out with new-password when autocomplete is %s", (autoComplete) => {
        render(
            <Input
                type="password"
                secret
                autoComplete={autoComplete}
                aria-label="API key"
            />,
        );
        const field = screen.getByLabelText("API key");
        expectOptOut(field, "new-password");
        expect(field.hasAttribute("secret")).toBe(false);
    });

    it("restores credential defaults when a secret field becomes a site password", () => {
        const view = render(
            <Input
                type="password"
                secret
                autoComplete="current-password"
                aria-label="Password"
            />,
        );
        const field = screen.getByLabelText("Password");
        expectOptOut(field, "new-password");
        view.rerender(
            <Input
                type="password"
                autoComplete="current-password"
                aria-label="Password"
            />,
        );
        expectCredential(field, "current-password");
    });

    it.each([
        "username",
        "email",
        "current-password",
        "new-password",
        "one-time-code",
        "section-login username webauthn",
        "section-signup new-password",
    ])("allows autofill for the %s credential token", (autoComplete) => {
        const { container } = render(
            <>
                <Input autoComplete={autoComplete} />
                <Textarea autoComplete={autoComplete} />
            </>,
        );
        for (const field of container.querySelectorAll("input, textarea")) {
            expectCredential(field, autoComplete);
        }
    });

    it.each([
        "off",
        "on",
        "name",
        "organization",
        "not-username",
    ])("keeps %s fields opted out", (autoComplete) => {
        render(<Input autoComplete={autoComplete} />);
        expectOptOut(screen.getByRole("textbox"));
    });

    it("removes and restores opt-outs when a field changes between credential and ordinary uses", () => {
        const view = render(<Input />);
        const field = screen.getByRole("textbox");
        expectOptOut(field);
        view.rerender(<Input autoComplete="current-password" />);
        expectCredential(field, "current-password");
        view.rerender(<Input />);
        expectOptOut(field);
    });

    it("opts the shared combobox search out and still filters and selects options", () => {
        const onValueChange = vi.fn();
        render(
            <SearchCombobox
                aria-label="Source"
                options={[
                    { value: "automatic", label: "Automatic" },
                    { value: "recording", label: "Weekly meeting" },
                ]}
                value="automatic"
                onValueChange={onValueChange}
            />,
        );
        fireEvent.click(screen.getByRole("combobox"));
        const search = screen.getByPlaceholderText<HTMLInputElement>("Search…");
        expectOptOut(search);
        expect(search.type).toBe("search");
        fireEvent.change(search, { target: { value: "Weekly" } });
        expect(screen.queryByRole("option", { name: "Automatic" })).toBeNull();
        fireEvent.click(screen.getByRole("option", { name: "Weekly meeting" }));
        expect(onValueChange).toHaveBeenCalledWith("recording");
    });

    it("forwards the opt-out attributes and search type through the folder picker's cmdk slot", () => {
        render(
            <FolderCombobox entries={[]} value="" onValueChange={vi.fn()} />,
        );
        fireEvent.click(screen.getByRole("combobox"));
        const search =
            screen.getByPlaceholderText<HTMLInputElement>("Find a folder…");
        expectOptOut(search);
        expect(search.type).toBe("search");
    });
});

describe("credential and non-credential forms", () => {
    it("allows password managers on the sign-in email and password", () => {
        render(<LoginForm />);
        expectCredential(screen.getByLabelText("Email"), "email");
        expectCredential(screen.getByLabelText("Password"), "current-password");
    });

    it("allows autofill for the Plaud sign-in email and verification code", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(
                    JSON.stringify({
                        otpToken: "example-otp-token",
                        apiBase: "https://example.com",
                    }),
                ),
            ),
        );
        render(<PlaudConnectTabs onConnected={vi.fn()} />);
        fireEvent.click(screen.getByRole("tab", { name: "Email code" }));
        const email = screen.getByLabelText("Plaud Email");
        expectCredential(email, "username");
        fireEvent.change(email, { target: { value: "person@example.com" } });
        fireEvent.click(
            screen.getByRole("button", { name: "Send Verification Code" }),
        );
        expectCredential(
            await screen.findByLabelText("Verification Code"),
            "one-time-code",
        );
    });

    it("keeps the newsletter email autofillable and the honeypot out", () => {
        const { container } = render(<NewsletterForm />);
        expectCredential(screen.getByLabelText("Email address"), "email");
        const honeypot = container.querySelector("#newsletter-hp");
        expect(honeypot).not.toBeNull();
        if (honeypot) expectOptOut(honeypot);
    });

    it("opts the Plaud access-token paste box out with new-password", () => {
        render(<PlaudConnectTabs onConnected={vi.fn()} />);
        fireEvent.click(screen.getByRole("tab", { name: "Paste token" }));
        expectOptOut(screen.getByLabelText("Access token"), "new-password");
    });

    describe.each([
        "personal",
        "organization",
    ] as const)("%s provider keys", (scope) => {
        it.each([
            "add",
            "edit",
            "duplicate",
        ] as const)("opts the masked API key out with new-password in %s mode", (mode) => {
            render(
                <ProviderFormDialog
                    scope={scope}
                    mode={mode}
                    provider={
                        mode === "add"
                            ? null
                            : {
                                  id: "example-provider",
                                  provider: "Custom",
                                  baseUrl: "https://example.com/v1",
                                  defaultModel: "example-model",
                              }
                    }
                    open
                    isHosted={false}
                    onOpenChange={vi.fn()}
                    onSuccess={vi.fn()}
                />,
            );
            expectOptOut(screen.getByLabelText("API Key"), "new-password");
        });
    });
});
