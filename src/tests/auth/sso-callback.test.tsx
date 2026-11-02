// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { betterAuth } from "better-auth";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SsoLogin } from "@/components/auth/sso-login";
import { clearSsoReturnPath } from "@/lib/auth/return-path";

const { handlerFetch } = vi.hoisted(() => {
    const handlerFetch = vi.fn();
    vi.stubGlobal("fetch", handlerFetch);
    return { handlerFetch };
});

const origin = window.location.origin;
const auth = betterAuth({
    baseURL: origin,
    secret: "test-secret-for-callback-validation-only",
    logger: { disabled: true },
    advanced: { disableOriginCheck: false },
    account: { storeStateStrategy: "cookie" },
    onAPIError: { errorURL: `${origin}/login` },
    plugins: [
        genericOAuth({
            config: [
                {
                    providerId: "oidc",
                    clientId: "test-client",
                    clientSecret: "test-secret",
                    authorizationUrl: "https://idp.example.com/authorize",
                    tokenUrl: "https://idp.example.com/token",
                },
            ],
        }),
    ],
});

afterEach(() => {
    cleanup();
    clearSsoReturnPath();
    vi.unstubAllGlobals();
});

function connectHandler() {
    const responses: Response[] = [];
    handlerFetch
        .mockReset()
        .mockImplementation(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const request = new Request(
                    input instanceof Request
                        ? input
                        : new URL(String(input), origin),
                    init,
                );
                const response = await auth.handler(request);
                responses.push(response.clone());
                if (!response.ok) return response;
                const body: unknown = await response.json();
                return Response.json({
                    ...(body as Record<string, unknown>),
                    redirect: false,
                });
            },
        );
    vi.stubGlobal("fetch", handlerFetch);
    return responses;
}

describe("SSO callbacks through better-auth", () => {
    it.each([
        "/tasks?x=1#notes",
        "/dashboard?filter=a:b",
    ])("starts sign-in for %s through the real callback validator", async (returnTo) => {
        const rejected = await auth.handler(
            new Request(`${origin}/api/auth/sign-in/oauth2`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    providerId: "oidc",
                    callbackURL: returnTo,
                }),
            }),
        );
        expect(rejected.status).toBe(403);
        expect(await rejected.json()).toEqual(
            expect.objectContaining({ code: "INVALID_CALLBACK_URL" }),
        );
        const responses = connectHandler();
        render(<SsoLogin providerName="Acme" returnTo={returnTo} />);
        fireEvent.click(
            screen.getByRole("button", { name: "Sign in with Acme" }),
        );
        await waitFor(() => expect(responses).toHaveLength(1));
        expect(responses[0].status).toBe(200);
        expect(await responses[0].json()).toEqual(
            expect.objectContaining({
                url: expect.stringContaining(
                    "https://idp.example.com/authorize?",
                ),
            }),
        );
    });

    it("retains the destination after the real provider-cancellation redirect", async () => {
        const responses = connectHandler();
        const first = render(
            <SsoLogin providerName="Acme" returnTo="/tasks?x=1#notes" />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Sign in with Acme" }),
        );
        await waitFor(() => expect(responses).toHaveLength(1));
        const cancellation = await auth.handler(
            new Request(
                `${origin}/api/auth/oauth2/callback/oidc?error=access_denied&state=example`,
            ),
        );
        expect(cancellation.status).toBe(302);
        const retry = new URL(
            cancellation.headers.get("location") ?? "",
            origin,
        );
        expect(retry.pathname).toBe("/login");
        expect(retry.searchParams.has("returnTo")).toBe(false);
        first.unmount();
        render(
            <SsoLogin
                providerName="Acme"
                error={retry.searchParams.get("error") ?? undefined}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Sign in with Acme" }),
        );
        await waitFor(() => expect(responses).toHaveLength(2));
        expect(responses[1].status).toBe(200);
        const request = handlerFetch.mock.calls[1];
        expect(JSON.parse(String(request[1]?.body))).toEqual(
            expect.objectContaining({
                callbackURL: `${origin}/tasks?x=1#notes`,
            }),
        );
    });
});
