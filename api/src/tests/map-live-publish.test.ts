import http from "http";
import type { AddressInfo } from "net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StoredOverride = {
    map_num: number;
    x: number;
    y: number;
    layer: number;
    grh_index: number | null;
    blocked: boolean | null;
    status: "draft" | "published";
};

type StoredEntity = {
    map_num: number;
    x: number;
    y: number;
    kind: "obj" | "npc";
    entity_id: number;
    status: "draft" | "published";
};

const state = vi.hoisted(() => ({
    internalAuth: "test-internal-auth",
    overrides: [] as StoredOverride[],
    entities: [] as StoredEntity[],
    syncVersions: new Map<string, number>(),
    validObjectIds: new Set<number>([10, 20]),
    validNpcIds: new Set<number>([501, 502]),
    release: vi.fn(),
}));

function executeFakeSql(
    rawSql: string,
    params: unknown[] = [],
): { rows: unknown[]; rowCount: number } {
    const sql = rawSql.replace(/\s+/g, " ").trim();

    if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.startsWith("CREATE TABLE IF NOT EXISTS game_data_sync_state")
    ) {
        return { rows: [], rowCount: 0 };
    }

    if (sql.includes("SELECT 1 FROM game_objects WHERE id = $1")) {
        const exists = state.validObjectIds.has(Number(params[0]));
        return { rows: exists ? [{ "?column?": 1 }] : [], rowCount: exists ? 1 : 0 };
    }

    if (sql.includes("SELECT 1 FROM game_npcs WHERE id = $1")) {
        const exists = state.validNpcIds.has(Number(params[0]));
        return { rows: exists ? [{ "?column?": 1 }] : [], rowCount: exists ? 1 : 0 };
    }

    if (
        sql.startsWith("INSERT INTO game_map_tile_overrides") &&
        sql.includes("VALUES ($1, $2, $3, $4, $5, $6, 'draft'")
    ) {
        const [mapNum, x, y, layer, grhIndex, blocked] = params as [
            number,
            number,
            number,
            number,
            number | null,
            boolean | null,
        ];
        const existing = state.overrides.find(
            (row) =>
                row.map_num === mapNum &&
                row.x === x &&
                row.y === y &&
                row.layer === layer &&
                row.status === "draft",
        );

        if (existing) {
            existing.grh_index = grhIndex;
            existing.blocked = blocked;
        } else {
            state.overrides.push({
                map_num: mapNum,
                x,
                y,
                layer,
                grh_index: grhIndex,
                blocked,
                status: "draft",
            });
        }
        return { rows: [], rowCount: 1 };
    }

    if (
        sql.startsWith("INSERT INTO game_map_tile_entities") &&
        sql.includes("VALUES ($1, $2, $3, $4, $5, 'draft'")
    ) {
        const [mapNum, x, y, kind, entityId] = params as [
            number,
            number,
            number,
            "obj" | "npc",
            number,
        ];
        const existing = state.entities.find(
            (row) =>
                row.map_num === mapNum &&
                row.x === x &&
                row.y === y &&
                row.kind === kind &&
                row.status === "draft",
        );

        if (existing) {
            existing.entity_id = entityId;
        } else {
            state.entities.push({
                map_num: mapNum,
                x,
                y,
                kind,
                entity_id: entityId,
                status: "draft",
            });
        }
        return { rows: [], rowCount: 1 };
    }

    if (
        sql.startsWith("INSERT INTO game_map_tile_overrides") &&
        sql.includes("SELECT map_num, x, y, layer, grh_index, blocked, 'published'")
    ) {
        const mapNum = Number(params[0]);
        const drafts = state.overrides.filter(
            (row) => row.map_num === mapNum && row.status === "draft",
        );

        for (const draft of drafts) {
            const published = state.overrides.find(
                (row) =>
                    row.map_num === mapNum &&
                    row.x === draft.x &&
                    row.y === draft.y &&
                    row.layer === draft.layer &&
                    row.status === "published",
            );

            if (published) {
                published.grh_index = draft.grh_index;
                published.blocked = draft.blocked;
            } else {
                state.overrides.push({
                    ...draft,
                    status: "published",
                });
            }
        }

        return { rows: [], rowCount: drafts.length };
    }

    if (
        sql.startsWith("INSERT INTO game_map_tile_entities") &&
        sql.includes("SELECT map_num, x, y, kind, entity_id, 'published'")
    ) {
        const mapNum = Number(params[0]);
        const drafts = state.entities.filter(
            (row) => row.map_num === mapNum && row.status === "draft",
        );

        for (const draft of drafts) {
            const published = state.entities.find(
                (row) =>
                    row.map_num === mapNum &&
                    row.x === draft.x &&
                    row.y === draft.y &&
                    row.kind === draft.kind &&
                    row.status === "published",
            );

            if (published) {
                published.entity_id = draft.entity_id;
            } else {
                state.entities.push({
                    ...draft,
                    status: "published",
                });
            }
        }

        return { rows: [], rowCount: drafts.length };
    }

    if (
        sql ===
        "DELETE FROM game_map_tile_overrides WHERE map_num = $1 AND status = 'draft'"
    ) {
        const mapNum = Number(params[0]);
        const before = state.overrides.length;
        state.overrides = state.overrides.filter(
            (row) => !(row.map_num === mapNum && row.status === "draft"),
        );
        return { rows: [], rowCount: before - state.overrides.length };
    }

    if (
        sql ===
        "DELETE FROM game_map_tile_entities WHERE map_num = $1 AND status = 'draft'"
    ) {
        const mapNum = Number(params[0]);
        const before = state.entities.length;
        state.entities = state.entities.filter(
            (row) => !(row.map_num === mapNum && row.status === "draft"),
        );
        return { rows: [], rowCount: before - state.entities.length };
    }

    if (sql === "DELETE FROM game_map_tile_overrides WHERE map_num = $1") {
        const mapNum = Number(params[0]);
        const before = state.overrides.length;
        state.overrides = state.overrides.filter((row) => row.map_num !== mapNum);
        return { rows: [], rowCount: before - state.overrides.length };
    }

    if (sql === "DELETE FROM game_map_tile_entities WHERE map_num = $1") {
        const mapNum = Number(params[0]);
        const before = state.entities.length;
        state.entities = state.entities.filter((row) => row.map_num !== mapNum);
        return { rows: [], rowCount: before - state.entities.length };
    }

    if (sql.startsWith("INSERT INTO game_data_sync_state")) {
        const nextVersion = (state.syncVersions.get("maps") ?? 0) + 1;
        state.syncVersions.set("maps", nextVersion);
        return {
            rows: [{ current_version: String(nextVersion) }],
            rowCount: 1,
        };
    }

    if (
        sql.includes("SELECT current_version FROM game_data_sync_state") &&
        sql.includes("WHERE domain = 'maps'")
    ) {
        const version = state.syncVersions.get("maps");
        return version === undefined
            ? { rows: [], rowCount: 0 }
            : { rows: [{ current_version: String(version) }], rowCount: 1 };
    }

    if (
        sql.includes("FROM game_map_tile_overrides") &&
        sql.includes("WHERE map_num = $1 AND status = 'published'")
    ) {
        const mapNum = Number(params[0]);
        const rows = state.overrides
            .filter(
                (row) => row.map_num === mapNum && row.status === "published",
            )
            .sort(
                (a, b) => a.y - b.y || a.x - b.x || a.layer - b.layer,
            );
        return { rows, rowCount: rows.length };
    }

    if (
        sql.includes("FROM game_map_tile_entities") &&
        sql.includes("WHERE map_num = $1 AND status = 'published'")
    ) {
        const mapNum = Number(params[0]);
        const rows = state.entities
            .filter(
                (row) => row.map_num === mapNum && row.status === "published",
            )
            .sort(
                (a, b) =>
                    a.y - b.y || a.x - b.x || a.kind.localeCompare(b.kind),
            );
        return { rows, rowCount: rows.length };
    }

    if (
        sql.includes("SELECT map_num, x, y, layer, grh_index, blocked, status") &&
        sql.includes("FROM game_map_tile_overrides WHERE status = 'published'")
    ) {
        const rows = state.overrides
            .filter((row) => row.status === "published")
            .sort(
                (a, b) =>
                    a.map_num - b.map_num ||
                    a.y - b.y ||
                    a.x - b.x ||
                    a.layer - b.layer,
            );
        return { rows, rowCount: rows.length };
    }

    if (
        sql.includes("SELECT map_num, x, y, kind, entity_id, status") &&
        sql.includes("FROM game_map_tile_entities WHERE status = 'published'")
    ) {
        const rows = state.entities
            .filter((row) => row.status === "published")
            .sort(
                (a, b) =>
                    a.map_num - b.map_num ||
                    a.y - b.y ||
                    a.x - b.x ||
                    a.kind.localeCompare(b.kind),
            );
        return { rows, rowCount: rows.length };
    }

    throw new Error(`Unhandled SQL in map-live-publish.test.ts: ${sql}`);
}

vi.mock("../config", () => ({
    default: {
        port: 3001,
        databaseUrl: "postgres-mock-unused",
        databasePoolMax: 2,
        databaseConnectionTimeoutMs: 5000,
        databaseIdleTimeoutMs: 30000,
        databaseStatementTimeoutMs: 15000,
        databaseIdleInTransactionTimeoutMs: 10000,
        tokenAuth: state.internalAuth,
        nodeEnv: "test",
        corsOrigin: "*",
        siteUrl: "http://127.0.0.1:3000",
        sesRegion: null,
        sesAccessKeyId: null,
        sesSecretAccessKey: null,
        sesFromEmail: null,
        sesFromName: "AOWeb",
        gameDataAdminEmail: "",
        gameDataAdminAccountId: null,
        gameDataAdminProxyToken: null,
        gameServerInternalUrl: "http://127.0.0.1:7666",
    },
}));

vi.mock("../db", () => ({
    default: {
        query: vi.fn(async (sql: string, params?: unknown[]) =>
            executeFakeSql(sql, params),
        ),
        connect: vi.fn(async () => ({
            query: vi.fn(async (sql: string, params?: unknown[]) =>
                executeFakeSql(sql, params),
            ),
            release: state.release,
        })),
    },
}));

import {
    getCurrentPublishedMapsVersion,
    getPublishedMapSnapshot,
    listAllPublishedMapsSnapshot,
    paintTiles,
    placeTileEntity,
    publishMap,
    revertMap,
} from "../repositories/worldBuilder";
import { notifyGameServerMapReload } from "../lib/gameServerNotify";

describe("live map publish snapshots and version state", () => {
    let activeServers: http.Server[] = [];

    beforeEach(() => {
        state.overrides = [];
        state.entities = [];
        state.syncVersions.clear();
        state.release.mockClear();
        activeServers = [];
    });

    afterEach(async () => {
        await Promise.all(
            activeServers.map(
                (server) =>
                    new Promise<void>((resolve) => {
                        server.close(() => resolve());
                    }),
            ),
        );
    });

    it("keeps draft tiles and entities strictly isolated from published snapshots until publishMap", async () => {
        await paintTiles(
            1,
            [
                { x: 25, y: 30, layer: 1, grhIndex: 1505, blocked: true },
                { x: 26, y: 30, layer: 3, grhIndex: null, blocked: false },
            ],
            "admin-1",
        );
        await placeTileEntity(
            1,
            { x: 27, y: 30, kind: "obj", entityId: 10 },
            "admin-1",
        );
        await placeTileEntity(
            1,
            { x: 28, y: 30, kind: "npc", entityId: 501 },
            "admin-1",
        );

        const prePublishSingle = await getPublishedMapSnapshot(1);
        const prePublishAll = await listAllPublishedMapsSnapshot();

        expect(prePublishSingle).toEqual({
            mapNum: 1,
            version: 0,
            overrides: [],
            entities: [],
        });
        expect(prePublishAll).toEqual({
            currentVersion: 0,
            maps: [],
        });

        const publishResult = await publishMap(1, "admin-1");
        expect(publishResult).toEqual({
            published: 2,
            publishedEntities: 2,
            version: 1,
        });

        // Los borradores nuevos siguen aislados de lo publicado hasta el proximo publishMap.
        await paintTiles(
            1,
            [{ x: 25, y: 30, layer: 1, grhIndex: 9999, blocked: false }],
            "admin-1",
        );
        await placeTileEntity(
            1,
            { x: 28, y: 30, kind: "npc", entityId: 502 },
            "admin-1",
        );

        const publishedSingle = await getPublishedMapSnapshot(1);
        expect(publishedSingle).toEqual({
            mapNum: 1,
            version: 1,
            overrides: [
                {
                    x: 25,
                    y: 30,
                    layer: 1,
                    grhIndex: 1505,
                    blocked: true,
                    status: "published",
                },
                {
                    x: 26,
                    y: 30,
                    layer: 3,
                    grhIndex: null,
                    blocked: false,
                    status: "published",
                },
            ],
            entities: [
                {
                    x: 27,
                    y: 30,
                    kind: "obj",
                    entityId: 10,
                    status: "published",
                },
                {
                    x: 28,
                    y: 30,
                    kind: "npc",
                    entityId: 501,
                    status: "published",
                },
            ],
        });

        const allSnapshot = await listAllPublishedMapsSnapshot();
        expect(allSnapshot).toEqual({
            currentVersion: 1,
            maps: [
                {
                    mapNum: 1,
                    overrides: publishedSingle.overrides,
                    entities: publishedSingle.entities,
                },
            ],
        });
    });

    it("increments sync version monotonically across publishMap and revertMap", async () => {
        await paintTiles(
            1,
            [{ x: 10, y: 10, layer: 1, grhIndex: 1200, blocked: true }],
            "admin-1",
        );
        const firstPublish = await publishMap(1, "admin-1");
        expect(firstPublish.version).toBe(1);

        await placeTileEntity(
            2,
            { x: 40, y: 40, kind: "npc", entityId: 501 },
            "admin-1",
        );
        const secondPublish = await publishMap(2, "admin-1");
        expect(secondPublish.version).toBe(2);

        const revertResult = await revertMap(1);
        expect(revertResult).toEqual({
            reverted: 1,
            revertedEntities: 0,
            version: 3,
        });
        expect(await getCurrentPublishedMapsVersion()).toBe(3);

        const revertedMap1 = await getPublishedMapSnapshot(1);
        expect(revertedMap1).toEqual({
            mapNum: 1,
            version: 3,
            overrides: [],
            entities: [],
        });

        const allAfterRevert = await listAllPublishedMapsSnapshot();
        expect(allAfterRevert.currentVersion).toBe(3);
        expect(allAfterRevert.maps.map((entry) => entry.mapNum)).toEqual([2]);
    });

    it("delivers authenticated reload webhook and degrades non-fatally when server is offline", async () => {
        const receivedRequests: Array<{
            method: string | undefined;
            url: string | undefined;
            authorization: string | undefined;
            body: unknown;
        }> = [];

        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
                const rawBody = Buffer.concat(chunks).toString("utf8");
                receivedRequests.push({
                    method: req.method,
                    url: req.url,
                    authorization: req.headers.authorization,
                    body: rawBody ? JSON.parse(rawBody) : null,
                });

                if (req.headers.authorization !== state.internalAuth) {
                    res.writeHead(401, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Unauthorized" }));
                    return;
                }

                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            });
        });

        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", () => resolve());
        });
        activeServers.push(server);

        const { port } = server.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${port}`;

        const okNotification = await notifyGameServerMapReload(166, 7, {
            baseUrl,
            tokenAuth: state.internalAuth,
        });
        expect(okNotification).toEqual({
            notified: true,
            status: 200,
        });
        expect(receivedRequests).toEqual([
            {
                method: "POST",
                url: "/internal/maps/166/reload",
                authorization: state.internalAuth,
                body: { mapNum: 166, version: 7 },
            },
        ]);

        const unauthorizedNotification = await notifyGameServerMapReload(166, 8, {
            baseUrl,
            tokenAuth: "wrong-token",
        });
        expect(unauthorizedNotification.notified).toBe(false);
        expect(unauthorizedNotification.status).toBe(401);

        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
        activeServers = [];

        const offlineNotification = await notifyGameServerMapReload(166, 9, {
            baseUrl,
            tokenAuth: state.internalAuth,
            timeoutMs: 500,
        });
        expect(offlineNotification.notified).toBe(false);
        expect(typeof offlineNotification.error).toBe("string");
    });
});
