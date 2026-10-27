export interface AgendaOutcome {
    covered: string[];
    notCovered: string[];
    unplanned: string[];
}

/** Appended after the tasks directive, only for an absorbed agenda. */
export const SUMMARY_AGENDA_DIRECTIVE = `AGENDA: the user message includes an agenda labelled "the plan, not evidence". Return "agendaOutcome": {"covered": [pointId], "notCovered": [pointId], "unplanned": [text]} alongside the other JSON fields. Use only supplied point ids. Classify every point exactly once. A point is covered ONLY when the transcript supports that it was discussed. Ticks and notes are hints, never evidence; a ticked point with no transcript support is notCovered. Unplanned lists distinct topics actually discussed outside the plan, in the summary's language. Never invent discussion, decisions, facts or tasks from the plan. Reviewed tasks marked changedDuringMeeting are already decided; never propose them again in actionItems or taskUpdates.
Keep unplanned to at most 100 short topic lines, each at most 2000 characters.
The summary Markdown MUST end with an Agenda part, translating the heading and the Covered / Not covered / Unplanned subheadings into the summary's language. List the points by their text under the matching heading, and the supported unplanned topics. Keep ids only in agendaOutcome. This applies to every template, including custom templates and templates with task extraction disabled.`;

/** Appended to a merge only when the original recording has an agenda. */
export const SUMMARY_AGENDA_MERGE_DIRECTIVE = `AGENDA: preserve "agendaOutcome" in the reply. covered is the union of point ids covered by ANY input version; notCovered contains every supplied agenda point not covered by any version. Deduplicate unplanned topics, preserving distinct supported topics. Never invent coverage to reconcile versions. End the summary Markdown with an Agenda part in the summary's language (including translated Covered / Not covered / Unplanned subheadings), consistent with that union. Points, ticks and notes are a plan, never evidence. Do not create facts or tasks from them.`;

/** Accept only the outcome shape, retaining distinct nonempty strings. */
export function readAgendaOutcome(value: unknown): AgendaOutcome | null {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (
        ![row.covered, row.notCovered, row.unplanned].every(
            (entries) =>
                Array.isArray(entries) &&
                entries.every((entry) => typeof entry === "string"),
        )
    )
        return null;
    const strings = (entries: unknown) => [
        ...new Set(
            (entries as string[]).map((entry) => entry.trim()).filter(Boolean),
        ),
    ];
    const covered = strings(row.covered);
    return {
        covered,
        notCovered: strings(row.notCovered).filter(
            (id) => !covered.includes(id),
        ),
        unplanned: strings(row.unplanned)
            .slice(0, 100)
            .map((text) => text.slice(0, 2000)),
    };
}

/** Deterministic union across passes; a merge model cannot add or drop point coverage. */
export function mergeAgendaOutcomes(
    outcomes: readonly (AgendaOutcome | null | undefined)[],
    pointIds?: readonly string[],
): AgendaOutcome | null {
    const valid = outcomes.filter(
        (value): value is AgendaOutcome => value != null,
    );
    if (!valid.length) return null;
    const ids = new Set(
        pointIds ??
            valid.flatMap((outcome) => [
                ...outcome.covered,
                ...outcome.notCovered,
            ]),
    );
    const covered = [
        ...new Set(valid.flatMap((outcome) => outcome.covered)),
    ].filter((id) => ids.has(id));
    const seen = new Set<string>();
    const unplanned = valid
        .flatMap((outcome) => outcome.unplanned)
        .filter((text) => {
            const key = text
                .normalize("NFKC")
                .replace(/\s+/g, " ")
                .trim()
                .toLocaleLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    return {
        covered,
        notCovered: [...ids].filter((id) => !covered.includes(id)),
        unplanned: unplanned.slice(0, 100).map((text) => text.slice(0, 2000)),
    };
}
