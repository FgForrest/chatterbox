import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(__dirname, "../..");
const ALLOWED: Record<string, string> = {
    "db/queries/folder-restriction-contacts.ts":
        "Creator contact lookup is scoped to a custom Organization folder already resolved through the caller's read authorization.",
    "db/queries/task-list.ts":
        "Task folder options intersect current task visibility with readable placements, private-folder participation and receiver aliases.",
    "lib/events/visibility.ts":
        "Structural tree events are public; scoped placement and item events retain live audience checks.",
    "lib/folders/access-requests.ts":
        "Public Organization folder nodes do not grant request decisions; live audience or curator authority is checked separately.",
    "db/schema.ts":
        "Schema table and index definitions declare ownership rather than deciding publication.",
    "db/queries/almanac-usage.ts":
        "Organization scope usage excludes withheld placements; private usage remains owner-scoped.",
    "db/queries/folder-scope.ts":
        "Owner run context omits withheld Organization placements and inaccessible restricted descendants.",
    "db/queries/folder-knowledge.ts":
        "Viewer-aware subtree aggregation filters withheld placements and audience-only folders.",
    "db/queries/meetings.ts":
        "Viewer-aware agenda listings use publication and restricted receiver predicates.",
    "db/queries/restricted-agenda-sources.ts":
        "Agenda inputs cannot widen the audience of withheld source placements.",
    "lib/sharing/shared.ts":
        "Canonical viewer-independent publication predicates exclude withheld placements.",
    "lib/knowledge/org-people.ts":
        "Role-based publication predicate excludes withheld placements.",
    "db/queries/restricted-folders.ts":
        "Canonical audience predicates and release-time propagation distinguish withheld placement state.",
    "db/queries/organization-retention.ts":
        "Open placements acquire retention authority only after release grace.",
    "db/queries/meeting-folder-visibility.ts":
        "Viewer-aware folder metadata authorization applies restriction membership.",
    "db/queries/meeting-audience.ts":
        "Withheld placements contribute their audience instead of Organization publication.",
    "db/queries/meeting-folders.ts":
        "Internal owner-authorized placements are filtered by navigation before presentation.",
    "db/queries/meeting-shares.ts":
        "Private direct invitation ownership, separate from Organization publication.",
    "db/queries/item-shares.ts":
        "Private folder participation and receiver aliases; restricted access uses its own predicate.",
    "db/queries/item-folder-audience.ts":
        "Private folder invitations describe accepted receiver participation.",
    "lib/folders/person-shared-leaf.ts":
        "Private person-share leaf rules scope folder and attachment children by parent ownership, independently of Organization publication.",
    "lib/folders/folders.ts":
        "Tree ownership and filing transitions explicitly separate withheld placements.",
    "lib/folders/restore-restrictions.ts":
        "Empty Organization folders restore restriction metadata; personal references require active audience membership.",
    "lib/folders/restricted-folders.ts":
        "Authorized restrict/lift lifecycle and preview distinguish other open placements.",
    "lib/profiles/placement-binding.ts":
        "Withheld placements cannot select Organization processing profiles.",
    "lib/profiles/resolve-for-placement.ts":
        "Folder defaults are authorized and restricted folders never select placement profiles.",
    "lib/pipeline/arrival-context.ts":
        "Stable folder ownership and explicit agenda filing select arrival tree locking before insertion.",
    "lib/pipeline/share-intent.ts":
        "Owner-scoped pending publication rechecks folder state at execution.",
    "lib/pipeline/presentation.ts":
        "Owners see their own public placement nodes; other viewers retain withheld placement and intent filtering.",
    "lib/pipeline/categorization.ts":
        "Owner-scoped existing withheld placements may be retained without filing access; new targets still require filing authority.",
    "lib/tasks/mentions.ts":
        "Task-home withdrawal counts only open, released Organization placements.",
    "lib/tasks/folders.ts":
        "Personal task filing selects the caller's own tree.",
    "lib/meetings/service.ts":
        "Display placements and source preparation apply viewer and agenda audience predicates.",
    "lib/meetings/folders.ts":
        "Navigation loads public Organization node metadata; item placement projections separately require ownership or audience access.",
    "lib/meetings/suggestions-provider.ts":
        "Provider settings follow authorized item state and visible placement defaults.",
    "lib/meetings/attachment.ts":
        "Owner-authorized attachment resolves fileable folder targets before filing.",
    "lib/meetings/attachment-audience.ts":
        "Disclosure unions restricted audiences without declaring Organization publication.",
    "lib/folder-exports/configurations.ts":
        "Configuration ownership is independent of content scope; restricted targets are refused.",
    "lib/folder-exports/target.ts":
        "Export discovery filters restricted folder metadata by current viewer.",
    "lib/folder-exports/jobs.ts":
        "Scheduling finds configuration writers by tree ownership, without returning content.",
    "lib/export/build-archive.ts":
        "Organization archives include published member items and every item owned by the Organization account.",
    "lib/export/restricted-folders.ts":
        "Owner archives carry Organization placements with withholding and release metadata; the Organization also archives its audience.",
    "lib/export/meetings.ts":
        "Archived meetings are selected through archive membership predicates.",
    "lib/export/folder-shares.ts":
        "Personal archives serialize only invitations from the owner's private tree.",
    "lib/sharing/folder-shares.ts":
        "Person invitations require private folder ownership.",
    "lib/sharing/restore-folder-shares.ts":
        "Restored person invitations require mapped private-folder ownership.",
    "lib/sharing/person-shares.ts":
        "Receiver filing and visible private folder aliases follow invitation membership.",
    "lib/mail/detail.ts":
        "Owners see their own placement ids; other viewers use the common viewer-aware withheld filter.",
    "lib/mail/addresses.ts":
        "Address allocation walks the namespace owner's tree, separate from address disclosure.",
    "lib/mail/manage.ts":
        "Mail mutation authority uses item sharing state before scoped placement reads.",
    "lib/mail/store.ts":
        "Personal filing is owner-scoped; Organization targets use intended/withheld filing.",
    "lib/mail/views.ts":
        "Personal mailbox display selects only the namespace owner's tree.",
    "lib/demo/user-guide/seed.ts":
        "Disposable demonstration data selects folders owned by its invented demo user.",
    "app/api/folders/[id]/default-profiles/route.ts":
        "Folder-by-id access is checked before exposing default profile metadata.",
    "app/api/recordings/[id]/route.ts":
        "Owner deletion resolves the Organization tree for cleanup after withdrawal.",
    "app/api/recordings/[id]/folders/route.ts":
        "Personal received-item filing is distinct from owner-authorized Organization moves.",
    "app/api/recordings/[id]/categorize/route.ts":
        "Owner categorization serializes Organization placements under the tree lock.",
};

function sources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (
            entry.name === "tests" ||
            entry.name === "migrations" ||
            entry.name === ".source"
        )
            return [];
        const path = join(directory, entry.name);
        return entry.isDirectory()
            ? sources(path)
            : /\.tsx?$/.test(path) && !/\.test\./.test(path)
              ? [path]
              : [];
    });
}

it("requires review of every folder-owner comparison outside the shared helpers", () => {
    const unreviewed = sources(ROOT)
        .filter((file) =>
            /recordingFolders\.userId\b|orgOwnedCondition\s*\(\s*recordingFolders|recording_folders\b|\$\{recordingFolders\}\s+(?:as\s+)?[A-Za-z_][A-Za-z_0-9]*[\s\S]*?\.user_id/.test(
                readFileSync(file, "utf8"),
            ),
        )
        .map((file) => relative(ROOT, file))
        .filter((file) => !ALLOWED[file]);
    expect(unreviewed).toEqual([]);
    for (const reason of Object.values(ALLOWED))
        expect(reason.trim().length).toBeGreaterThan(20);
});
