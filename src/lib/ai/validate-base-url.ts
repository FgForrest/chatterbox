import { deploymentProductName } from "@/lib/deployment-brand";
import { defaultLocale } from "@/lib/i18n/config";
import { InvalidHttpUrlError, requireHttpUrl } from "@/lib/net/http-url";
import { resolvePublicHostname } from "@/lib/net/public-target";

export const HOSTED_LOCAL_BASE_URL_MESSAGE = `We can't reach \`localhost\` or other private addresses from the hosted app — to use LM Studio or Ollama, self-host ${deploymentProductName(defaultLocale)} (\`docker compose up\`).`;

export type BaseUrlValidationResult =
    | { ok: true }
    | { ok: false; message: string };

interface ValidateOptions {
    isHosted: boolean;
}

/** Check a stored base URL before using it to build a provider request. */
export function providerBaseUrl(
    input: string | null | undefined,
): string | undefined {
    if (input == null || input.trim() === "") return undefined;
    requireHttpUrl(input, { field: "baseUrl", allowCredentials: true });
    return input;
}

/** Validate an AI provider `baseUrl`. Hosted mode resolves and requires public targets. */
export async function validateAiBaseUrl(
    input: unknown,
    { isHosted }: ValidateOptions,
): Promise<BaseUrlValidationResult> {
    if (input == null || (typeof input === "string" && input.trim() === "")) {
        return { ok: true };
    }

    let url: URL;
    try {
        url = requireHttpUrl(input, {
            field: "baseUrl",
            allowCredentials: false,
        });
    } catch (error) {
        if (!(error instanceof InvalidHttpUrlError)) throw error;
        return { ok: false, message: error.message };
    }

    if (!isHosted) return { ok: true };
    try {
        await resolvePublicHostname(url.hostname);
    } catch {
        return { ok: false, message: HOSTED_LOCAL_BASE_URL_MESSAGE };
    }
    return { ok: true };
}
