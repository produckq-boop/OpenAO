import { MAX_NPCS_PER_MAP } from "./mapNpcStorage";
import type {
    UserMapContent,
    UserMapCoordinate,
    UserMapModerationAction,
    UserMapState,
} from "../types";

export { MAX_NPCS_PER_MAP };

export const UPLOADED_GRAPHIC_INDEX_START = 1_000_000;
export const MIN_USER_MAP_DIMENSION = 10;
export const MAX_USER_MAP_DIMENSION = 100;
export const MAX_MAPS_PER_ACCOUNT = 10;
export const MAX_OBJECTS_PER_MAP = 200;
export const MAX_SIGNS_PER_MAP = 50;
export const MAX_EXITS_PER_MAP = 40;
export const MAX_TELEPORTS_PER_MAP = 20;
export const MAX_TILE_ENTRIES_PER_MAP = 40_000;
export const MAX_BLOCKED_TILES_PER_MAP = 10_000;
export const MAX_CUSTOM_GRAPHICS_PER_MAP = 100;
export const MAX_SIGN_TEXT_LENGTH = 280;
export const MAX_NPC_TEXT_LENGTH = 280;
export const MIN_MAP_NAME_LENGTH = 3;
export const MAX_MAP_NAME_LENGTH = 80;
export const MAX_MAP_DESCRIPTION_LENGTH = 500;
export const MIN_WALKABLE_PATH_TILES = 2;

/**
 * Los mapas 1..599 corresponden al mundo oficial y mapas locales estaticos.
 * Un mapa de usuario nunca puede abrir salidas directas hacia ese rango.
 */
export const OFFICIAL_WORLD_MAP_MAX_ID = 599;

export const USER_MAP_STATES: readonly UserMapState[] = [
    "draft",
    "proposed",
    "in_review",
    "published",
    "rejected",
    "unpublished",
] as const;

/**
 * Lista base de terminos ofensivos para el pre-filtro automatico de nombres,
 * descripciones, carteles y textos de NPCs. Se evalua por palabra completa tras
 * normalizar acentos y sustituciones comunes para no bloquear palabras validas
 * como "computadora" o "disputa".
 */
export const DEFAULT_BANNED_WORDS: readonly string[] = [
    "puta",
    "puto",
    "mierda",
    "pendejo",
    "pendeja",
    "pelotudo",
    "pelotuda",
    "boludo",
    "boluda",
    "conchudo",
    "conchuda",
    "concha",
    "maricon",
    "cabron",
    "zorra",
    "verga",
    "chingar",
    "nazi",
    "hitler",
    "pedofilo",
    "violar",
    "violacion",
    "porno",
    "fuck",
    "shit",
    "bitch",
    "asshole",
    "nigger",
    "faggot",
] as const;

const STATE_TRANSITIONS: Record<
    UserMapState,
    Partial<Record<UserMapModerationAction, UserMapState>>
> = {
    draft: {
        propose: "proposed",
        edit_reset: "draft",
    },
    proposed: {
        start_review: "in_review",
    },
    in_review: {
        approve: "published",
        reject: "rejected",
    },
    published: {
        report: "proposed",
        unpublish: "unpublished",
    },
    rejected: {
        edit_reset: "draft",
    },
    unpublished: {
        edit_reset: "draft",
    },
};

export function canTransitionUserMapState(
    fromState: UserMapState,
    action: UserMapModerationAction,
): boolean {
    return STATE_TRANSITIONS[fromState]?.[action] !== undefined;
}

export function resolveNextUserMapState(
    fromState: UserMapState,
    action: UserMapModerationAction,
): UserMapState | null {
    return STATE_TRANSITIONS[fromState]?.[action] ?? null;
}

export type MapValidationViolationCode =
    | "invalid_name"
    | "invalid_description"
    | "invalid_dimensions"
    | "invalid_spawn"
    | "account_map_quota_exceeded"
    | "npc_quota_exceeded"
    | "object_quota_exceeded"
    | "sign_quota_exceeded"
    | "exit_quota_exceeded"
    | "teleport_quota_exceeded"
    | "tile_quota_exceeded"
    | "custom_graphic_quota_exceeded"
    | "invalid_tile_entry"
    | "invalid_blocked_tile"
    | "invalid_npc_entry"
    | "invalid_object_entry"
    | "invalid_sign_entry"
    | "invalid_exit_entry"
    | "forbidden_official_world_exit"
    | "invalid_teleport_entry"
    | "banned_word"
    | "spawn_blocked"
    | "npc_on_blocked_tile"
    | "duplicate_npc_tile"
    | "exit_blocked"
    | "teleport_blocked"
    | "no_path_from_entry"
    | "isolated_walkable_region"
    | "inescapable_trap";

export type MapValidationViolation = {
    code: MapValidationViolationCode;
    field: string;
    message: string;
    coordinate?: UserMapCoordinate;
};

export type MapValidationInput = {
    name: unknown;
    description?: unknown;
    width: unknown;
    height: unknown;
    spawn: unknown;
    mapData?: unknown;
};

export type NormalizedMapValidationTarget = {
    name: string;
    description: string;
    width: number;
    height: number;
    spawn: UserMapCoordinate;
    mapData: UserMapContent;
    customGraphicIds: number[];
};

export type QuotaCheckOptions = {
    authorMapCount?: number;
    maxMapsPerAccount?: number;
    maxNpcsPerMap?: number;
    maxObjectsPerMap?: number;
    maxSignsPerMap?: number;
    maxCustomGraphicsPerMap?: number;
};

export type BoundsAndQuotasResult =
    | {
          ok: true;
          normalized: NormalizedMapValidationTarget;
      }
    | {
          ok: false;
          violations: MapValidationViolation[];
      };

export type BannedWordsCheckOptions = {
    bannedWords?: readonly string[];
    catalogNpcNames?: ReadonlyMap<number, string> | Record<number, string>;
};

export type GeometryDiagnostics = {
    totalTiles: number;
    walkableTiles: number;
    blockedTiles: number;
    reachableWalkableTiles: number;
    isolatedRegionCount: number;
    isolatedTileCount: number;
    trapTileCount: number;
};

export type GeometryCheckResult = {
    ok: boolean;
    diagnostics: GeometryDiagnostics;
    violations: MapValidationViolation[];
};

export type AutomatedMapCheckStage =
    | "bounds_and_quotas"
    | "banned_words"
    | "geometry"
    | "passed";

export type AutomatedMapCheckResult =
    | {
          ok: true;
          stage: "passed";
          normalized: NormalizedMapValidationTarget;
          diagnostics: GeometryDiagnostics;
          violations: [];
      }
    | {
          ok: false;
          stage: Exclude<AutomatedMapCheckStage, "passed">;
          violations: MapValidationViolation[];
          diagnostics: GeometryDiagnostics | null;
      };

function isFinitePositiveInt(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isInGridBounds(
    x: unknown,
    y: unknown,
    width: number,
    height: number,
): boolean {
    return (
        typeof x === "number" &&
        typeof y === "number" &&
        Number.isInteger(x) &&
        Number.isInteger(y) &&
        x >= 1 &&
        x <= width &&
        y >= 1 &&
        y <= height
    );
}

/**
 * Valida limites estructurales, dimensiones enteras finitas y cuotas ANTES de
 * ejecutar cualquier recorrido de grilla o BFS. Si las dimensiones o las
 * cantidades son invalidas se corta de inmediato sin alocar la grilla.
 */
export function validateBoundsAndQuotas(
    input: MapValidationInput,
    options: QuotaCheckOptions = {},
): BoundsAndQuotasResult {
    const violations: MapValidationViolation[] = [];

    const rawName = typeof input.name === "string" ? input.name.trim() : "";
    if (
        rawName.length < MIN_MAP_NAME_LENGTH ||
        rawName.length > MAX_MAP_NAME_LENGTH
    ) {
        violations.push({
            code: "invalid_name",
            field: "name",
            message: `El nombre del mapa debe tener entre ${MIN_MAP_NAME_LENGTH} y ${MAX_MAP_NAME_LENGTH} caracteres.`,
        });
    }

    const rawDescription =
        input.description === undefined || input.description === null
            ? ""
            : typeof input.description === "string"
              ? input.description.trim()
              : null;

    if (
        rawDescription === null ||
        rawDescription.length > MAX_MAP_DESCRIPTION_LENGTH
    ) {
        violations.push({
            code: "invalid_description",
            field: "description",
            message: `La descripcion del mapa no puede superar los ${MAX_MAP_DESCRIPTION_LENGTH} caracteres.`,
        });
    }

    const width = input.width;
    const height = input.height;

    if (
        typeof width !== "number" ||
        typeof height !== "number" ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < MIN_USER_MAP_DIMENSION ||
        width > MAX_USER_MAP_DIMENSION ||
        height < MIN_USER_MAP_DIMENSION ||
        height > MAX_USER_MAP_DIMENSION
    ) {
        violations.push({
            code: "invalid_dimensions",
            field: "dimensions",
            message: `Las dimensiones del mapa deben ser enteros entre ${MIN_USER_MAP_DIMENSION}x${MIN_USER_MAP_DIMENSION} y ${MAX_USER_MAP_DIMENSION}x${MAX_USER_MAP_DIMENSION}.`,
        });
        return { ok: false, violations };
    }

    const maxMapsPerAccount =
        options.maxMapsPerAccount ?? MAX_MAPS_PER_ACCOUNT;
    if (
        options.authorMapCount !== undefined &&
        options.authorMapCount >= maxMapsPerAccount
    ) {
        violations.push({
            code: "account_map_quota_exceeded",
            field: "ownerAccountId",
            message: `Se alcanzo la cuota maxima de ${maxMapsPerAccount} mapas por cuenta.`,
        });
    }

    const rawSpawn =
        input.spawn && typeof input.spawn === "object"
            ? (input.spawn as Record<string, unknown>)
            : null;
    if (!rawSpawn || !isInGridBounds(rawSpawn.x, rawSpawn.y, width, height)) {
        violations.push({
            code: "invalid_spawn",
            field: "spawn",
            message: `El punto de entrada debe tener coordenadas enteras dentro de (1..${width}, 1..${height}).`,
        });
    }

    const rawData =
        input.mapData === undefined
            ? {}
            : input.mapData &&
                typeof input.mapData === "object" &&
                !Array.isArray(input.mapData)
              ? (input.mapData as Record<string, unknown>)
              : null;

    if (!rawData) {
        violations.push({
            code: "invalid_tile_entry",
            field: "mapData",
            message: "El contenido de mapData debe ser un objeto valido.",
        });
        return { ok: false, violations };
    }

    const rawTiles = rawData.tiles ?? [];
    const rawBlockedTiles = rawData.blockedTiles ?? [];
    const rawNpcs = rawData.npcs ?? [];
    const rawObjects = rawData.objects ?? [];
    const rawSigns = rawData.signs ?? [];
    const rawExits = rawData.exits ?? [];
    const rawTeleports = rawData.teleports ?? [];

    if (!Array.isArray(rawTiles) || rawTiles.length > MAX_TILE_ENTRIES_PER_MAP) {
        violations.push({
            code: "tile_quota_exceeded",
            field: "mapData.tiles",
            message: `La lista de tiles supera el maximo permitido de ${MAX_TILE_ENTRIES_PER_MAP}.`,
        });
    }

    if (
        !Array.isArray(rawBlockedTiles) ||
        rawBlockedTiles.length > MAX_BLOCKED_TILES_PER_MAP
    ) {
        violations.push({
            code: "tile_quota_exceeded",
            field: "mapData.blockedTiles",
            message: `La lista de tiles bloqueados supera el maximo permitido de ${MAX_BLOCKED_TILES_PER_MAP}.`,
        });
    }

    const maxNpcs = options.maxNpcsPerMap ?? MAX_NPCS_PER_MAP;
    if (!Array.isArray(rawNpcs) || rawNpcs.length > maxNpcs) {
        violations.push({
            code: "npc_quota_exceeded",
            field: "mapData.npcs",
            message: `El mapa supera el maximo permitido de ${maxNpcs} NPCs.`,
        });
    }

    const maxObjects = options.maxObjectsPerMap ?? MAX_OBJECTS_PER_MAP;
    if (!Array.isArray(rawObjects) || rawObjects.length > maxObjects) {
        violations.push({
            code: "object_quota_exceeded",
            field: "mapData.objects",
            message: `El mapa supera el maximo permitido de ${maxObjects} objetos.`,
        });
    }

    const maxSigns = options.maxSignsPerMap ?? MAX_SIGNS_PER_MAP;
    if (!Array.isArray(rawSigns) || rawSigns.length > maxSigns) {
        violations.push({
            code: "sign_quota_exceeded",
            field: "mapData.signs",
            message: `El mapa supera el maximo permitido de ${maxSigns} carteles.`,
        });
    }

    if (!Array.isArray(rawExits) || rawExits.length > MAX_EXITS_PER_MAP) {
        violations.push({
            code: "exit_quota_exceeded",
            field: "mapData.exits",
            message: `El mapa supera el maximo permitido de ${MAX_EXITS_PER_MAP} salidas.`,
        });
    }

    if (
        !Array.isArray(rawTeleports) ||
        rawTeleports.length > MAX_TELEPORTS_PER_MAP
    ) {
        violations.push({
            code: "teleport_quota_exceeded",
            field: "mapData.teleports",
            message: `El mapa supera el maximo permitido de ${MAX_TELEPORTS_PER_MAP} teleports internos.`,
        });
    }

    if (violations.length > 0) {
        return { ok: false, violations };
    }

    const tiles: UserMapContent["tiles"] = [];
    const customGraphicSet = new Set<number>();

    for (const entry of rawTiles as unknown[]) {
        if (!entry || typeof entry !== "object") {
            violations.push({
                code: "invalid_tile_entry",
                field: "mapData.tiles",
                message: "Entrada de tile invalida.",
            });
            break;
        }
        const candidate = entry as Record<string, unknown>;
        const layer = candidate.layer ?? 1;
        const grhIndex = candidate.grhIndex ?? null;
        const blocked = candidate.blocked ?? null;

        if (
            !isInGridBounds(candidate.x, candidate.y, width, height) ||
            typeof layer !== "number" ||
            !Number.isInteger(layer) ||
            layer < 1 ||
            layer > 4 ||
            (grhIndex !== null &&
                (typeof grhIndex !== "number" ||
                    !Number.isInteger(grhIndex) ||
                    grhIndex < 0)) ||
            (blocked !== null && typeof blocked !== "boolean")
        ) {
            violations.push({
                code: "invalid_tile_entry",
                field: "mapData.tiles",
                message: "Tile fuera de limites o con capa/grafico invalido.",
            });
            break;
        }

        if (grhIndex !== null && grhIndex >= UPLOADED_GRAPHIC_INDEX_START) {
            customGraphicSet.add(grhIndex);
        }

        tiles.push({
            x: candidate.x as number,
            y: candidate.y as number,
            layer,
            grhIndex,
            blocked,
        });
    }

    const maxCustomGraphics =
        options.maxCustomGraphicsPerMap ?? MAX_CUSTOM_GRAPHICS_PER_MAP;
    if (customGraphicSet.size > maxCustomGraphics) {
        violations.push({
            code: "custom_graphic_quota_exceeded",
            field: "mapData.tiles",
            message: `El mapa referencia mas de ${maxCustomGraphics} graficos personalizados.`,
        });
    }

    const blockedTiles: UserMapContent["blockedTiles"] = [];
    for (const entry of rawBlockedTiles as unknown[]) {
        if (!entry || typeof entry !== "object") {
            violations.push({
                code: "invalid_blocked_tile",
                field: "mapData.blockedTiles",
                message: "Coordenada de bloqueo invalida.",
            });
            break;
        }
        const candidate = entry as Record<string, unknown>;
        if (!isInGridBounds(candidate.x, candidate.y, width, height)) {
            violations.push({
                code: "invalid_blocked_tile",
                field: "mapData.blockedTiles",
                message: `Tile bloqueado fuera de los limites (1..${width}, 1..${height}).`,
            });
            break;
        }
        blockedTiles.push({
            x: candidate.x as number,
            y: candidate.y as number,
        });
    }

    const npcs: UserMapContent["npcs"] = [];
    for (const entry of rawNpcs as unknown[]) {
        if (!entry || typeof entry !== "object") {
            violations.push({
                code: "invalid_npc_entry",
                field: "mapData.npcs",
                message: "Colocacion de NPC invalida.",
            });
            break;
        }
        const candidate = entry as Record<string, unknown>;
        const customName =
            candidate.name === undefined
                ? undefined
                : typeof candidate.name === "string"
                  ? candidate.name.trim()
                  : null;
        const dialogue =
            candidate.dialogue === undefined
                ? undefined
                : typeof candidate.dialogue === "string"
                  ? candidate.dialogue.trim()
                  : null;

        if (
            !isInGridBounds(candidate.x, candidate.y, width, height) ||
            !isFinitePositiveInt(candidate.npcId) ||
            customName === null ||
            (customName !== undefined &&
                (customName.length === 0 ||
                    customName.length > MAX_MAP_NAME_LENGTH)) ||
            dialogue === null ||
            (dialogue !== undefined && dialogue.length > MAX_NPC_TEXT_LENGTH)
        ) {
            violations.push({
                code: "invalid_npc_entry",
                field: "mapData.npcs",
                message: "NPC con coordenadas, identificador o texto invalido.",
            });
            break;
        }

        npcs.push({
            x: candidate.x as number,
            y: candidate.y as number,
            npcId: candidate.npcId,
            ...(customName !== undefined ? { name: customName } : {}),
            ...(dialogue !== undefined ? { dialogue } : {}),
        });
    }

    const objects: UserMapContent["objects"] = [];
    for (const entry of rawObjects as unknown[]) {
        if (!entry || typeof entry !== "object") {
            violations.push({
                code: "invalid_object_entry",
                field: "mapData.objects",
                message: "Colocacion de objeto invalida.",
            });
            break;
        }
        const candidate = entry as Record<string, unknown>;
        const amount = candidate.amount ?? 1;
        if (
            !isInGridBounds(candidate.x, candidate.y, width, height) ||
            !isFinitePositiveInt(candidate.objectId) ||
            !isFinitePositiveInt(amount) ||
            amount > 10_000
        ) {
            violations.push({
                code: "invalid_object_entry",
                field: "mapData.objects",
                message: "Objeto con coordenadas, identificador o cantidad invalida.",
            });
            break;
        }
        objects.push({
            x: candidate.x as number,
            y: candidate.y as number,
            objectId: candidate.objectId,
            amount,
        });
    }

    const signs: UserMapContent["signs"] = [];
    for (const entry of rawSigns as unknown[]) {
        if (!entry || typeof entry !== "object") {
            violations.push({
                code: "invalid_sign_entry",
                field: "mapData.signs",
                message: "Cartel invalido.",
            });
            break;
        }
        const candidate = entry as Record<string, unknown>;
        const text =
            typeof candidate.text === "string" ? candidate.text.trim() : "";
        if (
            !isInGridBounds(candidate.x, candidate.y, width, height) ||
            text.length === 0 ||
            text.length > MAX_SIGN_TEXT_LENGTH
        ) {
            violations.push({
                code: "invalid_sign_entry",
                field: "mapData.signs",
                message: `Cada cartel debe ubicarse dentro de la grilla y tener entre 1 y ${MAX_SIGN_TEXT_LENGTH} caracteres.`,
            });
            break;
        }
        signs.push({
            x: candidate.x as number,
            y: candidate.y as number,
            text,
        });
    }

    const exits: UserMapContent["exits"] = [];
    for (const entry of rawExits as unknown[]) {
        if (!entry || typeof entry !== "object") {
            violations.push({
                code: "invalid_exit_entry",
                field: "mapData.exits",
                message: "Salida de mapa invalida.",
            });
            break;
        }
        const candidate = entry as Record<string, unknown>;
        if (!isInGridBounds(candidate.x, candidate.y, width, height)) {
            violations.push({
                code: "invalid_exit_entry",
                field: "mapData.exits",
                message: "Coordenada de salida fuera de los limites del mapa.",
            });
            break;
        }
        if (candidate.targetMap !== undefined) {
            if (!isFinitePositiveInt(candidate.targetMap)) {
                violations.push({
                    code: "invalid_exit_entry",
                    field: "mapData.exits",
                    message: "El mapa de destino de la salida es invalido.",
                });
                break;
            }
            if (candidate.targetMap <= OFFICIAL_WORLD_MAP_MAX_ID) {
                violations.push({
                    code: "forbidden_official_world_exit",
                    field: "mapData.exits",
                    message:
                        "Un mapa de usuario no puede apuntar salidas directas al mundo oficial.",
                    coordinate: {
                        x: candidate.x as number,
                        y: candidate.y as number,
                    },
                });
                break;
            }
        }
        if (
            candidate.targetX !== undefined &&
            (!isFinitePositiveInt(candidate.targetX) ||
                candidate.targetX > MAX_USER_MAP_DIMENSION)
        ) {
            violations.push({
                code: "invalid_exit_entry",
                field: "mapData.exits",
                message: `La coordenada targetX de la salida debe estar entre 1 y ${MAX_USER_MAP_DIMENSION}.`,
            });
            break;
        }
        if (
            candidate.targetY !== undefined &&
            (!isFinitePositiveInt(candidate.targetY) ||
                candidate.targetY > MAX_USER_MAP_DIMENSION)
        ) {
            violations.push({
                code: "invalid_exit_entry",
                field: "mapData.exits",
                message: `La coordenada targetY de la salida debe estar entre 1 y ${MAX_USER_MAP_DIMENSION}.`,
            });
            break;
        }
        exits.push({
            x: candidate.x as number,
            y: candidate.y as number,
            ...(candidate.targetMap !== undefined
                ? { targetMap: candidate.targetMap as number }
                : {}),
            ...(candidate.targetX !== undefined
                ? { targetX: candidate.targetX as number }
                : {}),
            ...(candidate.targetY !== undefined
                ? { targetY: candidate.targetY as number }
                : {}),
        });
    }

    const teleports: UserMapContent["teleports"] = [];
    for (const entry of rawTeleports as unknown[]) {
        if (!entry || typeof entry !== "object") {
            violations.push({
                code: "invalid_teleport_entry",
                field: "mapData.teleports",
                message: "Teleport interno invalido.",
            });
            break;
        }
        const candidate = entry as Record<string, unknown>;
        if (
            !isInGridBounds(candidate.fromX, candidate.fromY, width, height) ||
            !isInGridBounds(candidate.toX, candidate.toY, width, height)
        ) {
            violations.push({
                code: "invalid_teleport_entry",
                field: "mapData.teleports",
                message: "Las coordenadas del teleport interno estan fuera de limites.",
            });
            break;
        }
        teleports.push({
            fromX: candidate.fromX as number,
            fromY: candidate.fromY as number,
            toX: candidate.toX as number,
            toY: candidate.toY as number,
        });
    }

    if (violations.length > 0) {
        return { ok: false, violations };
    }

    return {
        ok: true,
        normalized: {
            name: rawName,
            description: rawDescription as string,
            width,
            height,
            spawn: {
                x: (rawSpawn as Record<string, number>).x,
                y: (rawSpawn as Record<string, number>).y,
            },
            mapData: {
                tiles,
                blockedTiles,
                npcs,
                objects,
                signs,
                exits,
                teleports,
            },
            customGraphicIds: Array.from(customGraphicSet).sort(
                (left, right) => left - right,
            ),
        },
    };
}

function normalizeForModeration(text: string): string {
    return text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}

function decodeLeetToken(token: string): string {
    return token
        .replace(/0/g, "o")
        .replace(/[1!|]/g, "i")
        .replace(/3/g, "e")
        .replace(/[4@]/g, "a")
        .replace(/[5$]/g, "s")
        .replace(/7/g, "t");
}

function findBannedTermInText(
    text: string,
    normalizedTerms: string[],
): string | null {
    if (!text) {
        return null;
    }

    const normalized = normalizeForModeration(text);
    const rawTokens = normalized.split(/[^a-z0-9@$!|]+/).filter(Boolean);
    const tokenSet = new Set<string>();

    for (const rawToken of rawTokens) {
        const cleaned = rawToken.replace(/[^a-z0-9]/g, "");
        if (cleaned) {
            tokenSet.add(cleaned);
        }
        const deLeeted = decodeLeetToken(rawToken).replace(/[^a-z0-9]/g, "");
        if (deLeeted) {
            tokenSet.add(deLeeted);
        }
    }

    const collapsedText = decodeLeetToken(normalized)
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

    for (const term of normalizedTerms) {
        if (!term) {
            continue;
        }

        if (!term.includes(" ")) {
            if (
                tokenSet.has(term) ||
                (term.length >= 4 &&
                    (tokenSet.has(`${term}s`) || tokenSet.has(`${term}es`)))
            ) {
                return term;
            }
            continue;
        }

        const paddedHaystack = ` ${collapsedText} `;
        if (paddedHaystack.includes(` ${term} `)) {
            return term;
        }
    }

    return null;
}

export function validateBannedWords(
    target: NormalizedMapValidationTarget,
    options: BannedWordsCheckOptions = {},
): MapValidationViolation[] {
    const terms = (options.bannedWords ?? DEFAULT_BANNED_WORDS).map((word) =>
        normalizeForModeration(word).replace(/[^a-z0-9 ]+/g, " ").trim(),
    );

    const violations: MapValidationViolation[] = [];

    const nameMatch = findBannedTermInText(target.name, terms);
    if (nameMatch) {
        violations.push({
            code: "banned_word",
            field: "name",
            message: `El nombre del mapa contiene lenguaje no permitido ("${nameMatch}").`,
        });
    }

    const descMatch = findBannedTermInText(target.description, terms);
    if (descMatch) {
        violations.push({
            code: "banned_word",
            field: "description",
            message: `La descripcion del mapa contiene lenguaje no permitido ("${descMatch}").`,
        });
    }

    target.mapData.signs.forEach((sign, index) => {
        const match = findBannedTermInText(sign.text, terms);
        if (match) {
            violations.push({
                code: "banned_word",
                field: `mapData.signs[${index}].text`,
                message: `El cartel en (${sign.x}, ${sign.y}) contiene lenguaje no permitido ("${match}").`,
                coordinate: { x: sign.x, y: sign.y },
            });
        }
    });

    target.mapData.npcs.forEach((npc, index) => {
        const catalogSource = options.catalogNpcNames;
        const catalogName =
            catalogSource &&
            "get" in catalogSource &&
            typeof catalogSource.get === "function"
                ? catalogSource.get(npc.npcId)
                : (catalogSource as Record<number, string> | undefined)?.[
                      npc.npcId
                  ];
        const effectiveName = npc.name ?? catalogName ?? "";

        const npcNameMatch = findBannedTermInText(effectiveName, terms);
        if (npcNameMatch) {
            violations.push({
                code: "banned_word",
                field: `mapData.npcs[${index}].name`,
                message: `El nombre del NPC en (${npc.x}, ${npc.y}) contiene lenguaje no permitido ("${npcNameMatch}").`,
                coordinate: { x: npc.x, y: npc.y },
            });
        }

        if (npc.dialogue) {
            const dialogueMatch = findBannedTermInText(npc.dialogue, terms);
            if (dialogueMatch) {
                violations.push({
                    code: "banned_word",
                    field: `mapData.npcs[${index}].dialogue`,
                    message: `El dialogo del NPC en (${npc.x}, ${npc.y}) contiene lenguaje no permitido ("${dialogueMatch}").`,
                    coordinate: { x: npc.x, y: npc.y },
                });
            }
        }
    });

    return violations;
}

/**
 * Recorrido BFS en O(W * H) sobre buffers tipados.
 *
 * Verifica:
 *   1. Punto de entrada transitable y existencia de camino valido desde alli.
 *   2. Ausencia de regiones transitables aisladas por paredes/tiles bloqueados.
 *   3. Ausencia de trampas sin salida alcanzables mediante teleports de ida.
 */
function runGeometryAndReachabilityImpl(
    target: NormalizedMapValidationTarget,
): GeometryCheckResult {
    const { width, height, spawn, mapData } = target;
    const totalTiles = width * height;
    const blocked = new Uint8Array(totalTiles);

    const toIndex = (x: number, y: number): number => (y - 1) * width + (x - 1);
    const toCoord = (index: number): UserMapCoordinate => ({
        x: (index % width) + 1,
        y: Math.floor(index / width) + 1,
    });

    for (const tile of mapData.blockedTiles) {
        blocked[toIndex(tile.x, tile.y)] = 1;
    }

    for (const tile of mapData.tiles) {
        if (tile.blocked === true) {
            blocked[toIndex(tile.x, tile.y)] = 1;
        }
    }

    let blockedTilesCount = 0;
    for (let i = 0; i < totalTiles; i += 1) {
        if (blocked[i] === 1) {
            blockedTilesCount += 1;
        }
    }
    const walkableTilesCount = totalTiles - blockedTilesCount;

    const violations: MapValidationViolation[] = [];
    const spawnIndex = toIndex(spawn.x, spawn.y);

    if (blocked[spawnIndex] === 1) {
        violations.push({
            code: "spawn_blocked",
            field: "spawn",
            message: `El punto de entrada (${spawn.x}, ${spawn.y}) esta bloqueado.`,
            coordinate: { x: spawn.x, y: spawn.y },
        });
    }

    const occupiedNpcTiles = new Set<number>();
    for (const npc of mapData.npcs) {
        const idx = toIndex(npc.x, npc.y);
        if (blocked[idx] === 1) {
            violations.push({
                code: "npc_on_blocked_tile",
                field: "mapData.npcs",
                message: `El NPC ${npc.npcId} en (${npc.x}, ${npc.y}) esta sobre un tile bloqueado.`,
                coordinate: { x: npc.x, y: npc.y },
            });
        }
        if (occupiedNpcTiles.has(idx)) {
            violations.push({
                code: "duplicate_npc_tile",
                field: "mapData.npcs",
                message: `Hay mas de un NPC colocado en (${npc.x}, ${npc.y}).`,
                coordinate: { x: npc.x, y: npc.y },
            });
        }
        occupiedNpcTiles.add(idx);
    }

    const exitIndices: number[] = [];
    for (const exit of mapData.exits) {
        const idx = toIndex(exit.x, exit.y);
        if (blocked[idx] === 1) {
            violations.push({
                code: "exit_blocked",
                field: "mapData.exits",
                message: `La salida en (${exit.x}, ${exit.y}) esta sobre un tile bloqueado.`,
                coordinate: { x: exit.x, y: exit.y },
            });
        } else {
            exitIndices.push(idx);
        }
    }

    const forwardTeleports = new Map<number, number[]>();
    const reverseTeleports = new Map<number, number[]>();

    for (const tp of mapData.teleports) {
        const fromIdx = toIndex(tp.fromX, tp.fromY);
        const toIdx = toIndex(tp.toX, tp.toY);

        if (blocked[fromIdx] === 1 || blocked[toIdx] === 1) {
            violations.push({
                code: "teleport_blocked",
                field: "mapData.teleports",
                message: `El teleport (${tp.fromX}, ${tp.fromY}) -> (${tp.toX}, ${tp.toY}) involucra un tile bloqueado.`,
                coordinate: { x: tp.fromX, y: tp.fromY },
            });
            continue;
        }

        const fwdList = forwardTeleports.get(fromIdx);
        if (fwdList) {
            fwdList.push(toIdx);
        } else {
            forwardTeleports.set(fromIdx, [toIdx]);
        }

        const revList = reverseTeleports.get(toIdx);
        if (revList) {
            revList.push(fromIdx);
        } else {
            reverseTeleports.set(toIdx, [fromIdx]);
        }
    }

    const visited = new Uint8Array(totalTiles);
    const queue = new Int32Array(totalTiles);
    let reachableWalkableTiles = 0;

    if (blocked[spawnIndex] === 0) {
        let head = 0;
        let tail = 0;
        visited[spawnIndex] = 1;
        queue[tail++] = spawnIndex;

        while (head < tail) {
            const current = queue[head++];
            reachableWalkableTiles += 1;

            const teleportTargets = forwardTeleports.get(current);
            if (teleportTargets && teleportTargets.length > 0) {
                for (const nextIdx of teleportTargets) {
                    if (blocked[nextIdx] === 0 && visited[nextIdx] === 0) {
                        visited[nextIdx] = 1;
                        queue[tail++] = nextIdx;
                    }
                }
                continue;
            }

            const cx = current % width;
            const cy = Math.floor(current / width);

            if (cx > 0) {
                const left = current - 1;
                if (blocked[left] === 0 && visited[left] === 0) {
                    visited[left] = 1;
                    queue[tail++] = left;
                }
            }
            if (cx + 1 < width) {
                const right = current + 1;
                if (blocked[right] === 0 && visited[right] === 0) {
                    visited[right] = 1;
                    queue[tail++] = right;
                }
            }
            if (cy > 0) {
                const up = current - width;
                if (blocked[up] === 0 && visited[up] === 0) {
                    visited[up] = 1;
                    queue[tail++] = up;
                }
            }
            if (cy + 1 < height) {
                const down = current + width;
                if (blocked[down] === 0 && visited[down] === 0) {
                    visited[down] = 1;
                    queue[tail++] = down;
                }
            }
        }

        if (reachableWalkableTiles < MIN_WALKABLE_PATH_TILES) {
            violations.push({
                code: "no_path_from_entry",
                field: "spawn",
                message: `No existe un camino transitable desde el punto de entrada (${spawn.x}, ${spawn.y}).`,
                coordinate: { x: spawn.x, y: spawn.y },
            });
        } else if (exitIndices.length > 0) {
            const reachableExits = exitIndices.filter(
                (idx) => visited[idx] === 1,
            );
            if (reachableExits.length === 0) {
                violations.push({
                    code: "no_path_from_entry",
                    field: "mapData.exits",
                    message:
                        "No existe ningun camino desde el punto de entrada hacia las salidas del mapa.",
                    coordinate: { x: spawn.x, y: spawn.y },
                });
            }
        }
    }

    let isolatedRegionCount = 0;
    let isolatedTileCount = 0;
    let firstIsolatedCoord: UserMapCoordinate | undefined;

    if (blocked[spawnIndex] === 0 && reachableWalkableTiles < walkableTilesCount) {
        const componentSeen = new Uint8Array(totalTiles);
        for (let i = 0; i < totalTiles; i += 1) {
            if (blocked[i] === 1 || visited[i] === 1 || componentSeen[i] === 1) {
                continue;
            }

            isolatedRegionCount += 1;
            if (!firstIsolatedCoord) {
                firstIsolatedCoord = toCoord(i);
            }

            let head = 0;
            let tail = 0;
            componentSeen[i] = 1;
            queue[tail++] = i;

            while (head < tail) {
                const current = queue[head++];
                isolatedTileCount += 1;

                const cx = current % width;
                const cy = Math.floor(current / width);

                if (cx > 0) {
                    const left = current - 1;
                    if (
                        blocked[left] === 0 &&
                        visited[left] === 0 &&
                        componentSeen[left] === 0
                    ) {
                        componentSeen[left] = 1;
                        queue[tail++] = left;
                    }
                }
                if (cx + 1 < width) {
                    const right = current + 1;
                    if (
                        blocked[right] === 0 &&
                        visited[right] === 0 &&
                        componentSeen[right] === 0
                    ) {
                        componentSeen[right] = 1;
                        queue[tail++] = right;
                    }
                }
                if (cy > 0) {
                    const up = current - width;
                    if (
                        blocked[up] === 0 &&
                        visited[up] === 0 &&
                        componentSeen[up] === 0
                    ) {
                        componentSeen[up] = 1;
                        queue[tail++] = up;
                    }
                }
                if (cy + 1 < height) {
                    const down = current + width;
                    if (
                        blocked[down] === 0 &&
                        visited[down] === 0 &&
                        componentSeen[down] === 0
                    ) {
                        componentSeen[down] = 1;
                        queue[tail++] = down;
                    }
                }
            }
        }

        if (isolatedTileCount > 0) {
            violations.push({
                code: "isolated_walkable_region",
                field: "mapData",
                message: `El mapa contiene ${isolatedRegionCount} region(es) aislada(s) (${isolatedTileCount} tiles inalcanzables desde la entrada).`,
                coordinate: firstIsolatedCoord,
            });
        }
    }

    let trapTileCount = 0;
    let firstTrapCoord: UserMapCoordinate | undefined;

    if (blocked[spawnIndex] === 0) {
        const canEscape = new Uint8Array(totalTiles);
        let head = 0;
        let tail = 0;

        canEscape[spawnIndex] = 1;
        queue[tail++] = spawnIndex;

        for (const exitIdx of exitIndices) {
            if (visited[exitIdx] === 1 && canEscape[exitIdx] === 0) {
                canEscape[exitIdx] = 1;
                queue[tail++] = exitIdx;
            }
        }

        while (head < tail) {
            const current = queue[head++];
            const cx = current % width;
            const cy = Math.floor(current / width);

            const stepBack = (candidate: number): void => {
                if (blocked[candidate] === 1 || canEscape[candidate] === 1) {
                    return;
                }
                // Si el candidato es origen de un teleport forzado, pisarlo no
                // camina al vecino sino que dispara el teleport; su escape se
                // resuelve unicamente por reverseTeleports.
                if (forwardTeleports.has(candidate)) {
                    return;
                }
                canEscape[candidate] = 1;
                queue[tail++] = candidate;
            };

            if (cx > 0) stepBack(current - 1);
            if (cx + 1 < width) stepBack(current + 1);
            if (cy > 0) stepBack(current - width);
            if (cy + 1 < height) stepBack(current + width);

            const incomingTeleports = reverseTeleports.get(current);
            if (incomingTeleports) {
                for (const originIdx of incomingTeleports) {
                    if (blocked[originIdx] === 0 && canEscape[originIdx] === 0) {
                        canEscape[originIdx] = 1;
                        queue[tail++] = originIdx;
                    }
                }
            }
        }

        for (let i = 0; i < totalTiles; i += 1) {
            if (visited[i] === 1 && canEscape[i] === 0) {
                trapTileCount += 1;
                if (!firstTrapCoord) {
                    firstTrapCoord = toCoord(i);
                }
            }
        }

        if (trapTileCount > 0) {
            violations.push({
                code: "inescapable_trap",
                field: "mapData.teleports",
                message: `El mapa contiene una trampa sin salida (${trapTileCount} tiles de los que no se puede escapar).`,
                coordinate: firstTrapCoord,
            });
        }
    }

    return {
        ok: violations.length === 0,
        diagnostics: {
            totalTiles,
            walkableTiles: walkableTilesCount,
            blockedTiles: blockedTilesCount,
            reachableWalkableTiles,
            isolatedRegionCount,
            isolatedTileCount,
            trapTileCount,
        },
        violations,
    };
}

export const mapGeometryChecks = {
    validateGeometryAndReachability: runGeometryAndReachabilityImpl,
};

export function validateGeometryAndReachability(
    target: NormalizedMapValidationTarget,
): GeometryCheckResult {
    return mapGeometryChecks.validateGeometryAndReachability(target);
}

/**
 * Ejecuta todos los pre-chequeos automaticos antes de admitir un mapa en la
 * cola humana de moderacion.
 *
 * Orden estricto:
 *   1. Dimensiones enteras y cuotas (corta antes de tocar texto o BFS).
 *   2. Lista de palabras prohibidas en nombre, descripcion, carteles y NPCs.
 *   3. Geometria y alcanzabilidad BFS sobre grilla acotada (<= 100x100).
 */
export function runAutomatedMapChecks(
    input: MapValidationInput,
    options: QuotaCheckOptions & BannedWordsCheckOptions = {},
): AutomatedMapCheckResult {
    const boundsResult = validateBoundsAndQuotas(input, options);
    if (!boundsResult.ok) {
        return {
            ok: false,
            stage: "bounds_and_quotas",
            violations: boundsResult.violations,
            diagnostics: null,
        };
    }

    const bannedViolations = validateBannedWords(
        boundsResult.normalized,
        options,
    );
    if (bannedViolations.length > 0) {
        return {
            ok: false,
            stage: "banned_words",
            violations: bannedViolations,
            diagnostics: null,
        };
    }

    const geometryResult = mapGeometryChecks.validateGeometryAndReachability(
        boundsResult.normalized,
    );
    if (!geometryResult.ok) {
        return {
            ok: false,
            stage: "geometry",
            violations: geometryResult.violations,
            diagnostics: geometryResult.diagnostics,
        };
    }

    return {
        ok: true,
        stage: "passed",
        normalized: boundsResult.normalized,
        diagnostics: geometryResult.diagnostics,
        violations: [],
    };
}
