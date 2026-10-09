import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
}));
vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn(),
}));
vi.mock("@/lib/integrations/google/config", () => ({
    GOOGLE_DRIVE_FILE_SCOPE: "https://www.googleapis.com/auth/drive.file",
    GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE:
        "https://www.googleapis.com/auth/calendar.events.readonly",
    getGoogleIntegrationConfig: () => null,
    getGoogleOAuthConfig: () => ({
        clientId: "client",
        clientSecret: "secret",
        workspaceDomains: [],
        redirectUri: "https://riffado.example/api/integrations/google/callback",
    }),
}));
vi.mock("@/lib/integrations/google/connection", () => ({
    getGoogleConnectionStatus: vi.fn(),
    saveGoogleConnection: vi.fn(),
    saveMeetGrant: vi.fn(),
}));

import { completeGoogleConnect } from "@/lib/integrations/google/connect-flow";
import {
    getGoogleConnectionStatus,
    saveGoogleConnection,
    saveMeetGrant,
} from "@/lib/integrations/google/connection";
import {
    GOOGLE_MEET_READ_SCOPE,
    meetConsentScopes,
} from "@/lib/integrations/google/meet-consent";
import {
    openGoogleOAuthState,
    sealGoogleOAuthState,
} from "@/lib/integrations/google/oauth-state";

const calendarScope =
    "https://www.googleapis.com/auth/calendar.events.readonly";
const existing = {
    subject: "google-user-1",
    email: "a@example.com",
    hostedDomain: null,
    status: "active" as const,
    scopes: ["openid", "email", calendarScope],
};
const state = {
    state: "state-1",
    verifier: "verifier-1",
    userId: "riffado-user-1",
    expectedSubject: existing.subject,
    returnTo: "/dashboard",
    expiresAt: Date.now() + 60_000,
    purpose: "meet" as const,
};

function idToken(subject: string): string {
    const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "RS256" })}.${encode({ sub: subject, email: existing.email, email_verified: true })}.signature`;
}

function tokenResponse(subject: string, scopes: string[]): Response {
    return new Response(
        JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            id_token: idToken(subject),
            expires_in: 3600,
            scope: scopes.join(" "),
        }),
        { status: 200 },
    );
}

function finish(fetchImpl: typeof fetch) {
    return completeGoogleConnect({
        userId: state.userId,
        sealedState: sealGoogleOAuthState(state),
        params: new URLSearchParams({ state: state.state, code: "code" }),
        fetchImpl,
    });
}

describe("Meet incremental Google consent", () => {
    beforeEach(() => {
        vi.mocked(getGoogleConnectionStatus).mockReset();
        vi.mocked(saveGoogleConnection).mockReset();
        vi.mocked(saveMeetGrant).mockReset();
        vi.mocked(saveMeetGrant).mockResolvedValue(true);
        vi.mocked(getGoogleConnectionStatus).mockResolvedValue(existing);
    });

    it("requests Meet alongside the active account's existing scopes", () => {
        expect(meetConsentScopes(existing.scopes)).toEqual([
            ...existing.scopes,
            GOOGLE_MEET_READ_SCOPE,
        ]);
        expect(meetConsentScopes([GOOGLE_MEET_READ_SCOPE])).toEqual([
            "openid",
            "email",
            GOOGLE_MEET_READ_SCOPE,
        ]);
    });

    it("binds Meet state to the expected Google subject", () => {
        expect(openGoogleOAuthState(sealGoogleOAuthState(state))).toEqual(
            state,
        );
        const withoutSubject = { ...state, expectedSubject: undefined };
        expect(
            openGoogleOAuthState(sealGoogleOAuthState(withoutSubject)),
        ).toBeNull();
    });

    it("stores a full grant for the existing account", async () => {
        const scopes = meetConsentScopes(existing.scopes);
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValue(tokenResponse(existing.subject, scopes));
        await expect(finish(fetchImpl)).resolves.toEqual({
            outcome: "connected",
            returnTo: state.returnTo,
        });
        expect(saveMeetGrant).toHaveBeenCalledWith(
            state.userId,
            existing.subject,
            existing.scopes,
            expect.objectContaining({ subject: existing.subject }),
            expect.objectContaining({ scopes }),
        );
        const body = new URLSearchParams(
            String(fetchImpl.mock.calls[0]?.[1]?.body),
        );
        expect(body.get("redirect_uri")).toBe(
            "https://riffado.example/api/integrations/google/callback",
        );
    });

    it("rejects another Google subject without replacing the connection", async () => {
        await expect(
            finish(
                vi
                    .fn<typeof fetch>()
                    .mockResolvedValue(
                        tokenResponse(
                            "other",
                            meetConsentScopes(existing.scopes),
                        ),
                    ),
            ),
        ).resolves.toMatchObject({ outcome: "account_mismatch" });
        expect(saveGoogleConnection).not.toHaveBeenCalled();
        expect(saveMeetGrant).not.toHaveBeenCalled();
    });

    it("rejects a partial grant without replacing the connection", async () => {
        await expect(
            finish(
                vi
                    .fn<typeof fetch>()
                    .mockResolvedValue(
                        tokenResponse(existing.subject, existing.scopes),
                    ),
            ),
        ).resolves.toMatchObject({ outcome: "missing_meet_scope" });
        expect(saveGoogleConnection).not.toHaveBeenCalled();
        expect(saveMeetGrant).not.toHaveBeenCalled();
    });

    it("rejects a changed connection during the consent redirect", async () => {
        vi.mocked(getGoogleConnectionStatus).mockResolvedValue({
            ...existing,
            subject: "other",
        });
        await expect(
            finish(
                vi
                    .fn<typeof fetch>()
                    .mockResolvedValue(
                        tokenResponse(
                            existing.subject,
                            meetConsentScopes(existing.scopes),
                        ),
                    ),
            ),
        ).resolves.toMatchObject({ outcome: "account_mismatch" });
        expect(saveGoogleConnection).not.toHaveBeenCalled();
        expect(saveMeetGrant).not.toHaveBeenCalled();
    });
});
