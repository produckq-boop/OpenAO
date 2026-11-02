import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CLIENT_PACKET_ID, PacketReader } from "@openao/protocol";

import {
    applyPublishedMapSnapshot,
    findNearestWalkableTile,
    handleInternalMapReloadHttpRequest,
    initializePublishedMapsFromApi,
    resetMapLiveSyncStateForTests,
} from "../src/mapLiveSync";
import type { RuntimeCharacter, RuntimeClient, RuntimeNpc } from "../src/types/runtime";

const vars = require("../src/vars");
const npcs = require("../src/npcs");

function createTempMapsSource(mapNum: number): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openao-map-live-sync-"));
    const mapDir = path.join(dir, `mapa_${mapNum}`);
    fs.mkdirSync(mapDir, { recursive: true });

    fs.writeFileSync(
        path.join(mapDir, "meta.json"),
        JSON.stringify({
            name: `Mapa Test ${mapNum}`,
            musicNum: 1,
            terreno: "BOSQUE",
            zona: "CAMPO",
            pk: 1,
        }),
        "utf8",
    );

    const rows = Array.from({ length: 12 }, (_, rowIdx) =>
        Array.from({ length: 12 }, (_, colIdx) => (rowIdx + 1 === 4 && colIdx + 1 === 4 ? 2 : 1)),
    );

    fs.writeFileSync(
        path.join(mapDir, "terrain.json"),
        JSON.stringify({
            width: 12,
            height: 12,
            palette: {
                "1": { blocked: false, graphics: [100] },
                "2": { blocked: true, graphics: [100, 250] },
            },
            rows,
        }),
        "utf8",
    );

    fs.writeFileSync(
        path.join(mapDir, "specials.json"),
        JSON.stringify({
            exits: {
                "5,4": { map: 2, x: 10, y: 10 },
            },
            objects: {},
            npcs: {},
            triggers: {},
        }),
        "utf8",
    );

    return {
        dir,
        cleanup: () => {
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

function resetRuntimeState(mapNums: number[]): void {
    resetMapLiveSyncStateForTests();
    vars.clients = {};
    vars.personajes = {};
    vars.npcs = {};
    vars.areaNpc = {};
    vars.onlineSessions = {};
    vars.partyStates = {};
    vars.clanStates = {};
    vars.partyIdByMemberId = {};
    vars.clanKeyByMemberId = {};
    vars.gameDataVersions = {
        objects: 0,
        npcs: 0,
        balance: 0,
        crafting: 0,
        maps: 0,
    };

    for (const mapNum of mapNums) {
        delete vars.mapa[mapNum];
        delete vars.mapData[mapNum];
    }
}

function extractIndividualFrames(sentPayloads: Buffer[]): Buffer[] {
    const frames: Buffer[] = [];

    for (const payload of sentPayloads) {
        if (payload.byteLength === 0) {
            continue;
        }

        const opcode = payload.readUInt8(0);
        if (opcode === CLIENT_PACKET_ID.batch) {
            const reader = new PacketReader(payload);
            reader.getByte();
            const count = reader.getShort();
            for (let i = 0; i < count; i++) {
                const frameLength = reader.getShort();
                frames.push(Buffer.from(reader.getBytes(frameLength)));
            }
        } else {
            frames.push(payload);
        }
    }

    return frames;
}

function createMockClient(
    id: number,
    sentPayloads: Buffer[],
): RuntimeClient {
    return {
        id,
        OPEN: 1,
        readyState: 1,
        bot: false,
        send(payload: unknown) {
            if (Buffer.isBuffer(payload)) {
                sentPayloads.push(Buffer.from(payload));
            } else if (payload instanceof Uint8Array) {
                sentPayloads.push(Buffer.from(payload));
            } else if (payload instanceof ArrayBuffer) {
                sentPayloads.push(Buffer.from(payload));
            }
        },
        close() {},
    } as RuntimeClient;
}

function createMockCharacter(id: number, mapNum: number, x: number, y: number, privileges = 0): RuntimeCharacter {
    return {
        id,
        nameCharacter: `Tester${id}`,
        map: mapNum,
        pos: { x, y },
        heading: 3,
        privileges,
        navegando: 0,
        dead: false,
        idBody: 1,
        idHead: 1,
        idHelmet: 0,
        idWeapon: 0,
        idShield: 0,
        color: "white",
        clanName: "",
        stateVersion: 1,
        lastProcessedMoveId: 0,
        pendingMoveQueue: [],
        pendingMoveTimerId: null,
        summonTargetNpcId: 0,
        items: {},
        spells: {},
    } as RuntimeCharacter;
}

test("hydrates published maps at boot while ignoring draft entries", async (t) => {
    const mapNum = 901;
    const tempMaps = createTempMapsSource(mapNum);
    t.after(() => {
        tempMaps.cleanup();
        resetRuntimeState([mapNum]);
    });

    resetRuntimeState([mapNum]);
    vars.datObj[501] = {
        id: 501,
        name: "Antorcha",
        grhIndex: 777,
        objType: 6,
    };
    vars.datNpc[601] = {
        name: "Guardia",
        idBody: 12,
        idHead: 3,
        movement: 1,
        npcType: 0,
        hp: 100,
        maxHp: 100,
        aguaValida: 0,
    };

    const result = await initializePublishedMapsFromApi({
        mapsSourceDir: tempMaps.dir,
        async fetchAllPublished() {
            return {
                currentVersion: 15,
                maps: [
                    {
                        mapNum,
                        overrides: [
                            { x: 3, y: 3, layer: 1, grhIndex: 555, blocked: true, status: "published" },
                            { x: 4, y: 4, layer: 2, grhIndex: null, blocked: false, status: "published" },
                            { x: 6, y: 6, layer: 1, grhIndex: 999, blocked: true, status: "draft" },
                        ],
                        entities: [
                            { x: 2, y: 2, kind: "obj", entityId: 501, status: "published" },
                            { x: 7, y: 7, kind: "npc", entityId: 601, status: "published" },
                            { x: 8, y: 8, kind: "obj", entityId: 501, status: "draft" },
                        ],
                    },
                ],
            };
        },
    });

    assert.equal(result.currentVersion, 15);
    assert.equal(result.hydratedMaps, 1);
    assert.equal(result.appliedOverrides, 2);
    assert.equal(vars.gameDataVersions.maps, 15);

    assert.equal(vars.mapa[mapNum][3][3].blocked, 1);
    assert.equal(vars.mapa[mapNum][3][3].graphics[1], 555);
    assert.equal(Boolean(vars.mapa[mapNum][4][4].blocked), false);
    assert.equal(vars.mapa[mapNum][4][4].graphics[2], undefined);
    assert.equal(Boolean(vars.mapa[mapNum][6][6].blocked), false);
    assert.equal(vars.mapa[mapNum][6][6].graphics[1], 100);

    assert.equal(vars.mapa[mapNum][2][2].objInfo?.objIndex, 501);
    assert.equal(vars.mapa[mapNum][8][8].objInfo, undefined);

    const spawnedNpcId = vars.mapData[mapNum][7][7].id;
    assert.ok(spawnedNpcId > 0);
    assert.equal(vars.npcs[spawnedNpcId]?.templateNpcIndex, 601);
    assert.equal(vars.npcs[spawnedNpcId]?.worldBuilderManaged, true);
});

test("restores baseline blocked walls on revert while preserving dropped floor items", async (t) => {
    const mapNum = 902;
    const tempMaps = createTempMapsSource(mapNum);
    t.after(() => {
        tempMaps.cleanup();
        resetRuntimeState([mapNum]);
    });

    resetRuntimeState([mapNum]);
    vars.datObj[300] = {
        id: 300,
        name: "Pocion Roja",
        grhIndex: 400,
        objType: 11,
    };

    await applyPublishedMapSnapshot(
        mapNum,
        { mapNum, version: 1, overrides: [], entities: [] },
        { isBootHydration: true, mapsSourceDir: tempMaps.dir },
    );

    assert.equal(vars.mapa[mapNum][4][4].blocked, 1);

    const sentPayloads: Buffer[] = [];
    const client = createMockClient(10, sentPayloads);
    const player = createMockCharacter(10, mapNum, 2, 2);
    vars.clients[10] = client;
    vars.personajes[10] = player;
    vars.mapData[mapNum][2][2].id = 10;
    vars.mapa[mapNum][2][3].objInfo = {
        objIndex: 300,
        amount: 5,
        cleanupSource: "drop",
    };

    const unblockedResult = await applyPublishedMapSnapshot(
        mapNum,
        {
            mapNum,
            version: 2,
            overrides: [{ x: 4, y: 4, layer: 1, grhIndex: 100, blocked: false }],
            entities: [],
        },
        { mapsSourceDir: tempMaps.dir },
    );

    assert.equal(unblockedResult.blockedChanges, 1);
    assert.equal(Boolean(vars.mapa[mapNum][4][4].blocked), false);

    sentPayloads.length = 0;

    const revertedResult = await applyPublishedMapSnapshot(
        mapNum,
        {
            mapNum,
            version: 3,
            overrides: [],
            entities: [],
        },
        { mapsSourceDir: tempMaps.dir },
    );

    assert.equal(revertedResult.blockedChanges, 1);
    assert.equal(vars.mapa[mapNum][4][4].blocked, 1);
    assert.equal(vars.mapData[mapNum][2][2].id, 10);
    assert.deepEqual(vars.mapa[mapNum][2][3].objInfo, {
        objIndex: 300,
        amount: 5,
        cleanupSource: "drop",
    });

    const frames = extractIndividualFrames(sentPayloads);
    const blockFrames = frames.filter((frame) => frame.readUInt8(0) === CLIENT_PACKET_ID.blockMap);
    assert.equal(blockFrames.length, 1);
    const reader = new PacketReader(blockFrames[0]!);
    assert.equal(reader.getByte(), CLIENT_PACKET_ID.blockMap);
    assert.equal(reader.getShort(), mapNum);
    assert.equal(reader.getByte(), 4);
    assert.equal(reader.getByte(), 4);
    assert.equal(reader.getByte(), 1);
});

test("relocates blocked players and admins via deterministic BFS while skipping tileExit tiles", async (t) => {
    const mapNum = 903;
    const tempMaps = createTempMapsSource(mapNum);
    t.after(() => {
        tempMaps.cleanup();
        resetRuntimeState([mapNum]);
    });

    resetRuntimeState([mapNum]);

    await applyPublishedMapSnapshot(
        mapNum,
        { mapNum, version: 1, overrides: [], entities: [] },
        { isBootHydration: true, mapsSourceDir: tempMaps.dir },
    );

    const playerPayloads: Buffer[] = [];
    const adminPayloads: Buffer[] = [];
    const playerClient = createMockClient(21, playerPayloads);
    const adminClient = createMockClient(22, adminPayloads);
    const player = createMockCharacter(21, mapNum, 5, 5, 0);
    const admin = createMockCharacter(22, mapNum, 6, 6, 1);

    vars.clients[21] = playerClient;
    vars.clients[22] = adminClient;
    vars.personajes[21] = player;
    vars.personajes[22] = admin;
    vars.mapData[mapNum][5][5].id = 21;
    vars.mapData[mapNum][6][6].id = 22;

    assert.deepEqual(findNearestWalkableTile(mapNum, 5, 4, false, 21), { x: 5, y: 3 });

    const result = await applyPublishedMapSnapshot(
        mapNum,
        {
            mapNum,
            version: 2,
            overrides: [
                { x: 5, y: 5, layer: 1, grhIndex: 100, blocked: true },
                { x: 6, y: 6, layer: 1, grhIndex: 100, blocked: true },
            ],
            entities: [],
        },
        { mapsSourceDir: tempMaps.dir },
    );

    assert.equal(result.relocatedPlayers, 2);
    assert.deepEqual(player.pos, { x: 6, y: 5 });
    assert.equal(vars.mapData[mapNum][5][5].id, 0);
    assert.equal(vars.mapData[mapNum][5][6].id, 21);

    assert.deepEqual(admin.pos, { x: 7, y: 6 });
    assert.equal(vars.mapData[mapNum][6][6].id, 0);
    assert.equal(vars.mapData[mapNum][6][7].id, 22);

    const playerOpcodes = extractIndividualFrames(playerPayloads).map((frame) => frame.readUInt8(0));
    const adminOpcodes = extractIndividualFrames(adminPayloads).map((frame) => frame.readUInt8(0));
    assert.ok(playerOpcodes.includes(CLIENT_PACKET_ID.telepMe));
    assert.ok(playerOpcodes.includes(CLIENT_PACKET_ID.console));
    assert.ok(adminOpcodes.includes(CLIENT_PACKET_ID.telepMe));
});

test("spawns and combat-safely removes World Builder NPCs and static objects without touching baseline NPCs", async (t) => {
    const mapNum = 904;
    const tempMaps = createTempMapsSource(mapNum);
    t.after(() => {
        tempMaps.cleanup();
        resetRuntimeState([mapNum]);
    });

    resetRuntimeState([mapNum]);

    await applyPublishedMapSnapshot(
        mapNum,
        { mapNum, version: 1, overrides: [], entities: [] },
        { isBootHydration: true, mapsSourceDir: tempMaps.dir },
    );

    const baselineNpc = {
        ...npcs.createNpc(),
        id: 5000,
        templateNpcIndex: 700,
        spawnMapNum: mapNum,
        spawnOrigin: { x: 10, y: 10 },
        map: mapNum,
        pos: { x: 10, y: 10 },
        nameCharacter: "Lobo Base",
        isNpc: true,
        idBody: 10,
        idHead: 0,
        movement: 3,
        hp: 50,
        maxHp: 50,
    } as RuntimeNpc;
    vars.npcs[baselineNpc.id] = baselineNpc;
    vars.areaNpc[baselineNpc.id] = [];
    vars.mapData[mapNum][10][10].id = baselineNpc.id;

    const sentPayloads: Buffer[] = [];
    const client = createMockClient(31, sentPayloads);
    const player = createMockCharacter(31, mapNum, 2, 2);
    vars.clients[31] = client;
    vars.personajes[31] = player;
    vars.mapData[mapNum][2][2].id = 31;

    delete vars.datObj[801];
    delete vars.datNpc[901];
    let loadedObjTemplate = 0;
    let loadedNpcTemplate = 0;

    const spawnResult = await applyPublishedMapSnapshot(
        mapNum,
        {
            mapNum,
            version: 2,
            overrides: [],
            entities: [
                { x: 3, y: 2, kind: "obj", entityId: 801 },
                { x: 3, y: 3, kind: "npc", entityId: 901 },
            ],
        },
        {
            mapsSourceDir: tempMaps.dir,
            async ensureObjectTemplateLoaded(objId) {
                loadedObjTemplate = objId;
                vars.datObj[objId] = {
                    id: objId,
                    name: "Cofre",
                    grhIndex: 888,
                    objType: 6,
                };
            },
            async ensureNpcTemplateLoaded(npcId) {
                loadedNpcTemplate = npcId;
                vars.datNpc[npcId] = {
                    name: "Esqueleto",
                    idBody: 14,
                    idHead: 0,
                    movement: 3,
                    npcType: 0,
                    hp: 120,
                    maxHp: 120,
                    aguaValida: 0,
                };
            },
        },
    );

    assert.equal(loadedObjTemplate, 801);
    assert.equal(loadedNpcTemplate, 901);
    assert.equal(spawnResult.spawnedObjects, 1);
    assert.equal(spawnResult.spawnedNpcs, 1);

    const spawnedNpcId = vars.mapData[mapNum][3][3].id;
    assert.ok(spawnedNpcId > 0);
    assert.ok(vars.npcs[spawnedNpcId]);

    const spawnOpcodes = extractIndividualFrames(sentPayloads).map((frame) => frame.readUInt8(0));
    assert.ok(spawnOpcodes.includes(CLIENT_PACKET_ID.renderItem));
    assert.ok(spawnOpcodes.includes(CLIENT_PACKET_ID.getNpc));

    player.summonTargetNpcId = spawnedNpcId;
    baselineNpc.currentTargetId = spawnedNpcId;
    baselineNpc.currentTargetLockedUntil = Date.now() + 5000;
    baselineNpc.reservedAttackTargetId = spawnedNpcId;
    baselineNpc.reservedAttackPos = { x: 3, y: 2 };
    baselineNpc.attackReservationExpiresAt = Date.now() + 5000;
    baselineNpc.lastAggressorId = spawnedNpcId;
    baselineNpc.lastAggressedAt = Date.now();

    sentPayloads.length = 0;

    const removeResult = await applyPublishedMapSnapshot(
        mapNum,
        {
            mapNum,
            version: 3,
            overrides: [],
            entities: [],
        },
        { mapsSourceDir: tempMaps.dir },
    );

    assert.equal(removeResult.removedObjects, 1);
    assert.equal(removeResult.removedNpcs, 1);
    assert.equal(vars.npcs[spawnedNpcId], undefined);
    assert.equal(vars.areaNpc[spawnedNpcId], undefined);
    assert.equal(vars.mapData[mapNum][3][3].id, 0);
    assert.equal(player.summonTargetNpcId, 0);
    assert.equal(baselineNpc.currentTargetId, 0);
    assert.equal(baselineNpc.reservedAttackTargetId, 0);
    assert.equal(baselineNpc.lastAggressorId, 0);
    assert.ok(vars.npcs[baselineNpc.id]);

    const removeOpcodes = extractIndividualFrames(sentPayloads).map((frame) => frame.readUInt8(0));
    assert.ok(removeOpcodes.includes(CLIENT_PACKET_ID.deleteItem));
    assert.ok(removeOpcodes.includes(CLIENT_PACKET_ID.deleteCharacter));
});

test("broadcasts mapLiveReload binary frame to connected clients and skips stale versions", async (t) => {
    const mapNum = 905;
    const tempMaps = createTempMapsSource(mapNum);
    t.after(() => {
        tempMaps.cleanup();
        resetRuntimeState([mapNum, 1]);
    });

    resetRuntimeState([mapNum, 1]);

    await applyPublishedMapSnapshot(
        mapNum,
        { mapNum, version: 5, overrides: [], entities: [] },
        { isBootHydration: true, mapsSourceDir: tempMaps.dir },
    );

    const remotePayloads: Buffer[] = [];
    const remoteClient = createMockClient(41, remotePayloads);
    const remotePlayer = createMockCharacter(41, 1, 50, 50);
    vars.clients[41] = remoteClient;
    vars.personajes[41] = remotePlayer;

    const liveResult = await applyPublishedMapSnapshot(
        mapNum,
        { mapNum, version: 9, overrides: [], entities: [] },
        { mapsSourceDir: tempMaps.dir },
    );
    assert.equal(liveResult.version, 9);
    assert.equal(liveResult.skippedStale, undefined);

    const frames = extractIndividualFrames(remotePayloads);
    const reloadFrame = frames.find((frame) => frame.readUInt8(0) === CLIENT_PACKET_ID.mapLiveReload);
    assert.ok(reloadFrame);
    const reader = new PacketReader(reloadFrame);
    assert.equal(reader.getByte(), CLIENT_PACKET_ID.mapLiveReload);
    assert.equal(reader.getShort(), mapNum);
    assert.equal(reader.getInt(), 9);

    remotePayloads.length = 0;

    const staleResult = await applyPublishedMapSnapshot(
        mapNum,
        {
            mapNum,
            version: 7,
            overrides: [{ x: 2, y: 2, layer: 1, grhIndex: 333, blocked: true }],
            entities: [],
        },
        { mapsSourceDir: tempMaps.dir },
    );

    assert.equal(staleResult.skippedStale, true);
    assert.equal(staleResult.version, 9);
    assert.equal(Boolean(vars.mapa[mapNum][2][2].blocked), false);
    assert.equal(remotePayloads.length, 0);
});

test("validates auth and dispatches POST /internal/maps/:mapNum/reload over HTTP", async (t) => {
    const previousToken = vars.tokenAuth;
    vars.tokenAuth = "secret-sync-token";

    const server = http.createServer((req, res) => {
        void (async () => {
            const handled = await handleInternalMapReloadHttpRequest(req, res, {
                async reloadMap(mapNum) {
                    return {
                        mapNum,
                        version: 21,
                        appliedOverrides: 4,
                        blockedChanges: 1,
                        spawnedObjects: 0,
                        removedObjects: 0,
                        spawnedNpcs: 1,
                        removedNpcs: 0,
                        relocatedPlayers: 0,
                    };
                },
            });

            if (!handled) {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "Not found" }));
            }
        })();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        vars.tokenAuth = previousToken;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const notFoundRes = await fetch(`${baseUrl}/health`);
    assert.equal(notFoundRes.status, 404);

    const wrongMethodRes = await fetch(`${baseUrl}/internal/maps/1/reload`, { method: "GET" });
    assert.equal(wrongMethodRes.status, 405);

    const unauthorizedRes = await fetch(`${baseUrl}/internal/maps/1/reload`, {
        method: "POST",
        headers: { Authorization: "wrong-token" },
    });
    assert.equal(unauthorizedRes.status, 401);

    const invalidMapRes = await fetch(`${baseUrl}/internal/maps/999999/reload`, {
        method: "POST",
        headers: { Authorization: "secret-sync-token" },
    });
    assert.equal(invalidMapRes.status, 400);

    const okRes = await fetch(`${baseUrl}/internal/maps/1/reload`, {
        method: "POST",
        headers: { Authorization: "Bearer secret-sync-token" },
    });
    assert.equal(okRes.status, 200);
    const body = (await okRes.json()) as { ok: boolean; mapNum: number; version: number; spawnedNpcs: number };
    assert.equal(body.ok, true);
    assert.equal(body.mapNum, 1);
    assert.equal(body.version, 21);
    assert.equal(body.spawnedNpcs, 1);
});
