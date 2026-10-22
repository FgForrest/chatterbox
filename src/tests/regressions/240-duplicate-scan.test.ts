import { expect, it } from "vitest";
import {
    type DuplicateRecord,
    rankDuplicateRecords,
} from "@/lib/knowledge/duplicate-score";

it("bounds a full scan of 2,000 invented people with eight aliases and eight heard-as forms", async () => {
    let seed = 7;
    const random = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };
    const given = [
        "Zavi",
        "Nelo",
        "Vemi",
        "Daro",
        "Kivo",
        "Luni",
        "Ravo",
        "Seli",
        "Tavi",
        "Mirov",
        "Zuna",
        "Relu",
        "Favi",
        "Belo",
        "Pavi",
        "Zemi",
        "Navi",
        "Kelu",
        "Dovi",
        "Fenu",
        "Ruli",
        "Telu",
        "Havi",
        "Welo",
        "Gavi",
        "Yemi",
        "Jelu",
        "Cavi",
        "Qelo",
        "Xavi",
    ];
    const syllables = [
        "ka",
        "ro",
        "mi",
        "vel",
        "sto",
        "bra",
        "len",
        "dus",
        "pek",
        "tor",
        "han",
        "zil",
        "mor",
        "vac",
        "kri",
        "bul",
    ];
    const pick = (values: string[]) =>
        values[Math.floor(random() * values.length)] ?? "";
    const surname = () => pick(syllables) + pick(syllables) + pick(syllables);
    const records: DuplicateRecord[] = Array.from(
        { length: 2000 },
        (_, index) => ({
            id: `invented-${index}`,
            kind: "person",
            typeKey: "person",
            name: `${pick(given)} ${surname()}`,
            primaryEmail: null,
            emails: [],
            aliases: Array.from({ length: 8 }, () => pick(given)),
            heardAs: Array.from(
                { length: 8 },
                () => `${pick(given)} ${surname()}`,
            ),
            evidenceCount: 0,
        }),
    );
    const started = performance.now();
    const { candidates } = await rankDuplicateRecords(records);
    const elapsed = performance.now() - started;
    process.stdout.write(
        `Duplicate scan benchmark: ${JSON.stringify({ records: records.length, forms: 8, candidates: candidates.length, milliseconds: Math.round(elapsed) })}\n`,
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(10_000);
}, 15_000);
