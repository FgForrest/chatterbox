"use client";

import { useExtracted } from "next-intl";
import { Panel } from "@/components/panel";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    type AiRate,
    billingUnits,
    hasRate,
    publishedRate,
} from "@/lib/ai/published-rates";

/** The price fields as typed, blank meaning "no rate of mine". */
export interface PricingDraft {
    input: string;
    output: string;
    audio: string;
}

export const EMPTY_PRICING: PricingDraft = { input: "", output: "", audio: "" };

/** Seed the fields from a card's stored rate. */
export function pricingDraft(rate: AiRate | null | undefined): PricingDraft {
    const text = (value: number | null | undefined) =>
        value == null ? "" : String(value);
    return {
        input: text(rate?.inputUsdPerMillion),
        output: text(rate?.outputUsdPerMillion),
        audio: text(rate?.audioUsdPerHour),
    };
}

/**
 * The request fields for `draft`, dropping units `provider` never reports
 * so a hidden field cannot price anything. Null when only one of the two
 * token rates is filled in.
 */
export function pricingPayload(
    provider: string,
    draft: PricingDraft,
): AiRate | null {
    const units = billingUnits(provider);
    const parse = (value: string, shown: boolean) =>
        shown && value.trim() !== "" ? Number(value) : null;
    const rate: AiRate = {
        inputUsdPerMillion: parse(draft.input, units.tokens),
        outputUsdPerMillion: parse(draft.output, units.tokens),
        audioUsdPerHour: parse(draft.audio, units.audio),
    };
    if (
        (rate.inputUsdPerMillion === null) !==
        (rate.outputUsdPerMillion === null)
    ) {
        return null;
    }
    return rate;
}

function usd(value: number): string {
    return `$${value}`;
}

/** The parts of a rate a person reads, e.g. "$0.22 per audio hour". */
export function useRateText() {
    const i18n = useExtracted();
    return (rate: AiRate): string => {
        const parts: string[] = [];
        if (
            rate.inputUsdPerMillion !== null &&
            rate.outputUsdPerMillion !== null
        ) {
            parts.push(
                i18n("{input} in, {output} out per 1M tokens", {
                    input: usd(rate.inputUsdPerMillion),
                    output: usd(rate.outputUsdPerMillion),
                }),
            );
        }
        if (rate.audioUsdPerHour !== null) {
            parts.push(
                i18n("{price} per audio hour", {
                    price: usd(rate.audioUsdPerHour),
                }),
            );
        }
        return parts.join(", ");
    };
}

/** The price a provider card bills at, and where that price comes from. */
export function ProviderPriceLine({
    provider,
    model,
    baseUrl,
    rate,
}: {
    provider: string;
    model: string | null;
    baseUrl: string | null;
    rate: AiRate | null | undefined;
}) {
    const i18n = useExtracted();
    const rateText = useRateText();
    const published = model ? publishedRate(provider, model, baseUrl) : null;
    let text: string;
    if (hasRate(rate)) {
        text = `${rateText(rate)} · ${i18n("your price")}`;
    } else if (published) {
        text = `${rateText(published)} · ${i18n("published price")}`;
    } else {
        text = i18n("Price unknown. Set one to count its spend.");
    }
    return <p className="text-xs text-muted-foreground">{text}</p>;
}

/**
 * The price fields of a provider dialog. Shows only the units the
 * provider reports usage in, with the published price, where Riffado
 * knows one, as the placeholder a blank field falls back to.
 */
export function ProviderPricingFields({
    provider,
    model,
    baseUrl,
    value,
    onChange,
    disabled,
}: {
    provider: string;
    model: string;
    baseUrl: string;
    value: PricingDraft;
    onChange: (next: PricingDraft) => void;
    disabled?: boolean;
}) {
    const i18n = useExtracted();
    const rateText = useRateText();
    if (!provider) return null;
    const units = billingUnits(provider);
    const published = model ? publishedRate(provider, model, baseUrl) : null;
    const placeholder = (rate: number | null | undefined) =>
        rate == null ? "" : String(rate);
    const field = (
        id: string,
        label: string,
        key: keyof PricingDraft,
        fallback: number | null | undefined,
    ) => (
        <div className="space-y-2">
            <Label htmlFor={id}>{label}</Label>
            <Input
                id={id}
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                placeholder={placeholder(fallback)}
                value={value[key]}
                onChange={(event) =>
                    onChange({ ...value, [key]: event.target.value })
                }
                disabled={disabled}
            />
        </div>
    );

    return (
        <Panel variant="inset" className="space-y-3 text-sm">
            <div className="space-y-1">
                <p className="font-medium">{i18n("Price")}</p>
                <p className="text-xs text-muted-foreground">
                    {published
                        ? i18n(
                              "Published price: {price}. Leave blank to use it, or enter what you pay.",
                              { price: rateText(published) },
                          )
                        : i18n(
                              "No published price for this model. Without one, its spend shows as unknown.",
                          )}
                </p>
            </div>
            {units.tokens && (
                <div className="grid gap-3 sm:grid-cols-2">
                    {field(
                        "price-input",
                        i18n("Input, USD per 1M tokens"),
                        "input",
                        published?.inputUsdPerMillion,
                    )}
                    {field(
                        "price-output",
                        i18n("Output, USD per 1M tokens"),
                        "output",
                        published?.outputUsdPerMillion,
                    )}
                </div>
            )}
            {units.audio && (
                <div className="grid gap-3 sm:grid-cols-2">
                    {field(
                        "price-audio",
                        i18n("Audio, USD per hour"),
                        "audio",
                        published?.audioUsdPerHour,
                    )}
                </div>
            )}
            <p className="text-xs text-muted-foreground">
                {i18n(
                    "Applies to requests from now on. Costs already recorded keep their price.",
                )}
            </p>
        </Panel>
    );
}
