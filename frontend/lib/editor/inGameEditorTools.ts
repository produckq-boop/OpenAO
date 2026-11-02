import type { GraphicData, GraphicsDB, MapTile } from "../../types/game";
import { TILE_SIZE } from "../viewport";
import type {
    MapTileOverride,
    TilePaint,
    UploadedGraphic,
} from "./editorApi";
import type { TerrainBrush } from "./editorStore";

/** Tope de entradas por lote aceptado por `PUT /maps/:mapNum/tiles`. */
export const PAINT_BATCH_SIZE = 500;
export const EDITOR_LAYER_NUMBERS = [1, 2, 3, 4] as const;

export type DrawMode = "brush" | "rect";

export type TileCoord = {
    x: number;
    y: number;
};

export type MapDimensions = {
    width: number;
    height: number;
};

export type TileRectBounds = {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    width: number;
    height: number;
    tileCount: number;
};

export type DraftTileExit = {
    x: number;
    y: number;
    targetMap: number;
    targetX: number;
    targetY: number;
};

export type PlayerCountSummary = {
    totalPlayers: number;
    otherPlayers: number;
};

export function makeTileKey(x: number, y: number): string {
    return `${x},${y}`;
}

/**
 * Convierte coordenadas locales de `mapContainer` (en pixeles del mundo) al
 * tile 1-based del mapa, devolviendo `null` cuando cae fuera de los limites.
 */
export function localPixelToTile(
    localX: number,
    localY: number,
    dimensions: MapDimensions,
    tileSize = TILE_SIZE,
): TileCoord | null {
    if (
        !Number.isFinite(localX) ||
        !Number.isFinite(localY) ||
        dimensions.width <= 0 ||
        dimensions.height <= 0 ||
        tileSize <= 0
    ) {
        return null;
    }

    const tileX = Math.floor(localX / tileSize) + 1;
    const tileY = Math.floor(localY / tileSize) + 1;

    if (
        tileX < 1 ||
        tileX > dimensions.width ||
        tileY < 1 ||
        tileY > dimensions.height
    ) {
        return null;
    }

    return { x: tileX, y: tileY };
}

/**
 * Igual que `localPixelToTile`, pero sujeta el resultado al borde del mapa para
 * no perder una seleccion rectangular si el puntero sale apenas del lienzo.
 */
export function clampLocalPixelToTile(
    localX: number,
    localY: number,
    dimensions: MapDimensions,
    tileSize = TILE_SIZE,
): TileCoord | null {
    if (
        !Number.isFinite(localX) ||
        !Number.isFinite(localY) ||
        dimensions.width <= 0 ||
        dimensions.height <= 0 ||
        tileSize <= 0
    ) {
        return null;
    }

    const rawX = Math.floor(localX / tileSize) + 1;
    const rawY = Math.floor(localY / tileSize) + 1;

    return {
        x: Math.max(1, Math.min(dimensions.width, rawX)),
        y: Math.max(1, Math.min(dimensions.height, rawY)),
    };
}

export function computeTileRectBounds(
    start: TileCoord,
    end: TileCoord,
): TileRectBounds {
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;

    return {
        minX,
        maxX,
        minY,
        maxY,
        width,
        height,
        tileCount: width * height,
    };
}

export function expandTileRectCoords(bounds: TileRectBounds): TileCoord[] {
    const coords: TileCoord[] = [];

    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
        for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
            coords.push({ x, y });
        }
    }

    return coords;
}

/**
 * Expande un pincel de terreno sobre una lista de tiles respetando las capas
 * definidas por la entrada de paleta y aplicando el bloqueo sobre la capa 1.
 */
export function buildBrushTilePaints(
    coords: ReadonlyArray<TileCoord>,
    brush: Pick<TerrainBrush, "graphics" | "blocked">,
): TilePaint[] {
    const paints: TilePaint[] = [];
    const seen = new Set<string>();
    const layers = brush.graphics.slice(0, EDITOR_LAYER_NUMBERS.length);

    for (const coord of coords) {
        const key = makeTileKey(coord.x, coord.y);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);

        layers.forEach((grhIndex, index) => {
            const layer = index + 1;
            paints.push({
                x: coord.x,
                y: coord.y,
                layer,
                grhIndex,
                blocked: layer === 1 ? brush.blocked : null,
            });
        });
    }

    return paints;
}

export function chunkTilePaints(
    tiles: ReadonlyArray<TilePaint>,
    batchSize = PAINT_BATCH_SIZE,
): TilePaint[][] {
    const safeBatchSize = Math.max(1, Math.floor(batchSize));
    const chunks: TilePaint[][] = [];

    for (let index = 0; index < tiles.length; index += safeBatchSize) {
        chunks.push(tiles.slice(index, index + safeBatchSize));
    }

    return chunks;
}

export function resolveEffectiveTileBlocked(
    baseBlocked: number | boolean | undefined,
    overridesForTile: ReadonlyArray<Pick<MapTileOverride, "blocked">>,
): { blocked: boolean; overridden: boolean } {
    let overrideBlocked: boolean | null = null;

    for (const entry of overridesForTile) {
        if (entry.blocked !== null && entry.blocked !== undefined) {
            overrideBlocked = entry.blocked;
        }
    }

    if (overrideBlocked !== null) {
        return { blocked: overrideBlocked, overridden: true };
    }

    return { blocked: Boolean(baseBlocked), overridden: false };
}

/**
 * Arma la entrada `GraphicData` de un PNG recien subido para inyectarla en
 * `engine.graphicsDB` sin recargar la sesion de `/play`.
 */
export function createUploadedGraphicEntry(
    uploaded: Pick<UploadedGraphic, "grhIndex" | "width" | "height">,
): GraphicData {
    const fileId = String(uploaded.grhIndex);

    return {
        numFrames: 1,
        numFile: fileId,
        sX: 0,
        sY: 0,
        width: Math.max(1, uploaded.width),
        height: Math.max(1, uploaded.height),
        frames: { "1": fileId },
        offset: { x: 0, y: 0 },
    };
}

export function registerUploadedGraphicInCatalog(
    graphicsDB: GraphicsDB | null | undefined,
    uploaded: Pick<UploadedGraphic, "grhIndex" | "width" | "height">,
): GraphicData {
    const entry = createUploadedGraphicEntry(uploaded);

    if (graphicsDB) {
        graphicsDB[String(uploaded.grhIndex)] = entry;
    }

    return entry;
}

type CharacterLike = {
    id: number;
    map?: number;
    isNpc?: boolean;
};

/**
 * Cuenta cuantos jugadores reales (excluyendo NPCs) estan conectados en el mapa
 * actual segun el estado vivo del `Engine`, diferenciando al propio editor del
 * resto de los jugadores presentes.
 */
export function countPlayersInMap(source: {
    mapNumber: number;
    user?: CharacterLike | null;
    personajes?: Record<string, CharacterLike | undefined> | null;
}): PlayerCountSummary {
    const playerIds = new Set<number>();
    const selfId =
        source.user && !source.user.isNpc ? source.user.id : null;

    if (
        source.user &&
        !source.user.isNpc &&
        (source.user.map === undefined || source.user.map === source.mapNumber)
    ) {
        playerIds.add(source.user.id);
    }

    for (const entity of Object.values(source.personajes ?? {})) {
        if (!entity || entity.isNpc) {
            continue;
        }

        if (entity.map === undefined || entity.map === source.mapNumber) {
            playerIds.add(entity.id);
        }
    }

    const totalPlayers = playerIds.size;
    const otherPlayers =
        selfId !== null && playerIds.has(selfId)
            ? Math.max(0, totalPlayers - 1)
            : totalPlayers;

    return { totalPlayers, otherPlayers };
}

/**
 * Reconstruye un `MapTile` combinando el tile estatico base con los overrides
 * activos y la salida en borrador del editor.
 */
export function buildEffectiveMapTile(
    baseTile: MapTile | undefined,
    tileOverrides: ReadonlyArray<MapTileOverride>,
    draftExit: DraftTileExit | null | undefined,
): MapTile {
    const nextGraphics: Record<string, number> = {
        ...(baseTile?.graphics ?? {}),
    };
    let nextBlocked = baseTile?.blocked;

    for (const override of tileOverrides) {
        const layerKey = String(override.layer);
        if (override.grhIndex == null) {
            delete nextGraphics[layerKey];
        } else {
            nextGraphics[layerKey] = override.grhIndex;
        }

        if (override.blocked != null) {
            nextBlocked = override.blocked ? 1 : 0;
        }
    }

    const nextTile: MapTile = {};

    if (nextBlocked !== undefined) {
        nextTile.blocked = nextBlocked;
    }

    if (Object.keys(nextGraphics).length > 0) {
        nextTile.graphics = nextGraphics;
    }

    if (baseTile?.trigger !== undefined) {
        nextTile.trigger = baseTile.trigger;
    }

    if (baseTile?.npcIndex !== undefined) {
        nextTile.npcIndex = baseTile.npcIndex;
    }

    if (baseTile?.objInfo !== undefined) {
        nextTile.objInfo = { ...baseTile.objInfo };
    }

    if (draftExit) {
        nextTile.tileExit = {
            map: draftExit.targetMap,
            x: draftExit.targetX,
            y: draftExit.targetY,
        };
    } else if (baseTile?.tileExit) {
        nextTile.tileExit = { ...baseTile.tileExit };
    }

    return nextTile;
}

export function tileVisualSignature(tile: MapTile | undefined): string {
    const g1 = tile?.graphics?.["1"] ?? 0;
    const g2 = tile?.graphics?.["2"] ?? 0;
    const g3 = tile?.graphics?.["3"] ?? 0;
    const g4 = tile?.graphics?.["4"] ?? 0;
    const blocked = tile?.blocked ?? 0;
    const obj = tile?.objInfo
        ? `${tile.objInfo.objIndex}:${tile.objInfo.amount}`
        : "";
    const exit = tile?.tileExit
        ? `${tile.tileExit.map}:${tile.tileExit.x}:${tile.tileExit.y}`
        : "";

    return `${g1}|${g2}|${g3}|${g4}|${blocked}|${obj}|${exit}`;
}
