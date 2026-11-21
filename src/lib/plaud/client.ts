import { gunzipSync } from "node:zlib";
import { AppError, ErrorCode } from "@/lib/errors";
import type {
    PlaudApiError,
    PlaudDeviceListResponse,
    PlaudFileDetailResponse,
    PlaudRecording,
    PlaudRecordingsResponse,
    PlaudTempUrlResponse,
    PlaudV4ContentUrlResponse,
    PlaudV4FileDetailResponse,
    PlaudV4FolderChildrenResponse,
    PlaudV4Node,
    PlaudV4RecordingsResponse,
    PlaudV4RenameResponse,
} from "@/types/plaud";
import { plaudFetch } from "./fetch";
import { safeParseJson } from "./parse";
import { DEFAULT_SERVER_KEY, PLAUD_SERVERS, PLAUD_USER_AGENT } from "./servers";
import {
    applyPlaudV4Detail,
    isPlaudV4MigratedResponse,
    mapPlaudV4Item,
    PLAUD_V4_VERSION_CONFLICT_STATUS,
    plaudV4AudioObjects,
    plaudV4DetailToLegacy,
    recordingIdToPlaudV4FileId,
    sortPlaudRecordings,
} from "./v4";
import { resolveWorkspaceToken } from "./workspace";

export interface PlaudUpdateFilenameResponse {
    status: number;
    msg: string;
    data_file?: unknown;
}

export interface PlaudMoveToTrashResponse {
    status: number;
    msg: string;
    data_file?: unknown;
}

export const DEFAULT_PLAUD_API_BASE = PLAUD_SERVERS[DEFAULT_SERVER_KEY].apiBase;
const V4_PAGE_SIZE = 50;
const V4_MAX_PAGES = 400;
const MAX_RETRIES = 3;
const MAX_AUTH_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function plaudHttpError(status: number, msg: string): AppError {
    if (status >= 500) {
        return new AppError(
            ErrorCode.PLAUD_UPSTREAM_ERROR,
            "Plaud is temporarily unavailable. Please try again later.",
            502,
            { plaudStatus: status, plaudMessage: msg },
        );
    }
    return new AppError(ErrorCode.PLAUD_API_ERROR, msg, 400, {
        plaudStatus: status,
    });
}

/** Carries the rejected token's database identity outside the error payload. */
export class PlaudTokenRejection extends AppError {
    readonly #bearerCiphertext: string | undefined;

    constructor(bearerCiphertext: string | undefined, error?: AppError) {
        super(
            ErrorCode.PLAUD_INVALID_TOKEN,
            error?.message ??
                "Plaud rejected the access token. Reconnect your Plaud account.",
            401,
            error?.details ?? { plaudStatus: 401 },
        );
        this.#bearerCiphertext = bearerCiphertext;
    }

    get bearerCiphertext(): string | undefined {
        return this.#bearerCiphertext;
    }
}

/**
 * True when `err` means Plaud rejected the token outright
 * (`PLAUD_INVALID_TOKEN`), as opposed to a rate limit, upstream or network
 * failure that may succeed on a later attempt.
 */
export function isPlaudTokenRejection(
    err: unknown,
): err is AppError & { code: ErrorCode.PLAUD_INVALID_TOKEN } {
    return (
        err instanceof AppError && err.code === ErrorCode.PLAUD_INVALID_TOKEN
    );
}

export interface PlaudClientOptions {
    /** Encrypted user token from the connection row, used only for guarded writes. */
    bearerCiphertext?: string;
    /** Supplies and persists a fresh user token for 401 recovery. */
    refreshUserToken?: () => Promise<{
        accessToken: string;
        bearerCiphertext: string;
    }>;
}

interface PlaudAuthorization {
    bearer: string;
    bearerCiphertext: string | undefined;
    workspace: boolean;
    reminted: boolean;
    refreshGeneration: number;
}

interface PlaudAuthorizationRetry {
    authorization: PlaudAuthorization;
    refreshed: boolean;
    attempts: number;
}

export class PlaudClient {
    private userToken: {
        accessToken: string;
        bearerCiphertext: string | undefined;
    };
    private readonly refreshUserToken?: PlaudClientOptions["refreshUserToken"];
    private readonly apiBase: string;
    private resolvedWorkspaceId?: string;
    private authorization?: PlaudAuthorization;
    private authorizationInFlight?: Promise<PlaudAuthorization>;
    private lastSuccessfulBearer?: string;
    private refreshGeneration = 0;
    private refreshRejected = false;
    private v4Mode = false;
    private v4List?: Promise<PlaudRecording[]>;
    private readonly v4SortedLists = new Map<string, PlaudRecording[]>();
    private readonly v4Details = new Map<
        string,
        NonNullable<PlaudV4FileDetailResponse["data"]>
    >();

    constructor(
        userToken: string,
        apiBase: string = DEFAULT_PLAUD_API_BASE,
        workspaceId?: string | null,
        options: PlaudClientOptions = {},
    ) {
        this.userToken = {
            accessToken: userToken,
            bearerCiphertext: options.bearerCiphertext,
        };
        this.refreshUserToken = options.refreshUserToken;
        this.apiBase = apiBase;
        this.resolvedWorkspaceId = workspaceId ?? undefined;
    }

    get workspaceId(): string | undefined {
        return this.resolvedWorkspaceId;
    }

    get usingUserTokenFallback(): boolean {
        return this.authorization?.workspace === false;
    }

    get usingPlaudV4(): boolean {
        return this.v4Mode;
    }

    get lastSuccessfulBearerCiphertext(): string | undefined {
        return this.lastSuccessfulBearer;
    }

    private async mintAuthorization(
        mode: "initial" | "remint" | "refreshed",
    ): Promise<PlaudAuthorization> {
        const { accessToken, bearerCiphertext } = this.userToken;
        let workspaceToken: string | undefined;
        try {
            const workspace = await resolveWorkspaceToken(
                accessToken,
                this.apiBase,
                this.resolvedWorkspaceId,
                mode !== "initial",
            );
            workspaceToken = workspace.workspaceToken;
            this.resolvedWorkspaceId = workspace.workspaceId;
        } catch (error) {
            if (mode !== "initial") {
                if (isPlaudTokenRejection(error))
                    throw new PlaudTokenRejection(bearerCiphertext);
                throw error instanceof AppError
                    ? error
                    : new AppError(
                          ErrorCode.PLAUD_UPSTREAM_ERROR,
                          "Failed to communicate with Plaud. Please try again later.",
                          502,
                      );
            }
            console.warn(
                "[plaud] workspace token mint failed, falling back to user token",
            );
        }

        return {
            bearer: workspaceToken ?? accessToken,
            bearerCiphertext,
            workspace: workspaceToken !== undefined,
            reminted: mode === "remint",
            refreshGeneration: this.refreshGeneration,
        };
    }

    private async updateAuthorization(
        load: () => Promise<PlaudAuthorization>,
    ): Promise<PlaudAuthorization> {
        if (this.authorizationInFlight) return this.authorizationInFlight;
        this.authorizationInFlight = load();
        try {
            this.authorization = await this.authorizationInFlight;
            return this.authorization;
        } finally {
            this.authorizationInFlight = undefined;
        }
    }

    private async getAuthorization(): Promise<PlaudAuthorization> {
        if (this.authorizationInFlight) return this.authorizationInFlight;
        return (
            this.authorization ??
            this.updateAuthorization(() =>
                this.mintAuthorization(
                    this.refreshGeneration === 0 ? "initial" : "refreshed",
                ),
            )
        );
    }

    private async recoverAuthorization(
        rejected: PlaudAuthorization,
        canRemint: boolean,
        canRefresh: boolean,
    ): Promise<PlaudAuthorization> {
        if (
            this.authorizationInFlight ||
            (this.authorization && this.authorization !== rejected) ||
            rejected.refreshGeneration !== this.refreshGeneration
        ) {
            return this.getAuthorization();
        }

        return this.updateAuthorization(async () => {
            if (!canRefresh || this.refreshRejected) {
                throw new PlaudTokenRejection(rejected.bearerCiphertext);
            }
            if (canRemint && rejected.workspace && !rejected.reminted) {
                try {
                    return await this.mintAuthorization("remint");
                } catch (error) {
                    if (!isPlaudTokenRejection(error)) throw error;
                }
            }

            if (!this.refreshUserToken)
                throw new PlaudTokenRejection(rejected.bearerCiphertext);
            try {
                this.userToken = await this.refreshUserToken();
            } catch (error) {
                if (!isPlaudTokenRejection(error)) throw error;
                this.refreshRejected = true;
                throw new PlaudTokenRejection(rejected.bearerCiphertext, error);
            }

            this.refreshGeneration++;
            this.authorization = undefined;
            return this.mintAuthorization(
                rejected.workspace ? "refreshed" : "initial",
            );
        });
    }

    private async request<T>(
        endpoint: string,
        options?: RequestInit,
        retryCount = 0,
        authRetry?: PlaudAuthorizationRetry,
    ): Promise<T> {
        const authorization =
            authRetry?.authorization ?? (await this.getAuthorization());
        const url = `${this.apiBase}${endpoint}`;

        try {
            const response = await plaudFetch(url, {
                ...options,
                headers: {
                    ...options?.headers,
                    Authorization: `Bearer ${authorization.bearer}`,
                    "Content-Type": "application/json",
                    "User-Agent": PLAUD_USER_AGENT,
                },
            });

            if (response.status === 429) {
                if (!authRetry && retryCount < MAX_RETRIES) {
                    const retryAfter = response.headers.get("Retry-After");
                    const delay = retryAfter
                        ? Number.parseInt(retryAfter, 10) * 1000
                        : INITIAL_RETRY_DELAY * 2 ** retryCount;
                    await sleep(delay);
                    return this.request<T>(endpoint, options, retryCount + 1);
                }
                const retryAfter = response.headers.get("Retry-After");
                throw new AppError(
                    ErrorCode.PLAUD_RATE_LIMITED,
                    "Too many requests to Plaud. Please try again later.",
                    429,
                    retryAfter
                        ? { retryAfter: Number.parseInt(retryAfter, 10) }
                        : undefined,
                );
            }

            if (response.status === 401) {
                await response.body?.cancel().catch(() => undefined);
                const attempts = authRetry?.attempts ?? 0;
                if (attempts >= MAX_AUTH_RETRIES) {
                    throw new PlaudTokenRejection(
                        authorization.bearerCiphertext,
                    );
                }
                const next = await this.recoverAuthorization(
                    authorization,
                    authRetry === undefined,
                    !authRetry?.refreshed,
                );
                return this.request<T>(endpoint, options, retryCount, {
                    authorization: next,
                    attempts: attempts + 1,
                    refreshed:
                        authRetry?.refreshed === true ||
                        next.refreshGeneration !==
                            authorization.refreshGeneration,
                });
            }

            if (!response.ok) {
                const error = (await response
                    .json()
                    .catch(() => ({}) as PlaudApiError)) as PlaudApiError;
                const upstreamMsg = error.msg || response.statusText;

                if (
                    !authRetry &&
                    response.status >= 500 &&
                    response.status < 600 &&
                    retryCount < MAX_RETRIES
                ) {
                    const delay = INITIAL_RETRY_DELAY * 2 ** retryCount;
                    await sleep(delay);
                    return this.request<T>(endpoint, options, retryCount + 1);
                }

                throw plaudHttpError(response.status, upstreamMsg);
            }

            const body = await safeParseJson<T>(response);
            this.lastSuccessfulBearer = authorization.bearerCiphertext;
            return body;
        } catch (error) {
            if (
                !authRetry &&
                error instanceof TypeError &&
                error.message.includes("fetch") &&
                retryCount < MAX_RETRIES
            ) {
                const delay = INITIAL_RETRY_DELAY * 2 ** retryCount;
                await sleep(delay);
                return this.request<T>(endpoint, options, retryCount + 1);
            }

            if (error instanceof AppError) throw error;
            throw new AppError(
                ErrorCode.PLAUD_UPSTREAM_ERROR,
                "Failed to communicate with Plaud. Please try again later.",
                502,
            );
        }
    }

    /**
     * Fetch the device list. Validates the response shape before returning:
     * a 200 with a non-zero `status` (or missing/malformed `data_devices`) is
     * a business-level Plaud error, not a schema `PlaudDeviceListResponse`
     * guarantees -- callers that iterate `data_devices` without this check
     * crash on an undefined array (issue #231). Surfaces as a typed,
     * actionable `PLAUD_API_ERROR` instead.
     */
    async listDevices(): Promise<PlaudDeviceListResponse> {
        const body =
            await this.request<PlaudDeviceListResponse>("/device/list");
        if (body?.status !== 0 || !Array.isArray(body.data_devices)) {
            throw new AppError(
                ErrorCode.PLAUD_API_ERROR,
                body?.msg ||
                    "Plaud returned an invalid device list response. Reconnect your Plaud account and try again.",
                400,
                { plaudStatus: body?.status },
            );
        }
        return body;
    }

    private detectMigration(body: unknown): boolean {
        if (!isPlaudV4MigratedResponse(body)) return false;
        this.v4Mode = true;
        return true;
    }

    async getRecordings(
        skip: number = 0,
        limit: number = 99999,
        isTrash: number = 0,
        sortBy: string = "edit_time",
        isDesc: boolean = true,
    ): Promise<PlaudRecordingsResponse> {
        if (!this.v4Mode) {
            const params = new URLSearchParams({
                skip: skip.toString(),
                limit: limit.toString(),
                is_trash: isTrash.toString(),
                sort_by: sortBy,
                is_desc: isDesc.toString(),
            });

            const body = await this.request<PlaudRecordingsResponse>(
                `/file/simple/web?${params.toString()}`,
            );
            if (!this.detectMigration(body)) {
                if (Array.isArray(body?.data_file_list)) return body;
                throw new AppError(
                    ErrorCode.PLAUD_API_ERROR,
                    body?.msg ||
                        "Plaud returned an invalid recordings list response.",
                    400,
                    { plaudStatus: body?.status },
                );
            }
        }

        if (isTrash !== 0) {
            return {
                status: 0,
                msg: "success",
                data_file_total: 0,
                data_file_list: [],
            };
        }
        if (!this.v4List) {
            this.v4List = this.listAllRecordingsV4().catch((error) => {
                this.v4List = undefined;
                throw error;
            });
        }
        const recordings = await this.v4List;
        const sort =
            sortBy === "create_time" || sortBy === "start_time"
                ? "start_time"
                : "edit_time";
        const key = `${sort}:${isDesc}`;
        let all = this.v4SortedLists.get(key);
        if (!all) {
            all = sortPlaudRecordings(recordings, sort, isDesc);
            this.v4SortedLists.set(key, all);
        }
        return {
            status: 0,
            msg: "success",
            data_file_total: all.length,
            data_file_list: all.slice(skip, skip + limit),
        };
    }

    private async listAllRecordingsV4(): Promise<PlaudRecording[]> {
        const recordings = new Map<string, PlaudRecording>();
        const seenCursors = new Set<string>();
        let cursor: string | null | undefined;
        for (let page = 0; page < V4_MAX_PAGES; page++) {
            const params = new URLSearchParams({
                sort_by: "created",
                sort_order: "desc",
                page_size: V4_PAGE_SIZE.toString(),
            });
            if (cursor) params.set("cursor", cursor);

            const body = await this.request<PlaudV4RecordingsResponse>(
                `/file-app/v4/recordings/all?${params.toString()}`,
            );
            if (body?.status !== 0 || !Array.isArray(body.data?.items)) {
                throw new AppError(
                    ErrorCode.PLAUD_API_ERROR,
                    body?.msg ||
                        "Plaud returned an invalid v4 recordings response.",
                    400,
                    { plaudStatus: body?.status },
                );
            }
            for (const item of body.data.items) {
                if (!item?.file_id) continue;
                const recording = mapPlaudV4Item(item);
                const previous = recordings.get(recording.id);
                if (!previous || recording.version_ms > previous.version_ms) {
                    recordings.set(recording.id, recording);
                }
            }
            cursor = body.data.next_cursor;
            if (!cursor) return [...recordings.values()];
            if (seenCursors.has(cursor)) {
                throw new AppError(
                    ErrorCode.PLAUD_API_ERROR,
                    "Plaud returned a repeated recordings cursor.",
                    400,
                );
            }
            seenCursors.add(cursor);
        }

        throw new AppError(
            ErrorCode.PLAUD_API_ERROR,
            "Plaud recording scan exceeded the page limit.",
            400,
        );
    }

    private async getFileDetailV4(
        recordingId: string,
        { fresh = false }: { fresh?: boolean } = {},
    ): Promise<NonNullable<PlaudV4FileDetailResponse["data"]>> {
        const fileId = recordingIdToPlaudV4FileId(recordingId);
        const cached = this.v4Details.get(fileId);
        if (cached && !fresh) return cached;

        const body = await this.request<PlaudV4FileDetailResponse>(
            `/file-app/v4/files/detail/${encodeURIComponent(fileId)}`,
        );
        if (body?.status !== 0 || !body.data) {
            throw new AppError(
                ErrorCode.PLAUD_API_ERROR,
                body?.msg || "Plaud returned an invalid v4 file detail.",
                400,
                { plaudStatus: body?.status },
            );
        }
        this.v4Details.set(fileId, body.data);
        return body.data;
    }

    /**
     * Complete a recording listed through the v4 API (device serial, size,
     * timezone) from its v4 detail. No-op for legacy listings, so callers
     * can invoke it unconditionally before downloading.
     */
    async hydrateRecording(recording: PlaudRecording): Promise<PlaudRecording> {
        if (recording.source !== "v4") return recording;
        const detail = await this.getFileDetailV4(recording.id);
        return applyPlaudV4Detail(recording, detail);
    }

    private async getAudioUrlV4(recordingId: string): Promise<string> {
        const detail = await this.getFileDetailV4(recordingId);
        for (const audio of plaudV4AudioObjects(detail)) {
            if (audio.content_url) return audio.content_url;
            if (audio.content_id) {
                const urls = await this.resolveContentUrlsV4([
                    audio.content_id,
                ]);
                const url = urls[audio.content_id];
                if (typeof url === "string" && url) return url;
            }
        }

        throw new AppError(
            ErrorCode.PLAUD_API_ERROR,
            "Plaud has no downloadable audio for this recording yet.",
            400,
        );
    }

    private async resolveContentUrlsV4(
        contentIds: string[],
    ): Promise<Record<string, string>> {
        if (contentIds.length === 0) return {};
        const body = await this.request<PlaudV4ContentUrlResponse>(
            "/file-app/v4/files/content/url",
            {
                method: "POST",
                body: JSON.stringify({ content_ids: contentIds }),
            },
        );
        return body?.status === 0 ? (body.data?.url_map ?? {}) : {};
    }

    private async withContentUrlsV4(
        detail: NonNullable<PlaudV4FileDetailResponse["data"]>,
    ): Promise<NonNullable<PlaudV4FileDetailResponse["data"]>> {
        const objects = detail.objects ?? [];
        const missing = objects.flatMap((object) =>
            (object.object_type === "TRANSCRIPT" ||
                object.object_type === "SUMMARY") &&
            object.task_status === 1 &&
            !object.content_url &&
            object.content_id
                ? [object.content_id]
                : [],
        );
        if (missing.length === 0) return detail;
        const urls = await this.resolveContentUrlsV4(missing);
        return {
            ...detail,
            objects: objects.map((object) => {
                const url = object.content_id
                    ? urls[object.content_id]
                    : undefined;
                return !object.content_url && typeof url === "string" && url
                    ? { ...object, content_url: url }
                    : object;
            }),
        };
    }

    async getTempUrl(
        fileId: string,
        isOpus: boolean = true,
    ): Promise<PlaudTempUrlResponse> {
        if (!this.v4Mode) {
            const params = new URLSearchParams({ is_opus: isOpus ? "1" : "0" });
            const body = await this.request<PlaudTempUrlResponse>(
                `/file/temp-url/${fileId}?${params.toString()}`,
            );
            if (!this.detectMigration(body)) return body;
        }
        return { status: 0, temp_url: await this.getAudioUrlV4(fileId) };
    }

    async downloadRecording(
        fileId: string,
        preferOpus: boolean = true,
    ): Promise<Buffer> {
        try {
            const tempUrlResponse = await this.getTempUrl(fileId, preferOpus);
            const downloadUrl =
                preferOpus && tempUrlResponse.temp_url_opus
                    ? tempUrlResponse.temp_url_opus
                    : tempUrlResponse.temp_url;

            const response = await plaudFetch(downloadUrl);
            if (!response.ok) {
                throw new AppError(
                    ErrorCode.PLAUD_UPSTREAM_ERROR,
                    "Failed to download recording from Plaud. Please try again later.",
                    502,
                    { plaudStatus: response.status },
                );
            }

            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer);
        } catch (error) {
            if (error instanceof AppError) throw error;
            throw new AppError(
                ErrorCode.PLAUD_UPSTREAM_ERROR,
                "Failed to download recording from Plaud. Please try again later.",
                502,
            );
        }
    }

    /**
     * Fetch a recording's content manifest (`/file/detail/{id}`) — lists the
     * transcript / summary / note items Plaud has processed and the presigned
     * links to their bodies. Goes through `request`, so it inherits
     * workspace-token auth, retry/backoff, and 401 → PLAUD_INVALID_TOKEN.
     * NOTE: the response shape is unverified (see #204 / Phase 0).
     * V4 content imports use fresh presigned links.
     */
    async getFileDetail(fileId: string): Promise<PlaudFileDetailResponse> {
        if (!this.v4Mode) {
            const body = await this.request<PlaudFileDetailResponse>(
                `/file/detail/${fileId}`,
            );
            if (!this.detectMigration(body)) return body;
        }
        return plaudV4DetailToLegacy(
            await this.withContentUrlsV4(
                await this.getFileDetailV4(fileId, { fresh: true }),
            ),
        );
    }

    /**
     * Fetch a presigned content link (transcript / summary JSON) from S3.
     * Unlike Plaud API calls this carries no auth header and is gzip-aware:
     * undici inflates transparently when `Content-Encoding: gzip` is present,
     * otherwise we detect the gzip magic bytes and inflate manually. Returns
     * parsed JSON, or the raw string when the body isn't JSON (parsers
     * tolerate both). A 403 here means an expired presign (skip this item) —
     * distinct from a dead Plaud token (401 from `getFileDetail`).
     */
    async fetchContentLink(url: string): Promise<unknown> {
        const response = await plaudFetch(url);
        if (!response.ok) {
            throw new AppError(
                ErrorCode.PLAUD_UPSTREAM_ERROR,
                "Failed to fetch Plaud content link.",
                502,
                { plaudStatus: response.status },
            );
        }

        const arrayBuffer = await response.arrayBuffer();
        let buf = Buffer.from(arrayBuffer);
        if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
            buf = gunzipSync(buf);
        }

        const text = buf.toString("utf-8");
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }

    async testConnection(): Promise<boolean> {
        try {
            await this.listDevices();
            return true;
        } catch {
            return false;
        }
    }

    async updateFilename(
        fileId: string,
        filename: string,
    ): Promise<PlaudUpdateFilenameResponse> {
        if (!this.v4Mode) {
            const body = await this.request<PlaudUpdateFilenameResponse>(
                `/file/${fileId}`,
                {
                    method: "PATCH",
                    body: JSON.stringify({ filename }),
                },
            );
            if (!this.detectMigration(body)) return body;
        }
        return this.renameV4(fileId, filename);
    }

    private async renameV4(
        recordingId: string,
        name: string,
    ): Promise<PlaudUpdateFilenameResponse> {
        let fileNode: PlaudV4Node | undefined;
        const renamed = await this.renameNodeV4(name, async () => {
            const detail = await this.getFileDetailV4(recordingId, {
                fresh: true,
            });
            fileNode = detail.node ?? undefined;
            return { nodeId: fileNode?.node_id, version: fileNode?.version_ms };
        });

        const folder = fileNode?.folder;
        const previousName = fileNode?.name;
        if (
            folder?.folder_id &&
            folder.name &&
            folder.name === previousName &&
            folder.name !== name
        ) {
            const folderId = folder.folder_id;
            const parentId = fileNode?.breadcrumbs?.[0]?.node_id;
            let fromResponse = renamed?.data?.parent_items?.find(
                (p) => p.node_id === folderId && p.name !== undefined,
            );
            try {
                await this.renameNodeV4(name, async () => {
                    const current =
                        fromResponse ??
                        (parentId
                            ? await this.findChildV4(parentId, folderId)
                            : undefined);
                    fromResponse = undefined;
                    if (!current || current.name !== previousName) {
                        return { skip: true };
                    }
                    return { nodeId: folderId, version: current.version_ms };
                });
            } catch (error) {
                console.warn(
                    "[plaud] v4 folder rename failed",
                    error instanceof AppError
                        ? error.code
                        : ErrorCode.INTERNAL_ERROR,
                );
            }
        }

        return { status: 0, msg: "success", data_file: renamed?.data };
    }

    private async renameNodeV4(
        name: string,
        resolve: () => Promise<{
            nodeId?: string;
            version?: number;
            skip?: boolean;
        }>,
    ): Promise<PlaudV4RenameResponse | undefined> {
        let lastStatus: number | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
            const { nodeId, version, skip } = await resolve();
            if (skip) return undefined;
            if (!nodeId || version === undefined) {
                throw new AppError(
                    ErrorCode.PLAUD_API_ERROR,
                    "Plaud returned no node version to rename.",
                    400,
                );
            }
            const body = await this.request<PlaudV4RenameResponse>(
                `/file-app/v4/nodes/rename/${encodeURIComponent(nodeId)}`,
                {
                    method: "PATCH",
                    body: JSON.stringify({ name, origin_version: version }),
                },
            );
            if (body?.status === 0) return body;
            lastStatus = body?.status;
            if (body?.status !== PLAUD_V4_VERSION_CONFLICT_STATUS) {
                throw new AppError(
                    ErrorCode.PLAUD_API_ERROR,
                    body?.msg || "Plaud rejected the rename.",
                    400,
                    { plaudStatus: body?.status },
                );
            }
        }
        throw new AppError(
            ErrorCode.PLAUD_API_ERROR,
            "Plaud rename failed: node version conflict.",
            400,
            { plaudStatus: lastStatus },
        );
    }

    private async findChildV4(
        parentId: string,
        childId: string,
    ): Promise<PlaudV4Node | undefined> {
        let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
            const params = new URLSearchParams({
                node_id: parentId,
                page_size: V4_PAGE_SIZE.toString(),
            });
            if (cursor) params.set("cursor", cursor);
            const body = await this.request<PlaudV4FolderChildrenResponse>(
                `/file-app/v4/folders/children?${params.toString()}`,
            );
            if (body?.status !== 0 || !Array.isArray(body.data?.items)) {
                return undefined;
            }
            const items = body.data.items;
            const hit = items.find((i) => i.node_id === childId);
            if (hit) return hit;
            const next = body?.data?.next_cursor;
            if (!next || items.length === 0) return undefined;
            cursor = next;
        }
        return undefined;
    }

    /** Move a Plaud recording to Trash. Plaud requires a separate action to permanently empty Trash. */
    async moveFileToTrash(fileId: string): Promise<PlaudMoveToTrashResponse> {
        if (!this.v4Mode) {
            const body = await this.request<PlaudMoveToTrashResponse>(
                `/file/${fileId}`,
                {
                    method: "PATCH",
                    body: JSON.stringify({ is_trash: true }),
                },
            );
            if (!this.detectMigration(body)) return body;
        }
        throw new AppError(
            ErrorCode.PLAUD_API_ERROR,
            "Moving to Plaud Trash is not supported for Plaud 4.0 accounts yet.",
            400,
        );
    }
}

export * from "./types";
