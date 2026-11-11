import { hashPassword } from "better-auth/crypto";
import { db } from "@/db";
import { accounts, users } from "@/db/schema";
import {
    addRecordingToFolder,
    createFolder,
    ensureRootFolders,
    listFolderOrganization,
} from "@/lib/folders/folders";
import type { DemoSeedResult } from "./seed";

/** Extend the disposable user-guide seed with two readers and a public locked-node viewer. */
export async function seedRestrictedFolderDemo(seed: DemoSeedResult) {
    const tree = await listFolderOrganization(seed.users.alex);
    const root = tree.folders.find(
        (folder) => folder.scope === "org" && folder.parentId === null,
    );
    if (!root) throw new Error("The demo requires a writable Organization");
    const parent = await createFolder({
        userId: seed.orgUserId,
        parentId: root.id,
        name: "Restricted folder demo",
        canCurate: true,
    });
    const folder = await createFolder({
        userId: seed.users.alex,
        parentId: parent.id,
        name: "Pilot audience",
        restricted: true,
        audienceUserIds: [seed.users.priya],
    });
    await addRecordingToFolder({
        userId: seed.users.alex,
        recordingId: seed.recordings["pilot-call"],
        folderId: folder.id,
    });
    const [outsider] = await db
        .insert(users)
        .values({
            name: "Robin Fields",
            email: "robin@example.com",
            emailVerified: true,
        })
        .returning({ id: users.id });
    if (!outsider) throw new Error("Demo outsider was not created");
    await db.insert(accounts).values({
        userId: outsider.id,
        accountId: outsider.id,
        providerId: "credential",
        password: await hashPassword("demo-password-123"),
    });
    await ensureRootFolders(outsider.id);
    return {
        folderId: folder.id,
        parentId: parent.id,
        readerUserId: seed.users.alex,
        outsiderUserId: outsider.id,
    };
}
