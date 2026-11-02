import fs from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import path from "path";
import { reloadNpcsDiff, reloadObjectsDiff } from "./gameDataSync";
import type { GameApi } from "./game";
import type { HandleProtocolApi } from "./handleProtocol";
import { clearNpcRespawnCooldown } from "./npcRespawnCooldowns";
import type { SocketApi } from "./socket";
import type {
    DropItem,
    EntityId,
    MapObjectInfo,
    Position,
    RuntimeCharacter,
    RuntimeCharacters,
    RuntimeClient,
    RuntimeClients,
    RuntimeNpc,
    RuntimeNpcs,
    TradeItem,
} from "./types/runtime";

const _ = require("lodash");
const funct = require("./functions");
const game = require("./game") as GameApi;
const handleProtocol = require("./handleProtocol") as HandleProtocolApi;
const login = require("./login") as { createId: () => number };
const npcs = require("./npcs") as {
    createNpc: () => RuntimeNpc;
    loopArea: (idNpc: EntityId, callback: (user: RuntimeCharacter) => void) => void;
};
const socket = require("./socket") as SocketApi;
const vars = require("./vars");

const DEFAULT_MAPS_SOURCE_DIR = path.join(__dirname, "../mapas_source");
const RELOCATED_PLAYER_MESSAGE = "[Mundo] El mapa fue actualizado y fuiste reubicado a una posición segura.";

const BFS_DIRECTIONS: ReadonlyArray<Position> = [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
];

export type PublishedTileOverride = {
    x: number;
    y: number;
    layer: number;
    grhIndex: number | null;
    blocked: boolean | null;
    status?: "draft" | "published";
};

export type PublishedTileEntity = {
    x: number;
    y: number;
    kind: "obj" | "npc";
    entityId: number;
    status?: "draft" | "published";
};

export type PublishedMapSnapshot = {
    mapNum: number;
    version: number;
    overrides: PublishedTileOverride[];
    entities: PublishedTileEntity[];
};

export type AllPublishedMapsSnapshotResponse = {
    currentVersion: number;
    maps: Array<{
        mapNum: number;
        overrides: PublishedTileOverride[];
        entities: PublishedTileEntity[];
    }>;
};

export type MapLiveReloadResult = {
    mapNum: number;
    version: number;
    appliedOverrides: number;
    blockedChanges: number;
    spawnedObjects: number;
    removedObjects: number;
    spawnedNpcs: number;
    removedNpcs: number;
    relocatedPlayers: number;
    skippedStale?: boolean;
};

export type InitializePublishedMapsResult = {
    currentVersion: number;
    hydratedMaps: number;
    appliedOverrides: number;
    appliedEntities: number;
};

export type ApplyPublishedMapOptions = {
    isBootHydration?: boolean;
    mapsSourceDir?: string;
    ensureObjectTemplateLoaded?: (objId: number) => Promise<void>;
    ensureNpcTemplateLoaded?: (npcId: number) => Promise<void>;
};

type MapMetadata = {
    name?: string;
    musicNum?: number;
    magiaSinEfecto?: number;
    noEncriptarMp?: number;
    terreno?: string;
    zona?: string;
    restringir?: string | number;
    minLevel?: number;
    maxLevel?: number;
    backup?: number;
    pk?: number;
};

type TerrainTile = {
    blocked?: boolean;
    graphics?: number | Array<number | null>;
};

type TerrainMap = {
    width?: number;
    height?: number;
    palette?: Record<string, TerrainTile>;
    rows?: number[][];
};

type TileExitDestination = {
    map?: number;
    x?: number;
    y?: number;
};

type TileExitConfig = TileExitDestination | TileExitDestination[] | { destinations?: TileExitDestination[] };

type SpecialsMap = {
    exits?: Record<string, TileExitConfig>;
    objects?: Record<string, { objIndex?: number; amount?: number }>;
    npcs?: Record<string, number>;
    triggers?: Record<string, number>;
};

type RuntimeMapTile = {
    blocked?: number;
    graphics?: Record<number, number>;
    tileExit?:
        | { map: number; x: number; y: number }
        | { destinations: Array<{ map: number; x: number; y: number }> };
    objInfo?: MapObjectInfo;
    npcIndex?: number;
    trigger?: number;
};

type NpcTemplateRecord = {
    name?: string;
    idBody?: number;
    idHead?: number;
    movement?: number;
    npcType?: number;
    exp?: number;
    gold?: number;
    hp?: number;
    maxHp?: number;
    minHit?: number;
    maxHit?: number;
    def?: number;
    defM?: number;
    magicDef?: number;
    magicResistance?: number;
    poderAtaque?: number;
    poderEvasion?: number;
    snd1?: number;
    snd2?: number;
    soundClose?: number;
    spellCastIntervalMs?: number;
    spellRange?: number;
    spells?: Array<{ idSpell?: number; cooldownSeconds?: number }>;
    drop?: DropItem[];
    objs?: Record<string, TradeItem>;
    aguaValida?: number | boolean;
    tierraInvalida?: number | boolean;
    desc?: string;
};

type TrackedWorldBuilderNpcSpawn = {
    x: number;
    y: number;
    entityId: number;
};

const appliedVersionByMap = new Map<number, number>();
const activeWorldBuilderNpcSpawnsByMap = new Map<number, Map<string, TrackedWorldBuilderNpcSpawn>>();
const reloadChainsByMap = new Map<number, Promise<MapLiveReloadResult>>();

function toNumber(value: unknown, fallback = 0): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return fallback;
}

function normalizeGraphics(graphics: unknown): Record<number, number> | undefined {
    if (typeof graphics === "number" && Number.isFinite(graphics)) {
        return { 1: graphics };
    }

    if (!Array.isArray(graphics)) {
        return undefined;
    }

    const normalizedGraphics: Record<number, number> = {};

    for (let index = 0; index < graphics.length; index++) {
        const value = graphics[index];
        if (typeof value === "number" && Number.isFinite(value)) {
            normalizedGraphics[index + 1] = value;
        }
    }

    return Object.keys(normalizedGraphics).length > 0 ? normalizedGraphics : undefined;
}

function parseCoordinateKey(key: string): Position | null {
    const [rawX, rawY] = key.split(",");
    const x = Number.parseInt(rawX ?? "", 10);
    const y = Number.parseInt(rawY ?? "", 10);

    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || y < 1) {
        return null;
    }

    return { x, y };
}

function normalizeTileExitDestinations(exit: TileExitConfig | undefined): Array<{ map: number; x: number; y: number }> {
    let rawDestinations: TileExitDestination[] = [];

    if (Array.isArray(exit)) {
        rawDestinations = exit;
    } else if (exit && typeof exit === "object" && "destinations" in exit && Array.isArray(exit.destinations)) {
        rawDestinations = exit.destinations;
    } else if (exit && typeof exit === "object") {
        rawDestinations = [exit as TileExitDestination];
    }

    const destinations: Array<{ map: number; x: number; y: number }> = [];

    for (const destination of rawDestinations) {
        const map = toNumber(destination?.map, Number.NaN);
        const x = toNumber(destination?.x, Number.NaN);
        const y = toNumber(destination?.y, Number.NaN);

        if (!Number.isFinite(map) || !Number.isFinite(x) || !Number.isFinite(y)) {
            continue;
        }

        destinations.push({ map, x, y });
    }

    return destinations;
}

function getMapDirectory(mapNum: number, mapsSourceDir = DEFAULT_MAPS_SOURCE_DIR): string {
    return path.join(mapsSourceDir, `mapa_${mapNum}`);
}

export function baselineMapExists(mapNum: number, mapsSourceDir = DEFAULT_MAPS_SOURCE_DIR): boolean {
    const mapDir = getMapDirectory(mapNum, mapsSourceDir);
    return fs.existsSync(path.join(mapDir, "meta.json")) && fs.existsSync(path.join(mapDir, "terrain.json"));
}

function ensureRuntimeTile(mapId: number, x: number, y: number): RuntimeMapTile {
    if (!vars.mapa[mapId]) {
        vars.mapa[mapId] = {};
    }

    if (!vars.mapa[mapId][y]) {
        vars.mapa[mapId][y] = {};
    }

    if (!vars.mapa[mapId][y][x]) {
        vars.mapa[mapId][y][x] = {};
    }

    return vars.mapa[mapId][y][x] as RuntimeMapTile;
}

function rebuildBaselineMap(mapNum: number, mapsSourceDir: string): { width: number; height: number } {
    const mapDir = getMapDirectory(mapNum, mapsSourceDir);
    const metaPath = path.join(mapDir, "meta.json");
    const terrainPath = path.join(mapDir, "terrain.json");

    if (!fs.existsSync(metaPath) || !fs.existsSync(terrainPath)) {
        throw new Error(`El mapa ${mapNum} no existe en mapas_source.`);
    }

    const metadata = JSON.parse(fs.readFileSync(metaPath, "utf8")) as MapMetadata;
    const terrain = JSON.parse(fs.readFileSync(terrainPath, "utf8")) as TerrainMap;
    const specialsPath = path.join(mapDir, "specials.json");
    const specials = fs.existsSync(specialsPath)
        ? (JSON.parse(fs.readFileSync(specialsPath, "utf8")) as SpecialsMap)
        : ({ exits: {}, objects: {}, npcs: {}, triggers: {} } as SpecialsMap);

    const palette = terrain.palette ?? {};
    const rows = Array.isArray(terrain.rows) ? terrain.rows : [];
    const width = Math.max(1, toNumber(terrain.width, 100));
    const height = Math.max(1, toNumber(terrain.height, 100));

    const existingMapData = vars.mapData[mapNum];
    if (!existingMapData) {
        vars.mapData[mapNum] = [];
    }

    vars.mapa[mapNum] = {};

    const gridWidth = Math.max(100, width);
    const gridHeight = Math.max(100, height);

    for (let y = 1; y <= gridHeight; y++) {
        if (!vars.mapData[mapNum][y]) {
            vars.mapData[mapNum][y] = [];
        }

        for (let x = 1; x <= gridWidth; x++) {
            if (!vars.mapData[mapNum][y][x]) {
                vars.mapData[mapNum][y][x] = { id: 0 };
            }
        }
    }

    for (let y = 1; y <= height; y++) {
        vars.mapa[mapNum][y] = {};

        const row = Array.isArray(rows[y - 1]) ? rows[y - 1] : [];

        for (let x = 1; x <= width; x++) {
            const runtimeTile: RuntimeMapTile = {};
            const paletteId = toNumber(row[x - 1], 0);
            const paletteTile = paletteId > 0 ? palette[String(paletteId)] : undefined;
            const graphics = normalizeGraphics(paletteTile?.graphics);

            if (paletteTile?.blocked) {
                runtimeTile.blocked = 1;
            }

            if (graphics) {
                runtimeTile.graphics = graphics;
            }

            vars.mapa[mapNum][y][x] = runtimeTile;
        }
    }

    for (const [coordinateKey, exit] of Object.entries(specials.exits ?? {})) {
        const coordinates = parseCoordinateKey(coordinateKey);
        if (!coordinates) {
            continue;
        }

        const destinations = normalizeTileExitDestinations(exit);
        if (destinations.length === 0) {
            continue;
        }

        const tile = ensureRuntimeTile(mapNum, coordinates.x, coordinates.y);
        tile.tileExit = destinations.length === 1 ? destinations[0] : { destinations };
    }

    for (const [coordinateKey, objectInfo] of Object.entries(specials.objects ?? {})) {
        const coordinates = parseCoordinateKey(coordinateKey);
        if (!coordinates) {
            continue;
        }

        const tile = ensureRuntimeTile(mapNum, coordinates.x, coordinates.y);
        tile.objInfo = {
            objIndex: toNumber(objectInfo.objIndex),
            amount: Math.max(1, toNumber(objectInfo.amount, 1)),
        };
    }

    for (const [coordinateKey, npcIndex] of Object.entries(specials.npcs ?? {})) {
        const coordinates = parseCoordinateKey(coordinateKey);
        if (!coordinates) {
            continue;
        }

        const tile = ensureRuntimeTile(mapNum, coordinates.x, coordinates.y);
        tile.npcIndex = toNumber(npcIndex);
    }

    for (const [coordinateKey, trigger] of Object.entries(specials.triggers ?? {})) {
        const coordinates = parseCoordinateKey(coordinateKey);
        if (!coordinates) {
            continue;
        }

        const tile = ensureRuntimeTile(mapNum, coordinates.x, coordinates.y);
        tile.trigger = toNumber(trigger);
    }

    vars.mapData[mapNum].name = metadata.name || "";
    vars.mapData[mapNum].musicNum = toNumber(metadata.musicNum);
    vars.mapData[mapNum].magiaSinEfecto = toNumber(metadata.magiaSinEfecto);
    vars.mapData[mapNum].noEncriptarMp = toNumber(metadata.noEncriptarMp);
    vars.mapData[mapNum].terreno = metadata.terreno || "";
    vars.mapData[mapNum].zona = metadata.zona || "";
    vars.mapData[mapNum].restringir = metadata.restringir || 0;
    vars.mapData[mapNum].minLevel = toNumber(metadata.minLevel);
    vars.mapData[mapNum].maxLevel = toNumber(metadata.maxLevel);
    vars.mapData[mapNum].backup = toNumber(metadata.backup);
    vars.mapData[mapNum].pk = toNumber(metadata.pk);

    return { width, height };
}

function isSameEntityId(left: EntityId | undefined, right: EntityId | undefined): boolean {
    if (typeof left === "undefined" || typeof right === "undefined") {
        return false;
    }

    return String(left) === String(right);
}

export function findNearestWalkableTile(
    mapNum: number,
    originX: number,
    originY: number,
    aguaValida: boolean,
    ignoreOccupantId?: EntityId,
): Position | undefined {
    const queue: Position[] = [{ x: originX, y: originY }];
    const visited = new Set<string>([`${originX},${originY}`]);

    let head = 0;
    while (head < queue.length) {
        const current = queue[head++]!;
        const tile = vars.mapa[mapNum]?.[current.y]?.[current.x] as RuntimeMapTile | undefined;

        if (
            tile &&
            typeof tile.tileExit === "undefined" &&
            game.legalPos(current.x, current.y, mapNum, aguaValida, ignoreOccupantId)
        ) {
            return { x: current.x, y: current.y };
        }

        for (const delta of BFS_DIRECTIONS) {
            const nextX = current.x + delta.x;
            const nextY = current.y + delta.y;

            if (nextX < 1 || nextX > 100 || nextY < 1 || nextY > 100) {
                continue;
            }

            const key = `${nextX},${nextY}`;
            if (visited.has(key)) {
                continue;
            }

            visited.add(key);
            queue.push({ x: nextX, y: nextY });
        }
    }

    return undefined;
}

function isLegalNpcTile(
    mapNum: number,
    x: number,
    y: number,
    aguaValida: boolean,
    tierraInvalida: boolean,
    movement: number,
    ignoreOccupantId?: EntityId,
): boolean {
    if (x < 1 || x > 100 || y < 1 || y > 100) {
        return false;
    }

    const tile = vars.mapa[mapNum]?.[y]?.[x] as RuntimeMapTile | undefined;
    if (!tile || typeof tile.tileExit !== "undefined") {
        return false;
    }

    const occupantId = vars.mapData[mapNum]?.[y]?.[x]?.id as EntityId | 0 | undefined;
    if (occupantId && !isSameEntityId(occupantId, ignoreOccupantId)) {
        return false;
    }

    const isWater = Boolean(game.hayAgua(mapNum, { x, y }));
    const allowBlocked = movement !== 3;
    const isBlocked = Boolean(tile.blocked);

    if (aguaValida && tierraInvalida) {
        return isWater && (allowBlocked || !isBlocked);
    }

    if (aguaValida) {
        return isWater || allowBlocked || !isBlocked;
    }

    return !isWater && (allowBlocked || !isBlocked);
}

function findNearestWalkableNpcTile(
    mapNum: number,
    originX: number,
    originY: number,
    aguaValida: boolean,
    tierraInvalida: boolean,
    movement: number,
    ignoreOccupantId?: EntityId,
): Position | undefined {
    const queue: Position[] = [{ x: originX, y: originY }];
    const visited = new Set<string>([`${originX},${originY}`]);

    let head = 0;
    while (head < queue.length) {
        const current = queue[head++]!;

        if (isLegalNpcTile(mapNum, current.x, current.y, aguaValida, tierraInvalida, movement, ignoreOccupantId)) {
            return { x: current.x, y: current.y };
        }

        for (const delta of BFS_DIRECTIONS) {
            const nextX = current.x + delta.x;
            const nextY = current.y + delta.y;

            if (nextX < 1 || nextX > 100 || nextY < 1 || nextY > 100) {
                continue;
            }

            const key = `${nextX},${nextY}`;
            if (visited.has(key)) {
                continue;
            }

            visited.add(key);
            queue.push({ x: nextX, y: nextY });
        }
    }

    return undefined;
}

function getAllConnectedGameClients(): RuntimeClient[] {
    const clients: RuntimeClient[] = [];
    const clientMap = (vars.clients ?? {}) as RuntimeClients;

    for (const [clientId, client] of Object.entries(clientMap)) {
        if (!client || client.bot || client.readyState !== client.OPEN) {
            continue;
        }

        const character = (vars.personajes as RuntimeCharacters)?.[clientId];
        if (!character || character.cerrado) {
            continue;
        }

        clients.push(client);
    }

    return clients;
}

function getConnectedClientsOnMap(mapNum: number): RuntimeClient[] {
    const clients: RuntimeClient[] = [];
    const clientMap = (vars.clients ?? {}) as RuntimeClients;
    const characters = (vars.personajes ?? {}) as RuntimeCharacters;

    for (const [clientId, client] of Object.entries(clientMap)) {
        if (!client || client.bot || client.readyState !== client.OPEN) {
            continue;
        }

        const character = characters[clientId];
        if (!character || character.cerrado || Number(character.map) !== mapNum) {
            continue;
        }

        clients.push(client);
    }

    return clients;
}

function isInvisibleToHostileNpc(character: RuntimeCharacter): boolean {
    return Boolean(
        character.dead ||
            character.invisibleSpell ||
            character.hiddenSkill ||
            (character.privileges === 1 && character.invisibleAdmin),
    );
}

function despawnLiveNpc(npc: RuntimeNpc): void {
    const npcId = npc.id;
    const characters = (vars.personajes ?? {}) as RuntimeCharacters;
    const allNpcs = (vars.npcs ?? {}) as RuntimeNpcs;

    for (const character of Object.values(characters)) {
        if (!character) {
            continue;
        }

        if (isSameEntityId(character.summonTargetNpcId as EntityId | undefined, npcId)) {
            game.clearSummonTargetNpc(character.id);
            character.summonTargetNpcId = 0;
        }
    }

    for (const otherNpc of Object.values(allNpcs)) {
        if (!otherNpc || isSameEntityId(otherNpc.id, npcId)) {
            continue;
        }

        if (isSameEntityId(otherNpc.currentTargetId as EntityId | undefined, npcId)) {
            otherNpc.currentTargetId = 0;
            otherNpc.currentTargetLockedUntil = 0;
        }

        if (isSameEntityId(otherNpc.reservedAttackTargetId as EntityId | undefined, npcId)) {
            otherNpc.reservedAttackTargetId = 0;
            otherNpc.reservedAttackPos = undefined;
            otherNpc.attackReservationExpiresAt = 0;
        }

        if (isSameEntityId(otherNpc.lastAggressorId as EntityId | undefined, npcId)) {
            otherNpc.lastAggressorId = 0;
            otherNpc.lastAggressedAt = 0;
        }
    }

    npc.currentTargetId = 0;
    npc.currentTargetLockedUntil = 0;
    npc.lastAggressorId = 0;
    npc.lastAggressedAt = 0;
    npc.reservedAttackTargetId = 0;
    npc.reservedAttackPos = undefined;
    npc.attackReservationExpiresAt = 0;
    npc.rute = [];

    const currentCell = vars.mapData[npc.map]?.[npc.pos.y]?.[npc.pos.x];
    if (currentCell && isSameEntityId(currentCell.id as EntityId | undefined, npcId)) {
        currentCell.id = 0;
    }

    const notifiedClients = new Set<RuntimeClient>();
    const notifyDelete = (client: RuntimeClient | undefined) => {
        if (!client || client.bot || client.readyState !== client.OPEN || notifiedClients.has(client)) {
            return;
        }

        notifiedClients.add(client);
        handleProtocol.deleteCharacter(npcId, client);
    };

    const npcArea = Array.isArray(vars.areaNpc?.[npcId]) ? (vars.areaNpc[npcId] as EntityId[]) : [];
    for (const userId of npcArea) {
        notifyDelete((vars.clients as RuntimeClients)?.[String(userId)]);
    }

    for (const client of getConnectedClientsOnMap(npc.map)) {
        notifyDelete(client);
    }

    delete vars.areaNpc[npcId];
    delete vars.npcs[npcId];
}

function spawnWorldBuilderNpc(
    mapNum: number,
    x: number,
    y: number,
    npcIndex: number,
    spawnKey: string,
    notifyPlayers: boolean,
): RuntimeNpc | null {
    const datNpc = vars.datNpc?.[npcIndex] as NpcTemplateRecord | undefined;
    if (!datNpc || !vars.mapData[mapNum]) {
        return null;
    }

    const tmpNPC = _.cloneDeep(npcs.createNpc()) as RuntimeNpc;
    tmpNPC.id = login.createId();
    tmpNPC.templateNpcIndex = Number(npcIndex);
    tmpNPC.spawnMapNum = Number(mapNum);
    tmpNPC.spawnOrigin = { x, y };
    tmpNPC.worldBuilderManaged = true;
    tmpNPC.worldBuilderSpawnKey = spawnKey;
    tmpNPC.map = mapNum;
    tmpNPC.pos = { x, y };
    tmpNPC.nameCharacter = datNpc.name;
    tmpNPC.color = "white";
    tmpNPC.isNpc = true;
    tmpNPC.idBody = datNpc.idBody;
    tmpNPC.idHead = datNpc.idHead;
    tmpNPC.movement = Number(datNpc.movement ?? 1);
    tmpNPC.npcType = Number(datNpc.npcType ?? 0);
    tmpNPC.exp = Number(datNpc.exp ?? 0);
    if (datNpc.gold) {
        tmpNPC.gold = Number(datNpc.gold);
    }
    tmpNPC.hp = Number(datNpc.hp ?? 1);
    tmpNPC.maxHp = Number(datNpc.maxHp ?? tmpNPC.hp);
    tmpNPC.minHit = Number(datNpc.minHit ?? 0);
    tmpNPC.maxHit = Number(datNpc.maxHit ?? 0);
    tmpNPC.def = Number(datNpc.def ?? 0);
    tmpNPC.defM = Number(datNpc.defM ?? datNpc.magicDef ?? 0);
    tmpNPC.magicDef = Number(datNpc.magicDef ?? datNpc.defM ?? 0);
    tmpNPC.magicResistance = Number(datNpc.magicResistance ?? 0);
    tmpNPC.poderAtaque = Number(datNpc.poderAtaque ?? 0);
    tmpNPC.poderEvasion = Number(datNpc.poderEvasion ?? 0);
    tmpNPC.snd1 = Number(datNpc.snd1 ?? 0);
    tmpNPC.snd2 = Number(datNpc.snd2 ?? 0);
    tmpNPC.soundClose = Number(datNpc.soundClose ?? 0);
    tmpNPC.spellCastIntervalMs = Number(datNpc.spellCastIntervalMs ?? 0);
    tmpNPC.spellRange = Number(datNpc.spellRange ?? 0);
    tmpNPC.spells = Array.isArray(datNpc.spells)
        ? datNpc.spells
              .filter((spell) => Number(spell?.idSpell ?? 0) > 0)
              .map((spell) => ({
                  idSpell: Number(spell.idSpell),
                  cooldownSeconds: Math.max(0, Number(spell.cooldownSeconds ?? 0)),
                  lastUsedAt: 0,
              }))
        : [];
    if (datNpc.drop) {
        tmpNPC.drop = datNpc.drop;
    }
    if (datNpc.objs) {
        tmpNPC.objs = datNpc.objs;
    }
    tmpNPC.aguaValida = datNpc.aguaValida;
    tmpNPC.tierraInvalida = datNpc.tierraInvalida ?? 0;
    if (datNpc.desc) {
        tmpNPC.desc = datNpc.desc;
    }

    const resolvedPos = findNearestWalkableNpcTile(
        mapNum,
        x,
        y,
        Boolean(tmpNPC.aguaValida),
        Boolean(tmpNPC.tierraInvalida),
        Number(tmpNPC.movement ?? 1),
    );

    if (!resolvedPos) {
        return null;
    }

    tmpNPC.pos.x = resolvedPos.x;
    tmpNPC.pos.y = resolvedPos.y;

    const clan = vars.clanNpc?.[tmpNPC.npcType];
    if (clan) {
        tmpNPC.clan = clan;
    }

    tmpNPC.cooldownAtaque = Date.now() + 4000;
    vars.npcs[tmpNPC.id] = tmpNPC;
    vars.areaNpc[tmpNPC.id] = [];
    vars.mapData[mapNum][tmpNPC.pos.y][tmpNPC.pos.x].id = tmpNPC.id;

    if (notifyPlayers) {
        const rangeX = Number(vars.areaVisionRangeX ?? 15);
        const rangeY = Number(vars.areaVisionRangeY ?? 15);
        const characters = (vars.personajes ?? {}) as RuntimeCharacters;
        const clients = (vars.clients ?? {}) as RuntimeClients;

        for (const [charId, character] of Object.entries(characters)) {
            if (!character || character.cerrado || Number(character.map) !== mapNum) {
                continue;
            }

            if (
                Math.abs(character.pos.x - tmpNPC.pos.x) > rangeX ||
                Math.abs(character.pos.y - tmpNPC.pos.y) > rangeY
            ) {
                continue;
            }

            if (tmpNPC.movement === 3 && !isInvisibleToHostileNpc(character)) {
                const areaList = vars.areaNpc[tmpNPC.id] as EntityId[];
                if (!areaList.some((entry) => isSameEntityId(entry, character.id))) {
                    areaList.push(character.id);
                }
            }

            const targetClient = clients[charId];
            if (targetClient && !targetClient.bot && targetClient.readyState === targetClient.OPEN) {
                handleProtocol.sendNpc(tmpNPC as Parameters<HandleProtocolApi["sendNpc"]>[0]);
                socket.send(targetClient);
            }
        }
    }

    return tmpNPC;
}

function relocateBlockedBaseNpcsOnMap(mapNum: number): void {
    const allNpcs = (vars.npcs ?? {}) as RuntimeNpcs;

    for (const npc of Object.values(allNpcs)) {
        if (!npc || Number(npc.map) !== mapNum || npc.summonedByUserId) {
            continue;
        }

        const movement = Number(npc.movement ?? 1);
        const validHere = isLegalNpcTile(
            mapNum,
            npc.pos.x,
            npc.pos.y,
            Boolean(npc.aguaValida),
            Boolean(npc.tierraInvalida),
            movement,
            npc.id,
        );

        if (validHere) {
            continue;
        }

        const safePos = findNearestWalkableNpcTile(
            mapNum,
            npc.pos.x,
            npc.pos.y,
            Boolean(npc.aguaValida),
            Boolean(npc.tierraInvalida),
            movement,
            npc.id,
        );

        if (!safePos) {
            continue;
        }

        const previousCell = vars.mapData[mapNum]?.[npc.pos.y]?.[npc.pos.x];
        if (previousCell && isSameEntityId(previousCell.id as EntityId | undefined, npc.id)) {
            previousCell.id = 0;
        }

        npc.pos.x = safePos.x;
        npc.pos.y = safePos.y;
        npc.rute = [];
        vars.mapData[mapNum][safePos.y][safePos.x].id = npc.id;

        npcs.loopArea(npc.id, (viewer) => {
            const viewerClient = (vars.clients as RuntimeClients)?.[String(viewer.id)];
            if (viewerClient && !viewerClient.bot && viewerClient.readyState === viewerClient.OPEN) {
                handleProtocol.actPosition(npc.id, npc.pos, viewerClient);
            }
        });
    }
}

function relocateBlockedPlayersOnMap(mapNum: number): number {
    let relocatedPlayers = 0;
    const characters = (vars.personajes ?? {}) as RuntimeCharacters;
    const clients = (vars.clients ?? {}) as RuntimeClients;

    for (const [charId, user] of Object.entries(characters)) {
        if (!user || user.cerrado || Number(user.map) !== mapNum) {
            continue;
        }

        const isSailing = Boolean(user.navegando);
        const currentTile = vars.mapa[mapNum]?.[user.pos.y]?.[user.pos.x] as RuntimeMapTile | undefined;
        const currentlyLegal =
            Boolean(currentTile) && game.legalPos(user.pos.x, user.pos.y, mapNum, isSailing, user.id);

        if (currentlyLegal) {
            continue;
        }

        const safePos =
            findNearestWalkableTile(mapNum, user.pos.x, user.pos.y, isSailing, user.id) ??
            (isSailing ? findNearestWalkableTile(mapNum, user.pos.x, user.pos.y, false, user.id) : undefined);

        if (!safePos) {
            continue;
        }

        const userClient = clients[charId];
        if (userClient && !userClient.bot && userClient.readyState === userClient.OPEN) {
            game.telep(userClient, mapNum, safePos.x, safePos.y, "mapLiveSync");
            handleProtocol.console(RELOCATED_PLAYER_MESSAGE, "#E69500", 1, 0, userClient);
        } else {
            const oldCell = vars.mapData[mapNum]?.[user.pos.y]?.[user.pos.x];
            if (oldCell && isSameEntityId(oldCell.id as EntityId | undefined, user.id)) {
                oldCell.id = 0;
            }

            user.pos.x = safePos.x;
            user.pos.y = safePos.y;
            if (vars.mapData[mapNum]?.[safePos.y]?.[safePos.x]) {
                vars.mapData[mapNum][safePos.y][safePos.x].id = user.id;
            }
        }

        relocatedPlayers++;
    }

    return relocatedPlayers;
}

export async function applyPublishedMapSnapshot(
    mapNum: number,
    snapshot: PublishedMapSnapshot,
    options?: ApplyPublishedMapOptions,
): Promise<MapLiveReloadResult> {
    const isBootHydration = Boolean(options?.isBootHydration);
    const mapsSourceDir = options?.mapsSourceDir ?? DEFAULT_MAPS_SOURCE_DIR;
    const ensureObjectTemplateLoaded =
        options?.ensureObjectTemplateLoaded ??
        (async (objId: number) => {
            if (!vars.datObj?.[objId]) {
                await reloadObjectsDiff();
            }
        });
    const ensureNpcTemplateLoaded =
        options?.ensureNpcTemplateLoaded ??
        (async (npcId: number) => {
            if (!vars.datNpc?.[npcId]) {
                await reloadNpcsDiff();
            }
        });

    const incomingVersion = Math.max(0, Number(snapshot.version ?? 0));
    const previousAppliedVersion = appliedVersionByMap.get(mapNum) ?? 0;

    if (!isBootHydration && incomingVersion > 0 && incomingVersion < previousAppliedVersion) {
        return {
            mapNum,
            version: previousAppliedVersion,
            appliedOverrides: 0,
            blockedChanges: 0,
            spawnedObjects: 0,
            removedObjects: 0,
            spawnedNpcs: 0,
            removedNpcs: 0,
            relocatedPlayers: 0,
            skippedStale: true,
        };
    }

    const previousBlockedByCoord = new Map<string, boolean>();
    const previousObjIndexByCoord = new Map<string, number>();
    const droppedItemsByCoord = new Map<string, MapObjectInfo>();

    const existingMapTiles = vars.mapa[mapNum] as
        | Record<number, Record<number, RuntimeMapTile | undefined> | undefined>
        | undefined;
    if (existingMapTiles) {
        for (const [rawY, row] of Object.entries(existingMapTiles)) {
            if (!row) {
                continue;
            }

            const y = Number(rawY);
            for (const [rawX, tile] of Object.entries(row)) {
                const x = Number(rawX);
                const coordKey = `${x},${y}`;
                previousBlockedByCoord.set(coordKey, Boolean(tile?.blocked));
                previousObjIndexByCoord.set(coordKey, Number(tile?.objInfo?.objIndex ?? 0));

                if (tile?.objInfo?.cleanupSource === "drop") {
                    droppedItemsByCoord.set(coordKey, { ...tile.objInfo });
                }
            }
        }
    }

    const { width, height } = rebuildBaselineMap(mapNum, mapsSourceDir);

    const publishedOverrides = (snapshot.overrides ?? []).filter(
        (entry) => entry.status === undefined || entry.status === "published",
    );
    const publishedEntities = (snapshot.entities ?? []).filter(
        (entry) => entry.status === undefined || entry.status === "published",
    );

    let appliedOverrides = 0;

    for (const override of publishedOverrides) {
        if (override.x < 1 || override.x > width || override.y < 1 || override.y > height) {
            continue;
        }

        const tile = ensureRuntimeTile(mapNum, override.x, override.y);
        const layerKey = Number(override.layer);

        if (override.grhIndex === null) {
            if (tile.graphics) {
                delete tile.graphics[layerKey];
                if (Object.keys(tile.graphics).length === 0) {
                    delete tile.graphics;
                }
            }
        } else if (typeof override.grhIndex === "number" && override.grhIndex > 0) {
            if (!tile.graphics) {
                tile.graphics = {};
            }
            tile.graphics[layerKey] = override.grhIndex;
        }

        if (override.blocked === true) {
            tile.blocked = 1;
        } else if (override.blocked === false) {
            delete tile.blocked;
        }

        appliedOverrides++;
    }

    for (const entity of publishedEntities) {
        if (entity.kind !== "obj") {
            continue;
        }

        if (entity.x < 1 || entity.x > width || entity.y < 1 || entity.y > height) {
            continue;
        }

        if (!isBootHydration && !vars.datObj?.[entity.entityId]) {
            await ensureObjectTemplateLoaded(entity.entityId);
        }

        const tile = ensureRuntimeTile(mapNum, entity.x, entity.y);
        tile.objInfo = {
            objIndex: entity.entityId,
            amount: 1,
        };
    }

    for (const [coordKey, droppedObj] of droppedItemsByCoord.entries()) {
        const coords = parseCoordinateKey(coordKey);
        if (!coords) {
            continue;
        }

        const tile = ensureRuntimeTile(mapNum, coords.x, coords.y);
        if (!tile.objInfo) {
            tile.objInfo = droppedObj;
        }
    }

    let blockedChanges = 0;
    let spawnedObjects = 0;
    let removedObjects = 0;

    if (!isBootHydration) {
        const mapClients = getConnectedClientsOnMap(mapNum);

        for (let y = 1; y <= height; y++) {
            for (let x = 1; x <= width; x++) {
                const coordKey = `${x},${y}`;
                const tile = vars.mapa[mapNum]?.[y]?.[x] as RuntimeMapTile | undefined;
                const prevBlocked = previousBlockedByCoord.get(coordKey) ?? false;
                const nextBlocked = Boolean(tile?.blocked);

                if (nextBlocked !== prevBlocked) {
                    blockedChanges++;
                    for (const client of mapClients) {
                        handleProtocol.blockMap(mapNum, { x, y }, nextBlocked ? 1 : 0, client);
                    }
                }

                const prevObjIndex = previousObjIndexByCoord.get(coordKey) ?? 0;
                const nextObjIndex = Number(tile?.objInfo?.objIndex ?? 0);

                if (nextObjIndex !== prevObjIndex) {
                    if (nextObjIndex > 0) {
                        if (prevObjIndex > 0) {
                            removedObjects++;
                        }
                        spawnedObjects++;
                        for (const client of mapClients) {
                            handleProtocol.renderItem(nextObjIndex, mapNum, { x, y }, client);
                        }
                    } else if (prevObjIndex > 0) {
                        removedObjects++;
                        for (const client of mapClients) {
                            handleProtocol.deleteItem(mapNum, { x, y }, client);
                        }
                    }
                }
            }
        }
    }

    const desiredNpcSpawns = new Map<string, TrackedWorldBuilderNpcSpawn>();
    for (const entity of publishedEntities) {
        if (entity.kind !== "npc") {
            continue;
        }

        if (entity.x < 1 || entity.x > width || entity.y < 1 || entity.y > height) {
            continue;
        }

        const spawnKey = `${mapNum}:${entity.x}:${entity.y}`;
        desiredNpcSpawns.set(spawnKey, {
            x: entity.x,
            y: entity.y,
            entityId: entity.entityId,
        });
    }

    const previousTrackedSpawns = activeWorldBuilderNpcSpawnsByMap.get(mapNum) ?? new Map<string, TrackedWorldBuilderNpcSpawn>();
    for (const [spawnKey, previousSpawn] of previousTrackedSpawns.entries()) {
        const nextSpawn = desiredNpcSpawns.get(spawnKey);
        if (!nextSpawn || nextSpawn.entityId !== previousSpawn.entityId) {
            clearNpcRespawnCooldown({
                mapNum,
                x: previousSpawn.x,
                y: previousSpawn.y,
                npcIndex: previousSpawn.entityId,
            });
        }
    }

    let spawnedNpcs = 0;
    let removedNpcs = 0;
    const keptSpawnKeys = new Set<string>();
    const allNpcs = (vars.npcs ?? {}) as RuntimeNpcs;

    for (const npc of [...Object.values(allNpcs)]) {
        if (!npc) {
            continue;
        }

        const originMap = Number(npc.spawnMapNum ?? npc.map);
        if (originMap !== mapNum) {
            continue;
        }

        const inferredKey = `${mapNum}:${npc.spawnOrigin?.x ?? npc.pos.x}:${npc.spawnOrigin?.y ?? npc.pos.y}`;
        const isManagedByWorldBuilder = Boolean(npc.worldBuilderManaged) || previousTrackedSpawns.has(inferredKey);

        if (!isManagedByWorldBuilder) {
            continue;
        }

        const spawnKey = npc.worldBuilderSpawnKey ?? inferredKey;
        const desiredSpawn = desiredNpcSpawns.get(spawnKey);

        if (!desiredSpawn || Number(npc.templateNpcIndex) !== desiredSpawn.entityId || keptSpawnKeys.has(spawnKey)) {
            despawnLiveNpc(npc);
            removedNpcs++;
            continue;
        }

        npc.worldBuilderManaged = true;
        npc.worldBuilderSpawnKey = spawnKey;
        keptSpawnKeys.add(spawnKey);
    }

    for (const [spawnKey, desiredSpawn] of desiredNpcSpawns.entries()) {
        if (keptSpawnKeys.has(spawnKey)) {
            continue;
        }

        clearNpcRespawnCooldown({
            mapNum,
            x: desiredSpawn.x,
            y: desiredSpawn.y,
            npcIndex: desiredSpawn.entityId,
        });

        if (!isBootHydration && !vars.datNpc?.[desiredSpawn.entityId]) {
            await ensureNpcTemplateLoaded(desiredSpawn.entityId);
        }

        const created = spawnWorldBuilderNpc(
            mapNum,
            desiredSpawn.x,
            desiredSpawn.y,
            desiredSpawn.entityId,
            spawnKey,
            !isBootHydration,
        );

        if (created) {
            spawnedNpcs++;
        }
    }

    activeWorldBuilderNpcSpawnsByMap.set(mapNum, desiredNpcSpawns);

    let relocatedPlayers = 0;

    if (!isBootHydration) {
        relocateBlockedBaseNpcsOnMap(mapNum);
        relocatedPlayers = relocateBlockedPlayersOnMap(mapNum);
    }

    const effectiveVersion =
        incomingVersion > 0 ? incomingVersion : Math.max(1, Number(vars.gameDataVersions?.maps ?? 0) + 1);
    appliedVersionByMap.set(mapNum, effectiveVersion);

    if (vars.gameDataVersions) {
        vars.gameDataVersions.maps = Math.max(Number(vars.gameDataVersions.maps ?? 0), effectiveVersion);
    }

    if (!isBootHydration) {
        const allConnectedClients = getAllConnectedGameClients();
        for (const client of allConnectedClients) {
            handleProtocol.mapLiveReload(mapNum, effectiveVersion, client);
            socket.flushClient(client);
        }
    }

    return {
        mapNum,
        version: effectiveVersion,
        appliedOverrides,
        blockedChanges,
        spawnedObjects,
        removedObjects,
        spawnedNpcs,
        removedNpcs,
        relocatedPlayers,
    };
}

function enqueueMapReload(mapNum: number, task: () => Promise<MapLiveReloadResult>): Promise<MapLiveReloadResult> {
    const previous = reloadChainsByMap.get(mapNum) ?? Promise.resolve({} as MapLiveReloadResult);
    const next = previous.catch(() => ({}) as MapLiveReloadResult).then(task);
    reloadChainsByMap.set(mapNum, next);
    return next.finally(() => {
        if (reloadChainsByMap.get(mapNum) === next) {
            reloadChainsByMap.delete(mapNum);
        }
    });
}

export async function reloadPublishedMapFromApi(mapNum: number): Promise<MapLiveReloadResult> {
    return enqueueMapReload(mapNum, async () => {
        const snapshot = (await funct.fetchUrl(`/internal/game-data/maps/${mapNum}/published`, {
            headers: {
                Authorization: vars.tokenAuth,
            },
        })) as PublishedMapSnapshot;

        return applyPublishedMapSnapshot(mapNum, snapshot);
    });
}

export async function initializePublishedMapsFromApi(options?: {
    fetchAllPublished?: () => Promise<AllPublishedMapsSnapshotResponse>;
    mapsSourceDir?: string;
}): Promise<InitializePublishedMapsResult> {
    const fetchAllPublished =
        options?.fetchAllPublished ??
        (async () =>
            (await funct.fetchUrl("/internal/game-data/maps/published", {
                headers: {
                    Authorization: vars.tokenAuth,
                },
            })) as AllPublishedMapsSnapshotResponse);

    const payload = await fetchAllPublished();
    const currentVersion = Math.max(0, Number(payload.currentVersion ?? 0));
    let hydratedMaps = 0;
    let appliedOverrides = 0;
    let appliedEntities = 0;

    for (const mapEntry of payload.maps ?? []) {
        if (!baselineMapExists(mapEntry.mapNum, options?.mapsSourceDir)) {
            continue;
        }

        const result = await applyPublishedMapSnapshot(
            mapEntry.mapNum,
            {
                mapNum: mapEntry.mapNum,
                version: currentVersion,
                overrides: mapEntry.overrides ?? [],
                entities: mapEntry.entities ?? [],
            },
            {
                isBootHydration: true,
                mapsSourceDir: options?.mapsSourceDir,
            },
        );

        hydratedMaps++;
        appliedOverrides += result.appliedOverrides;
        appliedEntities += (mapEntry.entities ?? []).length;
    }

    if (vars.gameDataVersions) {
        vars.gameDataVersions.maps = Math.max(Number(vars.gameDataVersions.maps ?? 0), currentVersion);
    }

    return {
        currentVersion,
        hydratedMaps,
        appliedOverrides,
        appliedEntities,
    };
}

function writeJsonResponse(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
}

function extractAuthToken(request: IncomingMessage): string {
    const rawHeader = request.headers?.authorization;
    const headerValue = Array.isArray(rawHeader) ? (rawHeader[0] ?? "") : (rawHeader ?? "");
    const trimmed = headerValue.trim();

    if (trimmed.toLowerCase().startsWith("bearer ")) {
        return trimmed.slice(7).trim();
    }

    return trimmed;
}

export async function handleInternalMapReloadHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    options?: {
        reloadMap?: (mapNum: number) => Promise<MapLiveReloadResult>;
    },
): Promise<boolean> {
    let pathname = "/";
    try {
        pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
        pathname = request.url ?? "/";
    }

    const match = /^\/internal\/maps\/([^/]+)\/reload\/?$/.exec(pathname);
    if (!match) {
        return false;
    }

    if (request.method !== "POST") {
        writeJsonResponse(response, 405, { error: "Method not allowed" });
        return true;
    }

    const expectedToken = String(vars.tokenAuth ?? "").trim();
    const providedToken = extractAuthToken(request);

    if (!expectedToken || providedToken !== expectedToken) {
        writeJsonResponse(response, 401, { error: "Unauthorized" });
        return true;
    }

    const rawMapNum = match[1] ?? "";
    const mapNum = /^\d+$/.test(rawMapNum) ? Number.parseInt(rawMapNum, 10) : Number.NaN;

    if (!Number.isInteger(mapNum) || mapNum <= 0 || !baselineMapExists(mapNum)) {
        writeJsonResponse(response, 400, { error: "Numero de mapa invalido." });
        return true;
    }

    try {
        const reloadMap = options?.reloadMap ?? reloadPublishedMapFromApi;
        const result = await reloadMap(mapNum);
        writeJsonResponse(response, 200, {
            ok: true,
            ...result,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Error inesperado al recargar mapa.";
        writeJsonResponse(response, 500, { error: message });
    }

    return true;
}

export function resetMapLiveSyncStateForTests(): void {
    appliedVersionByMap.clear();
    activeWorldBuilderNpcSpawnsByMap.clear();
    reloadChainsByMap.clear();
}
