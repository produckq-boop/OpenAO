import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    type RefObject,
} from "react";
import {
    Container,
    FederatedPointerEvent,
    Graphics,
    Sprite,
    Text,
    TextStyle,
    type Texture,
} from "pixi.js";
import {
    buildEffectiveMapTile,
    clampLocalPixelToTile,
    computeTileRectBounds,
    countPlayersInMap,
    expandTileRectCoords,
    localPixelToTile,
    makeTileKey,
    registerUploadedGraphicInCatalog,
    resolveEffectiveTileBlocked,
    tileVisualSignature,
    type PlayerCountSummary,
    type TileCoord,
} from "../../../lib/editor/inGameEditorTools";
import {
    loadGraphicTexture,
    resolveGraphicFrame,
} from "../../../lib/graphicTextures";
import { TILE_SIZE } from "../../../lib/viewport";
import type { MapData } from "../../../types/game";
import {
    getTileAt,
    invalidateCachedMapData,
    loadRawBaseMapData,
} from "../../../utils/gameLoader";
import type { Engine } from "../engine/Engine";
import { getBottomAnchoredGraphicPosition } from "../rendering/characterLayout";
import {
    ensureMapTile,
    removeObjectSprite,
    removeRoofSpritesForTile,
    removeSceneLayerSprite,
} from "../rendering/sceneRenderer";
import type { InGameEditorSceneConfig } from "./inGameEditorTypes";

type OverlayHandles = {
    engine: Engine;
    root: Container;
    entityPreviewContainer: Container;
    gridGraphics: Graphics;
    blockedGraphics: Graphics;
    exitsContainer: Container;
    selectionGraphics: Graphics;
    syncTicker: () => void;
};

type ActiveGesture =
    | {
          mode: "stroke";
          visitedKeys: Set<string>;
          coords: TileCoord[];
      }
    | {
          mode: "rect";
          start: TileCoord;
          current: TileCoord;
      };

const previewTextureCache = new Map<string, Promise<Texture | null>>();

function loadPreviewTextureCached(
    engine: Engine,
    grhIndex: number,
): Promise<Texture | null> {
    if (!engine.graphicsDB || grhIndex <= 0) {
        return Promise.resolve(null);
    }

    const graphic = resolveGraphicFrame(engine.graphicsDB, grhIndex, "2");
    if (!graphic) {
        return Promise.resolve(null);
    }

    const cacheKey = `${graphic.numFile}:${graphic.sX}:${graphic.sY}:${graphic.width}:${graphic.height}`;
    const existing = previewTextureCache.get(cacheKey);
    if (existing) {
        return existing;
    }

    const pending = loadGraphicTexture(graphic).catch(() => null);
    previewTextureCache.set(cacheKey, pending);
    return pending;
}

const EXIT_LABEL_STYLE = new TextStyle({
    fontFamily: "Courier New, monospace",
    fontSize: 9,
    fontWeight: "700",
    fill: 0xa7f3d0,
    stroke: { color: 0x09090b, width: 2.5 },
});

type UseInGameEditorSceneOptions = {
    engineRef: RefObject<Engine | null>;
    isSceneReady: boolean;
    mapNumber: number;
    config?: InGameEditorSceneConfig | null;
    clearMovementInputState: (engine?: Engine | null) => void;
    clearTargetingMode: () => void;
    updateCanvasCursor: () => void;
    preloadGraphicIds: (engine: Engine, graphicIds: string[]) => Promise<void>;
    renderMap: (
        engine: Engine,
        options?: {
            includeLayers?: Array<"1" | "2" | "3" | "4">;
            includeObjects?: boolean;
            bounds?: {
                minX: number;
                maxX: number;
                minY: number;
                maxY: number;
            };
        },
    ) => Promise<void>;
};

export function useInGameEditorScene({
    engineRef,
    isSceneReady,
    mapNumber,
    config,
    clearMovementInputState,
    clearTargetingMode,
    updateCanvasCursor,
    preloadGraphicIds,
    renderMap,
}: UseInGameEditorSceneOptions) {
    const configRef = useRef<InGameEditorSceneConfig | null>(config ?? null);
    useLayoutEffect(() => {
        configRef.current = config ?? null;
    }, [config]);

    const overlayRef = useRef<OverlayHandles | null>(null);
    const gestureRef = useRef<ActiveGesture | null>(null);
    const hoverTileRef = useRef<TileCoord | null>(null);
    const rawBaseMapRef = useRef<{ mapNumber: number; data: MapData } | null>(
        null,
    );
    const appliedSignaturesRef = useRef<{
        mapNumber: number;
        signatures: Map<string, string>;
    } | null>(null);
    const hadPatchedMapRef = useRef(false);
    const syncRunIdRef = useRef(0);
    const entityRenderTokenRef = useRef(0);
    const lastReloadRevisionRef = useRef<number>(config?.reloadRevision ?? 0);
    const lastEmittedPlayerCountRef = useRef<PlayerCountSummary | null>(null);

    const isEditorEnabled = Boolean(config?.enabled);

    const destroyOverlay = useCallback(() => {
        const current = overlayRef.current;
        if (!current) {
            return;
        }

        overlayRef.current = null;

        if (current.engine.app && !current.engine.isDestroyed) {
            current.engine.app.ticker.remove(current.syncTicker);
        }

        if (!(current.root as { destroyed?: boolean }).destroyed) {
            current.root.parent?.removeChild(current.root);
            current.root.destroy({ children: true });
        }
    }, []);

    const ensureOverlay = useCallback((): OverlayHandles | null => {
        const engine = engineRef.current;
        if (
            !engine ||
            engine.isDestroyed ||
            !engine.app ||
            !engine.mapContainer
        ) {
            return null;
        }

        const existing = overlayRef.current;
        if (
            existing &&
            existing.engine === engine &&
            !(existing.root as { destroyed?: boolean }).destroyed
        ) {
            return existing;
        }

        destroyOverlay();

        engine.app.stage.sortableChildren = true;

        const root = new Container();
        root.sortableChildren = true;
        root.eventMode = "none";
        root.interactiveChildren = false;
        root.zIndex = 900;
        root.x = engine.mapContainer.x;
        root.y = engine.mapContainer.y;

        const entityPreviewContainer = new Container();
        entityPreviewContainer.sortableChildren = true;
        entityPreviewContainer.zIndex = 1;

        const gridGraphics = new Graphics();
        gridGraphics.zIndex = 10;

        const blockedGraphics = new Graphics();
        blockedGraphics.zIndex = 11;

        const exitsContainer = new Container();
        exitsContainer.zIndex = 12;

        const selectionGraphics = new Graphics();
        selectionGraphics.zIndex = 13;

        root.addChild(entityPreviewContainer);
        root.addChild(gridGraphics);
        root.addChild(blockedGraphics);
        root.addChild(exitsContainer);
        root.addChild(selectionGraphics);
        engine.app.stage.addChild(root);

        const syncTicker = () => {
            if (engine.isDestroyed || !engine.mapContainer) {
                return;
            }
            root.x = engine.mapContainer.x;
            root.y = engine.mapContainer.y;
        };
        engine.app.ticker.add(syncTicker);

        const handles: OverlayHandles = {
            engine,
            root,
            entityPreviewContainer,
            gridGraphics,
            blockedGraphics,
            exitsContainer,
            selectionGraphics,
            syncTicker,
        };
        overlayRef.current = handles;
        return handles;
    }, [destroyOverlay, engineRef]);

    const redrawSelectionOverlay = useCallback(() => {
        const handles = overlayRef.current;
        if (!handles) {
            return;
        }

        const graphics = handles.selectionGraphics;
        graphics.clear();

        if (!configRef.current?.enabled) {
            graphics.visible = false;
            return;
        }

        const gesture = gestureRef.current;
        if (gesture?.mode === "rect") {
            const bounds = computeTileRectBounds(
                gesture.start,
                gesture.current,
            );
            graphics.visible = true;
            graphics
                .rect(
                    (bounds.minX - 1) * TILE_SIZE,
                    (bounds.minY - 1) * TILE_SIZE,
                    bounds.width * TILE_SIZE,
                    bounds.height * TILE_SIZE,
                )
                .fill({ color: 0xfbbf24, alpha: 0.2 })
                .stroke({ color: 0xfbbf24, alpha: 0.95, width: 2 });
            return;
        }

        if (gesture?.mode === "stroke" && gesture.coords.length > 0) {
            graphics.visible = true;
            for (const coord of gesture.coords) {
                graphics
                    .rect(
                        (coord.x - 1) * TILE_SIZE,
                        (coord.y - 1) * TILE_SIZE,
                        TILE_SIZE,
                        TILE_SIZE,
                    )
                    .fill({ color: 0x38bdf8, alpha: 0.22 })
                    .stroke({ color: 0x38bdf8, alpha: 0.85, width: 1 });
            }
        }

        const hover = hoverTileRef.current;
        if (hover) {
            graphics.visible = true;
            graphics
                .rect(
                    (hover.x - 1) * TILE_SIZE,
                    (hover.y - 1) * TILE_SIZE,
                    TILE_SIZE,
                    TILE_SIZE,
                )
                .fill({ color: 0xfbbf24, alpha: 0.24 })
                .stroke({ color: 0xfbbf24, alpha: 0.9, width: 1.5 });
            return;
        }

        if (!gesture) {
            graphics.visible = false;
        }
    }, []);

    const getPlayerCountSummary = useCallback((): PlayerCountSummary => {
        const engine = engineRef.current;
        if (!engine) {
            return { totalPlayers: 0, otherPlayers: 0 };
        }

        return countPlayersInMap({
            mapNumber: engine.mapNumber,
            user: engine.user,
            personajes: engine.personajes,
        });
    }, [engineRef]);

    const registerUploadedGraphic = useCallback(
        async (uploaded: {
            grhIndex: number;
            width: number;
            height: number;
        }) => {
            const engine = engineRef.current;
            if (!engine || engine.isDestroyed) {
                return;
            }

            registerUploadedGraphicInCatalog(engine.graphicsDB, uploaded);
            await preloadGraphicIds(engine, [String(uploaded.grhIndex)]);
        },
        [engineRef, preloadGraphicIds],
    );

    useEffect(() => {
        if (!config?.onBridgeReady) {
            return;
        }

        config.onBridgeReady({
            registerUploadedGraphic,
            getPlayerCountSummary,
        });

        return () => {
            config.onBridgeReady?.(null);
        };
    }, [config, getPlayerCountSummary, registerUploadedGraphic]);

    useEffect(() => {
        const engine = engineRef.current;

        if (isEditorEnabled) {
            clearMovementInputState(engine);
            clearTargetingMode();
            if (engine?.app?.canvas) {
                engine.app.canvas.style.cursor = "crosshair";
            }
            return;
        }

        gestureRef.current = null;
        hoverTileRef.current = null;
        configRef.current?.onCursorTileChange?.(null);
        configRef.current?.onSelectionPreviewChange?.(null);
        if (overlayRef.current) {
            overlayRef.current.root.visible = false;
        }
        updateCanvasCursor();
    }, [
        clearMovementInputState,
        clearTargetingMode,
        engineRef,
        isEditorEnabled,
        isSceneReady,
        updateCanvasCursor,
    ]);

    useEffect(() => {
        gestureRef.current = null;
        hoverTileRef.current = null;
        rawBaseMapRef.current = null;
        appliedSignaturesRef.current = null;
        hadPatchedMapRef.current = false;
    }, [mapNumber]);

    useEffect(() => {
        if (!config || config.reloadRevision === lastReloadRevisionRef.current) {
            return;
        }

        lastReloadRevisionRef.current = config.reloadRevision;
        invalidateCachedMapData(mapNumber);
    }, [config, mapNumber]);

    useEffect(() => {
        if (!isEditorEnabled || !isSceneReady) {
            return;
        }

        const emitIfChanged = () => {
            const next = getPlayerCountSummary();
            const previous = lastEmittedPlayerCountRef.current;
            if (
                !previous ||
                previous.totalPlayers !== next.totalPlayers ||
                previous.otherPlayers !== next.otherPlayers
            ) {
                lastEmittedPlayerCountRef.current = next;
                configRef.current?.onPlayerCountChange?.(next);
            }
        };

        emitIfChanged();
        const intervalId = window.setInterval(emitIfChanged, 1000);
        return () => {
            window.clearInterval(intervalId);
        };
    }, [getPlayerCountSummary, isEditorEnabled, isSceneReady, mapNumber]);

    // Sincroniza los tiles editados sobre `engine.mapData` y re-renderiza solo
    // el rectangulo modificado en la escena viva de PixiJS.
    useEffect(() => {
        const engine = engineRef.current;
        if (
            !isSceneReady ||
            !engine ||
            engine.isDestroyed ||
            !engine.mapData ||
            engine.mapNumber !== mapNumber
        ) {
            return;
        }

        const activeConfig = config;
        const shouldPatchWithDrafts = Boolean(
            activeConfig?.enabled && activeConfig.mapNum === mapNumber,
        );

        if (!shouldPatchWithDrafts && !hadPatchedMapRef.current) {
            return;
        }

        const runId = ++syncRunIdRef.current;

        void (async () => {
            try {
                let rawBaseMap =
                    rawBaseMapRef.current?.mapNumber === mapNumber
                        ? rawBaseMapRef.current.data
                        : null;

                if (!rawBaseMap) {
                    rawBaseMap = await loadRawBaseMapData(mapNumber);
                    if (
                        runId !== syncRunIdRef.current ||
                        engine.isDestroyed ||
                        engineRef.current !== engine
                    ) {
                        return;
                    }
                    rawBaseMapRef.current = { mapNumber, data: rawBaseMap };
                }

                const overridesSource =
                    activeConfig && activeConfig.mapNum === mapNumber
                        ? shouldPatchWithDrafts
                            ? activeConfig.overrides
                            : activeConfig.overrides.filter(
                                  (entry) => entry.status === "published",
                              )
                        : [];
                const exitsSource =
                    activeConfig &&
                    shouldPatchWithDrafts &&
                    activeConfig.mapNum === mapNumber
                        ? activeConfig.draftExits
                        : [];

                const overridesByTile = new Map<
                    string,
                    typeof overridesSource
                >();
                for (const entry of overridesSource) {
                    const key = makeTileKey(entry.x, entry.y);
                    const list = overridesByTile.get(key) ?? [];
                    list.push(entry);
                    overridesByTile.set(key, list);
                }

                const exitByTile = new Map(
                    exitsSource.map((entry) => [
                        makeTileKey(entry.x, entry.y),
                        entry,
                    ]),
                );

                if (
                    !appliedSignaturesRef.current ||
                    appliedSignaturesRef.current.mapNumber !== mapNumber
                ) {
                    const baseline = new Map<string, string>();
                    for (let y = 1; y <= engine.mapDimensions.height; y += 1) {
                        for (
                            let x = 1;
                            x <= engine.mapDimensions.width;
                            x += 1
                        ) {
                            baseline.set(
                                makeTileKey(x, y),
                                tileVisualSignature(
                                    getTileAt(engine.mapData!, mapNumber, x, y),
                                ),
                            );
                        }
                    }
                    appliedSignaturesRef.current = {
                        mapNumber,
                        signatures: baseline,
                    };
                }

                const signatures = appliedSignaturesRef.current.signatures;
                let minX = Infinity;
                let maxX = -Infinity;
                let minY = Infinity;
                let maxY = -Infinity;
                let changedCount = 0;

                for (let y = 1; y <= engine.mapDimensions.height; y += 1) {
                    for (let x = 1; x <= engine.mapDimensions.width; x += 1) {
                        const key = makeTileKey(x, y);
                        const baseTile = getTileAt(rawBaseMap, mapNumber, x, y);
                        const nextTile = buildEffectiveMapTile(
                            baseTile,
                            overridesByTile.get(key) ?? [],
                            exitByTile.get(key),
                        );
                        const nextSig = tileVisualSignature(nextTile);

                        if (signatures.get(key) === nextSig) {
                            continue;
                        }

                        signatures.set(key, nextSig);
                        const targetTile = ensureMapTile(
                            engine,
                            mapNumber,
                            x,
                            y,
                        );
                        if (targetTile) {
                            delete targetTile.blocked;
                            delete targetTile.graphics;
                            delete targetTile.tileExit;
                            delete targetTile.trigger;
                            delete targetTile.npcIndex;
                            delete targetTile.objInfo;
                            Object.assign(targetTile, nextTile);
                        }

                        removeSceneLayerSprite(engine, `layer1:${key}`);
                        removeSceneLayerSprite(engine, `layer2:${key}`);
                        removeSceneLayerSprite(engine, `layer3:${key}`, key);
                        removeRoofSpritesForTile(engine, key);
                        if (!nextTile.objInfo) {
                            removeObjectSprite(engine, key);
                        }

                        minX = Math.min(minX, x);
                        maxX = Math.max(maxX, x);
                        minY = Math.min(minY, y);
                        maxY = Math.max(maxY, y);
                        changedCount += 1;
                    }
                }

                hadPatchedMapRef.current = shouldPatchWithDrafts;

                if (changedCount === 0) {
                    return;
                }

                await renderMap(engine, {
                    includeLayers: ["1", "2", "3", "4"],
                    includeObjects: true,
                    bounds: { minX, maxX, minY, maxY },
                });

                if (engine.isDestroyed || engineRef.current !== engine) {
                    return;
                }

                engine.cullingDirty = true;
                engine.roofVisibilityDirty = true;
                engine.treeTransparencyDirty = true;
                engine.updateCulling();
                engine.updateRoofVisibility();
            } catch (error) {
                console.warn(
                    "No se pudieron sincronizar los tiles del editor en /play:",
                    error,
                );
            }
        })();
    }, [
        config,
        engineRef,
        isSceneReady,
        mapNumber,
        renderMap,
    ]);

    // Dibuja los overlays de grilla, bloqueos y salidas sobre la escena.
    useEffect(() => {
        if (!isSceneReady || !config?.enabled || config.mapNum !== mapNumber) {
            if (overlayRef.current) {
                overlayRef.current.root.visible = false;
            }
            return;
        }

        const engine = engineRef.current;
        const handles = ensureOverlay();
        if (!engine || !handles || !engine.mapData) {
            return;
        }

        handles.root.visible = true;
        handles.root.x = engine.mapContainer?.x ?? 0;
        handles.root.y = engine.mapContainer?.y ?? 0;

        const { width, height } = engine.mapDimensions;

        handles.gridGraphics.clear();
        if (config.showGrid && width > 0 && height > 0) {
            handles.gridGraphics
                .rect(0, 0, width * TILE_SIZE, height * TILE_SIZE)
                .stroke({ color: 0x78716c, alpha: 0.42, width: 1 });

            for (let x = 1; x < width; x += 1) {
                handles.gridGraphics.moveTo(x * TILE_SIZE, 0);
                handles.gridGraphics.lineTo(x * TILE_SIZE, height * TILE_SIZE);
            }

            for (let y = 1; y < height; y += 1) {
                handles.gridGraphics.moveTo(0, y * TILE_SIZE);
                handles.gridGraphics.lineTo(width * TILE_SIZE, y * TILE_SIZE);
            }

            handles.gridGraphics.stroke({
                color: 0x78716c,
                alpha: 0.35,
                width: 1,
            });
        }

        handles.blockedGraphics.clear();
        if (config.showBlocked && width > 0 && height > 0) {
            const rawBaseMap =
                rawBaseMapRef.current?.mapNumber === mapNumber
                    ? rawBaseMapRef.current.data
                    : engine.mapData;
            const overridesByTile = new Map<
                string,
                typeof config.overrides
            >();

            for (const entry of config.overrides) {
                const key = makeTileKey(entry.x, entry.y);
                const existing = overridesByTile.get(key) ?? [];
                existing.push(entry);
                overridesByTile.set(key, existing);
            }

            for (let y = 1; y <= height; y += 1) {
                for (let x = 1; x <= width; x += 1) {
                    const baseTile = getTileAt(rawBaseMap, mapNumber, x, y);
                    const { blocked, overridden } = resolveEffectiveTileBlocked(
                        baseTile?.blocked,
                        overridesByTile.get(makeTileKey(x, y)) ?? [],
                    );

                    if (!blocked) {
                        continue;
                    }

                    handles.blockedGraphics
                        .rect(
                            (x - 1) * TILE_SIZE,
                            (y - 1) * TILE_SIZE,
                            TILE_SIZE,
                            TILE_SIZE,
                        )
                        .fill({
                            color: 0xef4444,
                            alpha: overridden ? 0.34 : 0.18,
                        });
                }
            }
        }

        for (const child of [...handles.exitsContainer.children]) {
            handles.exitsContainer.removeChild(child);
            child.destroy({ children: true });
        }

        const draftExitLookup = new Map(
            config.draftExits.map((entry) => [
                makeTileKey(entry.x, entry.y),
                entry,
            ]),
        );
        const exitGraphics = new Graphics();
        handles.exitsContainer.addChild(exitGraphics);

        for (let y = 1; y <= height; y += 1) {
            for (let x = 1; x <= width; x += 1) {
                const key = makeTileKey(x, y);
                const draftExit = draftExitLookup.get(key);
                const baseExit = getTileAt(
                    engine.mapData,
                    mapNumber,
                    x,
                    y,
                )?.tileExit;
                const activeExit = draftExit
                    ? {
                          map: draftExit.targetMap,
                          x: draftExit.targetX,
                          y: draftExit.targetY,
                          isDraft: true,
                      }
                    : baseExit
                      ? {
                            map: baseExit.map,
                            x: baseExit.x,
                            y: baseExit.y,
                            isDraft: false,
                        }
                      : null;

                if (!activeExit) {
                    continue;
                }

                const px = (x - 1) * TILE_SIZE;
                const py = (y - 1) * TILE_SIZE;
                exitGraphics
                    .rect(px + 2, py + 2, TILE_SIZE - 4, TILE_SIZE - 4)
                    .fill({
                        color: activeExit.isDraft ? 0x10b981 : 0x06b6d4,
                        alpha: activeExit.isDraft ? 0.28 : 0.14,
                    })
                    .stroke({
                        color: activeExit.isDraft ? 0x34d399 : 0x22d3ee,
                        alpha: activeExit.isDraft ? 0.95 : 0.55,
                        width: activeExit.isDraft ? 2 : 1,
                    });

                if (activeExit.isDraft || config.tool?.kind === "exit") {
                    const label = new Text({
                        text: `M${activeExit.map} ${activeExit.x},${activeExit.y}`,
                        style: EXIT_LABEL_STYLE,
                    });
                    label.anchor.set(0.5, 1);
                    label.x = px + TILE_SIZE / 2;
                    label.y = py + TILE_SIZE - 2;
                    handles.exitsContainer.addChild(label);
                }
            }
        }

        redrawSelectionOverlay();
    }, [
        config,
        engineRef,
        ensureOverlay,
        isSceneReady,
        mapNumber,
        redrawSelectionOverlay,
    ]);

    // Dibuja previsualizaciones de objetos y NPCs colocados desde el editor.
    const configEnabled = config?.enabled ?? false;
    const configMapNum = config?.mapNum ?? null;
    const configEntities = config?.entities;
    const configNpcs = config?.npcs;

    useEffect(() => {
        if (
            !isSceneReady ||
            !configEnabled ||
            configMapNum !== mapNumber ||
            !configEntities ||
            !configNpcs
        ) {
            return;
        }

        const engine = engineRef.current;
        const handles = ensureOverlay();
        if (!engine || !handles || !engine.objectsDB || !engine.bodiesDB) {
            return;
        }

        const renderToken = ++entityRenderTokenRef.current;
        const npcById = new Map(configNpcs.map((entry) => [entry.id, entry]));

        void (async () => {
            const resolvedItems: Array<{
                entity: (typeof configEntities)[number];
                texture: Texture | null;
            }> = await Promise.all(
                configEntities.map(async (entity) => {
                    let grhIndex = 0;
                    if (entity.kind === "obj") {
                        grhIndex = Number(
                            engine.objectsDB?.[String(entity.entityId)]
                                ?.grhIndex ?? 0,
                        );
                    } else {
                        const npcEntry = npcById.get(entity.entityId);
                        const bodyData = npcEntry
                            ? engine.bodiesDB?.[String(npcEntry.idBody)]
                            : undefined;
                        grhIndex = Number(bodyData?.["2"] ?? 0);
                    }

                    const texture = await loadPreviewTextureCached(
                        engine,
                        grhIndex,
                    );
                    return { entity, texture };
                }),
            );

            if (
                renderToken !== entityRenderTokenRef.current ||
                overlayRef.current !== handles
            ) {
                return;
            }

            for (const child of [...handles.entityPreviewContainer.children]) {
                handles.entityPreviewContainer.removeChild(child);
                child.destroy({ children: true });
            }

            for (const { entity, texture } of resolvedItems) {
                const px = (entity.x - 1) * TILE_SIZE;
                const py = (entity.y - 1) * TILE_SIZE;

                const marker = new Graphics();
                marker
                    .rect(px + 3, py + 3, TILE_SIZE - 6, TILE_SIZE - 6)
                    .stroke({
                        color:
                            entity.status === "draft" ? 0xfbbf24 : 0x34d399,
                        alpha: entity.status === "draft" ? 0.85 : 0.45,
                        width: 1.5,
                    });
                marker.zIndex = entity.y * 10;
                handles.entityPreviewContainer.addChild(marker);

                if (!texture) {
                    continue;
                }

                const sprite = new Sprite(texture);
                const anchored = getBottomAnchoredGraphicPosition(
                    texture.width,
                    texture.height,
                );
                sprite.x = Math.round(px + anchored.x);
                sprite.y = Math.round(py + anchored.y);
                sprite.alpha = entity.status === "draft" ? 0.92 : 0.72;
                if (entity.kind === "npc") {
                    sprite.tint = 0xd8b4fe;
                }
                sprite.zIndex = entity.y * 10 + 1;
                handles.entityPreviewContainer.addChild(sprite);
            }
        })();
    }, [
        configEnabled,
        configEntities,
        configMapNum,
        configNpcs,
        engineRef,
        ensureOverlay,
        isSceneReady,
        mapNumber,
    ]);

    const resolveEventTile = useCallback(
        (
            event: FederatedPointerEvent,
            clampToMap: boolean,
        ): TileCoord | null => {
            const engine = engineRef.current;
            if (!engine?.mapContainer) {
                return null;
            }

            const localPos = engine.mapContainer.toLocal(event.global);
            return clampToMap
                ? clampLocalPixelToTile(
                      localPos.x,
                      localPos.y,
                      engine.mapDimensions,
                  )
                : localPixelToTile(
                      localPos.x,
                      localPos.y,
                      engine.mapDimensions,
                  );
        },
        [engineRef],
    );

    const handleEditorPointerDown = useCallback(
        (event: FederatedPointerEvent): boolean => {
            const activeConfig = configRef.current;
            if (!activeConfig?.enabled) {
                return false;
            }

            // En modo edicion cualquier click sobre el lienzo queda absorbido
            // para no disparar movimiento ni ataques del personaje.
            if (event.button !== 0 || !activeConfig.tool) {
                return true;
            }

            const tile = resolveEventTile(event, false);
            if (!tile) {
                return true;
            }

            const supportsArea =
                activeConfig.tool.kind === "terrain" ||
                activeConfig.tool.kind === "erase" ||
                activeConfig.tool.kind === "exit";
            const useRectMode =
                supportsArea &&
                (activeConfig.drawMode === "rect" || event.shiftKey);

            if (useRectMode) {
                gestureRef.current = {
                    mode: "rect",
                    start: tile,
                    current: tile,
                };
                activeConfig.onSelectionPreviewChange?.(
                    computeTileRectBounds(tile, tile),
                );
                redrawSelectionOverlay();
                return true;
            }

            if (
                activeConfig.tool.kind === "object" ||
                activeConfig.tool.kind === "npc"
            ) {
                activeConfig.onCommitTiles?.([tile], "stroke");
                return true;
            }

            const visitedKeys = new Set<string>([makeTileKey(tile.x, tile.y)]);
            gestureRef.current = {
                mode: "stroke",
                visitedKeys,
                coords: [tile],
            };
            redrawSelectionOverlay();
            return true;
        },
        [redrawSelectionOverlay, resolveEventTile],
    );

    const handleEditorPointerMove = useCallback(
        (event: FederatedPointerEvent): void => {
            const activeConfig = configRef.current;
            if (!activeConfig?.enabled) {
                return;
            }

            const gesture = gestureRef.current;
            const hoverTile = resolveEventTile(event, false);
            const prevHover = hoverTileRef.current;
            const changedHover =
                prevHover?.x !== hoverTile?.x || prevHover?.y !== hoverTile?.y;

            if (changedHover) {
                hoverTileRef.current = hoverTile;
                activeConfig.onCursorTileChange?.(hoverTile);
            }

            if (gesture?.mode === "rect") {
                const clampedTile = resolveEventTile(event, true);
                if (
                    clampedTile &&
                    (clampedTile.x !== gesture.current.x ||
                        clampedTile.y !== gesture.current.y)
                ) {
                    gesture.current = clampedTile;
                    activeConfig.onSelectionPreviewChange?.(
                        computeTileRectBounds(gesture.start, clampedTile),
                    );
                    redrawSelectionOverlay();
                }
                return;
            }

            if (gesture?.mode === "stroke" && hoverTile) {
                const key = makeTileKey(hoverTile.x, hoverTile.y);
                if (!gesture.visitedKeys.has(key)) {
                    gesture.visitedKeys.add(key);
                    gesture.coords.push(hoverTile);
                    redrawSelectionOverlay();
                    return;
                }
            }

            if (changedHover) {
                redrawSelectionOverlay();
            }
        },
        [redrawSelectionOverlay, resolveEventTile],
    );

    const finalizeActiveGesture = useCallback(() => {
        const gesture = gestureRef.current;
        if (!gesture) {
            return;
        }

        gestureRef.current = null;
        const activeConfig = configRef.current;
        activeConfig?.onSelectionPreviewChange?.(null);
        redrawSelectionOverlay();

        if (!activeConfig?.enabled) {
            return;
        }

        if (gesture.mode === "rect") {
            const bounds = computeTileRectBounds(
                gesture.start,
                gesture.current,
            );
            activeConfig.onCommitTiles?.(
                expandTileRectCoords(bounds),
                "rect",
            );
            return;
        }

        if (gesture.coords.length > 0) {
            activeConfig.onCommitTiles?.(gesture.coords, "stroke");
        }
    }, [redrawSelectionOverlay]);

    const handleEditorPointerUp = useCallback((): boolean => {
        if (!configRef.current?.enabled) {
            return false;
        }

        finalizeActiveGesture();
        return true;
    }, [finalizeActiveGesture]);

    useEffect(() => {
        if (!isEditorEnabled) {
            return;
        }

        const handleWindowPointerUp = () => {
            finalizeActiveGesture();
        };

        window.addEventListener("pointerup", handleWindowPointerUp);
        window.addEventListener("pointercancel", handleWindowPointerUp);
        return () => {
            window.removeEventListener("pointerup", handleWindowPointerUp);
            window.removeEventListener("pointercancel", handleWindowPointerUp);
        };
    }, [finalizeActiveGesture, isEditorEnabled]);

    useEffect(() => {
        return () => {
            destroyOverlay();
        };
    }, [destroyOverlay]);

    const isGameplayBlockedByEditor = useCallback(
        () => Boolean(configRef.current?.enabled),
        [],
    );

    return {
        isGameplayBlockedByEditor,
        handleEditorPointerDown,
        handleEditorPointerMove,
        handleEditorPointerUp,
    };
}
