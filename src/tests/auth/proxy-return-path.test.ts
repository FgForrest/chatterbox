import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOGIN_RETURN_PATH_HEADER } from "@/lib/auth/return-path";
import { config, proxy } from "@/proxy";

const mockEnv = vi.hoisted(() => ({
    APP_URL: "https://example.com",
    ADMIN_HOSTNAME: undefined as string | undefined,
}));
vi.mock("@/lib/env", () => ({ env: mockEnv }));

const forwardedHeader = `x-middleware-request-${LOGIN_RETURN_PATH_HEADER}`;

beforeEach(() => {
    mockEnv.ADMIN_HOSTNAME = undefined;
});

describe("proxy login destination", () => {
    it.each([
        ["/dashboard?meeting=example", "/dashboard?meeting=example"],
        [
            "/dashboard?filter=a:b&example=%20",
            "/dashboard?filter=a:b&example=%20",
        ],
        ["/tasks/example", "/tasks/example"],
    ])("forwards %s after overwriting a forged header", (path, expected) => {
        expect(unstable_doesMiddlewareMatch({ config, url: path })).toBe(true);
        const request = new NextRequest(`https://example.com${path}`, {
            headers: {
                host: "example.com",
                [LOGIN_RETURN_PATH_HEADER]: "/tasks/forged",
                cookie: "session=example",
            },
        });
        const response = proxy(request);
        expect(response.headers.get(forwardedHeader)).toBe(expected);
        expect(response.headers.get("x-middleware-request-cookie")).toBe(
            "session=example",
        );
        expect(response.headers.has(LOGIN_RETURN_PATH_HEADER)).toBe(false);
    });

    it.each([
        "/api/recordings",
        "/api/int/script.js",
        "/api/admin/users",
    ])("does not add a destination to %s", (path) => {
        const response = proxy(new NextRequest(`https://example.com${path}`));
        expect(response.headers.has(forwardedHeader)).toBe(false);
    });

    it("keeps ordinary API requests untouched", () => {
        const response = proxy(
            new NextRequest("https://example.com/api/recordings", {
                headers: { [LOGIN_RETURN_PATH_HEADER]: "/tasks/forged" },
            }),
        );
        expect(response.headers.has("x-middleware-override-headers")).toBe(
            false,
        );
    });

    it("keeps analytics credentials stripped", () => {
        const response = proxy(
            new NextRequest("https://example.com/api/int/script.js", {
                headers: {
                    cookie: "session=example",
                    authorization: "Bearer example",
                },
            }),
        );
        expect(response.headers.has("x-middleware-request-cookie")).toBe(false);
        expect(response.headers.has("x-middleware-request-authorization")).toBe(
            false,
        );
        expect(response.headers.has(forwardedHeader)).toBe(false);
    });

    it("preserves the admin pathname on the admin host", () => {
        mockEnv.ADMIN_HOSTNAME = "admin.example.com";
        const response = proxy(
            new NextRequest("https://admin.example.com/admin/users?example=1", {
                headers: {
                    host: "admin.example.com",
                    "x-pathname": "/forged",
                    [LOGIN_RETURN_PATH_HEADER]: "/forged",
                },
            }),
        );
        expect(response.headers.get("x-middleware-request-x-pathname")).toBe(
            "/admin/users",
        );
        expect(response.headers.get(forwardedHeader)).toBe(
            "/admin/users?example=1",
        );
    });

    it.each([
        ["admin.example.com", "/", 307],
        ["admin.example.com", "/dashboard", 404],
        ["example.com", "/admin/users", 404],
    ])("preserves the hostname gate for %s%s", (host, path, status) => {
        mockEnv.ADMIN_HOSTNAME = "admin.example.com";
        const response = proxy(
            new NextRequest(`https://${host}${path}`, { headers: { host } }),
        );
        expect(response.status).toBe(status);
        expect(response.headers.has(forwardedHeader)).toBe(false);
        if (status === 307) {
            expect(response.headers.get("location")).toBe(
                "https://admin.example.com/admin",
            );
        }
    });
});
