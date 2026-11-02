import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
    MapModeratorRecord,
    UserMapModerationLogRecord,
    UserMapRecord,
    UserMapReportRecord,
    UserMapState,
} from "../types";

const ADMIN_ACCOUNT_ID = "00000000-0000-0000-0000-000000000001";
const AUTHOR_ACCOUNT_ID = "00000000-0000-0000-0000-000000000002";
const MOD_A_ACCOUNT_ID = "00000000-0000-0000-0000-000000000003";
const MOD_B_ACCOUNT_ID = "00000000-0000-0000-0000-000000000004";
const PLAYER_ACCOUNT_ID = "00000000-0000-0000-0000-000000000005";

const ADMIN_TOKEN = "tok-root-admin";
const AUTHOR_TOKEN = "tok-map-author";
const MOD_A_TOKEN = "tok-mod-alpha";
const MOD_B_TOKEN = "tok-mod-beta";
const PLAYER_TOKEN = "tok-regular-player";

type AccountEntry = {
    id: string;
    name: string;
    email: string;
};

type SessionEntry = {
    token: string;
    account_id: string;
    expires_at: Date;
};

type UploadedGraphicEntry = {
    grh_index: number;
    checksum: string;
    width: number;
    height: number;
    byte_size: number;
    uploaded_by_account_id: string | null;
    created_at: Date;
};

type DbState = {
    accounts: AccountEntry[];
    sessions: SessionEntry[];
    moderators: MapModeratorRecord[];
    maps: UserMapRecord[];
    reports: UserMapReportRecord[];
    logs: UserMapModerationLogRecord[];
    graphics: UploadedGraphicEntry[];
    npcs: Array<{ id: number; name: string }>;
    nextLogId: number;
};

const harness = vi.hoisted(() => {
    const configMock = {
        gameDataAdminAccountId:
            "00000000-0000-0000-0000-000000000001" as string | null,
        gameDataAdminEmail: "admin@openao.test",
        gameDataAdminProxyToken: null as string | null,
    };

    const createInitialState = (): DbState => {
        const future = new Date(Date.now() + 86_400_000);
        return {
            accounts: [
                {
                    id: "00000000-0000-0000-0000-000000000001",
                    name: "RootAdmin",
                    email: "admin@openao.test",
                },
                {
                    id: "00000000-0000-0000-0000-000000000002",
                    name: "ConstructorSur",
                    email: "autor@openao.test",
                },
                {
                    id: "00000000-0000-0000-0000-000000000003",
                    name: "ModAlpha",
                    email: "moda@openao.test",
                },
                {
                    id: "00000000-0000-0000-0000-000000000004",
                    name: "ModBeta",
                    email: "modb@openao.test",
                },
                {
                    id: "00000000-0000-0000-0000-000000000005",
                    name: "JugadorComun",
                    email: "jugador@openao.test",
                },
            ],
            sessions: [
                {
                    token: "tok-root-admin",
                    account_id: "00000000-0000-0000-0000-000000000001",
                    expires_at: future,
                },
                {
                    token: "tok-map-author",
                    account_id: "00000000-0000-0000-0000-000000000002",
                    expires_at: future,
                },
                {
                    token: "tok-mod-alpha",
                    account_id: "00000000-0000-0000-0000-000000000003",
                    expires_at: future,
                },
                {
                    token: "tok-mod-beta",
                    account_id: "00000000-0000-0000-0000-000000000004",
                    expires_at: future,
                },
                {
                    token: "tok-regular-player",
                    account_id: "00000000-0000-0000-0000-000000000005",
                    expires_at: future,
                },
            ],
            moderators: [],
            maps: [],
            reports: [],
            logs: [],
            graphics: [
                {
                    grh_index: 1_000_000,
                    checksum: "abc123def456",
                    width: 32,
                    height: 32,
                    byte_size: 412,
                    uploaded_by_account_id:
                        "00000000-0000-0000-0000-000000000002",
                    created_at: new Date("2026-09-01T10:00:00Z"),
                },
            ],
            npcs: [
                { id: 10, name: "Sacerdote" },
                { id: 77, name: "Bandido Puto" },
            ],
            nextLogId: 1,
        };
    };

    let state: DbState = createInitialState();

    const cloneState = (source: DbState): DbState =>
        structuredClone(source);

    const executeSql = async (
        rawSql: string,
        params: unknown[] = [],
        txRef?: { snapshot: DbState | null },
    ): Promise<{ rows: unknown[]; rowCount: number }> => {
        const sql = rawSql.replace(/\s+/g, " ").trim();

        if (sql === "BEGIN") {
            if (txRef) {
                txRef.snapshot = cloneState(state);
            }
            return { rows: [], rowCount: 0 };
        }

        if (sql === "COMMIT") {
            if (txRef) {
                txRef.snapshot = null;
            }
            return { rows: [], rowCount: 0 };
        }

        if (sql === "ROLLBACK") {
            if (txRef?.snapshot) {
                state = txRef.snapshot;
                txRef.snapshot = null;
            }
            return { rows: [], rowCount: 0 };
        }

        if (sql.includes("FROM auth_sessions s JOIN accounts a")) {
            const token = String(params[0] ?? "");
            const now = new Date();
            const session = state.sessions.find(
                (entry) => entry.token === token && entry.expires_at > now,
            );
            if (!session) {
                return { rows: [], rowCount: 0 };
            }
            const account = state.accounts.find(
                (entry) => entry.id === session.account_id,
            );
            if (!account) {
                return { rows: [], rowCount: 0 };
            }
            return { rows: [{ ...account }], rowCount: 1 };
        }

        if (
            sql.startsWith(
                "SELECT account_id FROM map_moderators WHERE account_id = $1",
            )
        ) {
            const accountId = String(params[0] ?? "");
            const found = state.moderators.find(
                (entry) => entry.account_id === accountId,
            );
            return found
                ? { rows: [{ account_id: found.account_id }], rowCount: 1 }
                : { rows: [], rowCount: 0 };
        }

        if (sql.includes("FROM map_moderators mm JOIN accounts a")) {
            const rows = state.moderators.map((mod) => {
                const account = state.accounts.find(
                    (entry) => entry.id === mod.account_id,
                );
                return {
                    ...mod,
                    account_name: account?.name,
                    account_email: account?.email,
                };
            });
            return { rows, rowCount: rows.length };
        }

        if (
            sql.startsWith(
                "SELECT id, name, email FROM accounts WHERE id = $1",
            )
        ) {
            const id = String(params[0] ?? "");
            const found = state.accounts.find((entry) => entry.id === id);
            return found
                ? { rows: [{ ...found }], rowCount: 1 }
                : { rows: [], rowCount: 0 };
        }

        if (
            sql.startsWith(
                "SELECT id, name, email FROM accounts WHERE LOWER(email) = $1",
            )
        ) {
            const email = String(params[0] ?? "").toLowerCase();
            const found = state.accounts.find(
                (entry) => entry.email.toLowerCase() === email,
            );
            return found
                ? { rows: [{ ...found }], rowCount: 1 }
                : { rows: [], rowCount: 0 };
        }

        if (sql.startsWith("INSERT INTO map_moderators")) {
            const accountId = String(params[0]);
            const grantedBy = (params[1] as string | null) ?? null;
            const note = (params[2] as string | null) ?? null;
            const existing = state.moderators.find(
                (entry) => entry.account_id === accountId,
            );
            if (existing) {
                existing.granted_by_account_id = grantedBy;
                existing.note = note;
                return { rows: [{ ...existing }], rowCount: 1 };
            }
            const created: MapModeratorRecord = {
                account_id: accountId,
                granted_by_account_id: grantedBy,
                note,
                created_at: new Date(),
            };
            state.moderators.push(created);
            return { rows: [{ ...created }], rowCount: 1 };
        }

        if (sql.startsWith("DELETE FROM map_moderators WHERE account_id = $1")) {
            const accountId = String(params[0]);
            const before = state.moderators.length;
            state.moderators = state.moderators.filter(
                (entry) => entry.account_id !== accountId,
            );
            const removed = before - state.moderators.length;
            return { rows: [], rowCount: removed };
        }

        if (
            sql.startsWith(
                "SELECT COUNT(*)::int AS total FROM user_maps WHERE owner_account_id = $1 AND id <> $2",
            )
        ) {
            const ownerId = String(params[0]);
            const excludeId = String(params[1]);
            const total = state.maps.filter(
                (entry) =>
                    entry.owner_account_id === ownerId &&
                    entry.id !== excludeId,
            ).length;
            return { rows: [{ total }], rowCount: 1 };
        }

        if (
            sql.startsWith(
                "SELECT COUNT(*)::int AS total FROM user_maps WHERE owner_account_id = $1",
            )
        ) {
            const ownerId = String(params[0]);
            const total = state.maps.filter(
                (entry) => entry.owner_account_id === ownerId,
            ).length;
            return { rows: [{ total }], rowCount: 1 };
        }

        if (sql.includes("FROM game_uploaded_graphics WHERE grh_index = ANY")) {
            const ids = new Set((params[0] as number[]) ?? []);
            const rows = state.graphics
                .filter((entry) => ids.has(entry.grh_index))
                .map((entry) => ({ ...entry }));
            return { rows, rowCount: rows.length };
        }

        if (sql.includes("FROM game_npcs WHERE id = ANY")) {
            const ids = new Set((params[0] as number[]) ?? []);
            const rows = state.npcs
                .filter((entry) => ids.has(entry.id))
                .map((entry) => ({ ...entry }));
            return { rows, rowCount: rows.length };
        }

        if (sql.startsWith("INSERT INTO user_maps")) {
            const now = new Date();
            const record: UserMapRecord = {
                id: crypto.randomUUID(),
                owner_account_id: String(params[0]),
                name: String(params[1]),
                description: String(params[2]),
                width: Number(params[3]),
                height: Number(params[4]),
                spawn_x: Number(params[5]),
                spawn_y: Number(params[6]),
                map_data: JSON.parse(String(params[7])),
                npc_count: Number(params[8]),
                object_count: Number(params[9]),
                sign_count: Number(params[10]),
                state: "draft",
                reviewer_account_id: null,
                rejection_reason: null,
                open_report_count: 0,
                proposed_at: null,
                reviewed_at: null,
                published_at: null,
                created_at: now,
                updated_at: now,
            };
            state.maps.push(record);
            return { rows: [structuredClone(record)], rowCount: 1 };
        }

        if (
            sql.includes("FROM user_maps m JOIN accounts a") &&
            sql.includes("WHERE m.id = $1")
        ) {
            const mapId = String(params[0]);
            const found = state.maps.find((entry) => entry.id === mapId);
            if (!found) {
                return { rows: [], rowCount: 0 };
            }
            const owner = state.accounts.find(
                (entry) => entry.id === found.owner_account_id,
            );
            return {
                rows: [
                    {
                        ...structuredClone(found),
                        owner_name: owner?.name,
                        owner_email: owner?.email,
                    },
                ],
                rowCount: 1,
            };
        }

        if (
            sql.includes("FROM user_maps m JOIN accounts a") &&
            sql.includes("WHERE m.state = 'published'")
        ) {
            const rows = state.maps
                .filter((entry) => entry.state === "published")
                .sort(
                    (left, right) =>
                        (right.published_at?.getTime() ?? 0) -
                        (left.published_at?.getTime() ?? 0),
                )
                .map((entry) => {
                    const owner = state.accounts.find(
                        (acc) => acc.id === entry.owner_account_id,
                    );
                    return {
                        ...structuredClone(entry),
                        owner_name: owner?.name,
                    };
                });
            return { rows, rowCount: rows.length };
        }

        if (
            sql.includes("FROM user_maps m JOIN accounts a") &&
            sql.includes("WHERE m.owner_account_id = $1")
        ) {
            const ownerId = String(params[0]);
            const rows = state.maps
                .filter((entry) => entry.owner_account_id === ownerId)
                .sort(
                    (left, right) =>
                        right.updated_at.getTime() - left.updated_at.getTime(),
                )
                .map((entry) => {
                    const owner = state.accounts.find(
                        (acc) => acc.id === entry.owner_account_id,
                    );
                    return {
                        ...structuredClone(entry),
                        owner_name: owner?.name,
                    };
                });
            return { rows, rowCount: rows.length };
        }

        if (
            sql.includes("FROM user_maps m JOIN accounts a") &&
            sql.includes("WHERE m.state = ANY($1::text[])")
        ) {
            const allowed = new Set((params[0] as UserMapState[]) ?? []);
            const rows = state.maps
                .filter((entry) => allowed.has(entry.state))
                .sort((left, right) => {
                    if (right.open_report_count !== left.open_report_count) {
                        return (
                            right.open_report_count - left.open_report_count
                        );
                    }
                    return (
                        (left.proposed_at?.getTime() ?? 0) -
                        (right.proposed_at?.getTime() ?? 0)
                    );
                })
                .map((entry) => {
                    const owner = state.accounts.find(
                        (acc) => acc.id === entry.owner_account_id,
                    );
                    return {
                        ...structuredClone(entry),
                        owner_name: owner?.name,
                    };
                });
            return { rows, rowCount: rows.length };
        }

        if (
            sql.startsWith("UPDATE user_maps SET name = $2") &&
            sql.includes("state = 'draft'")
        ) {
            const mapId = String(params[0]);
            const found = state.maps.find((entry) => entry.id === mapId);
            if (!found) {
                return { rows: [], rowCount: 0 };
            }
            found.name = String(params[1]);
            found.description = String(params[2]);
            found.width = Number(params[3]);
            found.height = Number(params[4]);
            found.spawn_x = Number(params[5]);
            found.spawn_y = Number(params[6]);
            found.map_data = JSON.parse(String(params[7]));
            found.npc_count = Number(params[8]);
            found.object_count = Number(params[9]);
            found.sign_count = Number(params[10]);
            found.state = "draft";
            found.reviewer_account_id = null;
            found.rejection_reason = null;
            found.proposed_at = null;
            found.published_at = null;
            found.updated_at = new Date();
            return { rows: [structuredClone(found)], rowCount: 1 };
        }

        if (
            sql.startsWith("UPDATE user_maps SET state = 'proposed'") &&
            sql.includes("open_report_count = open_report_count + 1")
        ) {
            const mapId = String(params[0]);
            const found = state.maps.find((entry) => entry.id === mapId);
            if (!found) {
                return { rows: [], rowCount: 0 };
            }
            const now = new Date();
            found.state = "proposed";
            found.reviewer_account_id = null;
            found.published_at = null;
            found.open_report_count += 1;
            found.proposed_at = now;
            found.updated_at = now;
            return { rows: [structuredClone(found)], rowCount: 1 };
        }

        if (sql.startsWith("UPDATE user_maps SET state = 'proposed'")) {
            const mapId = String(params[0]);
            const found = state.maps.find((entry) => entry.id === mapId);
            if (!found) {
                return { rows: [], rowCount: 0 };
            }
            const now = new Date();
            found.state = "proposed";
            found.reviewer_account_id = null;
            found.rejection_reason = null;
            found.proposed_at = now;
            found.updated_at = now;
            return { rows: [structuredClone(found)], rowCount: 1 };
        }

        if (
            sql.startsWith("UPDATE user_maps SET state = 'in_review'") &&
            sql.includes("AND state = 'proposed'")
        ) {
            const mapId = String(params[0]);
            const reviewerId = String(params[1]);
            const found = state.maps.find(
                (entry) => entry.id === mapId && entry.state === "proposed",
            );
            if (!found) {
                return { rows: [], rowCount: 0 };
            }
            found.state = "in_review";
            found.reviewer_account_id = reviewerId;
            found.updated_at = new Date();
            return { rows: [structuredClone(found)], rowCount: 1 };
        }

        if (sql.startsWith("UPDATE user_maps SET state = 'published'")) {
            const mapId = String(params[0]);
            const reviewerId = String(params[1]);
            const found = state.maps.find((entry) => entry.id === mapId);
            if (!found) {
                return { rows: [], rowCount: 0 };
            }
            const now = new Date();
            found.state = "published";
            found.reviewer_account_id = reviewerId;
            found.rejection_reason = null;
            found.open_report_count = 0;
            found.reviewed_at = now;
            found.published_at = now;
            found.updated_at = now;
            return { rows: [structuredClone(found)], rowCount: 1 };
        }

        if (sql.startsWith("UPDATE user_maps SET state = 'rejected'")) {
            const mapId = String(params[0]);
            const reviewerId = String(params[1]);
            const reason = String(params[2]);
            if (!reason.trim()) {
                throw new Error("CHECK constraint rejection_reason failed");
            }
            const found = state.maps.find((entry) => entry.id === mapId);
            if (!found) {
                return { rows: [], rowCount: 0 };
            }
            const now = new Date();
            found.state = "rejected";
            found.reviewer_account_id = reviewerId;
            found.rejection_reason = reason;
            found.open_report_count = 0;
            found.reviewed_at = now;
            found.published_at = null;
            found.updated_at = now;
            return { rows: [structuredClone(found)], rowCount: 1 };
        }

        if (sql.startsWith("UPDATE user_maps SET state = 'unpublished'")) {
            const mapId = String(params[0]);
            const reviewerId = String(params[1]);
            const reason = String(params[2]);
            const found = state.maps.find((entry) => entry.id === mapId);
            if (!found) {
                return { rows: [], rowCount: 0 };
            }
            const now = new Date();
            found.state = "unpublished";
            found.reviewer_account_id = reviewerId;
            found.rejection_reason = reason;
            found.open_report_count = 0;
            found.reviewed_at = now;
            found.published_at = null;
            found.updated_at = now;
            return { rows: [structuredClone(found)], rowCount: 1 };
        }

        if (
            sql.startsWith("SELECT id FROM user_map_reports") &&
            sql.includes("AND status = 'open'")
        ) {
            const mapId = String(params[0]);
            const reporterId = String(params[1]);
            const openReport = state.reports.find(
                (entry) =>
                    entry.map_id === mapId &&
                    entry.reporter_account_id === reporterId &&
                    entry.status === "open",
            );
            return openReport
                ? { rows: [{ id: openReport.id }], rowCount: 1 }
                : { rows: [], rowCount: 0 };
        }

        if (sql.startsWith("INSERT INTO user_map_reports")) {
            const report: UserMapReportRecord = {
                id: crypto.randomUUID(),
                map_id: String(params[0]),
                reporter_account_id: String(params[1]),
                reason: String(params[2]),
                status: "open",
                resolved_by_account_id: null,
                resolved_at: null,
                created_at: new Date(),
            };
            state.reports.push(report);
            return { rows: [structuredClone(report)], rowCount: 1 };
        }

        if (sql.startsWith("UPDATE user_map_reports SET status = 'resolved'")) {
            const mapId = String(params[0]);
            const resolverId = String(params[1]);
            let updatedCount = 0;
            const now = new Date();
            for (const report of state.reports) {
                if (report.map_id === mapId && report.status === "open") {
                    report.status = "resolved";
                    report.resolved_by_account_id = resolverId;
                    report.resolved_at = now;
                    updatedCount += 1;
                }
            }
            return { rows: [], rowCount: updatedCount };
        }

        if (sql.includes("FROM user_map_reports r JOIN accounts a")) {
            const mapId = String(params[0]);
            const rows = state.reports
                .filter((entry) => entry.map_id === mapId)
                .map((entry) => {
                    const reporter = state.accounts.find(
                        (acc) => acc.id === entry.reporter_account_id,
                    );
                    return {
                        ...structuredClone(entry),
                        reporter_name: reporter?.name,
                    };
                });
            return { rows, rowCount: rows.length };
        }

        if (sql.startsWith("INSERT INTO user_map_moderation_logs")) {
            const log: UserMapModerationLogRecord = {
                id: state.nextLogId++,
                map_id: String(params[0]),
                actor_account_id: (params[1] as string | null) ?? null,
                action: params[2] as UserMapModerationLogRecord["action"],
                from_state: params[3] as UserMapState,
                to_state: params[4] as UserMapState,
                reason: (params[5] as string | null) ?? null,
                created_at: new Date(),
            };
            state.logs.push(log);
            return { rows: [structuredClone(log)], rowCount: 1 };
        }

        if (sql.includes("FROM user_map_moderation_logs WHERE map_id = $1")) {
            const mapId = String(params[0]);
            const rows = state.logs
                .filter((entry) => entry.map_id === mapId)
                .sort((left, right) => Number(right.id) - Number(left.id))
                .map((entry) => structuredClone(entry));
            return { rows, rowCount: rows.length };
        }

        throw new Error(`Unhandled SQL in route test store: ${sql}`);
    };

    const poolMock = {
        query: vi.fn((sql: string, params?: unknown[]) =>
            executeSql(sql, params),
        ),
        connect: vi.fn(async () => {
            const txRef: { snapshot: DbState | null } = { snapshot: null };
            return {
                query: vi.fn((sql: string, params?: unknown[]) =>
                    executeSql(sql, params, txRef),
                ),
                release: vi.fn(),
            };
        }),
    };

    return {
        configMock,
        poolMock,
        reset: () => {
            state = createInitialState();
            configMock.gameDataAdminAccountId =
                "00000000-0000-0000-0000-000000000001";
            configMock.gameDataAdminEmail = "admin@openao.test";
            configMock.gameDataAdminProxyToken = null;
            poolMock.query.mockClear();
            poolMock.connect.mockClear();
        },
    };
});

vi.mock("../config", () => ({
    default: harness.configMock,
}));

vi.mock("../db", () => ({
    default: harness.poolMock,
}));

import { registerUserMapModerationRoutes } from "../routes/userMapModeration";

function buildMapPayload(overrides: Record<string, unknown> = {}) {
    return {
        name: "Fortaleza del Sur",
        description: "Mapa simetrico creado por jugador.",
        width: 14,
        height: 14,
        spawn: { x: 2, y: 2 },
        mapData: {
            tiles: [{ x: 2, y: 2, layer: 1, grhIndex: 1_000_000 }],
            blockedTiles: [],
            npcs: [
                {
                    x: 4,
                    y: 4,
                    npcId: 10,
                    dialogue: "Que la suerte te acompane.",
                },
            ],
            objects: [{ x: 5, y: 5, objectId: 1, amount: 1 }],
            signs: [{ x: 3, y: 2, text: "Salida al este." }],
            exits: [{ x: 14, y: 14, targetMap: 700 }],
            teleports: [],
        },
        ...overrides,
    };
}

describe("Rutas HTTP de propuesta y moderacion de mapas", () => {
    let server: Server;
    let baseUrl = "";

    async function requestJson<T = Record<string, unknown>>(
        method: string,
        path: string,
        options: {
            token?: string;
            body?: unknown;
            headers?: Record<string, string>;
        } = {},
    ): Promise<{ status: number; body: T }> {
        const headers: Record<string, string> = {
            ...(options.headers ?? {}),
        };
        if (options.token) {
            headers.Authorization = `Bearer ${options.token}`;
        }
        if (options.body !== undefined) {
            headers["Content-Type"] = "application/json";
        }

        const response = await fetch(`${baseUrl}${path}`, {
            method,
            headers,
            body:
                options.body !== undefined
                    ? JSON.stringify(options.body)
                    : undefined,
        });

        const parsed = (await response.json()) as T;
        return { status: response.status, body: parsed };
    }

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        registerUserMapModerationRoutes(app);

        await new Promise<void>((resolve) => {
            server = app.listen(0, "127.0.0.1", () => {
                const address = server.address() as AddressInfo;
                baseUrl = `http://127.0.0.1:${address.port}`;
                resolve();
            });
        });
    });

    afterAll(async () => {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
    });

    beforeEach(() => {
        harness.reset();
    });

    it("mantiene aislamiento total de visibilidad hasta que el mapa es publicado", async () => {
        await requestJson("POST", "/moderation/moderators", {
            token: ADMIN_TOKEN,
            body: { accountId: MOD_A_ACCOUNT_ID, note: "Moderador turno A" },
        });

        const created = await requestJson<{ map: { id: string; state: string } }>(
            "POST",
            "/user-maps",
            {
                token: AUTHOR_TOKEN,
                body: buildMapPayload(),
            },
        );
        expect(created.status).toBe(201);
        const mapId = created.body.map.id;
        expect(created.body.map.state).toBe("draft");

        // En estado draft no aparece en el listado publico ni es visible para terceros.
        const publicDraftList = await requestJson<{ maps: unknown[] }>(
            "GET",
            "/user-maps",
        );
        expect(publicDraftList.status).toBe(200);
        expect(publicDraftList.body.maps).toHaveLength(0);

        const anonDraftView = await requestJson("GET", `/user-maps/${mapId}`);
        expect(anonDraftView.status).toBe(404);

        const otherPlayerDraftView = await requestJson(
            "GET",
            `/user-maps/${mapId}`,
            { token: PLAYER_TOKEN },
        );
        expect(otherPlayerDraftView.status).toBe(404);

        // El autor y los moderadores si pueden inspeccionarlo.
        const authorDraftView = await requestJson<{ map: { id: string } }>(
            "GET",
            `/user-maps/${mapId}`,
            { token: AUTHOR_TOKEN },
        );
        expect(authorDraftView.status).toBe(200);

        const proposed = await requestJson("POST", `/user-maps/${mapId}/propose`, {
            token: AUTHOR_TOKEN,
        });
        expect(proposed.status).toBe(200);

        expect(
            (await requestJson<{ maps: unknown[] }>("GET", "/user-maps")).body
                .maps,
        ).toHaveLength(0);
        expect(
            (
                await requestJson("GET", `/user-maps/${mapId}`, {
                    token: PLAYER_TOKEN,
                })
            ).status,
        ).toBe(404);

        const inReview = await requestJson(
            "POST",
            `/moderation/maps/${mapId}/review`,
            { token: MOD_A_TOKEN },
        );
        expect(inReview.status).toBe(200);

        expect(
            (await requestJson<{ maps: unknown[] }>("GET", "/user-maps")).body
                .maps,
        ).toHaveLength(0);
        expect((await requestJson("GET", `/user-maps/${mapId}`)).status).toBe(
            404,
        );

        const approved = await requestJson<{ map: { state: string } }>(
            "POST",
            `/moderation/maps/${mapId}/approve`,
            { token: MOD_A_TOKEN },
        );
        expect(approved.status).toBe(200);
        expect(approved.body.map.state).toBe("published");

        // Una vez publicado es visible para todos los jugadores.
        const publicPublishedList = await requestJson<{
            maps: Array<{ id: string; state: string }>;
        }>("GET", "/user-maps");
        expect(publicPublishedList.status).toBe(200);
        expect(publicPublishedList.body.maps).toHaveLength(1);
        expect(publicPublishedList.body.maps[0]?.id).toBe(mapId);

        const publicView = await requestJson<{ map: { state: string } }>(
            "GET",
            `/user-maps/${mapId}`,
        );
        expect(publicView.status).toBe(200);
        expect(publicView.body.map.state).toBe("published");
    });

    it("bloquea la entrada a la cola humana si fallan los pre-chequeos automaticos", async () => {
        await requestJson("POST", "/moderation/moderators", {
            token: ADMIN_TOKEN,
            body: { accountId: MOD_A_ACCOUNT_ID },
        });

        // Dimensiones invalidas rechazadas en creacion.
        const hugeMap = await requestJson("POST", "/user-maps", {
            token: AUTHOR_TOKEN,
            body: buildMapPayload({ width: 9999, height: 9999 }),
        });
        expect(hugeMap.status).toBe(400);

        // Borrador con lenguaje prohibido y trampa sin salida.
        const badDraft = await requestJson<{ map: { id: string } }>(
            "POST",
            "/user-maps",
            {
                token: AUTHOR_TOKEN,
                body: buildMapPayload({
                    mapData: {
                        tiles: [],
                        blockedTiles: Array.from({ length: 14 }, (_, idx) => ({
                            x: 7,
                            y: idx + 1,
                        })),
                        npcs: [{ x: 4, y: 4, npcId: 77 }],
                        objects: [],
                        signs: [{ x: 3, y: 2, text: "Cartel limpio" }],
                        exits: [],
                        teleports: [],
                    },
                }),
            },
        );
        expect(badDraft.status).toBe(201);
        const badMapId = badDraft.body.map.id;

        const failedBannedProposal = await requestJson<{
            error: string;
            details: { stage: string };
        }>("POST", `/user-maps/${badMapId}/propose`, {
            token: AUTHOR_TOKEN,
        });
        expect(failedBannedProposal.status).toBe(400);
        expect(failedBannedProposal.body.details.stage).toBe("banned_words");

        // Se quita el NPC ofensivo pero queda la pared que deja media grilla aislada.
        await requestJson("PUT", `/user-maps/${badMapId}`, {
            token: AUTHOR_TOKEN,
            body: {
                mapData: {
                    tiles: [],
                    blockedTiles: Array.from({ length: 14 }, (_, idx) => ({
                        x: 7,
                        y: idx + 1,
                    })),
                    npcs: [],
                    objects: [],
                    signs: [],
                    exits: [],
                    teleports: [],
                },
            },
        });

        const failedGeometryProposal = await requestJson<{
            error: string;
            details: { stage: string; violations: Array<{ code: string }> };
        }>("POST", `/user-maps/${badMapId}/propose`, {
            token: AUTHOR_TOKEN,
        });
        expect(failedGeometryProposal.status).toBe(400);
        expect(failedGeometryProposal.body.details.stage).toBe("geometry");
        expect(
            failedGeometryProposal.body.details.violations.some(
                (v) => v.code === "isolated_walkable_region",
            ),
        ).toBe(true);

        const queue = await requestJson<{ maps: unknown[] }>(
            "GET",
            "/moderation/maps/queue",
            { token: MOD_A_TOKEN },
        );
        expect(queue.status).toBe(200);
        expect(queue.body.maps).toHaveLength(0);
    });

    it("soporta multiples moderadores sin colisiones, preview sin entrar al juego y motivo obligatorio de rechazo", async () => {
        // Jugador normal no puede gestionar moderadores ni ver la cola.
        expect(
            (
                await requestJson("POST", "/moderation/moderators", {
                    token: PLAYER_TOKEN,
                    body: { accountId: MOD_A_ACCOUNT_ID },
                })
            ).status,
        ).toBe(403);

        expect(
            (
                await requestJson("GET", "/moderation/maps/queue", {
                    token: PLAYER_TOKEN,
                })
            ).status,
        ).toBe(403);

        // El admin principal habilita dos moderadores independientes.
        expect(
            (
                await requestJson("POST", "/moderation/moderators", {
                    token: ADMIN_TOKEN,
                    body: { email: "moda@openao.test", note: "Turno manana" },
                })
            ).status,
        ).toBe(201);
        expect(
            (
                await requestJson("POST", "/moderation/moderators", {
                    token: ADMIN_TOKEN,
                    body: { accountId: MOD_B_ACCOUNT_ID, note: "Turno tarde" },
                })
            ).status,
        ).toBe(201);

        const modsList = await requestJson<{ moderators: unknown[] }>(
            "GET",
            "/moderation/moderators",
            { token: ADMIN_TOKEN },
        );
        expect(modsList.status).toBe(200);
        expect(modsList.body.moderators).toHaveLength(2);

        // Autor crea y propone el mapa.
        const created = await requestJson<{ map: { id: string } }>(
            "POST",
            "/user-maps",
            {
                token: AUTHOR_TOKEN,
                body: buildMapPayload(),
            },
        );
        const mapId = created.body.map.id;
        await requestJson("POST", `/user-maps/${mapId}/propose`, {
            token: AUTHOR_TOKEN,
        });

        // Moderador B inspecciona el preview completo sin entrar al juego.
        const previewRes = await requestJson<{
            preview: {
                graphics: Array<{ grhIndex: number; url: string; width: number }>;
                texts: {
                    mapName: string;
                    signs: Array<{ text: string }>;
                    npcs: Array<{ catalogName: string | null; dialogue: string | null }>;
                };
                automatedChecks: { ok: boolean };
            };
        }>("GET", `/moderation/maps/${mapId}/preview`, {
            token: MOD_B_TOKEN,
        });
        expect(previewRes.status).toBe(200);
        expect(previewRes.body.preview.graphics).toEqual([
            expect.objectContaining({
                grhIndex: 1_000_000,
                url: "/game-data/graphics/1000000.png",
                width: 32,
            }),
        ]);
        expect(previewRes.body.preview.texts.mapName).toBe("Fortaleza del Sur");
        expect(previewRes.body.preview.texts.signs[0]?.text).toBe(
            "Salida al este.",
        );
        expect(previewRes.body.preview.texts.npcs[0]?.catalogName).toBe(
            "Sacerdote",
        );
        expect(previewRes.body.preview.automatedChecks.ok).toBe(true);

        // Moderador A reclama la revision primero; Moderador B recibe 409 al intentar tomarlo o aprobarlo.
        const claimedByA = await requestJson<{ map: { state: string } }>(
            "POST",
            `/moderation/maps/${mapId}/review`,
            { token: MOD_A_TOKEN },
        );
        expect(claimedByA.status).toBe(200);
        expect(claimedByA.body.map.state).toBe("in_review");

        const collisionReviewByB = await requestJson(
            "POST",
            `/moderation/maps/${mapId}/review`,
            { token: MOD_B_TOKEN },
        );
        expect(collisionReviewByB.status).toBe(409);

        const collisionApproveByB = await requestJson(
            "POST",
            `/moderation/maps/${mapId}/approve`,
            { token: MOD_B_TOKEN },
        );
        expect(collisionApproveByB.status).toBe(409);

        // Rechazar sin motivo falla con 400.
        const emptyReject = await requestJson(
            "POST",
            `/moderation/maps/${mapId}/reject`,
            {
                token: MOD_A_TOKEN,
                body: { reason: "   " },
            },
        );
        expect(emptyReject.status).toBe(400);

        // Rechazo con motivo valido llega al autor.
        const rejected = await requestJson<{
            map: { state: string; rejectionReason: string };
        }>("POST", `/moderation/maps/${mapId}/reject`, {
            token: MOD_A_TOKEN,
            body: { reason: "El cartel principal indica una direccion erronea." },
        });
        expect(rejected.status).toBe(200);
        expect(rejected.body.map.state).toBe("rejected");

        const authorMine = await requestJson<{
            maps: Array<{ id: string; state: string; rejectionReason: string }>;
        }>("GET", "/user-maps/mine", {
            token: AUTHOR_TOKEN,
        });
        expect(authorMine.status).toBe(200);
        expect(authorMine.body.maps[0]?.state).toBe("rejected");
        expect(authorMine.body.maps[0]?.rejectionReason).toBe(
            "El cartel principal indica una direccion erronea.",
        );

        // El autor corrige el mapa -> vuelve a draft y puede volver a proponerse y publicarse.
        const edited = await requestJson<{
            map: { state: string; rejectionReason: string | null };
        }>("PUT", `/user-maps/${mapId}`, {
            token: AUTHOR_TOKEN,
            body: { description: "Descripcion corregida tras revision." },
        });
        expect(edited.status).toBe(200);
        expect(edited.body.map.state).toBe("draft");
        expect(edited.body.map.rejectionReason).toBeNull();

        expect(
            (
                await requestJson("POST", `/user-maps/${mapId}/propose`, {
                    token: AUTHOR_TOKEN,
                })
            ).status,
        ).toBe(200);
        expect(
            (
                await requestJson("POST", `/moderation/maps/${mapId}/review`, {
                    token: MOD_B_TOKEN,
                })
            ).status,
        ).toBe(200);
        expect(
            (
                await requestJson("POST", `/moderation/maps/${mapId}/approve`, {
                    token: MOD_B_TOKEN,
                })
            ).status,
        ).toBe(200);

        // Revocar a Moderador B le retira el acceso a la cola.
        expect(
            (
                await requestJson(
                    "DELETE",
                    `/moderation/moderators/${MOD_B_ACCOUNT_ID}`,
                    { token: ADMIN_TOKEN },
                )
            ).status,
        ).toBe(200);
        expect(
            (
                await requestJson("GET", "/moderation/maps/queue", {
                    token: MOD_B_TOKEN,
                })
            ).status,
        ).toBe(403);
    });

    it("devuelve un mapa publicado a la cola cuando un jugador lo reporta y permite despublicacion de emergencia", async () => {
        await requestJson("POST", "/moderation/moderators", {
            token: ADMIN_TOKEN,
            body: { accountId: MOD_A_ACCOUNT_ID },
        });

        const created = await requestJson<{ map: { id: string } }>(
            "POST",
            "/user-maps",
            {
                token: AUTHOR_TOKEN,
                body: buildMapPayload(),
            },
        );
        const mapId = created.body.map.id;

        await requestJson("POST", `/user-maps/${mapId}/propose`, {
            token: AUTHOR_TOKEN,
        });
        await requestJson("POST", `/moderation/maps/${mapId}/review`, {
            token: MOD_A_TOKEN,
        });
        await requestJson("POST", `/moderation/maps/${mapId}/approve`, {
            token: MOD_A_TOKEN,
        });

        // El propio autor no puede auto-reportar su mapa.
        expect(
            (
                await requestJson("POST", `/user-maps/${mapId}/report`, {
                    token: AUTHOR_TOKEN,
                    body: { reason: "Auto reporte" },
                })
            ).status,
        ).toBe(400);

        // Un jugador reporta el mapa publicado -> vuelve a cola de revision y sale de la vista publica.
        const reported = await requestJson<{
            map: { state: string };
            report: { status: string; reason: string };
        }>("POST", `/user-maps/${mapId}/report`, {
            token: PLAYER_TOKEN,
            body: { reason: "Grafico inapropiado oculto en esquina." },
        });
        expect(reported.status).toBe(201);
        expect(reported.body.map.state).toBe("proposed");
        expect(reported.body.report.status).toBe("open");

        expect(
            (await requestJson<{ maps: unknown[] }>("GET", "/user-maps")).body
                .maps,
        ).toHaveLength(0);
        expect((await requestJson("GET", `/user-maps/${mapId}`)).status).toBe(
            404,
        );

        const queueAfterReport = await requestJson<{
            maps: Array<{ id: string; openReportCount: number }>;
        }>("GET", "/moderation/maps/queue", {
            token: MOD_A_TOKEN,
        });
        expect(queueAfterReport.body.maps).toHaveLength(1);
        expect(queueAfterReport.body.maps[0]?.openReportCount).toBe(1);

        // Moderador revisa y vuelve a aprobar tras verificar que es seguro -> resuelve el reporte.
        await requestJson("POST", `/moderation/maps/${mapId}/review`, {
            token: MOD_A_TOKEN,
        });
        await requestJson("POST", `/moderation/maps/${mapId}/approve`, {
            token: MOD_A_TOKEN,
        });

        const previewAfterResolve = await requestJson<{
            preview: { reports: Array<{ status: string }> };
        }>("GET", `/moderation/maps/${mapId}/preview`, {
            token: MOD_A_TOKEN,
        });
        expect(previewAfterResolve.body.preview.reports[0]?.status).toBe(
            "resolved",
        );

        // Despublicacion de emergencia por moderacion retira el mapa inmediatamente.
        const unpublished = await requestJson<{
            map: { state: string; rejectionReason: string };
        }>("POST", `/moderation/maps/${mapId}/unpublish`, {
            token: MOD_A_TOKEN,
            body: { reason: "Retirado preventivamente por mantenimiento." },
        });
        expect(unpublished.status).toBe(200);
        expect(unpublished.body.map.state).toBe("unpublished");

        expect(
            (await requestJson<{ maps: unknown[] }>("GET", "/user-maps")).body
                .maps,
        ).toHaveLength(0);
        expect((await requestJson("GET", `/user-maps/${mapId}`)).status).toBe(
            404,
        );
    });

    it("impide auto-moderacion del propio autor, mutacion de mapas en cola/publicados y exige proxy token si esta configurado", async () => {
        await requestJson("POST", "/moderation/moderators", {
            token: ADMIN_TOKEN,
            body: { accountId: MOD_A_ACCOUNT_ID },
        });
        await requestJson("POST", "/moderation/moderators", {
            token: ADMIN_TOKEN,
            body: { accountId: MOD_B_ACCOUNT_ID },
        });

        // Moderador A crea y propone su propio mapa: no puede auto-revisarlo ni auto-aprobarlo.
        const modOwnCreated = await requestJson<{ map: { id: string } }>(
            "POST",
            "/user-maps",
            {
                token: MOD_A_TOKEN,
                body: buildMapPayload({ name: "Mapa de ModAlpha" }),
            },
        );
        expect(modOwnCreated.status).toBe(201);
        const modMapId = modOwnCreated.body.map.id;

        expect(
            (
                await requestJson("POST", `/user-maps/${modMapId}/propose`, {
                    token: MOD_A_TOKEN,
                })
            ).status,
        ).toBe(200);

        expect(
            (
                await requestJson("PUT", `/user-maps/${modMapId}`, {
                    token: MOD_A_TOKEN,
                    body: { name: "Intento de cambio en cola" },
                })
            ).status,
        ).toBe(409);

        expect(
            (
                await requestJson(
                    "POST",
                    `/moderation/maps/${modMapId}/review`,
                    { token: MOD_A_TOKEN },
                )
            ).status,
        ).toBe(403);

        // Otro moderador independiente (ModBeta) si puede revisarlo, y ni en in_review ni en published puede editarse directo.
        expect(
            (
                await requestJson(
                    "POST",
                    `/moderation/maps/${modMapId}/review`,
                    { token: MOD_B_TOKEN },
                )
            ).status,
        ).toBe(200);

        expect(
            (
                await requestJson(
                    "POST",
                    `/moderation/maps/${modMapId}/approve`,
                    { token: MOD_A_TOKEN },
                )
            ).status,
        ).toBe(403);

        expect(
            (
                await requestJson("PUT", `/user-maps/${modMapId}`, {
                    token: MOD_A_TOKEN,
                    body: { name: "Intento de cambio en revision" },
                })
            ).status,
        ).toBe(409);

        expect(
            (
                await requestJson(
                    "POST",
                    `/moderation/maps/${modMapId}/approve`,
                    { token: MOD_B_TOKEN },
                )
            ).status,
        ).toBe(200);

        expect(
            (
                await requestJson("PUT", `/user-maps/${modMapId}`, {
                    token: MOD_A_TOKEN,
                    body: { name: "Intento de cambio ya publicado" },
                })
            ).status,
        ).toBe(409);

        // Cuando gameDataAdminProxyToken esta definido, gestionar moderadores exige ese header.
        harness.configMock.gameDataAdminProxyToken = "proxy-guard-header";
        expect(
            (
                await requestJson("GET", "/moderation/moderators", {
                    token: ADMIN_TOKEN,
                })
            ).status,
        ).toBe(403);

        expect(
            (
                await requestJson("GET", "/moderation/moderators", {
                    token: ADMIN_TOKEN,
                    headers: { "x-game-data-admin-token": "proxy-guard-header" },
                })
            ).status,
        ).toBe(200);
    });
});
