import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    existing: vi.fn(),
    save: vi.fn(),
    grant: vi.fn(),
    purpose: "calendar",
    exchange: vi.fn(),
    claims: vi.fn(),
}));

vi.mock("@/lib/folder-exports/jobs", () => ({
    enqueueExportPlansForUser: vi.fn(),
}));
vi.mock("@/lib/integrations/google/config", () => ({
    GOOGLE_CALENDAR_EVENTS_READONLY_SCOPE:
        "https://www.googleapis.com/auth/calendar.events.readonly",
    GOOGLE_CALENDAR_EVENTS_WRITE_SCOPE:
        "https://www.googleapis.com/auth/calendar.events",
    GOOGLE_DRIVE_FILE_SCOPE: "https://www.googleapis.com/auth/drive.file",
    getGoogleOAuthConfig: () => ({
        clientId: "id",
        clientSecret: "secret",
        workspaceDomains: [],
        redirectUri: "https://app.example/callback",
    }),
    getGoogleIntegrationConfig: () => null,
}));
vi.mock("@/lib/integrations/google/connection", () => ({
    getGoogleConnectionStatus: mocks.existing,
    saveGoogleConnection: mocks.save,
    saveMeetGrant: mocks.grant,
}));
vi.mock("@/lib/integrations/google/oauth", () => ({
    exchangeAuthorizationCode: mocks.exchange,
    readIdTokenClaims: mocks.claims,
}));
vi.mock("@/lib/integrations/google/oauth-state", () => ({
    openGoogleOAuthState: () => ({
        state: "state",
        verifier: "verifier",
        userId: "owner",
        returnTo: "/settings",
        purpose: mocks.purpose,
        expectedSubject: "same",
    }),
}));

import { completeGoogleConnect } from "@/lib/integrations/google/connect-flow";

const CALENDAR = "https://www.googleapis.com/auth/calendar.events.readonly";
const DRIVE = "https://www.googleapis.com/auth/drive.file";

async function complete() {
    return completeGoogleConnect({
        userId: "owner",
        sealedState: "sealed",
        params: new URLSearchParams({ state: "state", code: "code" }),
    });
}

describe("incremental Calendar consent", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.purpose = "calendar";
        mocks.grant.mockResolvedValue(true);
        mocks.existing.mockResolvedValue({
            subject: "same",
            status: "active",
            scopes: [DRIVE],
        });
        mocks.exchange.mockResolvedValue({
            accessToken: "access",
            refreshToken: "refresh",
            idToken: "id",
            scopes: [CALENDAR, DRIVE],
        });
        mocks.claims.mockReturnValue({
            subject: "same",
            email: "owner@example.com",
            emailVerified: true,
            hostedDomain: null,
        });
    });

    it("preserves the existing Drive grant on the same account", async () => {
        expect((await complete()).outcome).toBe("connected");
        expect(mocks.save).toHaveBeenCalledOnce();
    });

    it("refuses a different account instead of replacing and revoking Drive", async () => {
        mocks.claims.mockReturnValue({
            subject: "different",
            email: "other@example.com",
            emailVerified: true,
            hostedDomain: null,
        });
        expect((await complete()).outcome).toBe("account_mismatch");
        expect(mocks.save).not.toHaveBeenCalled();
    });

    it("refuses a Calendar grant that loses an existing Drive scope", async () => {
        mocks.exchange.mockResolvedValue({
            accessToken: "access",
            refreshToken: "refresh",
            idToken: "id",
            scopes: [CALENDAR],
        });
        expect((await complete()).outcome).toBe("missing_existing_scope");
        expect(mocks.save).not.toHaveBeenCalled();
    });
    it("adds Calendar write consent to the bound account and retains existing scopes", async () => {
        mocks.purpose = "calendar-write";
        mocks.exchange.mockResolvedValue({
            accessToken: "access",
            idToken: "id",
            scopes: [
                CALENDAR,
                DRIVE,
                "https://www.googleapis.com/auth/calendar.events",
            ],
        });
        expect((await complete()).outcome).toBe("connected");
        expect(mocks.grant).toHaveBeenCalledWith(
            "owner",
            "same",
            [DRIVE],
            expect.objectContaining({ subject: "same" }),
            expect.any(Object),
        );
        expect(mocks.save).not.toHaveBeenCalled();
    });
    it("refuses write consent without its scope or an active bound account", async () => {
        mocks.purpose = "calendar-write";
        expect((await complete()).outcome).toBe("missing_calendar_scope");
        mocks.exchange.mockResolvedValue({
            accessToken: "access",
            idToken: "id",
            scopes: [DRIVE, "https://www.googleapis.com/auth/calendar.events"],
        });
        mocks.existing.mockResolvedValue({
            subject: "same",
            status: "revoked",
            scopes: [DRIVE],
        });
        expect((await complete()).outcome).toBe("account_mismatch");
        expect(mocks.grant).not.toHaveBeenCalled();
    });
});
