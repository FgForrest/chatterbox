"use client";

import { createContext } from "react";

export interface AgendaPresence {
    hasAgenda: boolean;
    agendaCandidateCount: number;
}

export interface AgendaSummaryState {
    itemId: string;
    presence?: AgendaPresence;
    hasSummary: boolean;
    working?: boolean;
    run: () => void;
    disabled: boolean;
}

export const RecordingAgendaContext = createContext<
    ((state: AgendaSummaryState | null) => void) | null
>(null);
