import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";

const GPT_5_AND_NEWER = /^gpt-[5-9](?:[.-]|$)/;
const MAX_COMPLETION_TOKENS_PREFIXES = ["o1", "o3", "o4"] as const;

/**
 * Whether an OpenAI model requires `max_completion_tokens` instead of
 * `max_tokens`. This applies to:
 * - GPT models from major version 5 on (`gpt-5`, `gpt-5-mini`,
 *   `gpt-6.1-sol`, ...). The major version is one digit, so Azure's
 *   `gpt-35-turbo` (GPT-3.5) keeps `max_tokens`.
 * - `o1*`, `o3*`, and `o4*` reasoning models
 *
 * Other OpenAI-compatible providers keep `max_tokens`, so detection is
 * opt-in by model name rather than blanket.
 */
export function usesMaxCompletionTokens(model: string): boolean {
    const m = model.toLowerCase();
    if (GPT_5_AND_NEWER.test(m)) return true;
    return MAX_COMPLETION_TOKENS_PREFIXES.some((p) => m.startsWith(p));
}

/**
 * Build the parameter object passed to `openai.chat.completions.create`.
 *
 * Centralised so every call site picks the right token-limit parameter for
 * the configured model without each site re-implementing the detection.
 */
export function buildChatCompletionParams(args: {
    model: string;
    messages: ChatCompletionCreateParamsNonStreaming["messages"];
    temperature: number;
    maxTokens: number;
}): ChatCompletionCreateParamsNonStreaming {
    const { model, messages, temperature, maxTokens } = args;

    const base = {
        model,
        messages,
        temperature,
    };

    if (usesMaxCompletionTokens(model)) {
        return { ...base, max_completion_tokens: maxTokens };
    }
    return { ...base, max_tokens: maxTokens };
}
