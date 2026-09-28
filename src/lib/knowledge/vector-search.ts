/**
 * Search by meaning over the vectors a scope holds in memory: brute-force
 * cosine over one matrix per scope, merged. Measured 2026-09-27 at 1,024
 * dimensions: 50,000 items take 205 MB and about 33 ms a query under Bun,
 * which is why no index is needed at this size.
 *
 * Pure. Vectors are L2-normalized when made (`embeddings.ts`), so the
 * cosine is the dot product.
 */

export type VectorKind = "entity" | "fact";

export interface VectorMatrix {
    scope: string;
    dim: number;
    rows: number;
    ids: string[];
    kinds: VectorKind[];
    /** `rows * dim` values, row after row. */
    data: Float32Array;
}

export interface VectorHit {
    scope: string;
    id: string;
    kind: VectorKind;
    score: number;
}

/** One scope's vectors as one matrix; rows of another dimension are left out. */
export function buildMatrix(
    scope: string,
    vectors: readonly { id: string; kind: VectorKind; vector: Float32Array }[],
): VectorMatrix {
    const dim = vectors[0]?.vector.length ?? 0;
    const usable = vectors.filter((row) => row.vector.length === dim);
    const data = new Float32Array(usable.length * dim);
    usable.forEach((row, index) => {
        data.set(row.vector, index * dim);
    });
    return {
        scope,
        dim,
        rows: usable.length,
        ids: usable.map((row) => row.id),
        kinds: usable.map((row) => row.kind),
        data,
    };
}

/**
 * The `k` rows most like `query` across `matrices`, best first, none below
 * `minScore`. A matrix of another dimension (another model) is skipped.
 */
export function topK(
    query: Float32Array,
    matrices: readonly VectorMatrix[],
    k: number,
    minScore = Number.NEGATIVE_INFINITY,
): VectorHit[] {
    const best: VectorHit[] = [];
    for (const matrix of matrices) {
        if (matrix.dim !== query.length || matrix.rows === 0) continue;
        const { data, dim } = matrix;
        for (let row = 0; row < matrix.rows; row++) {
            let score = 0;
            const offset = row * dim;
            for (let i = 0; i < dim; i++) {
                score += (data[offset + i] ?? 0) * (query[i] ?? 0);
            }
            if (score < minScore) continue;
            if (best.length === k && score <= (best[k - 1]?.score ?? 0)) {
                continue;
            }
            const hit: VectorHit = {
                scope: matrix.scope,
                id: matrix.ids[row] ?? "",
                kind: matrix.kinds[row] ?? "entity",
                score,
            };
            let at = best.length;
            while (at > 0 && (best[at - 1]?.score ?? 0) < score) at--;
            best.splice(at, 0, hit);
            if (best.length > k) best.pop();
        }
    }
    return best;
}

/** A vector as text, to be encrypted at rest. */
export function encodeVector(vector: Float32Array): string {
    return Buffer.from(
        vector.buffer,
        vector.byteOffset,
        vector.byteLength,
    ).toString("base64");
}

/** A vector read back from `encodeVector`. */
export function decodeVector(text: string): Float32Array {
    const bytes = Buffer.from(text, "base64");
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Float32Array(copy.buffer);
}
