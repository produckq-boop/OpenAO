import http from "node:http";
import express from "express";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_MAP_ID_START } from "../lib/userMapIsolation";
import type {
    DbClientLike,
    DbPoolLike,
    QueryResultLike,
} from "../repositories/userMaps";
import { UPLOADED_GRAPHIC_INDEX_START } from "../repositories/worldBuilder";
import { createUserMapsRouter } from "../routes/userMaps";

type StoredUserMapRow = {
    map_num: number;
    owner_account_id: string;
    name: string;
    description: string;
    status: "draft" | "proposed" | "published" | "archived";
    combat_enabled: boolean;
    entry_x: number;
    entry_y: number;
    tiles: unknown[];
    objects: unknown[];
    npcs: unknown[];
    exits: unknown[];
    npc_count: number;
    object_count: number;
    created_at: Date;
    updated_at: Date;
};

type StoredGraphicRow = {
    grh_index: number;
    checksum: string;
    width: number;
    height: number;
    byte_size: number;
    content: Buffer;
    uploaded_by_account_id: string | null;
    created_at: Date;
};

class AsyncLock {
    private queue: Promise<void> = Promise.resolve();

    async acquire(): Promise<() => void> {
        let releaseNext!: () => void;
        const next = new Promise<void>((resolve) => {
            releaseNext = resolve;
        });
        const previous = this.queue;
        this.queue = previous.then(() => next);
        await previous;
        return releaseNext;
    }
}

/**
 * Base transaccional deterministica en memoria que respeta exactamente:
 * - `SELECT id FROM accounts WHERE id = $1 FOR UPDATE` (bloqueo real por fila)
 * - `LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE`
 * - `ON DELETE CASCADE` sobre `game_user_maps` y `ON DELETE SET NULL` sobre
 *   `game_uploaded_graphics` al eliminar una cuenta.
 */
class TransactionalMemoryDb implements DbPoolLike {
    readonly accounts = new Set<string>();
    private maps = new Map<number, StoredUserMapRow>();
    private graphics = new Map<number, StoredGraphicRow>();
    private readonly accountLocks = new Map<string, AsyncLock>();
    private readonly tableLock = new AsyncLock();

    addAccount(accountId: string): void {
        this.accounts.add(accountId);
        if (!this.accountLocks.has(accountId)) {
            this.accountLocks.set(accountId, new AsyncLock());
        }
    }

    deleteAccount(accountId: string): void {
        this.accounts.delete(accountId);
        for (const [mapNum, row] of this.maps.entries()) {
            if (row.owner_account_id === accountId) {
                this.maps.delete(mapNum);
            }
        }
        for (const graphic of this.graphics.values()) {
            if (graphic.uploaded_by_account_id === accountId) {
                graphic.uploaded_by_account_id = null;
            }
        }
    }

    async query<TRow = Record<string, unknown>>(
        text: string,
        values: unknown[] = [],
    ): Promise<QueryResultLike<TRow>> {
        const client = await this.connect();
        try {
            return await client.query<TRow>(text, values);
        } finally {
            client.release();
        }
    }

    async connect(): Promise<DbClientLike> {
        let snapshotMaps: Map<number, StoredUserMapRow> | null = null;
        let snapshotGraphics: Map<number, StoredGraphicRow> | null = null;
        const heldReleases: Array<() => void> = [];

        const releaseLocks = () => {
            while (heldReleases.length > 0) {
                const unlock = heldReleases.pop();
                unlock?.();
            }
        };

        return {
            query: async <TRow = Record<string, unknown>>(
                rawSql: string,
                values: unknown[] = [],
            ): Promise<QueryResultLike<TRow>> => {
                const sql = rawSql.replace(/\s+/g, " ").trim();

                if (sql === "BEGIN") {
                    snapshotMaps = new Map(
                        Array.from(this.maps.entries()).map(([k, v]) => [
                            k,
                            structuredClone(v),
                        ]),
                    );
                    snapshotGraphics = new Map(
                        Array.from(this.graphics.entries()).map(([k, v]) => [
                            k,
                            { ...v, content: Buffer.from(v.content) },
                        ]),
                    );
                    return { rows: [] };
                }

                if (sql === "COMMIT") {
                    snapshotMaps = null;
                    snapshotGraphics = null;
                    releaseLocks();
                    return { rows: [] };
                }

                if (sql === "ROLLBACK") {
                    if (snapshotMaps) {
                        this.maps = snapshotMaps;
                        snapshotMaps = null;
                    }
                    if (snapshotGraphics) {
                        this.graphics = snapshotGraphics;
                        snapshotGraphics = null;
                    }
                    releaseLocks();
                    return { rows: [] };
                }

                if (
                    sql ===
                    "SELECT id FROM accounts WHERE id = $1 FOR UPDATE"
                ) {
                    const accountId = String(values[0] ?? "");
                    let lock = this.accountLocks.get(accountId);
                    if (!lock) {
                        lock = new AsyncLock();
                        this.accountLocks.set(accountId, lock);
                    }
                    const release = await lock.acquire();
                    heldReleases.push(release);
                    if (!this.accounts.has(accountId)) {
                        return { rows: [] };
                    }
                    return {
                        rows: [{ id: accountId } as unknown as TRow],
                    };
                }

                if (sql.startsWith("LOCK TABLE ")) {
                    const release = await this.tableLock.acquire();
                    heldReleases.push(release);
                    return { rows: [] };
                }

                if (
                    sql.includes("COUNT(*) AS map_count") &&
                    sql.includes("FROM game_user_maps")
                ) {
                    const ownerId = String(values[0] ?? "");
                    let count = 0;
                    for (const row of this.maps.values()) {
                        if (
                            row.owner_account_id === ownerId &&
                            row.status !== "archived"
                        ) {
                            count += 1;
                        }
                    }
                    return {
                        rows: [{ map_count: count } as unknown as TRow],
                    };
                }

                if (
                    sql.includes("COALESCE(SUM(byte_size), 0) AS total_bytes") &&
                    sql.includes("WHERE uploaded_by_account_id = $1")
                ) {
                    const accountId = String(values[0] ?? "");
                    let totalBytes = 0;
                    for (const g of this.graphics.values()) {
                        if (g.uploaded_by_account_id === accountId) {
                            totalBytes += g.byte_size;
                        }
                    }
                    return {
                        rows: [{ total_bytes: totalBytes } as unknown as TRow],
                    };
                }

                if (
                    sql.includes("COUNT(*) AS found_count") &&
                    sql.includes("WHERE grh_index = ANY($1::int[])")
                ) {
                    const ids = (values[0] as number[]) ?? [];
                    let foundCount = 0;
                    let referencedBytes = 0;
                    for (const id of ids) {
                        const row = this.graphics.get(id);
                        if (row) {
                            foundCount += 1;
                            referencedBytes += row.byte_size;
                        }
                    }
                    return {
                        rows: [
                            {
                                found_count: foundCount,
                                referenced_bytes: referencedBytes,
                            } as unknown as TRow,
                        ],
                    };
                }

                if (
                    sql.includes("AS next_map_num") &&
                    sql.includes("FROM game_user_maps")
                ) {
                    const start = Number(values[0] ?? USER_MAP_ID_START);
                    const max =
                        this.maps.size === 0
                            ? start - 1
                            : Math.max(...this.maps.keys());
                    return {
                        rows: [{ next_map_num: max + 1 } as unknown as TRow],
                    };
                }

                if (sql.startsWith("INSERT INTO game_user_maps")) {
                    const now = new Date("2026-11-03T00:00:00.000Z");
                    const row: StoredUserMapRow = {
                        map_num: Number(values[0]),
                        owner_account_id: String(values[1]),
                        name: String(values[2]),
                        description: String(values[3]),
                        status: "draft",
                        combat_enabled: false,
                        entry_x: Number(values[4]),
                        entry_y: Number(values[5]),
                        tiles: JSON.parse(String(values[6])),
                        objects: JSON.parse(String(values[7])),
                        npcs: JSON.parse(String(values[8])),
                        exits: JSON.parse(String(values[9])),
                        npc_count: Number(values[10]),
                        object_count: Number(values[11]),
                        created_at: now,
                        updated_at: now,
                    };
                    this.maps.set(row.map_num, row);
                    return { rows: [structuredClone(row) as unknown as TRow] };
                }

                if (
                    sql ===
                        "SELECT * FROM game_user_maps WHERE map_num = $1 FOR UPDATE" ||
                    sql ===
                        "SELECT * FROM game_user_maps WHERE map_num = $1 LIMIT 1"
                ) {
                    const mapNum = Number(values[0]);
                    const row = this.maps.get(mapNum);
                    return {
                        rows: row
                            ? [structuredClone(row) as unknown as TRow]
                            : [],
                    };
                }

                if (
                    sql.startsWith("UPDATE game_user_maps SET name = $2")
                ) {
                    const mapNum = Number(values[0]);
                    const existing = this.maps.get(mapNum)!;
                    const updated: StoredUserMapRow = {
                        ...existing,
                        name: String(values[1]),
                        description: String(values[2]),
                        entry_x: Number(values[3]),
                        entry_y: Number(values[4]),
                        tiles: JSON.parse(String(values[5])),
                        objects: JSON.parse(String(values[6])),
                        npcs: JSON.parse(String(values[7])),
                        exits: JSON.parse(String(values[8])),
                        npc_count: Number(values[9]),
                        object_count: Number(values[10]),
                        status: values[11] as StoredUserMapRow["status"],
                        updated_at: new Date("2026-11-03T00:05:00.000Z"),
                    };
                    this.maps.set(mapNum, updated);
                    return {
                        rows: [structuredClone(updated) as unknown as TRow],
                    };
                }

                if (
                    sql.startsWith("UPDATE game_user_maps SET status = $2")
                ) {
                    const mapNum = Number(values[0]);
                    const existing = this.maps.get(mapNum)!;
                    const updated: StoredUserMapRow = {
                        ...existing,
                        status: values[1] as StoredUserMapRow["status"],
                        updated_at: new Date("2026-11-03T00:10:00.000Z"),
                    };
                    this.maps.set(mapNum, updated);
                    return {
                        rows: [structuredClone(updated) as unknown as TRow],
                    };
                }

                if (
                    sql.includes("FROM game_user_maps") &&
                    sql.includes("WHERE status = 'published'")
                ) {
                    const limit = Number(values[0] ?? 50);
                    const rows = Array.from(this.maps.values())
                        .filter((r) => r.status === "published")
                        .slice(0, limit)
                        .map((r) => structuredClone(r) as unknown as TRow);
                    return { rows };
                }

                if (
                    sql.includes("FROM game_user_maps") &&
                    sql.includes("WHERE owner_account_id = $1")
                ) {
                    const ownerId = String(values[0] ?? "");
                    const rows = Array.from(this.maps.values())
                        .filter((r) => r.owner_account_id === ownerId)
                        .map((r) => structuredClone(r) as unknown as TRow);
                    return { rows };
                }

                if (
                    sql.includes("FROM game_uploaded_graphics") &&
                    sql.includes("WHERE checksum = $1")
                ) {
                    const checksum = String(values[0] ?? "");
                    for (const g of this.graphics.values()) {
                        if (g.checksum === checksum) {
                            return { rows: [{ ...g } as unknown as TRow] };
                        }
                    }
                    return { rows: [] };
                }

                if (
                    sql.includes("AS next_index") &&
                    sql.includes("FROM game_uploaded_graphics")
                ) {
                    const start = Number(
                        values[0] ?? UPLOADED_GRAPHIC_INDEX_START,
                    );
                    const max =
                        this.graphics.size === 0
                            ? start - 1
                            : Math.max(...this.graphics.keys());
                    return {
                        rows: [{ next_index: max + 1 } as unknown as TRow],
                    };
                }

                if (sql.startsWith("INSERT INTO game_uploaded_graphics")) {
                    const createdAt = new Date("2026-11-03T00:01:00.000Z");
                    const row: StoredGraphicRow = {
                        grh_index: Number(values[0]),
                        checksum: String(values[1]),
                        width: Number(values[2]),
                        height: Number(values[3]),
                        byte_size: Number(values[4]),
                        content: Buffer.from(values[5] as Buffer),
                        uploaded_by_account_id: String(values[6]),
                        created_at: createdAt,
                    };
                    this.graphics.set(row.grh_index, row);
                    return {
                        rows: [{ created_at: createdAt } as unknown as TRow],
                    };
                }

                throw new Error(`SQL no soportado en test: ${sql}`);
            },
            release: () => {
                releaseLocks();
            },
        };
    }
}

function makeSolidPng(seedByte: number): Buffer {
    const png = new PNG({ width: 32, height: 32 });
    png.data.fill(seedByte);
    return PNG.sync.write(png);
}

describe("userMaps routes - propiedad, estados, cuotas concurrentes y visibilidad (#24)", () => {
    let db: TransactionalMemoryDb;
    let server: http.Server;
    let baseUrl: string;

    beforeEach(async () => {
        db = new TransactionalMemoryDb();
        db.addAccount("acc-owner");
        db.addAccount("acc-other");
        db.addAccount("acc-admin");

        const singlePngSize = makeSolidPng(200).length;

        const app = express();
        app.use(express.json({ limit: "1mb" }));
        app.use(
            createUserMapsRouter({
                resolveSession: async (req) => {
                    const auth = req.header("Authorization") ?? "";
                    const token = auth.startsWith("Bearer ")
                        ? auth.slice(7).trim()
                        : "";
                    if (token === "token-owner") {
                        return { accountId: "acc-owner", isAdmin: false };
                    }
                    if (token === "token-other") {
                        return { accountId: "acc-other", isAdmin: false };
                    }
                    if (token === "token-admin") {
                        return { accountId: "acc-admin", isAdmin: true };
                    }
                    return null;
                },
                repositoryDeps: {
                    db,
                    quotas: {
                        maxMapsPerAccount: 2,
                        maxUploadBytesPerAccount: Math.floor(
                            singlePngSize * 1.5,
                        ),
                        maxNpcsPerMap: 2,
                        maxObjectsPerMap: 2,
                    },
                },
            }),
        );

        server = await new Promise<http.Server>((resolve) => {
            const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
        });
        const addr = server.address();
        if (!addr || typeof addr === "string") {
            throw new Error("No se pudo abrir puerto efímero de test.");
        }
        baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterEach(async () => {
        await new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
        });
    });

    it("crea mapas en el rango 100.000..999.999 e impide que otra cuenta los edite (403)", async () => {
        const createRes = await fetch(`${baseUrl}/user-maps`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer token-owner",
            },
            body: JSON.stringify({
                name: "Posada del Sur",
                description: "Espacio social",
                objects: [{ x: 30, y: 30, objIndex: 155, amount: 1 }],
                npcs: [{ x: 35, y: 35, npcIndex: 1, movement: 0 }],
            }),
        });

        expect(createRes.status).toBe(201);
        const createdPayload = (await createRes.json()) as {
            map: { mapNum: number; status: string; ownerAccountId: string };
        };
        expect(createdPayload.map.mapNum).toBe(100_000);
        expect(createdPayload.map.status).toBe("draft");
        expect(createdPayload.map.ownerAccountId).toBe("acc-owner");

        const hijackRes = await fetch(`${baseUrl}/user-maps/100000`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer token-other",
            },
            body: JSON.stringify({ name: "Mapa Robado" }),
        });

        expect(hijackRes.status).toBe(403);
        const hijackBody = (await hijackRes.json()) as {
            error: string;
            code: string;
        };
        expect(hijackBody.code).toBe("FORBIDDEN_NOT_OWNER");
        expect(hijackBody.error).toMatch(/otra cuenta/);
    });

    it("oculta borradores a otros jugadores y los expone sólo tras publicarse", async () => {
        await fetch(`${baseUrl}/user-maps`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer token-owner",
            },
            body: JSON.stringify({ name: "Borrador Secreto" }),
        });

        // Invisible para visitante anónimo y para otra cuenta
        const [anonView, otherView, otherMapData, publicListBefore] =
            await Promise.all([
                fetch(`${baseUrl}/user-maps/100000`),
                fetch(`${baseUrl}/user-maps/100000`, {
                    headers: { Authorization: "Bearer token-other" },
                }),
                fetch(`${baseUrl}/user-maps/100000/map-data`, {
                    headers: { Authorization: "Bearer token-other" },
                }),
                fetch(`${baseUrl}/user-maps`),
            ]);

        expect(anonView.status).toBe(404);
        expect(otherView.status).toBe(404);
        expect(otherMapData.status).toBe(404);
        const beforeList = (await publicListBefore.json()) as {
            maps: unknown[];
        };
        expect(beforeList.maps).toHaveLength(0);

        // Visible para su dueño
        const ownerView = await fetch(`${baseUrl}/user-maps/100000`, {
            headers: { Authorization: "Bearer token-owner" },
        });
        expect(ownerView.status).toBe(200);

        // El dueño no puede auto-publicar sin moderación, pero sí proponerlo
        const selfPublish = await fetch(`${baseUrl}/user-maps/100000/status`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer token-owner",
            },
            body: JSON.stringify({ status: "published" }),
        });
        expect(selfPublish.status).toBe(403);

        const proposeRes = await fetch(`${baseUrl}/user-maps/100000/status`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer token-owner",
            },
            body: JSON.stringify({ status: "proposed" }),
        });
        expect(proposeRes.status).toBe(200);

        // Moderación publica el mapa
        const adminPublish = await fetch(`${baseUrl}/user-maps/100000/status`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer token-admin",
            },
            body: JSON.stringify({ status: "published" }),
        });
        expect(adminPublish.status).toBe(200);

        // Ahora cualquier jugador puede verlo y cargar su map-data
        const [publicAfter, mapDataAfter] = await Promise.all([
            fetch(`${baseUrl}/user-maps`),
            fetch(`${baseUrl}/user-maps/100000/map-data`),
        ]);
        expect(publicAfter.status).toBe(200);
        const afterList = (await publicAfter.json()) as {
            maps: Array<{ mapNum: number }>;
        };
        expect(afterList.maps.map((m) => m.mapNum)).toEqual([100_000]);
        expect(mapDataAfter.status).toBe(200);
    });

    it("serializa la cuota de mapas por cuenta bajo creaciones concurrentes (FOR UPDATE)", async () => {
        const responses = await Promise.all(
            [1, 2, 3].map((idx) =>
                fetch(`${baseUrl}/user-maps`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: "Bearer token-owner",
                    },
                    body: JSON.stringify({ name: `Mapa Concurrente ${idx}` }),
                }),
            ),
        );

        const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
        expect(statuses).toEqual([201, 201, 409]);

        const rejected = responses.find((r) => r.status === 409)!;
        const rejectedBody = (await rejected.json()) as {
            error: string;
            code: string;
        };
        expect(rejectedBody.code).toBe("QUOTA_EXCEEDED");
        expect(rejectedBody.error).toMatch(/límite máximo de mapas por cuenta/);
    });

    it("serializa la cuota de bytes PNG subidos por cuenta bajo subidas concurrentes", async () => {
        const pngA = makeSolidPng(64);
        const pngB = makeSolidPng(180);

        const [resA, resB] = await Promise.all([
            fetch(`${baseUrl}/user-maps/graphics`, {
                method: "POST",
                headers: {
                    "Content-Type": "image/png",
                    Authorization: "Bearer token-owner",
                },
                body: new Uint8Array(pngA),
            }),
            fetch(`${baseUrl}/user-maps/graphics`, {
                method: "POST",
                headers: {
                    "Content-Type": "image/png",
                    Authorization: "Bearer token-owner",
                },
                body: new Uint8Array(pngB),
            }),
        ]);

        const statuses = [resA.status, resB.status].sort((a, b) => a - b);
        expect(statuses).toEqual([201, 409]);

        const overQuota = resA.status === 409 ? resA : resB;
        const body = (await overQuota.json()) as {
            error: string;
            code: string;
        };
        expect(body.code).toBe("QUOTA_EXCEEDED");
        expect(body.error).toMatch(/peso total de assets subidos por cuenta/);
    });

    it("rechaza colocar oro o salidas a mapas oficiales y limpia mapas si el dueño borra su cuenta", async () => {
        const goldAttempt = await fetch(`${baseUrl}/user-maps`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer token-owner",
            },
            body: JSON.stringify({
                name: "Fabrica de Oro",
                objects: [{ x: 10, y: 10, objIndex: 12, amount: 1 }],
            }),
        });
        expect(goldAttempt.status).toBe(400);

        const officialRefAttempt = await fetch(`${baseUrl}/user-maps`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer token-owner",
            },
            body: JSON.stringify({
                name: "Portal Ilegal",
                exits: [
                    { x: 10, y: 10, targetMap: 1, targetX: 50, targetY: 50 },
                ],
            }),
        });
        expect(officialRefAttempt.status).toBe(400);

        const validRes = await fetch(`${baseUrl}/user-maps`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer token-owner",
            },
            body: JSON.stringify({ name: "Mapa Temporal" }),
        });
        expect(validRes.status).toBe(201);

        // Al eliminar la cuenta dueña, ON DELETE CASCADE elimina sus mapas
        db.deleteAccount("acc-owner");
        const afterDelete = await fetch(`${baseUrl}/user-maps/100000`, {
            headers: { Authorization: "Bearer token-admin" },
        });
        expect(afterDelete.status).toBe(404);
    });
});
