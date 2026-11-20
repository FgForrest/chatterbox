"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type FetchStatus = "loading" | "ready" | "error";

interface PartRequest {
    identity: string;
    url: string | null;
    version: string | undefined;
}

interface PartState<T> {
    request: PartRequest;
    data: T | null | undefined;
    status: FetchStatus;
    lastOk: boolean;
}

interface PartFetchOptions<T> {
    cachedData?: T | null;
    onLoad?: (data: T, signal: AbortSignal) => void;
}

interface PartRead<T> {
    request: PartRequest;
    controller: AbortController;
    result: Promise<T | null>;
    settled: boolean;
}

function dataFor<T>(
    state: PartState<T>,
    request: PartRequest,
    cachedData: T | null | undefined,
) {
    if (!request.url) return undefined;
    return state.request.identity === request.identity
        ? state.data
        : cachedData;
}

/** Refetch an item part by URL and version, retaining data for the same identity. */
export function useItemPartFetch<T>(
    url: string | null,
    version: string | undefined,
    identity: string,
    options?: PartFetchOptions<T>,
) {
    const request = useMemo(
        () => ({ identity, url, version }),
        [identity, url, version],
    );
    const [state, setState] = useState<PartState<T>>({
        request,
        data: options?.cachedData,
        status: "loading",
        lastOk: false,
    });
    const currentState = useRef(state);
    const updateState = useCallback((next: PartState<T>) => {
        currentState.current = next;
        setState(next);
    }, []);
    const currentRequest = useRef(request);
    currentRequest.current = request;
    const currentOptions = useRef(options);
    currentOptions.current = options;
    const pending = useRef<PartRead<T> | null>(null);

    const startRead = useCallback(
        (target: PartRequest) => {
            pending.current?.controller.abort();
            const controller = new AbortController();
            const previous = currentState.current;
            updateState({
                request: target,
                data: dataFor(
                    previous,
                    target,
                    currentOptions.current?.cachedData,
                ),
                status: "loading",
                lastOk:
                    previous.request.identity === target.identity &&
                    previous.lastOk,
            });

            const isCurrent = () =>
                !controller.signal.aborted && currentRequest.current === target;
            const load = async () => {
                if (!target.url) return null;
                try {
                    const response = await fetch(target.url, {
                        signal: controller.signal,
                    });
                    if (!response.ok) throw new Error(String(response.status));
                    const data = (await response.json()) as T;
                    if (!isCurrent()) return null;
                    updateState({
                        request: target,
                        data,
                        status: "ready",
                        lastOk: true,
                    });
                    currentOptions.current?.onLoad?.(data, controller.signal);
                    return data;
                } catch {
                    if (isCurrent()) {
                        updateState({
                            ...currentState.current,
                            status: "error",
                            lastOk: false,
                        });
                    }
                    return null;
                }
            };

            const read: PartRead<T> = {
                request: target,
                controller,
                result: load().finally(() => {
                    read.settled = true;
                }),
                settled: false,
            };
            pending.current = read;
            return read;
        },
        [updateState],
    );

    useEffect(() => {
        startRead(request);
        return () => {
            const read = pending.current;
            if (read?.request === request) {
                read.controller.abort();
                pending.current = null;
            }
        };
    }, [request, startRead]);

    const matchesScope = useCallback(
        (target: PartRequest) =>
            target.identity === identity && target.url === url,
        [identity, url],
    );
    const cancel = useCallback(() => {
        if (matchesScope(currentRequest.current))
            pending.current?.controller.abort();
    }, [matchesScope]);

    const reading = useCallback(() => {
        const read = pending.current;
        return Boolean(
            read &&
                matchesScope(read.request) &&
                !read.settled &&
                !read.controller.signal.aborted,
        );
    }, [matchesScope]);

    const reload = useCallback(async () => {
        if (!pending.current || !matchesScope(currentRequest.current))
            return null;
        let read: PartRead<T> | null = startRead(currentRequest.current);
        while (read && matchesScope(read.request)) {
            const data = await read.result;
            if (!matchesScope(currentRequest.current)) return null;
            if (pending.current === read) return data;
            read = pending.current;
        }
        return null;
    }, [matchesScope, startRead]);

    const getData = useCallback(
        () =>
            dataFor(
                currentState.current,
                currentRequest.current,
                currentOptions.current?.cachedData,
            ),
        [],
    );

    const setData = useCallback(
        (
            data: T | null,
            options?: Partial<Pick<PartState<T>, "status" | "lastOk">>,
        ) => {
            const current = currentRequest.current;
            if (!matchesScope(current)) return false;
            cancel();
            const previous = currentState.current;
            const sameIdentity = previous.request.identity === current.identity;
            updateState({
                request: current,
                data,
                status:
                    options?.status ??
                    (sameIdentity && previous.status === "error"
                        ? "error"
                        : "ready"),
                lastOk: options?.lastOk ?? (sameIdentity && previous.lastOk),
            });
            return true;
        },
        [cancel, matchesScope, updateState],
    );

    return {
        data: dataFor(state, request, options?.cachedData) ?? null,
        status: state.request === request ? state.status : "loading",
        lastOk: !!url && state.request.identity === identity && state.lastOk,
        cancel,
        reading,
        reload,
        getData,
        setData,
    };
}
