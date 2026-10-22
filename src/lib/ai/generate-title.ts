import { and, eq } from "drizzle-orm";
import { OpenAI } from "openai";
import { db } from "@/db";
import { transcriptions, users } from "@/db/schema";
import { CONTENT_IS_DATA_DIRECTIVE } from "@/lib/ai/content-directive";
import { enhancementChatModel } from "@/lib/ai/enhancement-provider";
import { resolveTitlePrompt } from "@/lib/profiles/prompts";
import { resolveStepProvider } from "@/lib/profiles/providers";
import { resolveItemProfile } from "@/lib/profiles/resolve";
import type { ProfileSettings } from "@/lib/profiles/settings";
import type { RecordingView } from "@/lib/sharing/view";
import { buildChatCompletionParams } from "./chat-completion-params";
import {
    getAiOutputLanguageDirective,
    resolveAiOutputLanguage,
} from "./summary-presets";
import { recordChatCompletionUsage } from "./usage-cost";

function isAbsentProviderSelection(error: unknown): boolean {
    if (!error || typeof error !== "object" || !("details" in error)) {
        return false;
    }
    const details = error.details;
    return (
        details !== null &&
        typeof details === "object" &&
        "providerSelection" in details &&
        details.providerSelection === "absent"
    );
}

export async function generateTitleFromTranscription(
    userId: string,
    recordingId: string,
    transcriptionText: string,
    source: "summary" | "transcript" = "transcript",
    ownerUserId = userId,
    view: RecordingView = "private",
    detectedLanguage?: string | null,
    automatic = false,
    jobId?: string,
): Promise<string | null> {
    const profile = await resolveItemProfile(
        recordingId,
        view,
        ownerUserId,
        userId,
        automatic ? "title" : undefined,
        automatic ? jobId : undefined,
    );
    const settings = profile.settings as ProfileSettings;
    let contentLanguage = detectedLanguage;
    if (contentLanguage === undefined) {
        const [transcript] = await db
            .select({ detectedLanguage: transcriptions.detectedLanguage })
            .from(transcriptions)
            .where(
                and(
                    eq(transcriptions.recordingId, recordingId),
                    eq(transcriptions.userId, ownerUserId),
                    eq(transcriptions.source, "riffado"),
                ),
            )
            .limit(1);
        contentLanguage = transcript?.detectedLanguage ?? null;
    }
    const [owner] = await db
        .select({ uiLocale: users.uiLocale })
        .from(users)
        .where(eq(users.id, ownerUserId))
        .limit(1);
    const outputLanguage = resolveAiOutputLanguage(
        settings.steps.summary.outputLanguage,
        contentLanguage,
    );
    const promptTemplate = resolveTitlePrompt({
        settings: settings.steps.title,
        outputLanguage: outputLanguage ?? settings.steps.summary.outputLanguage,
        contentLanguage,
        uiLocale: owner?.uiLocale === "cs-CZ" ? "cs-CZ" : "en",
    }).text;
    let resolved: Awaited<ReturnType<typeof resolveStepProvider>>;
    try {
        resolved = await resolveStepProvider({
            step: "title",
            pin: settings.steps.title.provider,
            actorUserId: userId,
        });
    } catch (error) {
        if (settings.steps.title.provider) throw error;
        if (!isAbsentProviderSelection(error)) throw error;
        console.error("Error resolving title provider:", error);
        return null;
    }
    if (resolved.kind !== "credential") {
        console.warn("No AI provider found for title generation");
        return null;
    }
    try {
        const credentials = resolved.credential;

        // Create OpenAI client
        const openai = new OpenAI({
            apiKey: credentials.apiKey,
            baseURL: credentials.baseUrl || undefined,
            maxRetries: resolved.organizationCredential ? 0 : undefined,
        });

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
        const languageDirective = getAiOutputLanguageDirective(outputLanguage);
        const capitalizationDirective =
            "Use the capitalization conventions of the output language. Use English Title Case only for English; Czech and most other European languages use sentence case.";

        // Replacement function so `$` sequences in the transcript are
        // inserted verbatim, not treated as `String.prototype.replace`
        // special patterns.
        const prompt = promptTemplate.replace(
            "{transcription}",
            () => truncatedTranscription,
        );

        const baseSystem =
            source === "summary"
                ? "You are a helpful assistant that generates concise, descriptive titles. The supplied text is a summary of the complete item; title it by its main subject. Always follow the rules strictly."
                : "You are a helpful assistant that generates concise, descriptive titles from supplied content. Always follow the rules strictly.";
        const systemContent = `${baseSystem} ${CONTENT_IS_DATA_DIRECTIVE} ${languageDirective} ${capitalizationDirective}`;

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
                maxOutputTokens: credentials.maxOutputTokens,
                maxTokens: 50, // Titles should be short
            }),
        );
        await recordChatCompletionUsage(
            {
                recordingId,
                ownerUserId,
                actorUserId: userId,
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
        console.error(
            `Error generating title with provider ${resolved.credential.id}:`,
            error,
        );
        return null;
    }
}
