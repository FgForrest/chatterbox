"use client";

import { useExtracted, useLocale } from "next-intl";
import { useId } from "react";
import { NativeSelect } from "@/components/ui/native-select";
import {
    recordingLanguageName,
    SELECTABLE_RECORDING_LANGUAGES,
} from "@/lib/recordings/language";

/** The independent language finding of an audio Learn review. */
export function LearnLanguageItem({
    language,
    detectedLanguage,
    chosen,
    disabled,
    onChoose,
}: {
    language: string;
    detectedLanguage: string;
    chosen: string;
    disabled: boolean;
    onChoose: (language: string) => void;
}) {
    const i18n = useExtracted();
    const locale = useLocale();
    const id = useId();
    const name = (code: string) => recordingLanguageName(code, locale);
    return (
        <fieldset
            className="space-y-2 rounded-lg bg-muted p-3 text-sm"
            disabled={disabled}
        >
            <legend className="sr-only">{i18n("Transcript language")}</legend>
            <p>
                {i18n(
                    "Transcript language: {detected}? Learn read {language}.",
                    {
                        detected: name(detectedLanguage),
                        language: name(language),
                    },
                )}
            </p>
            <label className="flex items-center gap-2 font-medium text-primary">
                <input
                    type="radio"
                    name={id}
                    checked={chosen === language}
                    onChange={() => onChoose(language)}
                />
                {i18n("Use {language}", { language: name(language) })}
            </label>
            <label className="flex items-center gap-2">
                <input
                    type="radio"
                    name={id}
                    checked={chosen === detectedLanguage}
                    onChange={() => onChoose(detectedLanguage)}
                />
                {i18n("Keep detected {language}", {
                    language: name(detectedLanguage),
                })}
            </label>
            <NativeSelect
                aria-label={i18n("Pick another language")}
                value={
                    chosen !== language && chosen !== detectedLanguage
                        ? chosen
                        : ""
                }
                onChange={(event) => onChoose(event.target.value)}
            >
                <option value="" disabled>
                    {i18n("Pick another language")}
                </option>
                {SELECTABLE_RECORDING_LANGUAGES.map((option) => (
                    <option key={option.code} value={option.code}>
                        {name(option.code)}
                    </option>
                ))}
            </NativeSelect>
        </fieldset>
    );
}
