import { AppError, ErrorCode } from "@/lib/errors";

/** The product-facing fix for a provider without an enhancement model. */
export function enhancementModelRequiredMessage(provider: string): string {
    return `Set a Default Model on ${provider} in Settings > Providers.`;
}

/** The chat model to run enhancement with. */
export function enhancementChatModel(credentials: {
    id?: string;
    provider: string;
    defaultModel: string | null;
    baseUrl: string | null;
}): string {
    const model = credentials.defaultModel;
    if (!model?.trim()) {
        throw new AppError(
            ErrorCode.AI_PROVIDER_NOT_CONFIGURED,
            enhancementModelRequiredMessage(credentials.provider),
            400,
            {
                field: "defaultModel",
                ...(credentials.id ? { providerId: credentials.id } : {}),
            },
        );
    }
    if (!model.includes("whisper")) return model;
    const baseUrl = credentials.baseUrl || "";
    if (baseUrl.includes("groq")) return "llama-3.1-8b-instant";
    if (baseUrl.includes("together")) {
        return "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo";
    }
    if (baseUrl.includes("openrouter")) return "openai/gpt-4o-mini";
    return "gpt-4o-mini";
}
