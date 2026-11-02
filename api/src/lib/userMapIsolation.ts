import { z } from "zod";
import {
    type GameNpcRecordData,
    type GameObjectRecordData,
    loadSeedNpcsJson,
    loadSeedObjectsJson,
} from "./gameData";

/**
 * Rango estructural reservado para mapas de usuario (#24):
 * - 1..~500: Mundo oficial
 * - 500..599: Mapas locales estaticos
 * - 2.000..29.999: Retos
 * - 30.000..99.999: Instancias dinamicas
 * - 100.000..999.999: Espacio aislado de mapas de usuario (ingreso desde menu)
 */
export const OFFICIAL_WORLD_MAP_MAX_ID = 99_999;
export const DYNAMIC_INSTANCE_MAP_START = 30_000;
export const DYNAMIC_INSTANCE_MAP_END = 99_999;
export const USER_MAP_ID_START = 100_000;
export const USER_MAP_ID_END = 999_999;
export const USER_MAP_GRID_SIZE = 100;
export const DEFAULT_GROUND_GRH_INDEX = 5500;

export const USER_MAP_STATUSES = [
    "draft",
    "proposed",
    "published",
    "archived",
] as const;

export type UserMapStatus = (typeof USER_MAP_STATUSES)[number];

/**
 * Tipos de objeto estaticos/decorativos permitidos en mapas de usuario:
 * - 6: puerta
 * - 8: carteles / lapidas
 * - 10: foros
 * - 15: fogata
 * - 20: muebles (cama, silla, mesa...)
 * - 35: manchas / rejas decorativas
 *
 * Quedan explicitamente prohibidos para aislar la economia y el mundo oficial:
 * - 4 (arboles talables), 5 (dinero/oro), 9 (llaves), 19 (teleports oficiales),
 *   22/23 (yacimientos y minerales), 27/28 (yunque/fragua), 29/36 (gemas/lingotes),
 *   30 (pieles/flores recolectables) y todo equipamiento o consumible agarrable.
 */
export const ALLOWED_USER_MAP_OBJECT_TYPES = new Set<number>([
    6, 8, 10, 15, 20, 35,
]);

/**
 * Tipos de NPC interactivos de economia/progresion prohibidos aunque no peguen:
 * - 3: entrenador
 * - 4: banquero
 * - 6: dragon
 * - 7: timbero (apuestas)
 * - 10: comerciante
 * - 12: subastador
 */
export const FORBIDDEN_USER_MAP_NPC_TYPES = new Set<number>([
    3, 4, 6, 7, 10, 12,
]);

export const userMapTileSchema = z.object({
    x: z.coerce.number().int().min(1).max(USER_MAP_GRID_SIZE),
    y: z.coerce.number().int().min(1).max(USER_MAP_GRID_SIZE),
    layer: z.coerce.number().int().min(1).max(4),
    grhIndex: z.coerce.number().int().nonnegative().nullable(),
    blocked: z.boolean().optional(),
});

export const userMapObjectPlacementSchema = z.object({
    x: z.coerce.number().int().min(1).max(USER_MAP_GRID_SIZE),
    y: z.coerce.number().int().min(1).max(USER_MAP_GRID_SIZE),
    objIndex: z.coerce.number().int().positive(),
    amount: z.coerce.number().int().min(1).max(1).default(1),
});

export const userMapNpcPlacementSchema = z.object({
    x: z.coerce.number().int().min(1).max(USER_MAP_GRID_SIZE),
    y: z.coerce.number().int().min(1).max(USER_MAP_GRID_SIZE),
    npcIndex: z.coerce.number().int().positive(),
    movement: z.coerce.number().int().min(0).max(4).default(0),
});

export const userMapExitPlacementSchema = z.object({
    x: z.coerce.number().int().min(1).max(USER_MAP_GRID_SIZE),
    y: z.coerce.number().int().min(1).max(USER_MAP_GRID_SIZE),
    targetMap: z.coerce.number().int(),
    targetX: z.coerce.number().int().min(1).max(USER_MAP_GRID_SIZE),
    targetY: z.coerce.number().int().min(1).max(USER_MAP_GRID_SIZE),
});

export type UserMapTileEntry = z.infer<typeof userMapTileSchema>;
export type UserMapObjectPlacement = z.infer<
    typeof userMapObjectPlacementSchema
>;
export type UserMapNpcPlacement = z.infer<typeof userMapNpcPlacementSchema>;
export type UserMapExitPlacement = z.infer<typeof userMapExitPlacementSchema>;

export type UserMapCatalogLookup = {
    getObjectById: (id: number) => GameObjectRecordData | null;
    getNpcById: (id: number) => GameNpcRecordData | null;
};

let cachedDefaultCatalog: UserMapCatalogLookup | null = null;

export function getDefaultUserMapCatalog(): UserMapCatalogLookup {
    if (cachedDefaultCatalog) {
        return cachedDefaultCatalog;
    }

    const objectsMap = new Map<number, GameObjectRecordData>();
    for (const entry of loadSeedObjectsJson()) {
        objectsMap.set(entry.id, entry.data);
    }

    const npcsMap = new Map<number, GameNpcRecordData>();
    for (const entry of loadSeedNpcsJson()) {
        npcsMap.set(entry.id, entry.data);
    }

    cachedDefaultCatalog = {
        getObjectById: (id: number) => objectsMap.get(id) ?? null,
        getNpcById: (id: number) => npcsMap.get(id) ?? null,
    };

    return cachedDefaultCatalog;
}

export function isUserMapId(mapNum: number): boolean {
    return (
        Number.isInteger(mapNum) &&
        mapNum >= USER_MAP_ID_START &&
        mapNum <= USER_MAP_ID_END
    );
}

export function isOfficialOrSystemMapId(mapNum: number): boolean {
    return (
        Number.isInteger(mapNum) &&
        mapNum >= 1 &&
        mapNum <= OFFICIAL_WORLD_MAP_MAX_ID
    );
}

/**
 * Impide que las rutas de edicion del mundo oficial muten por error o abuso
 * mapas dentro del rango reservado de mapas de usuario (100.000..999.999).
 */
export function assertOfficialWorldMapMutationAllowed(mapNum: number): void {
    if (isUserMapId(mapNum)) {
        throw new Error(
            `El mapa ${mapNum} pertenece al espacio aislado de mapas de usuario (${USER_MAP_ID_START}..${USER_MAP_ID_END}) y no puede editarse desde las rutas del mundo oficial.`,
        );
    }
}

export function validateUserMapObjectAllowed(
    objIndex: number,
    catalog: UserMapCatalogLookup = getDefaultUserMapCatalog(),
): { ok: true } | { ok: false; reason: string } {
    const obj = catalog.getObjectById(objIndex);
    if (!obj) {
        return {
            ok: false,
            reason: `El objeto #${objIndex} no existe en el catálogo oficial.`,
        };
    }

    if (obj.objType === 5) {
        return {
            ok: false,
            reason: `No se permite colocar oro ni monedas (#${objIndex}: ${obj.name}) en mapas de usuario.`,
        };
    }

    if (obj.objType === 19) {
        return {
            ok: false,
            reason: `No se permiten teleports del mundo oficial (#${objIndex}: ${obj.name}) en mapas de usuario.`,
        };
    }

    if (obj.objType === 9) {
        return {
            ok: false,
            reason: `No se permite colocar llaves (#${objIndex}: ${obj.name}) en mapas de usuario.`,
        };
    }

    if (obj.objType === 22 || obj.objType === 23 || obj.objType === 29 || obj.objType === 36) {
        return {
            ok: false,
            reason: `No se permite colocar minerales, gemas ni lingotes (#${objIndex}: ${obj.name}) en mapas de usuario.`,
        };
    }

    if (!ALLOWED_USER_MAP_OBJECT_TYPES.has(obj.objType)) {
        return {
            ok: false,
            reason: `El objeto #${objIndex} (${obj.name}, tipo ${obj.objType}) no es un objeto decorativo o estructural permitido en mapas de usuario.`,
        };
    }

    const hasCombatOrValueStats =
        (obj.minHit ?? 0) > 0 ||
        (obj.maxHit ?? 0) > 0 ||
        (obj.minDef ?? 0) > 0 ||
        (obj.maxDef ?? 0) > 0 ||
        (obj.proyectil ?? 0) > 0 ||
        (obj.magicDamageBonus ?? 0) > 0;

    if (hasCombatOrValueStats) {
        return {
            ok: false,
            reason: `El objeto #${objIndex} (${obj.name}) otorga atributos de equipamiento y no puede colocarse en mapas de usuario.`,
        };
    }

    return { ok: true };
}

export function validateUserMapNpcAllowed(
    npcIndex: number,
    catalog: UserMapCatalogLookup = getDefaultUserMapCatalog(),
): { ok: true } | { ok: false; reason: string } {
    const npc = catalog.getNpcById(npcIndex);
    if (!npc) {
        return {
            ok: false,
            reason: `El NPC #${npcIndex} no existe en el catálogo oficial.`,
        };
    }

    if (FORBIDDEN_USER_MAP_NPC_TYPES.has(npc.npcType)) {
        return {
            ok: false,
            reason: `El NPC #${npcIndex} (${npc.name}) tiene rol económico o de progresión (tipo ${npc.npcType}) y no está permitido en mapas de usuario.`,
        };
    }

    const exp = Number(npc.exp ?? 0);
    const gold = Number(npc.gold ?? 0);
    const maxHit = Number(npc.maxHit ?? 0);
    const minHit = Number(npc.minHit ?? 0);
    const drops = Array.isArray(npc.drop) ? npc.drop : [];
    const tradeObjs = Array.isArray(npc.objs) ? npc.objs : [];

    if (
        exp > 0 ||
        gold > 0 ||
        maxHit > 0 ||
        minHit > 0 ||
        drops.length > 0 ||
        tradeObjs.length > 0
    ) {
        return {
            ok: false,
            reason: `El NPC #${npcIndex} (${npc.name}) otorga experiencia, oro, combate, drops o comercio y no está permitido en mapas de usuario.`,
        };
    }

    return { ok: true };
}

export type ValidateUserMapContentOptions = {
    maxNpcsPerMap: number;
    maxObjectsPerMap: number;
    catalog?: UserMapCatalogLookup;
};

export function validateUserMapContent(
    input: {
        combatEnabled?: boolean;
        tiles?: UserMapTileEntry[];
        objects?: UserMapObjectPlacement[];
        npcs?: UserMapNpcPlacement[];
        exits?: UserMapExitPlacement[];
    },
    options: ValidateUserMapContentOptions,
): { ok: true } | { ok: false; reason: string; code: "QUOTA_EXCEEDED" | "ISOLATION_VIOLATION" | "INVALID_CONTENT" } {
    if (input.combatEnabled === true) {
        return {
            ok: false,
            code: "ISOLATION_VIOLATION",
            reason: "El combate y la ganancia de experiencia están deshabilitados en mapas de usuario.",
        };
    }

    const exits = input.exits ?? [];
    for (const exit of exits) {
        if (!isUserMapId(exit.targetMap)) {
            return {
                ok: false,
                code: "ISOLATION_VIOLATION",
                reason: `Un mapa de usuario no puede referenciar ni abrir portales hacia mapas fuera del rango reservado (${USER_MAP_ID_START}..${USER_MAP_ID_END}); destino inválido: ${exit.targetMap}.`,
            };
        }
    }

    const objects = input.objects ?? [];
    if (objects.length > options.maxObjectsPerMap) {
        return {
            ok: false,
            code: "QUOTA_EXCEEDED",
            reason: `Se alcanzó la cuota máxima de objetos por mapa (${options.maxObjectsPerMap}). Intentaste colocar ${objects.length} objetos.`,
        };
    }

    const npcs = input.npcs ?? [];
    if (npcs.length > options.maxNpcsPerMap) {
        return {
            ok: false,
            code: "QUOTA_EXCEEDED",
            reason: `Se alcanzó la cuota máxima de NPCs por mapa (${options.maxNpcsPerMap}). Intentaste colocar ${npcs.length} NPCs.`,
        };
    }

    const catalog = options.catalog ?? getDefaultUserMapCatalog();

    const occupiedObjectCoords = new Set<string>();
    for (const objPlacement of objects) {
        const key = `${objPlacement.x},${objPlacement.y}`;
        if (occupiedObjectCoords.has(key)) {
            return {
                ok: false,
                code: "INVALID_CONTENT",
                reason: `Ya existe otro objeto en la coordenada (${objPlacement.x}, ${objPlacement.y}).`,
            };
        }
        occupiedObjectCoords.add(key);

        if (objPlacement.amount !== 1) {
            return {
                ok: false,
                code: "ISOLATION_VIOLATION",
                reason: "En mapas de usuario sólo se permite 1 unidad estática por objeto decorativo.",
            };
        }

        const check = validateUserMapObjectAllowed(objPlacement.objIndex, catalog);
        if (!check.ok) {
            return {
                ok: false,
                code: "ISOLATION_VIOLATION",
                reason: check.reason,
            };
        }
    }

    const occupiedNpcCoords = new Set<string>();
    for (const npcPlacement of npcs) {
        const key = `${npcPlacement.x},${npcPlacement.y}`;
        if (occupiedNpcCoords.has(key)) {
            return {
                ok: false,
                code: "INVALID_CONTENT",
                reason: `Ya existe otro NPC en la coordenada (${npcPlacement.x}, ${npcPlacement.y}).`,
            };
        }
        occupiedNpcCoords.add(key);

        const check = validateUserMapNpcAllowed(npcPlacement.npcIndex, catalog);
        if (!check.ok) {
            return {
                ok: false,
                code: "ISOLATION_VIOLATION",
                reason: check.reason,
            };
        }
    }

    return { ok: true };
}

export type ClientMapTile = {
    blocked?: number;
    graphics?: Record<string, number>;
    npcIndex?: number;
    objInfo?: {
        objIndex: number;
        amount: number;
    };
    tileExit?: {
        map: number;
        x: number;
        y: number;
    };
};

export type ClientMapData = Record<
    string,
    Record<string, Record<string, ClientMapTile>>
>;

/**
 * Construye la grilla 100x100 compatible con `MapData` del cliente para el mapa
 * de usuario, asegurando que ninguna salida apunte fuera del espacio reservado.
 */
export function buildUserMapClientData(input: {
    mapNum: number;
    tiles: UserMapTileEntry[];
    objects: UserMapObjectPlacement[];
    npcs: UserMapNpcPlacement[];
    exits?: UserMapExitPlacement[];
}): ClientMapData {
    const rows: Record<string, Record<string, ClientMapTile>> = {};

    for (let y = 1; y <= USER_MAP_GRID_SIZE; y += 1) {
        const row: Record<string, ClientMapTile> = {};
        const isBorderY = y === 1 || y === USER_MAP_GRID_SIZE;
        for (let x = 1; x <= USER_MAP_GRID_SIZE; x += 1) {
            const isBorderX = x === 1 || x === USER_MAP_GRID_SIZE;
            row[String(x)] = {
                blocked: isBorderX || isBorderY ? 1 : 0,
                graphics: { "1": DEFAULT_GROUND_GRH_INDEX },
            };
        }
        rows[String(y)] = row;
    }

    for (const tileEdit of input.tiles) {
        const tile = rows[String(tileEdit.y)]?.[String(tileEdit.x)];
        if (!tile) {
            continue;
        }
        const graphics = { ...(tile.graphics ?? {}) };
        if (tileEdit.grhIndex === null) {
            delete graphics[String(tileEdit.layer)];
        } else {
            graphics[String(tileEdit.layer)] = tileEdit.grhIndex;
        }
        tile.graphics = graphics;
        if (typeof tileEdit.blocked === "boolean") {
            tile.blocked = tileEdit.blocked ? 1 : 0;
        }
    }

    for (const obj of input.objects) {
        const tile = rows[String(obj.y)]?.[String(obj.x)];
        if (!tile) {
            continue;
        }
        tile.objInfo = {
            objIndex: obj.objIndex,
            amount: 1,
        };
    }

    for (const npc of input.npcs) {
        const tile = rows[String(npc.y)]?.[String(npc.x)];
        if (!tile) {
            continue;
        }
        tile.npcIndex = npc.npcIndex;
    }

    for (const exit of input.exits ?? []) {
        if (!isUserMapId(exit.targetMap)) {
            continue;
        }
        const tile = rows[String(exit.y)]?.[String(exit.x)];
        if (!tile) {
            continue;
        }
        tile.tileExit = {
            map: exit.targetMap,
            x: exit.targetX,
            y: exit.targetY,
        };
    }

    return {
        [String(input.mapNum)]: rows,
    };
}
