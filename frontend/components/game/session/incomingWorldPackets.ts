import { OBJECT_TYPE } from "../../../lib/aowProtocol";
import type { GraphicsDB, MapData } from "../../../types/game";
import {
    getMapDimensions,
    invalidateMapCache,
    isUploadedGraphic,
    loadMapData,
    mergeUploadedGraphics,
} from "../../../utils/gameLoader";
import { applyHudMemberDelta } from "../state/hudState";
import type {
    ClanStateDelta,
    IncomingPacketHandlerArgs,
    PartyStateDelta,
} from "./incomingPacketTypes";

const AREA_SNAPSHOT_RANGE_X = 15;
const AREA_SNAPSHOT_RANGE_Y = 15;
const liveReloadStateByEngine = new WeakMap<
    object,
    {
        versions: Map<number, number>;
        sequences: Map<number, number>;
    }
>();

function getEngineLiveReloadState(engine: object) {
    let state = liveReloadStateByEngine.get(engine);
    if (!state) {
        state = {
            versions: new Map(),
            sequences: new Map(),
        };
        liveReloadStateByEngine.set(engine, state);
    }
    return state;
}

async function ensureUploadedMapGraphicsLoaded(
    mapData: MapData,
    mapNumber: number,
    graphicsDb: GraphicsDB,
): Promise<void> {
    const mapEntry = mapData[String(mapNumber)];
    if (!mapEntry) {
        return;
    }

    for (const row of Object.values(mapEntry)) {
        if (!row) {
            continue;
        }
        for (const tile of Object.values(row)) {
            const graphics = tile?.graphics;
            if (!graphics) {
                continue;
            }
            for (const grhIndex of Object.values(graphics)) {
                const numericGrh = Number(grhIndex);
                if (
                    Number.isFinite(numericGrh) &&
                    isUploadedGraphic(numericGrh) &&
                    !graphicsDb[String(numericGrh)]
                ) {
                    await mergeUploadedGraphics(graphicsDb);
                    return;
                }
            }
        }
    }
}

function getAreaSnapshotCenter(
    ctx: IncomingPacketHandlerArgs["ctx"],
    engine: IncomingPacketHandlerArgs["engine"],
    fallbackMap: number | undefined,
) {
    const pendingUser = ctx.pendingUserSnapshotRef.current;

    if (
        pendingUser?.pos &&
        typeof pendingUser.pos.x === "number" &&
        typeof pendingUser.pos.y === "number" &&
        typeof pendingUser.map === "number" &&
        (typeof fallbackMap === "undefined" || pendingUser.map === fallbackMap)
    ) {
        return {
            map: pendingUser.map,
            x: pendingUser.pos.x,
            y: pendingUser.pos.y,
        };
    }

    if (
        engine?.user?.pos &&
        typeof engine.user.pos.x === "number" &&
        typeof engine.user.pos.y === "number" &&
        typeof engine.user.map === "number" &&
        (typeof fallbackMap === "undefined" || engine.user.map === fallbackMap)
    ) {
        return {
            map: engine.user.map,
            x: engine.user.pos.x,
            y: engine.user.pos.y,
        };
    }

    return null;
}

function clearVisibleGroundItemsFromAreaSnapshot(
    ctx: IncomingPacketHandlerArgs["ctx"],
    engine: IncomingPacketHandlerArgs["engine"],
    targetMap: number,
) {
    const center = getAreaSnapshotCenter(ctx, engine, targetMap);

    if (!center) {
        return;
    }

    const minX = Math.max(1, center.x - AREA_SNAPSHOT_RANGE_X);
    const maxX = Math.min(100, center.x + AREA_SNAPSHOT_RANGE_X);
    const minY = Math.max(1, center.y - AREA_SNAPSHOT_RANGE_Y);
    const maxY = Math.min(100, center.y + AREA_SNAPSHOT_RANGE_Y);

    for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
            ctx.updatePendingTileState(targetMap, x, y, (current) => ({
                ...current,
                objInfo: null,
            }));

            if (engine?.mapData && targetMap === engine.mapNumber) {
                const tile = engine.mapData?.[targetMap]?.[y]?.[x];

                if (tile?.objInfo) {
                    delete tile.objInfo;
                }

                const tileKey = `${x},${y}`;
                if (engine.objectSprites?.has(tileKey)) {
                    ctx.removeObjectSprite(engine, tileKey);
                }
            }
        }
    }
}

export async function handleIncomingWorldPacket({
    packet,
    engine,
    renderedMapNumber,
    ctx,
}: IncomingPacketHandlerArgs): Promise<boolean> {
    switch (packet.type) {
        case "nameMap":
            if (engine) {
                engine.worldName = packet.payload.name;
            }
            ctx.emitStatus({
                connected: true,
                connecting: false,
                worldName: packet.payload.name,
            });
            return true;

        case "areaMetaSnapshot":
            await handleIncomingWorldPacket({
                packet: {
                    type: "nameMap",
                    payload: { name: packet.payload.name },
                },
                engine,
                renderedMapNumber,
                ctx,
            });

            for (const blockedTile of packet.payload.blockedTiles) {
                await handleIncomingWorldPacket({
                    packet: {
                        type: "blockMap",
                        payload: {
                            map: packet.payload.map,
                            x: blockedTile.x,
                            y: blockedTile.y,
                            blocked: blockedTile.blocked,
                        },
                    },
                    engine,
                    renderedMapNumber,
                    ctx,
                });
            }
            return true;

        case "selfMapMetaDelta":
            if (typeof packet.payload.name === "string") {
                await handleIncomingWorldPacket({
                    packet: {
                        type: "nameMap",
                        payload: { name: packet.payload.name },
                    },
                    engine,
                    renderedMapNumber,
                    ctx,
                });
            }

            if (typeof packet.payload.navegando !== "undefined") {
                await handleIncomingWorldPacket({
                    packet: {
                        type: "navegando",
                        payload: { navegando: packet.payload.navegando },
                    },
                    engine,
                    renderedMapNumber,
                    ctx,
                });
            }

            if (
                typeof packet.payload.map === "number" &&
                ctx.pendingUserSnapshotRef.current
            ) {
                ctx.pendingUserSnapshotRef.current = {
                    ...ctx.pendingUserSnapshotRef.current,
                    map: packet.payload.map,
                };
            }
            return true;

        case "pong":
            return true;

        case "quitarUserInvItem":
            ctx.removeInventoryItem(packet.payload.slot, packet.payload.amount);
            return true;

        case "agregarUserInvItem":
            ctx.upsertInventoryItem(packet.payload);
            return true;

        case "renderItem": {
            ctx.updatePendingTileState(
                packet.payload.map,
                packet.payload.x,
                packet.payload.y,
                (current) => ({
                    ...current,
                    objInfo: {
                        objIndex: packet.payload.idItem,
                        amount: current.objInfo?.amount ?? 1,
                    },
                }),
            );

            if (engine?.objectsDB) {
                const tile = ctx.ensureMapTile(
                    engine,
                    packet.payload.map,
                    packet.payload.x,
                    packet.payload.y,
                );

                if (tile) {
                    const existingAmount = tile.objInfo?.amount ?? 1;
                    tile.objInfo = {
                        objIndex: packet.payload.idItem,
                        amount: existingAmount,
                    };
                }

                if (packet.payload.map === engine.mapNumber) {
                    ctx.queueTileObjectVisualSync(
                        engine,
                        packet.payload.map,
                        packet.payload.x,
                        packet.payload.y,
                    );
                }
            }
            return true;
        }

        case "areaItemsSnapshot":
            clearVisibleGroundItemsFromAreaSnapshot(
                ctx,
                engine,
                packet.payload[0]?.map ??
                    ctx.pendingUserSnapshotRef.current?.map ??
                    engine?.user?.map ??
                    renderedMapNumber,
            );

            for (const item of packet.payload) {
                await handleIncomingWorldPacket({
                    packet: {
                        type: "renderItem",
                        payload: item,
                    },
                    engine,
                    renderedMapNumber,
                    ctx,
                });
            }
            return true;

        case "deleteItem": {
            ctx.updatePendingTileState(
                packet.payload.map,
                packet.payload.x,
                packet.payload.y,
                (current) => ({ ...current, objInfo: null }),
            );

            if (engine?.mapData) {
                const tile = ctx.ensureMapTile(
                    engine,
                    packet.payload.map,
                    packet.payload.x,
                    packet.payload.y,
                );

                if (tile) {
                    delete tile.objInfo;
                }

                if (packet.payload.map === engine.mapNumber) {
                    const tileKey = `${packet.payload.x},${packet.payload.y}`;
                    engine.tileObjectRenderRequestIds.set(
                        tileKey,
                        (engine.tileObjectRenderRequestIds.get(tileKey) ?? 0) +
                            1,
                    );
                    ctx.removeObjectSprite(engine, tileKey);
                }
            }
            return true;
        }

        case "blockMap": {
            ctx.updatePendingTileState(
                packet.payload.map,
                packet.payload.x,
                packet.payload.y,
                (current) => ({
                    ...current,
                    blocked: packet.payload.blocked || null,
                }),
            );

            if (engine?.mapData) {
                const tile = ctx.ensureMapTile(
                    engine,
                    packet.payload.map,
                    packet.payload.x,
                    packet.payload.y,
                );

                if (tile) {
                    if (packet.payload.blocked) {
                        tile.blocked = packet.payload.blocked;
                    } else {
                        delete tile.blocked;
                    }
                }
            }
            return true;
        }

        case "mapLiveReload": {
            const { mapNum, version } = packet.payload as {
                mapNum: number;
                version: number;
            };

            invalidateMapCache(mapNum);

            const activeMap = engine?.mapNumber ?? renderedMapNumber;
            if (
                !engine ||
                engine.isDestroyed ||
                !engine.mapData ||
                activeMap !== mapNum
            ) {
                return true;
            }

            const reloadState = getEngineLiveReloadState(engine);
            const previousVersion = reloadState.versions.get(mapNum) ?? 0;
            if (version > 0 && version < previousVersion) {
                return true;
            }

            if (version > 0) {
                reloadState.versions.set(
                    mapNum,
                    Math.max(previousVersion, version),
                );
            }

            const nextSequence = (reloadState.sequences.get(mapNum) ?? 0) + 1;
            reloadState.sequences.set(mapNum, nextSequence);

            try {
                const freshMapData = await loadMapData(mapNum, {
                    bypassCache: true,
                    requireOverrides: true,
                });

                if (
                    engine.isDestroyed ||
                    !engine.mapData ||
                    engine.mapNumber !== mapNum ||
                    reloadState.sequences.get(mapNum) !== nextSequence
                ) {
                    return true;
                }

                if (engine.graphicsDB) {
                    await ensureUploadedMapGraphicsLoaded(
                        freshMapData,
                        mapNum,
                        engine.graphicsDB,
                    );
                }

                if (
                    engine.isDestroyed ||
                    !engine.mapData ||
                    engine.mapNumber !== mapNum ||
                    reloadState.sequences.get(mapNum) !== nextSequence
                ) {
                    return true;
                }

                if (freshMapData[mapNum]) {
                    engine.mapData[mapNum] = freshMapData[mapNum];
                    engine.mapDimensions = getMapDimensions(
                        engine.mapData,
                        mapNum,
                    );
                    ctx.applyPendingTileStates(engine);
                    await ctx.renderMap(engine);
                    engine.updateCulling?.();
                }
            } catch (error) {
                console.warn(
                    `[MAPA] No se pudo actualizar en vivo el mapa ${mapNum}:`,
                    error,
                );
            }

            return true;
        }

        case "openTrade":
            ctx.emitTradeState(packet.payload);
            return true;

        case "openMarket":
            ctx.emitMarketState(packet.payload);
            return true;

        case "openRetos":
            ctx.emitRetosState(packet.payload);
            return true;

        case "closeTrade":
            ctx.emitTradeState(null);
            ctx.emitMarketState(null);
            return true;

        case "openBail":
            ctx.emitBailState(packet.payload);
            return true;

        case "openCrafting":
            ctx.emitCraftingState(packet.payload);
            return true;

        case "closeBail":
            ctx.emitBailState(null);
            return true;

        case "partyState":
            ctx.pendingPartyMembersRef.current = applyHudMemberDelta(
                ctx.pendingPartyMembersRef.current,
                packet.payload as PartyStateDelta,
            );
            ctx.mergeHud({ partyMembers: ctx.pendingPartyMembersRef.current });
            if (engine) {
                for (const entity of Object.values(
                    engine.personajes,
                ) as any[]) {
                    if (entity && entity.id !== engine.user?.id) {
                        await ctx.syncRemoteEntity(engine, entity);
                    }
                }
            }
            return true;

        case "clanState":
            ctx.pendingClanMembersRef.current = applyHudMemberDelta(
                ctx.pendingClanMembersRef.current,
                packet.payload as ClanStateDelta,
            );
            ctx.mergeHud({ clanMembers: ctx.pendingClanMembersRef.current });
            return true;

        case "navegando": {
            const isNavigating = Boolean(packet.payload.navegando);

            ctx.mergeHud({ navegando: isNavigating });

            if (ctx.pendingUserSnapshotRef.current) {
                ctx.pendingUserSnapshotRef.current = {
                    ...ctx.pendingUserSnapshotRef.current,
                    navegando: packet.payload.navegando,
                };
            }

            if (engine?.user) {
                engine.user.navegando = isNavigating;
                const currentUser = engine.personajes[engine.user.id];
                if (currentUser) {
                    currentUser.navegando = isNavigating;
                }
            }
            return true;
        }

        case "changeArrow":
            if (engine?.user?.id === packet.payload.id) {
                ctx.updateEquippedInventoryByType(
                    OBJECT_TYPE.flechas,
                    packet.payload.slot > 0 ? packet.payload.slot : null,
                );
            }
            return true;

        default:
            return false;
    }
}
