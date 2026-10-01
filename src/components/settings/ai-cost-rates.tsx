"use client";

import { useExtracted } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface CostRate {
    id: string;
    provider: string;
    model: string;
    inputUsdPerMillion: string | null;
    outputUsdPerMillion: string | null;
    audioUsdPerHour: string | null;
}

const ENDPOINT = "/api/settings/ai/cost-rates";

export function AiCostRates({ providers }: { providers: string[] }) {
    const i18n = useExtracted();
    const [rates, setRates] = useState<CostRate[]>([]);
    const [provider, setProvider] = useState("");
    const [model, setModel] = useState("");
    const [input, setInput] = useState("");
    const [output, setOutput] = useState("");
    const [audio, setAudio] = useState("");
    const [saving, setSaving] = useState(false);

    const reload = useCallback(async () => {
        const response = await fetch(ENDPOINT);
        if (!response.ok) throw new Error("Could not load AI rates");
        const data = (await response.json()) as { rates: CostRate[] };
        setRates(data.rates);
    }, []);

    useEffect(() => {
        void reload().catch(() => toast.error(i18n("Could not load AI rates")));
    }, [i18n, reload]);

    const parse = (value: string) =>
        value.trim() === "" ? null : Number(value);
    const save = async (event: React.FormEvent) => {
        event.preventDefault();
        setSaving(true);
        try {
            const response = await fetch(ENDPOINT, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    provider,
                    model,
                    inputUsdPerMillion: parse(input),
                    outputUsdPerMillion: parse(output),
                    audioUsdPerHour: parse(audio),
                }),
            });
            if (!response.ok) throw new Error(i18n("Could not save AI rate"));
            await reload();
            toast.success(i18n("AI rate saved"));
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : i18n("Could not save AI rate"),
            );
        } finally {
            setSaving(false);
        }
    };

    const remove = async (id: string) => {
        const response = await fetch(ENDPOINT, {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id }),
        });
        if (!response.ok) {
            toast.error(i18n("Could not remove AI rate"));
            return;
        }
        await reload();
    };

    return (
        <SettingsCard
            title={i18n("AI cost rates")}
            description={i18n(
                "Set USD rates for models without a known price, or override an estimate. Existing costs keep their original rate.",
            )}
        >
            <form onSubmit={save} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                        <Label htmlFor="cost-provider">
                            {i18n("Provider")}
                        </Label>
                        <Input
                            id="cost-provider"
                            list="cost-provider-list"
                            value={provider}
                            onChange={(event) =>
                                setProvider(event.target.value)
                            }
                            required
                        />
                        <datalist id="cost-provider-list">
                            {[...new Set(providers)].map((name) => (
                                <option key={name} value={name} />
                            ))}
                        </datalist>
                    </div>
                    <div>
                        <Label htmlFor="cost-model">{i18n("Model ID")}</Label>
                        <Input
                            id="cost-model"
                            value={model}
                            onChange={(event) => setModel(event.target.value)}
                            required
                        />
                    </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                        <Label htmlFor="cost-input">
                            {i18n("Input USD / 1M tokens")}
                        </Label>
                        <Input
                            id="cost-input"
                            type="number"
                            min="0"
                            step="any"
                            value={input}
                            onChange={(event) => setInput(event.target.value)}
                        />
                    </div>
                    <div>
                        <Label htmlFor="cost-output">
                            {i18n("Output USD / 1M tokens")}
                        </Label>
                        <Input
                            id="cost-output"
                            type="number"
                            min="0"
                            step="any"
                            value={output}
                            onChange={(event) => setOutput(event.target.value)}
                        />
                    </div>
                    <div>
                        <Label htmlFor="cost-audio">
                            {i18n("Audio USD / hour")}
                        </Label>
                        <Input
                            id="cost-audio"
                            type="number"
                            min="0"
                            step="any"
                            value={audio}
                            onChange={(event) => setAudio(event.target.value)}
                        />
                    </div>
                </div>
                <p className="text-xs text-muted-foreground">
                    {i18n(
                        "Enter both token rates or an audio rate. Rates apply to future requests only.",
                    )}
                </p>
                <Button type="submit" size="sm" disabled={saving}>
                    {i18n("Save rate")}
                </Button>
            </form>
            {rates.length > 0 && (
                <ul className="mt-4 space-y-2 text-sm">
                    {rates.map((rate) => (
                        <li
                            key={rate.id}
                            className="flex items-center justify-between gap-3 rounded-md border p-2"
                        >
                            <div>
                                <div className="font-medium">
                                    {rate.provider} · {rate.model}
                                </div>
                                <div className="text-muted-foreground">
                                    {rate.inputUsdPerMillion !== null &&
                                        `${i18n("Input")}: $${rate.inputUsdPerMillion}/1M `}
                                    {rate.outputUsdPerMillion !== null &&
                                        `${i18n("Output")}: $${rate.outputUsdPerMillion}/1M `}
                                    {rate.audioUsdPerHour !== null &&
                                        `${i18n("Audio")}: $${rate.audioUsdPerHour}/h`}
                                </div>
                            </div>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => void remove(rate.id)}
                            >
                                {i18n("Remove")}
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
        </SettingsCard>
    );
}
