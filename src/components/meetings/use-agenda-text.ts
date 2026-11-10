"use client";

import { useExtracted } from "next-intl";
import { type RefObject, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
    type AgendaTextState,
    bindAgendaTextInput,
} from "@/lib/meetings/text-sync";
import { meetingRequest, meetingUrl } from "./api";

export function useAgendaText(
    input: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
    agendaId: string,
    field: string,
    enabled: boolean,
    revision: number,
    onValue: (value: string) => void,
) {
    const i18n = useExtracted();
    const saveError = i18n("Could not save the agenda");
    const callbacks = useRef({ onValue, saveError });
    callbacks.current = { onValue, saveError };
    const binding = useRef<ReturnType<typeof bindAgendaTextInput> | null>(null);
    useEffect(() => {
        if (!enabled || !input.current) return;
        const current = bindAgendaTextInput(
            input.current,
            field,
            {
                get: (field) =>
                    meetingRequest<AgendaTextState>(
                        meetingUrl(
                            agendaId,
                            `/text?field=${encodeURIComponent(field)}`,
                        ),
                    ),
                send: (body) =>
                    meetingRequest<AgendaTextState>(
                        meetingUrl(agendaId, "/text"),
                        "POST",
                        body,
                    ),
            },
            {
                onValue: (value) => callbacks.current.onValue(value),
                onSaved: () =>
                    window.dispatchEvent(
                        new CustomEvent("agenda-text-saved", {
                            detail: agendaId,
                        }),
                    ),
                onError: () => toast.error(callbacks.current.saveError),
            },
        );
        binding.current = current;
        return () => {
            binding.current = null;
            current.destroy();
        };
    }, [enabled, input, agendaId, field]);
    useEffect(() => {
        if (revision >= 0) void binding.current?.resync().catch(() => {});
    }, [revision]);
    return {
        enabled,
        flush: () => binding.current?.flush() ?? Promise.resolve(true),
        materializedVersion: () => binding.current?.materializedVersion(),
    };
}
