"use client";

import { useEffect, useState } from "react";

/** Collapse state of one agenda part, remembered per agenda in this browser when storage is available. */
export function useAgendaCollapse(
    agendaId: string,
    part: string,
    defaultCollapsed = false,
) {
    const key = `agenda:${agendaId}:collapsed:${part}`;
    const [state, setState] = useState({ key, collapsed: defaultCollapsed });
    useEffect(() => {
        let collapsed = defaultCollapsed;
        try {
            const stored = window.localStorage.getItem(key);
            collapsed = stored === null ? defaultCollapsed : stored === "true";
        } catch {}
        setState({ key, collapsed });
    }, [key, defaultCollapsed]);
    const collapsed = state.key === key ? state.collapsed : defaultCollapsed;
    const toggle = () => {
        const next = !collapsed;
        setState({ key, collapsed: next });
        try {
            window.localStorage.setItem(key, String(next));
        } catch {}
    };
    return [collapsed, toggle] as const;
}
