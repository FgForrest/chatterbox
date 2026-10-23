import { deploymentProductName } from "@/lib/deployment-brand";
import { defaultLocale } from "@/lib/i18n/config";
import { resolvePublicHostname } from "@/lib/net/public-target";

export const HOSTED_LOCAL_BASE_URL_MESSAGE = `We can't reach \`localhost\` or other private addresses from the hosted app — to use LM Studio or Ollama, self-host ${deploymentProductName(defaultLocale)} (\`docker compose up\`).`;

export type BaseUrlValidationResult =
    | { ok: true }
    | { ok: false; message: string };

interface ValidateOptions {
    isHosted: boolean;
}

/** Validate an AI provider `baseUrl`. Hosted mode resolves and requires public targets. */
export async function validateAiBaseUrl(
    input: string | null | undefined,
    { isHosted }: ValidateOptions,
): Promise<BaseUrlValidationResult> {
    if (input == null) return { ok: true };
    const trimmed = input.trim();
    if (trimmed === "") return { ok: true };

    if (!isHosted) return { ok: true };

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return {
            ok: false,
            message:
                "Base URL must be a valid absolute URL (e.g. https://api.example.com/v1).",
        };
    }

    if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username ||
        parsed.password
    ) {
        return { ok: false, message: HOSTED_LOCAL_BASE_URL_MESSAGE };
    }
    try {
        await resolvePublicHostname(parsed.hostname);
    } catch {
        return { ok: false, message: HOSTED_LOCAL_BASE_URL_MESSAGE };
    }
    return { ok: true };
}
