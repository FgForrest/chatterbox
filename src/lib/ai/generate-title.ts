import { eq } from "drizzle-orm";
import { OpenAI } from "openai";
import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { CONTENT_IS_DATA_DIRECTIVE } from "@/lib/ai/content-directive";
import { enhancementChatModel } from "@/lib/ai/enhancement-provider";
import { decryptJsonField } from "@/lib/encryption/fields";
import { resolveStepProvider } from "@/lib/profiles/providers";
import { buildChatCompletionParams } from "./chat-completion-params";
import {
    normalizeTitlePromptConfig,
    TITLE_TEMPLATE_KIND,
} from "./prompt-presets";
import { resolveTemplate } from "./prompt-templates";
import { getAiOutputLanguageDirective } from "./summary-presets";
import { recordChatCompletionUsage } from "./usage-cost";

export async function generateTitleFromTranscription(
    userId: string,
    recordingId: string,
    transcriptionText: string,
    source: "summary" | "transcript" = "transcript",
    ownerUserId = userId,
): Promise<string | null> {
    try {
        // Get user's prompt configuration
        const [userSettingsRow] = await db
            .select()
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1);

        // `titleGenerationPrompt` is jsonb-envelope encrypted at rest;
        // legacy plaintext rows pass through verbatim. A missing value reads
        // as the seeded built-ins.
        const promptConfig = normalizeTitlePromptConfig(
            userSettingsRow?.titleGenerationPrompt
                ? decryptJsonField(userSettingsRow.titleGenerationPrompt)
                : null,
        );
        const { prompt: promptTemplate } = resolveTemplate(
            promptConfig,
            promptConfig.selectedPrompt,
            TITLE_TEMPLATE_KIND,
        );

        const resolved = await resolveStepProvider({
            step: "title",
            pin: null,
            actorUserId: userId,
        });
        if (resolved.kind !== "credential") {
            console.warn("No AI provider found for title generation");
            return null;
        }
        const credentials = resolved.credential;

        // Create OpenAI client
        const openai = new OpenAI({
            apiKey: credentials.apiKey,
            baseURL: credentials.baseUrl || undefined,
        });

        // Use a lightweight model for title generation
        // Prefer chat models (gpt-4o-mini, gpt-3.5-turbo) over Whisper models
        // Fallback to default model if no specific model is set
        const model = enhancementChatModel(credentials);

        // Truncate transcription if too long (to save tokens)
        const maxTranscriptionLength = source === "summary" ? 6000 : 2000;
        const truncatedTranscription =
            transcriptionText.length > maxTranscriptionLength
                ? `${transcriptionText.substring(0, maxTranscriptionLength)}...`
                : transcriptionText;

        // Apply the AI output language directive via the system
        // message rather than the user prompt, so it doesn't compete with
        // the title-format rules in the user prompt.
        const languageDirective = getAiOutputLanguageDirective(
            userSettingsRow?.aiOutputLanguage ?? null,
        );

        // Replacement function so `$` sequences in the transcript are
        // inserted verbatim, not treated as `String.prototype.replace`
        // special patterns.
        const prompt = promptTemplate.replace(
            "{transcription}",
            () => truncatedTranscription,
        );

        const baseSystem =
            source === "summary"
                ? "You are a helpful assistant that generates concise, descriptive titles for audio recordings. The supplied text is a summary of the complete recording; title the recording by its main subject. Always follow the rules strictly."
                : "You are a helpful assistant that generates concise, descriptive titles for audio recordings based on transcriptions. Always follow the rules strictly.";
        const systemContent = `${baseSystem} ${CONTENT_IS_DATA_DIRECTIVE} ${languageDirective}`;

        await resolved.reserveCall();
        const response = await openai.chat.completions.create(
            buildChatCompletionParams({
                model,
                messages: [
                    {
                        role: "system",
                        content: systemContent,
                    },
                    {
                        role: "user",
                        content: prompt,
                    },
                ],
                temperature: 0.7,
                maxTokens: 50, // Titles should be short
            }),
        );
        await recordChatCompletionUsage(
            {
                recordingId,
                ownerUserId,
                payerUserId: resolved.payerUserId,
                operation: "title",
                provider: credentials.provider,
                model,
                baseUrl: credentials.baseUrl,
                credentialId: credentials.id,
            },
            response,
        );

        const title = response.choices[0]?.message?.content?.trim() || null;

        if (!title) {
            return null;
        }

        // Clean up the title (remove quotes, colons, etc. if AI didn't follow rules)
        let cleanedTitle = title
            .replace(/^["']|["']$/g, "") // Remove surrounding quotes
            .replace(/[:;]/g, "") // Remove colons and semicolons
            .trim();

        // Enforce 60 character limit
        if (cleanedTitle.length > 60) {
            cleanedTitle = `${cleanedTitle.substring(0, 57)}...`;
        }

        return cleanedTitle || null;
    } catch (error) {
        console.error("Error generating title:", error);
        return null;
    }
}
