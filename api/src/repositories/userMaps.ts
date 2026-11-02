import type { PoolClient } from "pg";
import config from "../config";
import pool from "../db";
import {
    MAX_CUSTOM_GRAPHICS_PER_MAP,
    MAX_EXITS_PER_MAP,
    MAX_MAPS_PER_ACCOUNT,
    MAX_NPCS_PER_MAP,
    MAX_OBJECTS_PER_MAP,
    MAX_SIGNS_PER_MAP,
    MAX_TELEPORTS_PER_MAP,
    UPLOADED_GRAPHIC_INDEX_START,
    canTransitionUserMapState,
    runAutomatedMapChecks,
    validateBoundsAndQuotas,
    type AutomatedMapCheckResult,
} from "../lib/mapModerationValidation";
import type {
    MapModeratorRecord,
    UserMapContent,
    UserMapDetails,
    UserMapModerationAction,
    UserMapModerationLogRecord,
    UserMapRecord,
    UserMapReportRecord,
    UserMapState,
    UserMapSummary,
} from "../types";

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MODERATION_REASON_LENGTH = 500;

type Queryable = Pick<PoolClient, "query">;

export class UserMapDomainError extends Error {
    readonly statusCode: 400 | 401 | 403 | 404 | 409;
    readonly details?: unknown;

    constructor(
        message: string,
        statusCode: 400 | 401 | 403 | 404 | 409 = 400,
        details?: unknown,
    ) {
        super(message);
        this.name = "UserMapDomainError";
        this.statusCode = statusCode;
        this.details = details;
    }
}

export type MapAuthenticatedAccount = {
    id: string;
    name: string;
    email: string;
};

export type AccountModerationAccess = {
    isRootAdmin: boolean;
    isModerator: boolean;
};

export type MapViewerContext = {
    accountId: string | null;
    isModerator: boolean;
};

export type UploadedGraphicPreview = {
    grhIndex: number;
    url: string;
    checksum: string | null;
    width: number | null;
    height: number | null;
    byteSize: number | null;
    uploadedByAccountId: string | null;
    createdAt: string | null;
    missing: boolean;
};

export type UserMapReportSummary = {
    id: string;
    mapId: string;
    reporterAccountId: string;
    reporterName: string | null;
    reason: string;
    status: "open" | "resolved";
    resolvedByAccountId: string | null;
    resolvedAt: string | null;
    createdAt: string;
};

export type UserMapModerationLogSummary = {
    id: number;
    mapId: string;
    actorAccountId: string | null;
    action: UserMapModerationAction;
    fromState: UserMapState;
    toState: UserMapState;
    reason: string | null;
    createdAt: string;
};

export type UserMapModerationPreview = {
    map: UserMapDetails;
    graphics: UploadedGraphicPreview[];
    texts: {
        mapName: string;
        description: string;
        signs: Array<{
            x: number;
            y: number;
            text: string;
        }>;
        npcs: Array<{
            x: number;
            y: number;
            npcId: number;
            catalogName: string | null;
            customName: string | null;
            dialogue: string | null;
        }>;
    };
    quotas: {
        npcs: { used: number; max: number };
        objects: { used: number; max: number };
        signs: { used: number; max: number };
        exits: { used: number; max: number };
        teleports: { used: number; max: number };
        customGraphics: { used: number; max: number };
    };
    automatedChecks: {
        ok: boolean;
        stage: AutomatedMapCheckResult["stage"];
        violations: AutomatedMapCheckResult["violations"];
        diagnostics: AutomatedMapCheckResult["diagnostics"];
    };
    reports: UserMapReportSummary[];
    moderationLogs: UserMapModerationLogSummary[];
};

export type MapModeratorSummary = {
    accountId: string;
    accountName: string | null;
    accountEmail: string | null;
    grantedByAccountId: string | null;
    note: string | null;
    createdAt: string;
};

function assertValidUuid(value: unknown, label: string): string {
    if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
        throw new UserMapDomainError(`${label} invalido.`, 400);
    }

    return value.trim();
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
    if (!value) {
        return null;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function normalizeStoredMapContent(raw: unknown): UserMapContent {
    const data =
        raw && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as Partial<UserMapContent>)
            : {};

    return {
        tiles: Array.isArray(data.tiles) ? data.tiles : [],
        blockedTiles: Array.isArray(data.blockedTiles) ? data.blockedTiles : [],
        npcs: Array.isArray(data.npcs) ? data.npcs : [],
        objects: Array.isArray(data.objects) ? data.objects : [],
        signs: Array.isArray(data.signs) ? data.signs : [],
        exits: Array.isArray(data.exits) ? data.exits : [],
        teleports: Array.isArray(data.teleports) ? data.teleports : [],
    };
}

function toUserMapSummary(
    row: UserMapRecord,
    options: { includeInternalFields?: boolean } = {},
): UserMapSummary {
    const includeInternal = options.includeInternalFields ?? true;

    return {
        id: row.id,
        ownerAccountId: row.owner_account_id,
        ownerName: row.owner_name ?? null,
        name: row.name,
        description: row.description,
        width: Number(row.width),
        height: Number(row.height),
        spawn: {
            x: Number(row.spawn_x),
            y: Number(row.spawn_y),
        },
        npcCount: Number(row.npc_count),
        objectCount: Number(row.object_count),
        signCount: Number(row.sign_count),
        state: row.state,
        reviewerAccountId: includeInternal ? row.reviewer_account_id : null,
        rejectionReason: includeInternal ? row.rejection_reason : null,
        openReportCount: includeInternal ? Number(row.open_report_count) : 0,
        proposedAt: includeInternal ? toIsoOrNull(row.proposed_at) : null,
        reviewedAt: includeInternal ? toIsoOrNull(row.reviewed_at) : null,
        publishedAt: toIsoOrNull(row.published_at),
        createdAt: toIsoOrNull(row.created_at) ?? new Date(0).toISOString(),
        updatedAt: toIsoOrNull(row.updated_at) ?? new Date(0).toISOString(),
    };
}

function toUserMapDetails(
    row: UserMapRecord,
    options: { includeInternalFields?: boolean } = {},
): UserMapDetails {
    return {
        ...toUserMapSummary(row, options),
        mapData: normalizeStoredMapContent(row.map_data),
    };
}

function toReportSummary(row: UserMapReportRecord): UserMapReportSummary {
    return {
        id: row.id,
        mapId: row.map_id,
        reporterAccountId: row.reporter_account_id,
        reporterName: row.reporter_name ?? null,
        reason: row.reason,
        status: row.status,
        resolvedByAccountId: row.resolved_by_account_id,
        resolvedAt: toIsoOrNull(row.resolved_at),
        createdAt: toIsoOrNull(row.created_at) ?? new Date(0).toISOString(),
    };
}

function toModerationLogSummary(
    row: UserMapModerationLogRecord,
): UserMapModerationLogSummary {
    return {
        id: Number(row.id),
        mapId: row.map_id,
        actorAccountId: row.actor_account_id,
        action: row.action,
        fromState: row.from_state,
        toState: row.to_state,
        reason: row.reason,
        createdAt: toIsoOrNull(row.created_at) ?? new Date(0).toISOString(),
    };
}

function toModeratorSummary(row: MapModeratorRecord): MapModeratorSummary {
    return {
        accountId: row.account_id,
        accountName: row.account_name ?? null,
        accountEmail: row.account_email ?? null,
        grantedByAccountId: row.granted_by_account_id,
        note: row.note,
        createdAt: toIsoOrNull(row.created_at) ?? new Date(0).toISOString(),
    };
}

async function insertModerationLog(
    client: Queryable,
    entry: {
        mapId: string;
        actorAccountId: string | null;
        action: UserMapModerationAction;
        fromState: UserMapState;
        toState: UserMapState;
        reason?: string | null;
    },
): Promise<void> {
    await client.query(
        `INSERT INTO user_map_moderation_logs
             (map_id, actor_account_id, action, from_state, to_state, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
            entry.mapId,
            entry.actorAccountId,
            entry.action,
            entry.fromState,
            entry.toState,
            entry.reason ?? null,
        ],
    );
}

async function assertCustomGraphicsExist(
    queryable: Queryable,
    customGraphicIds: number[],
): Promise<void> {
    if (customGraphicIds.length === 0) {
        return;
    }

    const result = await queryable.query<{ grh_index: number }>(
        `SELECT grh_index
         FROM game_uploaded_graphics
         WHERE grh_index = ANY($1::int[])`,
        [customGraphicIds],
    );

    const found = new Set(result.rows.map((row) => Number(row.grh_index)));
    const missing = customGraphicIds.find((id) => !found.has(id));

    if (missing !== undefined) {
        throw new UserMapDomainError(
            `El grafico personalizado ${missing} no existe.`,
            400,
            {
                stage: "bounds_and_quotas",
                violations: [
                    {
                        code: "invalid_tile_entry",
                        field: "mapData.tiles",
                        message: `El grafico personalizado ${missing} no existe.`,
                    },
                ],
            },
        );
    }
}

async function fetchCatalogNpcNames(
    queryable: Queryable,
    npcIds: number[],
): Promise<Map<number, string>> {
    if (npcIds.length === 0) {
        return new Map();
    }

    const uniqueIds = Array.from(new Set(npcIds));
    const result = await queryable.query<{ id: number; name: string }>(
        `SELECT id, name
         FROM game_npcs
         WHERE id = ANY($1::int[])`,
        [uniqueIds],
    );

    const map = new Map<number, string>();
    for (const row of result.rows) {
        map.set(Number(row.id), row.name);
    }
    return map;
}

async function fetchMapWithOwnerById(
    queryable: Queryable,
    mapId: string,
    forUpdate = false,
): Promise<UserMapRecord | null> {
    const lockClause = forUpdate ? "FOR UPDATE OF m" : "";
    const result = await queryable.query<UserMapRecord>(
        `SELECT m.*,
                a.name AS owner_name,
                a.email AS owner_email
         FROM user_maps m
         JOIN accounts a ON a.id = m.owner_account_id
         WHERE m.id = $1
         LIMIT 1
         ${lockClause}`,
        [mapId],
    );

    return result.rows[0] ?? null;
}

export function isRootGameDataAdmin(account: {
    id: string;
    email: string;
}): boolean {
    if (
        config.gameDataAdminAccountId &&
        account.id === config.gameDataAdminAccountId
    ) {
        return true;
    }

    if (
        config.gameDataAdminEmail &&
        account.email.toLowerCase() === config.gameDataAdminEmail
    ) {
        return true;
    }

    return false;
}

export async function resolveMapAccountByToken(
    token: string,
): Promise<MapAuthenticatedAccount | null> {
    const trimmed = token.trim();
    if (!trimmed) {
        return null;
    }

    const result = await pool.query<MapAuthenticatedAccount>(
        `SELECT a.id, a.name, a.email
         FROM auth_sessions s
         JOIN accounts a ON a.id = s.account_id
         WHERE s.token = $1
           AND s.expires_at > NOW()
         LIMIT 1`,
        [trimmed],
    );

    return result.rows[0] ?? null;
}

export async function getAccountModerationAccess(
    account: MapAuthenticatedAccount,
): Promise<AccountModerationAccess> {
    if (isRootGameDataAdmin(account)) {
        return { isRootAdmin: true, isModerator: true };
    }

    const result = await pool.query<{ account_id: string }>(
        `SELECT account_id
         FROM map_moderators
         WHERE account_id = $1
         LIMIT 1`,
        [account.id],
    );

    return {
        isRootAdmin: false,
        isModerator: (result.rowCount ?? result.rows.length) > 0,
    };
}

export async function listMapModerators(): Promise<MapModeratorSummary[]> {
    const result = await pool.query<MapModeratorRecord>(
        `SELECT mm.account_id,
                a.name AS account_name,
                a.email AS account_email,
                mm.granted_by_account_id,
                mm.note,
                mm.created_at
         FROM map_moderators mm
         JOIN accounts a ON a.id = mm.account_id
         ORDER BY mm.created_at ASC`,
    );

    return result.rows.map(toModeratorSummary);
}

export async function grantMapModerator(
    payload: unknown,
    grantedByAccountId: string,
): Promise<MapModeratorSummary> {
    const actorId = assertValidUuid(grantedByAccountId, "Cuenta administradora");
    const body =
        payload && typeof payload === "object"
            ? (payload as Record<string, unknown>)
            : {};

    const rawAccountId =
        typeof body.accountId === "string" ? body.accountId.trim() : "";
    const rawEmail =
        typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const note =
        typeof body.note === "string" && body.note.trim().length > 0
            ? body.note.trim().slice(0, 280)
            : null;

    if (!rawAccountId && !rawEmail) {
        throw new UserMapDomainError(
            "Debes indicar accountId o email de la cuenta moderadora.",
            400,
        );
    }

    let accountRow: { id: string; name: string; email: string } | undefined;

    if (rawAccountId) {
        const validId = assertValidUuid(rawAccountId, "accountId");
        const lookup = await pool.query<{
            id: string;
            name: string;
            email: string;
        }>(
            `SELECT id, name, email
             FROM accounts
             WHERE id = $1
             LIMIT 1`,
            [validId],
        );
        accountRow = lookup.rows[0];
    } else {
        const lookup = await pool.query<{
            id: string;
            name: string;
            email: string;
        }>(
            `SELECT id, name, email
             FROM accounts
             WHERE LOWER(email) = $1
             LIMIT 1`,
            [rawEmail],
        );
        accountRow = lookup.rows[0];
    }

    if (!accountRow) {
        throw new UserMapDomainError(
            "No se encontro la cuenta para asignar como moderadora.",
            404,
        );
    }

    const upserted = await pool.query<MapModeratorRecord>(
        `INSERT INTO map_moderators (account_id, granted_by_account_id, note)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id)
         DO UPDATE SET
             granted_by_account_id = EXCLUDED.granted_by_account_id,
             note = EXCLUDED.note
         RETURNING account_id, granted_by_account_id, note, created_at`,
        [accountRow.id, actorId, note],
    );

    const row = upserted.rows[0];
    return toModeratorSummary({
        account_id: accountRow.id,
        account_name: accountRow.name,
        account_email: accountRow.email,
        granted_by_account_id: row?.granted_by_account_id ?? actorId,
        note: row?.note ?? note,
        created_at: row?.created_at ?? new Date(),
    });
}

export async function revokeMapModerator(
    targetAccountId: string,
): Promise<void> {
    const validId = assertValidUuid(targetAccountId, "accountId");
    const removed = await pool.query(
        `DELETE FROM map_moderators
         WHERE account_id = $1`,
        [validId],
    );

    if ((removed.rowCount ?? 0) === 0) {
        throw new UserMapDomainError(
            "La cuenta indicada no figura como moderadora de mapas.",
            404,
        );
    }
}

export async function createUserMap(
    ownerAccountId: string,
    payload: unknown,
): Promise<UserMapDetails> {
    const ownerId = assertValidUuid(ownerAccountId, "Cuenta autora");
    const rawBody =
        payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : null;

    if (!rawBody) {
        throw new UserMapDomainError("Datos de mapa invalidos.", 400);
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const countResult = await client.query<{ total: number }>(
            `SELECT COUNT(*)::int AS total
             FROM user_maps
             WHERE owner_account_id = $1`,
            [ownerId],
        );
        const authorMapCount = Number(countResult.rows[0]?.total ?? 0);

        const boundsResult = validateBoundsAndQuotas(
            {
                name: rawBody.name,
                description: rawBody.description,
                width: rawBody.width ?? 100,
                height: rawBody.height ?? 100,
                spawn: rawBody.spawn ?? { x: 50, y: 50 },
                mapData: rawBody.mapData,
            },
            { authorMapCount, maxMapsPerAccount: MAX_MAPS_PER_ACCOUNT },
        );

        if (!boundsResult.ok) {
            throw new UserMapDomainError(
                boundsResult.violations[0]?.message ??
                    "El mapa supera los limites permitidos.",
                400,
                {
                    stage: "bounds_and_quotas",
                    violations: boundsResult.violations,
                },
            );
        }

        const { normalized } = boundsResult;
        await assertCustomGraphicsExist(client, normalized.customGraphicIds);

        const inserted = await client.query<UserMapRecord>(
            `INSERT INTO user_maps (
                 owner_account_id,
                 name,
                 description,
                 width,
                 height,
                 spawn_x,
                 spawn_y,
                 map_data,
                 npc_count,
                 object_count,
                 sign_count,
                 state
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, 'draft')
             RETURNING *`,
            [
                ownerId,
                normalized.name,
                normalized.description,
                normalized.width,
                normalized.height,
                normalized.spawn.x,
                normalized.spawn.y,
                JSON.stringify(normalized.mapData),
                normalized.mapData.npcs.length,
                normalized.mapData.objects.length,
                normalized.mapData.signs.length,
            ],
        );

        const createdRow = inserted.rows[0];
        if (!createdRow) {
            throw new Error("No se pudo guardar el borrador del mapa.");
        }

        const hydrated =
            (await fetchMapWithOwnerById(client, createdRow.id)) ?? createdRow;

        await client.query("COMMIT");
        return toUserMapDetails(hydrated);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function updateUserMap(
    mapId: string,
    actorAccountId: string,
    payload: unknown,
): Promise<UserMapDetails> {
    const validMapId = assertValidUuid(mapId, "ID de mapa");
    const actorId = assertValidUuid(actorAccountId, "Cuenta autora");
    const rawBody =
        payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : null;

    if (!rawBody) {
        throw new UserMapDomainError("Datos de actualizacion invalidos.", 400);
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const existing = await fetchMapWithOwnerById(client, validMapId, true);
        if (!existing) {
            throw new UserMapDomainError("Mapa no encontrado.", 404);
        }

        if (existing.owner_account_id !== actorId) {
            throw new UserMapDomainError(
                "No tenes permisos para editar este mapa.",
                403,
            );
        }

        if (!canTransitionUserMapState(existing.state, "edit_reset")) {
            throw new UserMapDomainError(
                `No se puede editar un mapa mientras esta en estado "${existing.state}".`,
                409,
            );
        }

        const mergedInput = {
            name: rawBody.name !== undefined ? rawBody.name : existing.name,
            description:
                rawBody.description !== undefined
                    ? rawBody.description
                    : existing.description,
            width: rawBody.width !== undefined ? rawBody.width : existing.width,
            height:
                rawBody.height !== undefined ? rawBody.height : existing.height,
            spawn:
                rawBody.spawn !== undefined
                    ? rawBody.spawn
                    : { x: existing.spawn_x, y: existing.spawn_y },
            mapData:
                rawBody.mapData !== undefined
                    ? rawBody.mapData
                    : existing.map_data,
        };

        const boundsResult = validateBoundsAndQuotas(mergedInput);
        if (!boundsResult.ok) {
            throw new UserMapDomainError(
                boundsResult.violations[0]?.message ??
                    "El mapa supera los limites permitidos.",
                400,
                {
                    stage: "bounds_and_quotas",
                    violations: boundsResult.violations,
                },
            );
        }

        const { normalized } = boundsResult;
        await assertCustomGraphicsExist(client, normalized.customGraphicIds);

        const previousState = existing.state;
        const updated = await client.query<UserMapRecord>(
            `UPDATE user_maps
             SET name = $2,
                 description = $3,
                 width = $4,
                 height = $5,
                 spawn_x = $6,
                 spawn_y = $7,
                 map_data = $8::jsonb,
                 npc_count = $9,
                 object_count = $10,
                 sign_count = $11,
                 state = 'draft',
                 reviewer_account_id = NULL,
                 rejection_reason = NULL,
                 proposed_at = NULL,
                 published_at = NULL,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [
                validMapId,
                normalized.name,
                normalized.description,
                normalized.width,
                normalized.height,
                normalized.spawn.x,
                normalized.spawn.y,
                JSON.stringify(normalized.mapData),
                normalized.mapData.npcs.length,
                normalized.mapData.objects.length,
                normalized.mapData.signs.length,
            ],
        );

        if (previousState !== "draft") {
            await insertModerationLog(client, {
                mapId: validMapId,
                actorAccountId: actorId,
                action: "edit_reset",
                fromState: previousState,
                toState: "draft",
            });
        }

        const row = updated.rows[0] ?? existing;
        row.owner_name = existing.owner_name;
        row.owner_email = existing.owner_email;

        await client.query("COMMIT");
        return toUserMapDetails(row);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function listPublicPublishedUserMaps(): Promise<UserMapSummary[]> {
    const result = await pool.query<UserMapRecord>(
        `SELECT m.*,
                a.name AS owner_name
         FROM user_maps m
         JOIN accounts a ON a.id = m.owner_account_id
         WHERE m.state = 'published'
         ORDER BY m.published_at DESC NULLS LAST, m.updated_at DESC`,
    );

    return result.rows.map((row) =>
        toUserMapSummary(row, { includeInternalFields: false }),
    );
}

export async function listOwnUserMaps(
    ownerAccountId: string,
): Promise<UserMapSummary[]> {
    const ownerId = assertValidUuid(ownerAccountId, "Cuenta autora");
    const result = await pool.query<UserMapRecord>(
        `SELECT m.*,
                a.name AS owner_name
         FROM user_maps m
         JOIN accounts a ON a.id = m.owner_account_id
         WHERE m.owner_account_id = $1
         ORDER BY m.updated_at DESC`,
        [ownerId],
    );

    return result.rows.map((row) =>
        toUserMapSummary(row, { includeInternalFields: true }),
    );
}

export async function getUserMapForViewer(
    mapId: string,
    viewer: MapViewerContext,
): Promise<UserMapDetails> {
    const validMapId = assertValidUuid(mapId, "ID de mapa");
    const row = await fetchMapWithOwnerById(pool, validMapId, false);

    if (!row) {
        throw new UserMapDomainError("Mapa no encontrado.", 404);
    }

    const isOwner =
        viewer.accountId !== null && row.owner_account_id === viewer.accountId;
    const canSeeUnpublished = isOwner || viewer.isModerator;

    if (row.state !== "published" && !canSeeUnpublished) {
        throw new UserMapDomainError("Mapa no encontrado.", 404);
    }

    return toUserMapDetails(row, {
        includeInternalFields: canSeeUnpublished,
    });
}

export async function proposeUserMap(
    mapId: string,
    actorAccountId: string,
): Promise<{
    map: UserMapDetails;
    checks: {
        stage: "passed";
        diagnostics: AutomatedMapCheckResult["diagnostics"];
    };
}> {
    const validMapId = assertValidUuid(mapId, "ID de mapa");
    const actorId = assertValidUuid(actorAccountId, "Cuenta autora");

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const existing = await fetchMapWithOwnerById(client, validMapId, true);
        if (!existing) {
            throw new UserMapDomainError("Mapa no encontrado.", 404);
        }

        if (existing.owner_account_id !== actorId) {
            throw new UserMapDomainError(
                "Solo el autor puede proponer este mapa para revision.",
                403,
            );
        }

        if (!canTransitionUserMapState(existing.state, "propose")) {
            throw new UserMapDomainError(
                `Solo un mapa en estado "draft" puede proponerse (estado actual: "${existing.state}").`,
                409,
            );
        }

        const otherMapsCountResult = await client.query<{ total: number }>(
            `SELECT COUNT(*)::int AS total
             FROM user_maps
             WHERE owner_account_id = $1
               AND id <> $2`,
            [actorId, validMapId],
        );
        const authorMapCount = Number(otherMapsCountResult.rows[0]?.total ?? 0);

        const rawContent = normalizeStoredMapContent(existing.map_data);
        const candidateNpcIds =
            rawContent.npcs.length <= MAX_NPCS_PER_MAP
                ? rawContent.npcs
                      .map((entry) => entry?.npcId)
                      .filter(
                          (id): id is number =>
                              typeof id === "number" &&
                              Number.isInteger(id) &&
                              id > 0,
                      )
                : [];

        const catalogNpcNames = await fetchCatalogNpcNames(
            client,
            candidateNpcIds,
        );

        const checkResult = runAutomatedMapChecks(
            {
                name: existing.name,
                description: existing.description,
                width: existing.width,
                height: existing.height,
                spawn: { x: existing.spawn_x, y: existing.spawn_y },
                mapData: existing.map_data,
            },
            {
                authorMapCount,
                maxMapsPerAccount: MAX_MAPS_PER_ACCOUNT,
                catalogNpcNames,
            },
        );

        if (!checkResult.ok) {
            throw new UserMapDomainError(
                checkResult.violations[0]?.message ??
                    "El mapa no supero los chequeos automaticos.",
                400,
                {
                    stage: checkResult.stage,
                    violations: checkResult.violations,
                    diagnostics: checkResult.diagnostics,
                },
            );
        }

        await assertCustomGraphicsExist(
            client,
            checkResult.normalized.customGraphicIds,
        );

        const updated = await client.query<UserMapRecord>(
            `UPDATE user_maps
             SET state = 'proposed',
                 reviewer_account_id = NULL,
                 rejection_reason = NULL,
                 proposed_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [validMapId],
        );

        await insertModerationLog(client, {
            mapId: validMapId,
            actorAccountId: actorId,
            action: "propose",
            fromState: existing.state,
            toState: "proposed",
        });

        const row = updated.rows[0] ?? existing;
        row.owner_name = existing.owner_name;
        row.owner_email = existing.owner_email;

        await client.query("COMMIT");
        return {
            map: toUserMapDetails(row),
            checks: {
                stage: "passed",
                diagnostics: checkResult.diagnostics,
            },
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function listModerationQueue(
    stateFilter?: "proposed" | "in_review",
): Promise<UserMapSummary[]> {
    if (
        stateFilter !== undefined &&
        stateFilter !== "proposed" &&
        stateFilter !== "in_review"
    ) {
        throw new UserMapDomainError(
            'El filtro de cola solo admite "proposed" o "in_review".',
            400,
        );
    }

    const states = stateFilter ? [stateFilter] : ["proposed", "in_review"];
    const result = await pool.query<UserMapRecord>(
        `SELECT m.*,
                a.name AS owner_name
         FROM user_maps m
         JOIN accounts a ON a.id = m.owner_account_id
         WHERE m.state = ANY($1::text[])
         ORDER BY m.open_report_count DESC,
                  m.proposed_at ASC NULLS LAST,
                  m.updated_at ASC`,
        [states],
    );

    return result.rows.map((row) =>
        toUserMapSummary(row, { includeInternalFields: true }),
    );
}

export async function getUserMapModerationPreview(
    mapId: string,
): Promise<UserMapModerationPreview> {
    const validMapId = assertValidUuid(mapId, "ID de mapa");
    const row = await fetchMapWithOwnerById(pool, validMapId, false);

    if (!row) {
        throw new UserMapDomainError("Mapa no encontrado.", 404);
    }

    const content = normalizeStoredMapContent(row.map_data);
    const customGraphicIds = Array.from(
        new Set(
            content.tiles
                .map((tile) => tile.grhIndex)
                .filter(
                    (grh): grh is number =>
                        typeof grh === "number" &&
                        Number.isInteger(grh) &&
                        grh >= UPLOADED_GRAPHIC_INDEX_START,
                ),
        ),
    ).sort((left, right) => left - right);

    const graphicsMap = new Map<
        number,
        {
            grh_index: number;
            checksum: string;
            width: number;
            height: number;
            byte_size: number;
            uploaded_by_account_id: string | null;
            created_at: Date;
        }
    >();

    if (customGraphicIds.length > 0) {
        const graphicsResult = await pool.query<{
            grh_index: number;
            checksum: string;
            width: number;
            height: number;
            byte_size: number;
            uploaded_by_account_id: string | null;
            created_at: Date;
        }>(
            `SELECT grh_index,
                    checksum,
                    width,
                    height,
                    byte_size,
                    uploaded_by_account_id,
                    created_at
             FROM game_uploaded_graphics
             WHERE grh_index = ANY($1::int[])`,
            [customGraphicIds],
        );

        for (const graphicRow of graphicsResult.rows) {
            graphicsMap.set(Number(graphicRow.grh_index), graphicRow);
        }
    }

    const graphics: UploadedGraphicPreview[] = customGraphicIds.map(
        (grhIndex) => {
            const found = graphicsMap.get(grhIndex);
            return {
                grhIndex,
                url: `/game-data/graphics/${grhIndex}.png`,
                checksum: found?.checksum ?? null,
                width: found ? Number(found.width) : null,
                height: found ? Number(found.height) : null,
                byteSize: found ? Number(found.byte_size) : null,
                uploadedByAccountId: found?.uploaded_by_account_id ?? null,
                createdAt: toIsoOrNull(found?.created_at),
                missing: !found,
            };
        },
    );

    const candidateNpcIds =
        content.npcs.length <= MAX_NPCS_PER_MAP
            ? content.npcs
                  .map((npc) => npc.npcId)
                  .filter(
                      (id): id is number =>
                          typeof id === "number" &&
                          Number.isInteger(id) &&
                          id > 0,
                  )
            : [];

    const catalogNpcNames = await fetchCatalogNpcNames(pool, candidateNpcIds);

    const checkResult = runAutomatedMapChecks(
        {
            name: row.name,
            description: row.description,
            width: row.width,
            height: row.height,
            spawn: { x: row.spawn_x, y: row.spawn_y },
            mapData: row.map_data,
        },
        { catalogNpcNames },
    );

    const reportsResult = await pool.query<UserMapReportRecord>(
        `SELECT r.*,
                a.name AS reporter_name
         FROM user_map_reports r
         JOIN accounts a ON a.id = r.reporter_account_id
         WHERE r.map_id = $1
         ORDER BY r.status ASC, r.created_at DESC
         LIMIT 50`,
        [validMapId],
    );

    const logsResult = await pool.query<UserMapModerationLogRecord>(
        `SELECT id,
                map_id,
                actor_account_id,
                action,
                from_state,
                to_state,
                reason,
                created_at
         FROM user_map_moderation_logs
         WHERE map_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 50`,
        [validMapId],
    );

    return {
        map: toUserMapDetails(row, { includeInternalFields: true }),
        graphics,
        texts: {
            mapName: row.name,
            description: row.description,
            signs: content.signs.map((sign) => ({
                x: sign.x,
                y: sign.y,
                text: sign.text,
            })),
            npcs: content.npcs.map((npc) => ({
                x: npc.x,
                y: npc.y,
                npcId: npc.npcId,
                catalogName: catalogNpcNames.get(npc.npcId) ?? null,
                customName: npc.name ?? null,
                dialogue: npc.dialogue ?? null,
            })),
        },
        quotas: {
            npcs: { used: content.npcs.length, max: MAX_NPCS_PER_MAP },
            objects: { used: content.objects.length, max: MAX_OBJECTS_PER_MAP },
            signs: { used: content.signs.length, max: MAX_SIGNS_PER_MAP },
            exits: { used: content.exits.length, max: MAX_EXITS_PER_MAP },
            teleports: {
                used: content.teleports.length,
                max: MAX_TELEPORTS_PER_MAP,
            },
            customGraphics: {
                used: customGraphicIds.length,
                max: MAX_CUSTOM_GRAPHICS_PER_MAP,
            },
        },
        automatedChecks: {
            ok: checkResult.ok,
            stage: checkResult.stage,
            violations: checkResult.violations,
            diagnostics: checkResult.diagnostics,
        },
        reports: reportsResult.rows.map(toReportSummary),
        moderationLogs: logsResult.rows.map(toModerationLogSummary),
    };
}

export async function startUserMapReview(
    mapId: string,
    moderatorAccountId: string,
): Promise<UserMapDetails> {
    const validMapId = assertValidUuid(mapId, "ID de mapa");
    const moderatorId = assertValidUuid(
        moderatorAccountId,
        "Cuenta moderadora",
    );

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const existing = await fetchMapWithOwnerById(client, validMapId, true);
        if (!existing) {
            throw new UserMapDomainError("Mapa no encontrado.", 404);
        }

        if (existing.owner_account_id === moderatorId) {
            throw new UserMapDomainError(
                "El autor no puede moderar su propio mapa.",
                403,
            );
        }

        if (!canTransitionUserMapState(existing.state, "start_review")) {
            const detailMessage =
                existing.state === "in_review"
                    ? "El mapa ya fue tomado en revision por un moderador."
                    : `El mapa no puede pasar a revision desde el estado "${existing.state}".`;
            throw new UserMapDomainError(detailMessage, 409);
        }

        const updated = await client.query<UserMapRecord>(
            `UPDATE user_maps
             SET state = 'in_review',
                 reviewer_account_id = $2,
                 updated_at = NOW()
             WHERE id = $1
               AND state = 'proposed'
             RETURNING *`,
            [validMapId, moderatorId],
        );

        const row = updated.rows[0];
        if (!row) {
            throw new UserMapDomainError(
                "El mapa ya fue tomado en revision por otro moderador.",
                409,
            );
        }

        await insertModerationLog(client, {
            mapId: validMapId,
            actorAccountId: moderatorId,
            action: "start_review",
            fromState: existing.state,
            toState: "in_review",
        });

        row.owner_name = existing.owner_name;
        row.owner_email = existing.owner_email;

        await client.query("COMMIT");
        return toUserMapDetails(row);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function approveUserMap(
    mapId: string,
    moderatorAccountId: string,
    isRootAdmin = false,
): Promise<UserMapDetails> {
    const validMapId = assertValidUuid(mapId, "ID de mapa");
    const moderatorId = assertValidUuid(
        moderatorAccountId,
        "Cuenta moderadora",
    );

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const existing = await fetchMapWithOwnerById(client, validMapId, true);
        if (!existing) {
            throw new UserMapDomainError("Mapa no encontrado.", 404);
        }

        if (existing.owner_account_id === moderatorId) {
            throw new UserMapDomainError(
                "El autor no puede aprobar su propio mapa.",
                403,
            );
        }

        if (!canTransitionUserMapState(existing.state, "approve")) {
            throw new UserMapDomainError(
                `El mapa debe estar en estado "in_review" para aprobarse (estado actual: "${existing.state}").`,
                409,
            );
        }

        if (
            existing.reviewer_account_id &&
            existing.reviewer_account_id !== moderatorId &&
            !isRootAdmin
        ) {
            throw new UserMapDomainError(
                "Este mapa esta asignado a otro moderador en revision.",
                409,
            );
        }

        const rawContent = normalizeStoredMapContent(existing.map_data);
        const candidateNpcIds =
            rawContent.npcs.length <= MAX_NPCS_PER_MAP
                ? rawContent.npcs
                      .map((npc) => npc.npcId)
                      .filter(
                          (id): id is number =>
                              typeof id === "number" &&
                              Number.isInteger(id) &&
                              id > 0,
                      )
                : [];
        const catalogNpcNames = await fetchCatalogNpcNames(
            client,
            candidateNpcIds,
        );

        const checkResult = runAutomatedMapChecks(
            {
                name: existing.name,
                description: existing.description,
                width: existing.width,
                height: existing.height,
                spawn: { x: existing.spawn_x, y: existing.spawn_y },
                mapData: existing.map_data,
            },
            { catalogNpcNames },
        );

        if (!checkResult.ok) {
            throw new UserMapDomainError(
                checkResult.violations[0]?.message ??
                    "El mapa no cumple las validaciones obligatorias para publicarse.",
                400,
                {
                    stage: checkResult.stage,
                    violations: checkResult.violations,
                    diagnostics: checkResult.diagnostics,
                },
            );
        }

        await assertCustomGraphicsExist(
            client,
            checkResult.normalized.customGraphicIds,
        );

        const updated = await client.query<UserMapRecord>(
            `UPDATE user_maps
             SET state = 'published',
                 reviewer_account_id = $2,
                 rejection_reason = NULL,
                 open_report_count = 0,
                 reviewed_at = NOW(),
                 published_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [validMapId, moderatorId],
        );

        await client.query(
            `UPDATE user_map_reports
             SET status = 'resolved',
                 resolved_by_account_id = $2,
                 resolved_at = NOW()
             WHERE map_id = $1
               AND status = 'open'`,
            [validMapId, moderatorId],
        );

        await insertModerationLog(client, {
            mapId: validMapId,
            actorAccountId: moderatorId,
            action: "approve",
            fromState: existing.state,
            toState: "published",
        });

        const row = updated.rows[0] ?? existing;
        row.owner_name = existing.owner_name;
        row.owner_email = existing.owner_email;

        await client.query("COMMIT");
        return toUserMapDetails(row);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function rejectUserMap(
    mapId: string,
    moderatorAccountId: string,
    rawReason: unknown,
    isRootAdmin = false,
): Promise<UserMapDetails> {
    const validMapId = assertValidUuid(mapId, "ID de mapa");
    const moderatorId = assertValidUuid(
        moderatorAccountId,
        "Cuenta moderadora",
    );

    const trimmedReason =
        typeof rawReason === "string" ? rawReason.trim() : "";
    if (!trimmedReason) {
        throw new UserMapDomainError(
            "Debes indicar un motivo de rechazo obligatorio.",
            400,
        );
    }
    if (trimmedReason.length > MAX_MODERATION_REASON_LENGTH) {
        throw new UserMapDomainError(
            `El motivo de rechazo no puede superar los ${MAX_MODERATION_REASON_LENGTH} caracteres.`,
            400,
        );
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const existing = await fetchMapWithOwnerById(client, validMapId, true);
        if (!existing) {
            throw new UserMapDomainError("Mapa no encontrado.", 404);
        }

        if (existing.owner_account_id === moderatorId) {
            throw new UserMapDomainError(
                "El autor no puede moderar su propio mapa.",
                403,
            );
        }

        if (!canTransitionUserMapState(existing.state, "reject")) {
            throw new UserMapDomainError(
                `El mapa debe estar en estado "in_review" para rechazarse (estado actual: "${existing.state}").`,
                409,
            );
        }

        if (
            existing.reviewer_account_id &&
            existing.reviewer_account_id !== moderatorId &&
            !isRootAdmin
        ) {
            throw new UserMapDomainError(
                "Este mapa esta asignado a otro moderador en revision.",
                409,
            );
        }

        const updated = await client.query<UserMapRecord>(
            `UPDATE user_maps
             SET state = 'rejected',
                 reviewer_account_id = $2,
                 rejection_reason = $3,
                 open_report_count = 0,
                 reviewed_at = NOW(),
                 published_at = NULL,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [validMapId, moderatorId, trimmedReason],
        );

        await client.query(
            `UPDATE user_map_reports
             SET status = 'resolved',
                 resolved_by_account_id = $2,
                 resolved_at = NOW()
             WHERE map_id = $1
               AND status = 'open'`,
            [validMapId, moderatorId],
        );

        await insertModerationLog(client, {
            mapId: validMapId,
            actorAccountId: moderatorId,
            action: "reject",
            fromState: existing.state,
            toState: "rejected",
            reason: trimmedReason,
        });

        const row = updated.rows[0] ?? existing;
        row.owner_name = existing.owner_name;
        row.owner_email = existing.owner_email;

        await client.query("COMMIT");
        return toUserMapDetails(row);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function reportPublishedUserMap(
    mapId: string,
    reporterAccountId: string,
    rawReason: unknown,
): Promise<{
    map: UserMapDetails;
    report: UserMapReportSummary;
}> {
    const validMapId = assertValidUuid(mapId, "ID de mapa");
    const reporterId = assertValidUuid(
        reporterAccountId,
        "Cuenta reportante",
    );

    const trimmedReason =
        typeof rawReason === "string" ? rawReason.trim() : "";
    if (!trimmedReason) {
        throw new UserMapDomainError(
            "Debes explicar el motivo del reporte.",
            400,
        );
    }
    if (trimmedReason.length > MAX_MODERATION_REASON_LENGTH) {
        throw new UserMapDomainError(
            `El motivo del reporte no puede superar los ${MAX_MODERATION_REASON_LENGTH} caracteres.`,
            400,
        );
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const existing = await fetchMapWithOwnerById(client, validMapId, true);
        if (!existing) {
            throw new UserMapDomainError("Mapa no encontrado.", 404);
        }

        if (!canTransitionUserMapState(existing.state, "report")) {
            throw new UserMapDomainError(
                "Solo se pueden reportar mapas actualmente publicados.",
                409,
            );
        }

        if (existing.owner_account_id === reporterId) {
            throw new UserMapDomainError(
                "No podes reportar tu propio mapa.",
                400,
            );
        }

        const duplicateCheck = await client.query<{ id: string }>(
            `SELECT id
             FROM user_map_reports
             WHERE map_id = $1
               AND reporter_account_id = $2
               AND status = 'open'
             LIMIT 1`,
            [validMapId, reporterId],
        );

        if ((duplicateCheck.rowCount ?? duplicateCheck.rows.length) > 0) {
            throw new UserMapDomainError(
                "Ya tenes un reporte abierto sobre este mapa.",
                409,
            );
        }

        const reportInsert = await client.query<UserMapReportRecord>(
            `INSERT INTO user_map_reports (map_id, reporter_account_id, reason, status)
             VALUES ($1, $2, $3, 'open')
             RETURNING *`,
            [validMapId, reporterId, trimmedReason],
        );

        const updated = await client.query<UserMapRecord>(
            `UPDATE user_maps
             SET state = 'proposed',
                 reviewer_account_id = NULL,
                 published_at = NULL,
                 open_report_count = open_report_count + 1,
                 proposed_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [validMapId],
        );

        await insertModerationLog(client, {
            mapId: validMapId,
            actorAccountId: reporterId,
            action: "report",
            fromState: existing.state,
            toState: "proposed",
            reason: trimmedReason,
        });

        const mapRow = updated.rows[0] ?? existing;
        mapRow.owner_name = existing.owner_name;
        mapRow.owner_email = existing.owner_email;

        const reportRow = reportInsert.rows[0];
        if (!reportRow) {
            throw new Error("No se pudo registrar el reporte.");
        }

        await client.query("COMMIT");
        return {
            map: toUserMapDetails(mapRow, { includeInternalFields: false }),
            report: toReportSummary(reportRow),
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function unpublishUserMap(
    mapId: string,
    moderatorAccountId: string,
    rawReason?: unknown,
): Promise<UserMapDetails> {
    const validMapId = assertValidUuid(mapId, "ID de mapa");
    const moderatorId = assertValidUuid(
        moderatorAccountId,
        "Cuenta moderadora",
    );

    const trimmedReason =
        typeof rawReason === "string" && rawReason.trim().length > 0
            ? rawReason.trim()
            : "Despublicado de emergencia por moderacion.";

    if (trimmedReason.length > MAX_MODERATION_REASON_LENGTH) {
        throw new UserMapDomainError(
            `El motivo de despublicacion no puede superar los ${MAX_MODERATION_REASON_LENGTH} caracteres.`,
            400,
        );
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const existing = await fetchMapWithOwnerById(client, validMapId, true);
        if (!existing) {
            throw new UserMapDomainError("Mapa no encontrado.", 404);
        }

        if (!canTransitionUserMapState(existing.state, "unpublish")) {
            throw new UserMapDomainError(
                `Solo se puede despublicar un mapa en estado "published" (estado actual: "${existing.state}").`,
                409,
            );
        }

        const updated = await client.query<UserMapRecord>(
            `UPDATE user_maps
             SET state = 'unpublished',
                 reviewer_account_id = $2,
                 rejection_reason = $3,
                 open_report_count = 0,
                 reviewed_at = NOW(),
                 published_at = NULL,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [validMapId, moderatorId, trimmedReason],
        );

        await client.query(
            `UPDATE user_map_reports
             SET status = 'resolved',
                 resolved_by_account_id = $2,
                 resolved_at = NOW()
             WHERE map_id = $1
               AND status = 'open'`,
            [validMapId, moderatorId],
        );

        await insertModerationLog(client, {
            mapId: validMapId,
            actorAccountId: moderatorId,
            action: "unpublish",
            fromState: existing.state,
            toState: "unpublished",
            reason: trimmedReason,
        });

        const row = updated.rows[0] ?? existing;
        row.owner_name = existing.owner_name;
        row.owner_email = existing.owner_email;

        await client.query("COMMIT");
        return toUserMapDetails(row);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}
