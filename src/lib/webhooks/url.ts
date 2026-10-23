import { env } from "@/lib/env";
import {
    assertAllowedPublicHostname,
    type PublicAddress,
    resolvePublicHostname,
} from "@/lib/net/public-target";

export type PublicWebhookTarget = {
    url: URL;
    addresses: PublicAddress[] | null;
};

export function webhookTargetsRequirePublic(): boolean {
    return env.WEBHOOKS_REQUIRE_PUBLIC_TARGETS ?? env.IS_HOSTED;
}

function assertHttpOrHttpsWebhookUrl(url: URL): void {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Webhook URL must use HTTP or HTTPS");
    }
}

function assertHttpsWebhookUrl(url: URL): void {
    if (url.protocol !== "https:") {
        throw new Error("Webhook URL must use HTTPS");
    }
}

export function parseWebhookUrl(value: unknown): string {
    if (typeof value !== "string") throw new Error("URL is required");

    const trimmed = value.trim();
    const url = new URL(trimmed);
    assertHttpOrHttpsWebhookUrl(url);
    if (url.username || url.password) {
        throw new Error("Webhook URL must not include credentials");
    }
    if (webhookTargetsRequirePublic()) {
        assertHttpsWebhookUrl(url);
        assertAllowedPublicHostname(url.hostname, "Webhook URL");
    }
    return url.toString();
}

export function isWebhookUrlPolicyError(message: string): boolean {
    return (
        message === "URL is required" ||
        message === "Webhook URL must use HTTP or HTTPS" ||
        message === "Webhook URL must use HTTPS" ||
        message === "Webhook URL must not include credentials" ||
        message === "Webhook URL must use a public hostname or IP address" ||
        message === "Webhook URL must resolve to public IP addresses"
    );
}

export async function assertWebhookUrlAllowed(
    urlString: string,
): Promise<void> {
    await resolveWebhookUrl(urlString);
}

export async function resolveWebhookUrl(
    urlString: string,
): Promise<PublicWebhookTarget> {
    const url = new URL(parseWebhookUrl(urlString));
    if (!webhookTargetsRequirePublic()) {
        return {
            url,
            addresses: null,
        };
    }

    assertHttpsWebhookUrl(url);

    return {
        url,
        addresses: await resolvePublicHostname(url.hostname, "Webhook URL"),
    };
}
