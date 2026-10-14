/**
 * The browser's side of a web sign-in through a real Keycloak: start it at
 * the app, sign in on Keycloak's login form, and bring the code back to
 * the app's callback. Returns where the app sends the browser and the
 * session cookie it set.
 */

import { expect } from "vitest";
import { TEST_APP_URL } from "@/tests/identity/keycloak-fixture";

function cookiesFrom(response: Response): string {
    return response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
}

export async function keycloakLogin(
    handler: (request: Request) => Promise<Response>,
    person: { username: string; password: string },
): Promise<{ location: string; cookie: string }> {
    const start = await handler(
        new Request(`${TEST_APP_URL}/api/auth/sign-in/oauth2`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                origin: TEST_APP_URL,
            },
            body: JSON.stringify({
                providerId: "oidc",
                callbackURL: "/dashboard",
                errorCallbackURL: "/login",
            }),
        }),
    );
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };

    const page = await fetch(url, { redirect: "manual" });
    expect(page.status).toBe(200);
    const keycloakCookies = cookiesFrom(page);
    const html = await page.text();
    const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/
        .exec(html)?.[1]
        ?.replaceAll("&amp;", "&");
    if (!action) throw new Error("no Keycloak login form");
    const login = await fetch(action, {
        method: "POST",
        redirect: "manual",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: keycloakCookies,
        },
        body: new URLSearchParams({
            username: person.username,
            password: person.password,
            credentialId: "",
        }),
    });
    expect(login.status).toBe(302);
    const callbackUrl = login.headers.get("location") ?? "";
    expect(
        callbackUrl.startsWith(`${TEST_APP_URL}/api/auth/oauth2/callback/oidc`),
    ).toBe(true);

    const callback = await handler(
        new Request(callbackUrl, { headers: { cookie: cookiesFrom(start) } }),
    );
    expect(callback.status).toBe(302);
    return {
        location: callback.headers.get("location") ?? "",
        cookie: cookiesFrom(callback),
    };
}
