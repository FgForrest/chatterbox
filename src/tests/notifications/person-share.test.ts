import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendPersonShareInvitation } from "@/lib/notifications/person-share";

const { recipient, sent, limit } = vi.hoisted(() => ({
    recipient: {
        current: {
            email: "member@example.com",
            locale: "en",
            notificationEmail: "",
        },
    },
    sent: vi.fn().mockResolvedValue(undefined),
    limit: vi.fn(),
}));
vi.mock("@/db", () => ({
    db: {
        select: () => ({
            from: () => ({ innerJoin: () => ({ where: () => ({ limit }) }) }),
        }),
    },
}));
vi.mock("@/lib/env", () => ({ env: { APP_URL: "https://app.example.com" } }));
vi.mock("@/lib/notifications/email", () => ({ sendEmail: sent }));
vi.mock("next-intl/server", () => ({ getExtracted: vi.fn() }));

beforeEach(() => {
    recipient.current = {
        email: "member@example.com",
        locale: "en",
        notificationEmail: "",
    };
    limit.mockImplementation(async () => [recipient.current]);
    sent.mockClear();
});

describe("restricted folder invitation emails", () => {
    it.each([
        [
            "access-request",
            "A colleague requested access to a restricted folder.",
        ],
        [
            "access-approved",
            "Your request for access to a restricted folder was approved.",
        ],
        [
            "access-declined",
            "Your request for access to a restricted folder was declined.",
        ],
    ] as const)("renders %s without folder contents or audience identities", async (kind, subject) => {
        await sendPersonShareInvitation("member", kind);
        expect(sent).toHaveBeenCalledWith({
            to: "member@example.com",
            subject,
            html: `<p>${subject}</p><p><a href="https://app.example.com/dashboard?invitations=1">Review invitations</a></p>`,
        });
    });
    it("uses the recipient's Czech locale and configured notification address", async () => {
        recipient.current.locale = "cs-CZ";
        recipient.current.notificationEmail = "notices@example.com";
        await sendPersonShareInvitation("member", "access-declined");
        expect(sent).toHaveBeenCalledWith(
            expect.objectContaining({
                to: "notices@example.com",
                subject:
                    "Vaše žádost o přístup do uzavřené složky byla zamítnuta.",
            }),
        );
        expect(sent.mock.calls[0][0].html).toContain("Zobrazit pozvánky");
    });
    it("sends nothing when the email opt-in query returns no recipient", async () => {
        limit.mockResolvedValue([]);
        await sendPersonShareInvitation("member", "access-request");
        expect(sent).not.toHaveBeenCalled();
    });
    it("bounds waiting for invitation mail to three seconds", async () => {
        vi.useFakeTimers();
        try {
            sent.mockImplementationOnce(() => new Promise<void>(() => {}));
            const sending = sendPersonShareInvitation(
                "member",
                "access-request",
            );
            await vi.advanceTimersByTimeAsync(3000);
            await sending;
        } finally {
            vi.useRealTimers();
        }
    });
});
