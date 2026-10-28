"use client";

import { useExtracted, useFormatter } from "next-intl";
import {
    type ComboboxOption,
    SearchCombobox,
} from "@/components/ui/search-combobox";
import type { CalendarChoices } from "./types";

/** One event picker for preparing a meeting and editing its linked event. */
export function CalendarEventPicker({
    choices,
    value,
    onValueChange,
    current,
    agendaId,
    disabled,
    allowEmpty = false,
}: {
    choices: CalendarChoices | null;
    value: string;
    onValueChange: (value: string) => void;
    current?: { id: string; title: string };
    agendaId?: string;
    disabled?: boolean;
    allowEmpty?: boolean;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const options: ComboboxOption[] = [];
    if (allowEmpty)
        options.push({
            value: "",
            label: i18n("Without a calendar event"),
        });
    const events = [...(choices?.recurring ?? []), ...(choices?.other ?? [])];
    if (current && !events.some((event) => event.id === current.id))
        options.push({ value: current.id, label: current.title });
    for (const [group, events] of [
        [
            i18n("Recurring meetings recorded in this folder"),
            choices?.recurring ?? [],
        ],
        [i18n("Other calendar events"), choices?.other ?? []],
    ] as const) {
        for (const event of events)
            options.push({
                value: event.id,
                label: event.title,
                group,
                disabled: Boolean(
                    agendaId &&
                        event.visibleAgenda &&
                        event.visibleAgenda.id !== agendaId,
                ),
                description: (
                    <>
                        <span className="block">
                            {format.dateTime(new Date(event.start), {
                                dateStyle: "medium",
                                timeStyle: "short",
                            })}
                            –
                            {format.dateTime(new Date(event.end), {
                                timeStyle: "short",
                            })}
                        </span>
                        {event.recordingCount > 0 && (
                            <span className="block">
                                {i18n(
                                    "{count, plural, one {# recording in this folder} other {# recordings in this folder}}",
                                    { count: event.recordingCount },
                                )}
                            </span>
                        )}
                        <span className="block">
                            {i18n(
                                "{count, plural, one {# invitee} other {# invitees}}",
                                { count: event.attendees.length },
                            )}
                        </span>
                        {event.visibleAgenda && (
                            <span className="block text-primary">
                                {i18n("Open agenda · Prepared by {author}", {
                                    author:
                                        event.visibleAgenda.author.name ??
                                        i18n("Unknown author"),
                                })}
                            </span>
                        )}
                    </>
                ),
            });
    }
    return (
        <SearchCombobox
            aria-label={i18n("Calendar event")}
            options={options}
            value={value}
            onValueChange={onValueChange}
            disabled={disabled}
        />
    );
}
