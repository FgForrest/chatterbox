import { beforeEach, describe, expect, it, vi } from "vitest";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("@/lib/env", () => ({ env: { IS_HOSTED: true } }));

import {
    assertAllowedPublicHostname,
    PublicHostnameResolutionError,
    resolvePublicHostname,
} from "@/lib/net/public-target";
import { isWebhookUrlPolicyError, resolveWebhookUrl } from "@/lib/webhooks/url";

beforeEach(() => vi.clearAllMocks());

describe("IPv6 public-target classification", () => {
    it.each([
        "64:ff9b::a00:1",
        "64:ff9b::c0a8:101",
        "64:ff9b::a9fe:a9fe",
        "64:ff9b::7f00:1",
        "64:ff9b::10.0.0.1",
        "0064:ff9b:0000:0000:0000:0000:ac10:0001",
        "2002:a00:1::",
        "2002:c0a8:101::1",
        "2002:a9fe:a9fe::",
        "2002:7f00:1::",
        "2002:ac10:0001:abcd:1234:5678:0000:0001",
        "2002:a00:1::8.8.8.8",
        "fec0::1",
        "fec0::8.8.8.8",
        "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    ])("refuses private embedded IPv4 and site-local %s", async (address) => {
        expect(() => assertAllowedPublicHostname(address)).toThrow(
            "must use a public hostname",
        );
        await expect(resolvePublicHostname(address)).rejects.toThrow(
            "must use a public hostname",
        );
        await expect(
            resolveWebhookUrl(`https://[${address}]/hook`),
        ).rejects.toThrow("Webhook URL must use a public hostname");
        expect(lookup).not.toHaveBeenCalled();
    });

    it.each([
        "64:ff9b::808:808",
        "0064:ff9b:0000:0000:0000:0000:0808:0808",
        "64:ff9b::8.8.8.8",
        "2002:808:808::1",
        "2002:808:808::10.0.0.1",
        "2002:0101:0101:abcd:0000:0000:0000:0001",
        "2606:4700:4700::1111",
    ])("accepts public addresses and embedded IPv4 %s", async (address) => {
        expect(() => assertAllowedPublicHostname(address)).not.toThrow();
        await expect(resolvePublicHostname(address)).resolves.toEqual([
            { address, family: 6 },
        ]);
    });

    it.each([
        "64:ff9b::a00:1",
        "2002:a00:1::",
        "fec0::1",
    ])("refuses a mixed DNS answer containing %s", async (address) => {
        lookup.mockResolvedValue([
            { address: "8.8.8.8", family: 4 },
            { address, family: 6 },
        ]);
        await expect(resolvePublicHostname("api.example.com")).rejects.toThrow(
            "must resolve to public IP addresses",
        );
    });
});

describe("webhook resolution failure semantics", () => {
    it.each([
        "EAI_AGAIN",
        "empty answer",
    ])("keeps %s retryable by the webhook worker", async (failure) => {
        if (failure === "empty answer") lookup.mockResolvedValue([]);
        else lookup.mockRejectedValue(new Error(failure));
        const error: unknown = await resolveWebhookUrl(
            "https://api.example.com/hook",
        ).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(PublicHostnameResolutionError);
        expect(error).toMatchObject({
            message: "Webhook URL host could not be resolved",
        });
        expect(isWebhookUrlPolicyError((error as Error).message)).toBe(false);
    });

    it("keeps private DNS answers permanent for the webhook worker", async () => {
        lookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
        const error: unknown = await resolveWebhookUrl(
            "https://api.example.com/hook",
        ).catch((error: unknown) => error);
        expect(error).toMatchObject({
            message: "Webhook URL must resolve to public IP addresses",
        });
        expect(isWebhookUrlPolicyError((error as Error).message)).toBe(true);
    });
});
