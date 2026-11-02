import crypto from "crypto";
import { z } from "zod";
import config from "../config";
import pool from "../db";
import { validatePngUpload } from "../lib/pngValidation";
import {
    buildUserMapClientData,
    type ClientMapData,
    isUserMapId,
    USER_MAP_GRID_SIZE,
    USER_MAP_ID_END,
    USER_MAP_ID_START,
    USER_MAP_STATUSES,
    type UserMapCatalogLookup,
    type UserMapExitPlacement,
    userMapExitPlacementSchema,
    type UserMapNpcPlacement,
    userMapNpcPlacementSchema,
    type UserMapObjectPlacement,
    userMapObjectPlacementSchema,
    type UserMapStatus,
    type UserMapTileEntry,
    userMapTileSchema,
    validateUserMapContent,
} from "../lib/userMapIsolation";
import {
    UPLOADED_GRAPHIC_INDEX_START,
    type UploadedGraphic,
} from "./worldBuilder";

export type QueryResultLike<TRow> = {
    rows: TRow[];
    rowCount?: number | null;
};

export type DbClientLike = {
    query: <TRow = Record<string, unknown>>(
        text: string,
        values?: unknown[],
    ) => Promise<QueryResultLike<TRow>>;
    release: () => void;
};

export type DbPoolLike = {
    query: <TRow = Record<string, unknown>>(
        text: string,
        values?: unknown[],
    ) => Promise<QueryResultLike<TRow>>;
    connect: () => Promise<DbClientLike>;
};

export type UserMapQuotasConfig = {
    maxMapsPerAccount: number;
    maxUploadBytesPerAccount: number;
    maxNpcsPerMap: number;
    maxObjectsPerMap: number;
};

export function getDefaultUserMapQuotas(): UserMapQuotasConfig {
    return {
        maxMapsPerAccount: config.userMapMaxMapsPerAccount,
        maxUploadBytesPerAccount: config.userMapMaxUploadBytesPerAccount,
        maxNpcsPerMap: config.userMapMaxNpcsPerMap,
        maxObjectsPerMap: config.userMapMaxObjectsPerMap,
    };
}

export class UserMapError extends Error {
    readonly statusCode: number;
    readonly code: string;

    constructor(message: string, statusCode: number, code: string) {
        super(message);
        this.name = "UserMapError";
        this.statusCode = statusCode;
        this.code = code;
    }
}

export const createUserMapSchema = z.object({
    name: z
        .string()
        .trim()
        .min(1, "El nombre del mapa es obligatorio.")
        .max(80, "El nombre del mapa no puede superar los 80 caracteres."),
    description: z
        .string()
        .trim()
        .max(500, "La descripción no puede superar los 500 caracteres.")
        .optional()
        .default(""),
    entryX: z.coerce
        .number()
        .int()
        .min(1)
        .max(USER_MAP_GRID_SIZE)
        .optional()
        .default(50),
    entryY: z.coerce
        .number()
        .int()
        .min(1)
        .max(USER_MAP_GRID_SIZE)
        .optional()
        .default(50),
    combatEnabled: z.boolean().optional(),
    tiles: z.array(userMapTileSchema).max(10_000).optional().default([]),
    objects: z
        .array(userMapObjectPlacementSchema)
        .max(2_000)
        .optional()
        .default([]),
    npcs: z.array(userMapNpcPlacementSchema).max(2_000).optional().default([]),
    exits: z.array(userMapExitPlacementSchema).max(500).optional().default([]),
});

export const updateUserMapSchema = z.object({
    name: z
        .string()
        .trim()
        .min(1, "El nombre del mapa es obligatorio.")
        .max(80, "El nombre del mapa no puede superar los 80 caracteres.")
        .optional(),
    description: z
        .string()
        .trim()
        .max(500, "La descripción no puede superar los 500 caracteres.")
        .optional(),
    entryX: z.coerce.number().int().min(1).max(USER_MAP_GRID_SIZE).optional(),
    entryY: z.coerce.number().int().min(1).max(USER_MAP_GRID_SIZE).optional(),
    combatEnabled: z.boolean().optional(),
    tiles: z.array(userMapTileSchema).max(10_000).optional(),
    objects: z.array(userMapObjectPlacementSchema).max(2_000).optional(),
    npcs: z.array(userMapNpcPlacementSchema).max(2_000).optional(),
    exits: z.array(userMapExitPlacementSchema).max(500).optional(),
});

export const transitionUserMapStatusSchema = z.object({
    status: z.enum(USER_MAP_STATUSES),
});

type UserMapRow = {
    map_num: number;
    owner_account_id: string;
    name: string;
    description: string;
    status: UserMapStatus;
    combat_enabled: boolean;
    entry_x: number;
    entry_y: number;
    tiles: UserMapTileEntry[];
    objects: UserMapObjectPlacement[];
    npcs: UserMapNpcPlacement[];
    exits: UserMapExitPlacement[];
    npc_count: number;
    object_count: number;
    created_at: Date | string;
    updated_at: Date | string;
};

export type UserMapRecord = {
    mapNum: number;
    ownerAccountId: string;
    name: string;
    description: string;
    status: UserMapStatus;
    combatEnabled: false;
    entryX: number;
    entryY: number;
    tiles: UserMapTileEntry[];
    objects: UserMapObjectPlacement[];
    npcs: UserMapNpcPlacement[];
    exits: UserMapExitPlacement[];
    npcCount: number;
    objectCount: number;
    createdAt: string;
    updatedAt: string;
};

export type UserMapSummary = {
    mapNum: number;
    ownerAccountId: string;
    name: string;
    description: string;
    status: UserMapStatus;
    combatEnabled: false;
    entryX: number;
    entryY: number;
    npcCount: number;
    objectCount: number;
    createdAt: string;
    updatedAt: string;
};

export type UserMapDependencies = {
    db?: DbPoolLike;
    quotas?: Partial<UserMapQuotasConfig>;
    catalog?: UserMapCatalogLookup;
};

function toIsoTimestamp(value: Date | string): string {
    return value instanceof Date
        ? value.toISOString()
        : new Date(value).toISOString();
}

function mapRowToRecord(row: UserMapRow): UserMapRecord {
    return {
        mapNum: Number(row.map_num),
        ownerAccountId: row.owner_account_id,
        name: row.name,
        description: row.description ?? "",
        status: row.status,
        combatEnabled: false,
        entryX: Number(row.entry_x),
        entryY: Number(row.entry_y),
        tiles: Array.isArray(row.tiles) ? row.tiles : [],
        objects: Array.isArray(row.objects) ? row.objects : [],
        npcs: Array.isArray(row.npcs) ? row.npcs : [],
        exits: Array.isArray(row.exits) ? row.exits : [],
        npcCount: Number(row.npc_count),
        objectCount: Number(row.object_count),
        createdAt: toIsoTimestamp(row.created_at),
        updatedAt: toIsoTimestamp(row.updated_at),
    };
}

function mapRowToSummary(row: UserMapRow): UserMapSummary {
    return {
        mapNum: Number(row.map_num),
        ownerAccountId: row.owner_account_id,
        name: row.name,
        description: row.description ?? "",
        status: row.status,
        combatEnabled: false,
        entryX: Number(row.entry_x),
        entryY: Number(row.entry_y),
        npcCount: Number(row.npc_count),
        objectCount: Number(row.object_count),
        createdAt: toIsoTimestamp(row.created_at),
        updatedAt: toIsoTimestamp(row.updated_at),
    };
}

function resolveQuotas(
    overrides?: Partial<UserMapQuotasConfig>,
): UserMapQuotasConfig {
    return {
        ...getDefaultUserMapQuotas(),
        ...overrides,
    };
}

function assertValidUserMapNumber(mapNum: number): void {
    if (!isUserMapId(mapNum)) {
        throw new UserMapError(
            `El número de mapa debe pertenecer al rango reservado de mapas de usuario (${USER_MAP_ID_START}..${USER_MAP_ID_END}).`,
            400,
            "INVALID_USER_MAP_RANGE",
        );
    }
}

async function lockAccountForQuotaCheck(
    client: DbClientLike,
    accountId: string,
): Promise<void> {
    const locked = await client.query<{ id: string }>(
        "SELECT id FROM accounts WHERE id = $1 FOR UPDATE",
        [accountId],
    );

    if (!locked.rows[0]) {
        throw new UserMapError(
            "La cuenta solicitante no existe o fue eliminada.",
            404,
            "ACCOUNT_NOT_FOUND",
        );
    }
}

async function assertReferencedUploadedGraphicsFitQuota(
    client: DbClientLike,
    accountId: string,
    tiles: UserMapTileEntry[],
    maxUploadBytesPerAccount: number,
): Promise<void> {
    const uploadedGrhIds = Array.from(
        new Set(
            tiles
                .map((tile) => tile.grhIndex)
                .filter(
                    (grh): grh is number =>
                        typeof grh === "number" &&
                        grh >= UPLOADED_GRAPHIC_INDEX_START,
                ),
        ),
    );

    const accountBytesResult = await client.query<{ total_bytes: string | number }>(
        `SELECT COALESCE(SUM(byte_size), 0) AS total_bytes
         FROM game_uploaded_graphics
         WHERE uploaded_by_account_id = $1`,
        [accountId],
    );

    const accountUploadedBytes = Number(
        accountBytesResult.rows[0]?.total_bytes ?? 0,
    );

    if (accountUploadedBytes > maxUploadBytesPerAccount) {
        throw new UserMapError(
            `Superaste la cuota máxima de peso total de assets subidos por cuenta (${maxUploadBytesPerAccount} bytes). Uso actual: ${accountUploadedBytes} bytes.`,
            409,
            "QUOTA_EXCEEDED",
        );
    }

    if (uploadedGrhIds.length === 0) {
        return;
    }

    const referencedResult = await client.query<{
        found_count: string | number;
        referenced_bytes: string | number;
    }>(
        `SELECT COUNT(*) AS found_count, COALESCE(SUM(byte_size), 0) AS referenced_bytes
         FROM game_uploaded_graphics
         WHERE grh_index = ANY($1::int[])`,
        [uploadedGrhIds],
    );

    const foundCount = Number(referencedResult.rows[0]?.found_count ?? 0);
    if (foundCount !== uploadedGrhIds.length) {
        throw new UserMapError(
            "Uno o más gráficos personalizados referenciados en el mapa no existen.",
            400,
            "UNKNOWN_UPLOADED_GRAPHIC",
        );
    }

    const referencedBytes = Number(
        referencedResult.rows[0]?.referenced_bytes ?? 0,
    );
    if (referencedBytes > maxUploadBytesPerAccount) {
        throw new UserMapError(
            `El peso de los gráficos personalizados usados en el mapa (${referencedBytes} bytes) supera la cuota máxima por cuenta (${maxUploadBytesPerAccount} bytes).`,
            409,
            "QUOTA_EXCEEDED",
        );
    }
}

export async function createUserMap(
    ownerAccountId: string,
    rawInput: unknown,
    deps: UserMapDependencies = {},
): Promise<UserMapRecord> {
    const parsed = createUserMapSchema.safeParse(rawInput);
    if (!parsed.success) {
        throw new UserMapError(
            parsed.error.issues[0]?.message ?? "Datos de mapa inválidos.",
            400,
            "INVALID_PAYLOAD",
        );
    }

    const quotas = resolveQuotas(deps.quotas);
    const input = parsed.data;
    const contentCheck = validateUserMapContent(
        {
            combatEnabled: input.combatEnabled,
            tiles: input.tiles,
            objects: input.objects,
            npcs: input.npcs,
            exits: input.exits,
        },
        {
            maxNpcsPerMap: quotas.maxNpcsPerMap,
            maxObjectsPerMap: quotas.maxObjectsPerMap,
            catalog: deps.catalog,
        },
    );

    if (!contentCheck.ok) {
        throw new UserMapError(
            contentCheck.reason,
            contentCheck.code === "QUOTA_EXCEEDED" ? 409 : 400,
            contentCheck.code,
        );
    }

    const db = (deps.db ?? pool) as DbPoolLike;
    const client = await db.connect();

    try {
        await client.query("BEGIN");
        await lockAccountForQuotaCheck(client, ownerAccountId);

        const countResult = await client.query<{ map_count: string | number }>(
            `SELECT COUNT(*) AS map_count
             FROM game_user_maps
             WHERE owner_account_id = $1
               AND status <> 'archived'`,
            [ownerAccountId],
        );

        const currentMapCount = Number(countResult.rows[0]?.map_count ?? 0);
        if (currentMapCount >= quotas.maxMapsPerAccount) {
            throw new UserMapError(
                `Alcanzaste el límite máximo de mapas por cuenta (${quotas.maxMapsPerAccount}). Archivá o eliminá un borrador antes de crear otro.`,
                409,
                "QUOTA_EXCEEDED",
            );
        }

        await assertReferencedUploadedGraphicsFitQuota(
            client,
            ownerAccountId,
            input.tiles,
            quotas.maxUploadBytesPerAccount,
        );

        await client.query(
            "LOCK TABLE game_user_maps IN SHARE ROW EXCLUSIVE MODE",
        );

        const nextIdResult = await client.query<{ next_map_num: number }>(
            `SELECT COALESCE(MAX(map_num), $1 - 1) + 1 AS next_map_num
             FROM game_user_maps`,
            [USER_MAP_ID_START],
        );

        const mapNum = Number(
            nextIdResult.rows[0]?.next_map_num ?? USER_MAP_ID_START,
        );

        if (mapNum > USER_MAP_ID_END) {
            throw new UserMapError(
                `El rango reservado de mapas de usuario (${USER_MAP_ID_START}..${USER_MAP_ID_END}) está agotado.`,
                409,
                "RANGE_EXHAUSTED",
            );
        }

        const inserted = await client.query<UserMapRow>(
            `INSERT INTO game_user_maps (
                 map_num,
                 owner_account_id,
                 name,
                 description,
                 status,
                 combat_enabled,
                 entry_x,
                 entry_y,
                 tiles,
                 objects,
                 npcs,
                 exits,
                 npc_count,
                 object_count
             )
             VALUES ($1, $2, $3, $4, 'draft', FALSE, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12)
             RETURNING *`,
            [
                mapNum,
                ownerAccountId,
                input.name,
                input.description,
                input.entryX,
                input.entryY,
                JSON.stringify(input.tiles),
                JSON.stringify(input.objects),
                JSON.stringify(input.npcs),
                JSON.stringify(input.exits),
                input.npcs.length,
                input.objects.length,
            ],
        );

        await client.query("COMMIT");
        return mapRowToRecord(inserted.rows[0]!);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function updateUserMap(
    mapNum: number,
    actorAccountId: string,
    rawInput: unknown,
    deps: UserMapDependencies = {},
): Promise<UserMapRecord> {
    assertValidUserMapNumber(mapNum);

    const parsed = updateUserMapSchema.safeParse(rawInput);
    if (!parsed.success) {
        throw new UserMapError(
            parsed.error.issues[0]?.message ?? "Datos de edición inválidos.",
            400,
            "INVALID_PAYLOAD",
        );
    }

    const quotas = resolveQuotas(deps.quotas);
    const input = parsed.data;
    const db = (deps.db ?? pool) as DbPoolLike;
    const client = await db.connect();

    try {
        await client.query("BEGIN");
        await lockAccountForQuotaCheck(client, actorAccountId);

        const existingResult = await client.query<UserMapRow>(
            "SELECT * FROM game_user_maps WHERE map_num = $1 FOR UPDATE",
            [mapNum],
        );

        const existing = existingResult.rows[0];
        if (!existing) {
            throw new UserMapError(
                `El mapa de usuario #${mapNum} no existe.`,
                404,
                "MAP_NOT_FOUND",
            );
        }

        if (existing.owner_account_id !== actorAccountId) {
            throw new UserMapError(
                "No tenés permiso para editar un mapa que pertenece a otra cuenta.",
                403,
                "FORBIDDEN_NOT_OWNER",
            );
        }

        const nextTiles = input.tiles ?? existing.tiles ?? [];
        const nextObjects = input.objects ?? existing.objects ?? [];
        const nextNpcs = input.npcs ?? existing.npcs ?? [];
        const nextExits = input.exits ?? existing.exits ?? [];

        const contentCheck = validateUserMapContent(
            {
                combatEnabled: input.combatEnabled,
                tiles: nextTiles,
                objects: nextObjects,
                npcs: nextNpcs,
                exits: nextExits,
            },
            {
                maxNpcsPerMap: quotas.maxNpcsPerMap,
                maxObjectsPerMap: quotas.maxObjectsPerMap,
                catalog: deps.catalog,
            },
        );

        if (!contentCheck.ok) {
            throw new UserMapError(
                contentCheck.reason,
                contentCheck.code === "QUOTA_EXCEEDED" ? 409 : 400,
                contentCheck.code,
            );
        }

        await assertReferencedUploadedGraphicsFitQuota(
            client,
            actorAccountId,
            nextTiles,
            quotas.maxUploadBytesPerAccount,
        );

        // Si el mapa estaba publicado o propuesto y el dueño lo edita, vuelve a
        // borrador para no alterar lo visible sin pasar nuevamente por revision.
        const nextStatus: UserMapStatus =
            existing.status === "published" || existing.status === "proposed"
                ? "draft"
                : existing.status;

        const updated = await client.query<UserMapRow>(
            `UPDATE game_user_maps
             SET name = $2,
                 description = $3,
                 entry_x = $4,
                 entry_y = $5,
                 tiles = $6::jsonb,
                 objects = $7::jsonb,
                 npcs = $8::jsonb,
                 exits = $9::jsonb,
                 npc_count = $10,
                 object_count = $11,
                 status = $12,
                 updated_at = NOW()
             WHERE map_num = $1
             RETURNING *`,
            [
                mapNum,
                input.name ?? existing.name,
                input.description ?? existing.description,
                input.entryX ?? existing.entry_x,
                input.entryY ?? existing.entry_y,
                JSON.stringify(nextTiles),
                JSON.stringify(nextObjects),
                JSON.stringify(nextNpcs),
                JSON.stringify(nextExits),
                nextNpcs.length,
                nextObjects.length,
                nextStatus,
            ],
        );

        await client.query("COMMIT");
        return mapRowToRecord(updated.rows[0]!);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function transitionUserMapStatus(
    mapNum: number,
    actorAccountId: string,
    targetStatus: UserMapStatus,
    options: {
        isAdmin?: boolean;
        deps?: UserMapDependencies;
    } = {},
): Promise<UserMapRecord> {
    assertValidUserMapNumber(mapNum);

    const quotas = resolveQuotas(options.deps?.quotas);
    const db = (options.deps?.db ?? pool) as DbPoolLike;
    const client = await db.connect();

    try {
        await client.query("BEGIN");

        const existingResult = await client.query<UserMapRow>(
            "SELECT * FROM game_user_maps WHERE map_num = $1 FOR UPDATE",
            [mapNum],
        );

        const existing = existingResult.rows[0];
        if (!existing) {
            throw new UserMapError(
                `El mapa de usuario #${mapNum} no existe.`,
                404,
                "MAP_NOT_FOUND",
            );
        }

        const isOwner = existing.owner_account_id === actorAccountId;
        const isAdmin = Boolean(options.isAdmin);

        if (!isOwner && !isAdmin) {
            throw new UserMapError(
                "No tenés permiso para cambiar el estado de un mapa ajeno.",
                403,
                "FORBIDDEN_NOT_OWNER",
            );
        }

        if (targetStatus === "published" && !isAdmin) {
            throw new UserMapError(
                "Sólo moderación puede publicar un mapa de usuario propuesto.",
                403,
                "FORBIDDEN_PUBLISH_REQUIRES_ADMIN",
            );
        }

        if (
            existing.status === "archived" &&
            targetStatus !== "archived"
        ) {
            await lockAccountForQuotaCheck(client, existing.owner_account_id);
            const activeCountResult = await client.query<{
                map_count: string | number;
            }>(
                `SELECT COUNT(*) AS map_count
                 FROM game_user_maps
                 WHERE owner_account_id = $1
                   AND status <> 'archived'`,
                [existing.owner_account_id],
            );
            const activeMaps = Number(
                activeCountResult.rows[0]?.map_count ?? 0,
            );
            if (activeMaps >= quotas.maxMapsPerAccount) {
                throw new UserMapError(
                    `No se puede reactivar el mapa porque la cuenta ya alcanzó el límite de ${quotas.maxMapsPerAccount} mapas activos.`,
                    409,
                    "QUOTA_EXCEEDED",
                );
            }
        }

        const updated = await client.query<UserMapRow>(
            `UPDATE game_user_maps
             SET status = $2,
                 updated_at = NOW()
             WHERE map_num = $1
             RETURNING *`,
            [mapNum, targetStatus],
        );

        await client.query("COMMIT");
        return mapRowToRecord(updated.rows[0]!);
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function uploadUserMapGraphic(
    buffer: Buffer,
    accountId: string,
    deps: UserMapDependencies = {},
): Promise<{
    graphic: UploadedGraphic;
    deduped: boolean;
    totalAccountUploadBytes: number;
}> {
    const validation = validatePngUpload(buffer);
    if (!validation.ok) {
        throw new UserMapError(validation.reason, 400, "INVALID_PNG");
    }

    const quotas = resolveQuotas(deps.quotas);
    const checksum = crypto
        .createHash("sha256")
        .update(validation.content)
        .digest("hex");

    const db = (deps.db ?? pool) as DbPoolLike;
    const client = await db.connect();

    try {
        await client.query("BEGIN");
        await lockAccountForQuotaCheck(client, accountId);

        const usageResult = await client.query<{ total_bytes: string | number }>(
            `SELECT COALESCE(SUM(byte_size), 0) AS total_bytes
             FROM game_uploaded_graphics
             WHERE uploaded_by_account_id = $1`,
            [accountId],
        );
        const currentBytes = Number(usageResult.rows[0]?.total_bytes ?? 0);

        const existingResult = await client.query<{
            grh_index: number;
            checksum: string;
            width: number;
            height: number;
            byte_size: number;
            created_at: Date | string;
        }>(
            `SELECT grh_index, checksum, width, height, byte_size, created_at
             FROM game_uploaded_graphics
             WHERE checksum = $1
             LIMIT 1`,
            [checksum],
        );

        const existingRow = existingResult.rows[0];
        if (existingRow) {
            await client.query("COMMIT");
            return {
                deduped: true,
                totalAccountUploadBytes: currentBytes,
                graphic: {
                    grhIndex: Number(existingRow.grh_index),
                    checksum: existingRow.checksum,
                    width: Number(existingRow.width),
                    height: Number(existingRow.height),
                    byteSize: Number(existingRow.byte_size),
                    createdAt: toIsoTimestamp(existingRow.created_at),
                },
            };
        }

        const projectedBytes = currentBytes + validation.byteSize;
        if (projectedBytes > quotas.maxUploadBytesPerAccount) {
            throw new UserMapError(
                `Superaste la cuota máxima de peso total de assets subidos por cuenta (${quotas.maxUploadBytesPerAccount} bytes). Uso actual: ${currentBytes} bytes; este PNG requiere ${validation.byteSize} bytes.`,
                409,
                "QUOTA_EXCEEDED",
            );
        }

        await client.query(
            "LOCK TABLE game_uploaded_graphics IN SHARE ROW EXCLUSIVE MODE",
        );

        const nextResult = await client.query<{ next_index: number }>(
            `SELECT COALESCE(MAX(grh_index), $1 - 1) + 1 AS next_index
             FROM game_uploaded_graphics`,
            [UPLOADED_GRAPHIC_INDEX_START],
        );
        const grhIndex = Number(
            nextResult.rows[0]?.next_index ?? UPLOADED_GRAPHIC_INDEX_START,
        );

        const inserted = await client.query<{ created_at: Date | string }>(
            `INSERT INTO game_uploaded_graphics
                 (grh_index, checksum, width, height, byte_size, content, uploaded_by_account_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING created_at`,
            [
                grhIndex,
                checksum,
                validation.width,
                validation.height,
                validation.byteSize,
                validation.content,
                accountId,
            ],
        );

        await client.query("COMMIT");

        return {
            deduped: false,
            totalAccountUploadBytes: projectedBytes,
            graphic: {
                grhIndex,
                checksum,
                width: validation.width,
                height: validation.height,
                byteSize: validation.byteSize,
                createdAt: toIsoTimestamp(
                    inserted.rows[0]?.created_at ?? new Date(),
                ),
            },
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

export async function getUserMapForViewer(
    mapNum: number,
    viewerAccountId: string | null,
    options: {
        isAdmin?: boolean;
        deps?: UserMapDependencies;
    } = {},
): Promise<UserMapRecord | null> {
    assertValidUserMapNumber(mapNum);

    const db = (options.deps?.db ?? pool) as DbPoolLike;
    const result = await db.query<UserMapRow>(
        "SELECT * FROM game_user_maps WHERE map_num = $1 LIMIT 1",
        [mapNum],
    );

    const row = result.rows[0];
    if (!row) {
        return null;
    }

    const isOwner =
        Boolean(viewerAccountId) && row.owner_account_id === viewerAccountId;
    const canSeeNonPublished = isOwner || Boolean(options.isAdmin);

    if (row.status !== "published" && !canSeeNonPublished) {
        return null;
    }

    return mapRowToRecord(row);
}

export async function getUserMapClientPayloadForViewer(
    mapNum: number,
    viewerAccountId: string | null,
    options: {
        isAdmin?: boolean;
        deps?: UserMapDependencies;
    } = {},
): Promise<{
    map: UserMapSummary;
    mapData: ClientMapData;
} | null> {
    const record = await getUserMapForViewer(mapNum, viewerAccountId, options);
    if (!record) {
        return null;
    }

    const mapData = buildUserMapClientData({
        mapNum: record.mapNum,
        tiles: record.tiles,
        objects: record.objects,
        npcs: record.npcs,
        exits: record.exits,
    });

    return {
        map: {
            mapNum: record.mapNum,
            ownerAccountId: record.ownerAccountId,
            name: record.name,
            description: record.description,
            status: record.status,
            combatEnabled: false,
            entryX: record.entryX,
            entryY: record.entryY,
            npcCount: record.npcCount,
            objectCount: record.objectCount,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
        },
        mapData,
    };
}

export async function listPublicUserMaps(
    limit = 50,
    deps: UserMapDependencies = {},
): Promise<UserMapSummary[]> {
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 200);
    const db = (deps.db ?? pool) as DbPoolLike;
    const result = await db.query<UserMapRow>(
        `SELECT *
         FROM game_user_maps
         WHERE status = 'published'
         ORDER BY updated_at DESC
         LIMIT $1`,
        [safeLimit],
    );

    return result.rows.map(mapRowToSummary);
}

export async function listAccountUserMaps(
    ownerAccountId: string,
    deps: UserMapDependencies = {},
): Promise<UserMapSummary[]> {
    const db = (deps.db ?? pool) as DbPoolLike;
    const result = await db.query<UserMapRow>(
        `SELECT *
         FROM game_user_maps
         WHERE owner_account_id = $1
         ORDER BY updated_at DESC`,
        [ownerAccountId],
    );

    return result.rows.map(mapRowToSummary);
}
