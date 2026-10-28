import {
    type FolderKnowledgeScope,
    folderKnowledgeContext,
    folderKnowledgeCorrections,
    folderKnowledgeFacts,
    folderKnowledgeRecords,
} from "@/db/queries/folder-knowledge";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { resolveReadableFolder } from "@/lib/folders/folders";
import { itemScopeFolderIds } from "@/lib/folders/item-scope";
import { folderCareFor } from "@/lib/knowledge/folder-care";
import {
    FOLDER_KNOWLEDGE_PAGE_SIZE,
    FOLDER_KNOWLEDGE_PREVIEW_TERMS,
    type FolderKnowledgeTab,
} from "@/lib/knowledge/folder-knowledge";
import { readableScopes } from "@/lib/knowledge/scope";
import { vocabularyVisibleTo } from "@/lib/knowledge/vocabulary";
import {
    almanacRecordsFor,
    correctionAlmanacJson,
    MAX_ALMANAC_RECORDS,
} from "@/lib/learn/correction-pass";
import { getOrgUserId } from "@/lib/org/config";
import { folderDefaultProfile } from "@/lib/profiles/resolve-for-placement";
import {
    almanacTermRankingInput,
    MAX_ALMANAC_TERMS,
    rankAlmanacTermsWithOverflow,
} from "@/lib/transcription/almanac-terms";

/** A bounded, read-only tab of knowledge visible to this folder's viewer. */
export async function readFolderKnowledge(
    viewerId: string,
    folderId: string,
    tab: FolderKnowledgeTab,
    offset = 0,
    language?: string | null,
) {
    const orgUserId = await getOrgUserId();
    const target = await resolveReadableFolder(viewerId, folderId);
    if (!target)
        throw new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404);
    const { folder } = target;
    const shared = target.scope === "org";
    const scope: FolderKnowledgeScope = {
        folderId,
        ownerId: folder.userId,
        viewerId,
        shared,
        allOwnedItems: !shared && folder.kind === "private",
        scopes: readableScopes(
            { kind: "recording", ownerUserId: viewerId, shared },
            orgUserId,
        ),
    };
    return readScopedKnowledge(
        scope,
        {
            folder: {
                id: folder.id,
                name: decryptText(folder.name),
                scope: shared ? ("org" as const) : ("personal" as const),
                isRoot: folder.parentId === null,
            },
        },
        tab,
        offset,
        language,
    );
}

/** Read one authorized knowledge scope using the shared folder/item queries. */
export async function readScopedKnowledge<T extends object>(
    scope: FolderKnowledgeScope,
    target: T,
    tab: FolderKnowledgeTab,
    offset = 0,
    language?: string | null,
    namedRecordIds?: ReadonlySet<string>,
) {
    const { viewerId, folderId, shared } = scope;
    const orgUserId = await getOrgUserId();
    const metadata = (
        context: Awaited<ReturnType<typeof folderKnowledgeContext>>,
    ) => ({
        ...target,
        itemCount: context.itemCount,
        subfolderCount: context.subfolderCount,
    });
    const limit = FOLDER_KNOWLEDGE_PAGE_SIZE;
    const page = (rows: readonly { total: number }[], total: number) => ({
        total,
        nextOffset: rows.length > limit ? offset + limit : null,
    });
    const scopeOf = (userId: string) =>
        userId === orgUserId ? ("org" as const) : ("personal" as const);
    if (tab === "people" || tab === "things") {
        const { rows, context, total } = await folderKnowledgeRecords(
            scope,
            tab,
            offset,
            limit + 1,
        );
        const vocabulary =
            tab === "things"
                ? await vocabularyVisibleTo(viewerId, { sharedOnly: shared })
                : null;
        const typeLabels = new Map(
            vocabulary?.entityTypes.map((type) => [type.key, type.label]),
        );
        return {
            ...metadata(context),
            ...(await folderCareFor(
                viewerId,
                rows
                    .slice(0, limit)
                    .filter((row) => row.user_id === orgUserId)
                    .map((row) => row.id),
            )),
            tab,
            ...page(rows, total),
            records: rows.slice(0, limit).map((row) => ({
                id: row.id,
                name: decryptText(row.name),
                typeKey: row.type_key,
                typeLabel: typeLabels.get(row.type_key) ?? row.type_key,
                scope: scopeOf(row.user_id),
                hasEmail: row.has_email,
                itemCount: Number(row.item_count),
                lastAt: new Date(row.last_at).toISOString(),
            })),
        };
    }
    if (tab === "corrections") {
        const { rows, context, total } = await folderKnowledgeCorrections(
            scope,
            offset,
            limit + 1,
        );
        return {
            ...metadata(context),
            ...(await folderCareFor(
                viewerId,
                rows
                    .slice(0, limit)
                    .filter((row) => row.user_id === orgUserId)
                    .map((row) => row.target_id),
            )),
            tab,
            ...page(rows, total),
            corrections: rows.slice(0, limit).map((row) => ({
                id: row.id,
                heard: decryptText(row.heard),
                targetId: row.target_id,
                targetName: decryptText(row.target_name),
                scope: scopeOf(row.user_id),
                useCount: Number(row.use_count),
                itemCount: Number(row.item_count),
                lastAt: new Date(row.last_at).toISOString(),
            })),
        };
    }
    if (tab === "facts") {
        const { rows, context, total } = await folderKnowledgeFacts(
            scope,
            offset,
            limit + 1,
        );
        const vocabulary = await vocabularyVisibleTo(viewerId, {
            sharedOnly: shared,
        });
        const relationLabels = new Map(
            vocabulary.relationTypes.map((relation) => [
                relation.key,
                relation.label,
            ]),
        );
        return {
            ...metadata(context),
            ...(await folderCareFor(
                viewerId,
                [],
                rows
                    .slice(0, limit)
                    .filter((row) => row.user_id === orgUserId)
                    .map((row) => row.fact_id),
            )),
            tab,
            ...page(rows, total),
            facts: rows.slice(0, limit).map((row) => ({
                id: row.id,
                factId: row.fact_id,
                ...(scope.itemId ? { newFromItem: row.new_from_item } : {}),
                subject: decryptText(row.subject_name),
                relationKey: row.relation_key,
                relationLabel:
                    relationLabels.get(row.relation_key) ?? row.relation_key,
                object: decryptText(row.object_name),
                scope: scopeOf(row.user_id),
                itemId: row.item_id,
                itemTitle: decryptText(row.item_title),
                itemDate: new Date(row.item_date).toISOString(),
            })),
        };
    }
    const context = await folderKnowledgeContext(scope);
    const preview = await folderModelPreview({
        viewerId,
        ownerUserId: scope.itemId ? scope.ownerId : viewerId,
        folderId: scope.itemId ? undefined : folderId,
        shared,
        scopeFolderIds: scope.itemId
            ? await itemScopeFolderIds(
                  scope.itemId,
                  shared ? "org" : "private",
                  scope.ownerId,
              )
            : context.rankingFolderIds,
        itemId: scope.itemId,
        language,
        namedRecordIds,
    });
    return {
        ...metadata(context),
        ...preview,
        tab: "models" as const,
        transcription: {
            ...preview.transcription,
            sent: preview.transcription.terms.length,
            terms: preview.transcription.terms.slice(
                0,
                FOLDER_KNOWLEDGE_PREVIEW_TERMS,
            ),
        },
    };
}

/** Full pipeline context for a prospective item in one authorized folder. */
export async function folderModelPreview(input: {
    viewerId: string;
    ownerUserId?: string;
    folderId?: string;
    shared: boolean;
    scopeFolderIds: readonly string[];
    itemId?: string;
    language?: string | null;
    namedRecordIds?: ReadonlySet<string>;
}) {
    const profile = input.folderId
        ? await folderDefaultProfile(input.folderId, "audio")
        : null;
    const language =
        input.language ??
        (profile && "transcribe" in profile.settings.steps
            ? profile.settings.steps.transcribe.language
            : null);
    const rankingInput = await almanacTermRankingInput({
        ownerUserId: input.ownerUserId ?? input.viewerId,
        shared: input.shared,
        language,
        scopeFolderIds: input.scopeFolderIds,
        itemId: input.itemId,
    });
    const transcription = rankAlmanacTermsWithOverflow(rankingInput);
    const records = almanacRecordsFor(
        rankingInput.items,
        input.namedRecordIds ?? new Set(),
        {
            scopeUsage: rankingInput.scopeUsage,
        },
    );
    return {
        transcription: { ...transcription, limit: MAX_ALMANAC_TERMS },
        correction: {
            count: records.length,
            limit: MAX_ALMANAC_RECORDS,
            previewCount: Math.min(records.length, 5),
            preview: `ALMANAC (JSON):\n${JSON.stringify(correctionAlmanacJson(records.slice(0, 5)))}`,
        },
        language,
    };
}
