import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";

const GPT_MODEL_PATTERN = /^gpt-(\d+)/;
const MAX_COMPLETION_TOKENS_PREFIXES = ["o1", "o3", "o4"] as const;

/**
 * Whether an OpenAI model requires `max_completion_tokens` instead of
 * `max_tokens`. This applies to:
 * - GPT models with a numeric major version of 5 or newer (`gpt-5`,
 *   `gpt-6.1-sol`, `gpt-10-x`, ...)
 * - `o1*`, `o3*`, and `o4*` reasoning models
 *
 * Other OpenAI-compatible providers keep `max_tokens`, so detection is
 * opt-in by model name rather than blanket.
 */
export function usesMaxCompletionTokens(model: string): boolean {
    const m = model.toLowerCase();
    const gptModel = m.match(GPT_MODEL_PATTERN);
    if (gptModel && Number(gptModel[1]) >= 5) return true;
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
