"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode,
} from "react";
import {
    clearTileOverride,
    discardMapDrafts,
    paintTiles,
    placeTileEntity,
    publishMapChanges,
    removeTileEntity,
    type UploadedGraphic,
} from "../../lib/editor/editorApi";
import {
    createTerrainBrush,
    EditorStoreProvider,
    useEditorStore,
    type ExitToolTarget,
} from "../../lib/editor/editorStore";
import {
    createEntityOperationCommand,
    createEraseOperationCommand,
    createExitOperationCommand,
    createPaintOperationCommand,
    InGameEditorHistory,
    matchEditorHistoryShortcut,
    type EditorPersistenceAdapter,
} from "../../lib/editor/inGameEditorHistory";
import {
    buildBrushTilePaints,
    type DrawMode,
    type PlayerCountSummary,
    type TileCoord,
    type TileRectBounds,
} from "../../lib/editor/inGameEditorTools";
import type { GameDataAdminState } from "../../lib/editor/useGameDataAdmin";
import type {
    InGameEditorEngineBridge,
    InGameEditorSceneConfig,
} from "../game/editor/inGameEditorTypes";
import { invalidateCachedMapData } from "../../utils/gameLoader";
import NpcsBrowser from "./NpcsBrowser";
import ObjectsBrowser from "./ObjectsBrowser";
import RecentsStrip from "./RecentsStrip";
import TerrainPalette from "./TerrainPalette";

type ConfirmModalAction = "publish" | "discard";

type ToolCategory = "terrain" | "object" | "npc" | "exit" | "erase";

const DEFAULT_EXIT_TARGET: ExitToolTarget = {
    targetMap: 1,
    targetX: 50,
    targetY: 50,
};

export function InGameEditorToggleButton({
    adminState,
    isEditMode,
    onToggle,
}: {
    adminState: GameDataAdminState;
    isEditMode: boolean;
    onToggle: () => void;
}) {
    if (adminState !== "allowed") {
        return null;
    }

    return (
        <button
            type="button"
            onClick={onToggle}
            aria-pressed={isEditMode}
            data-testid="ingame-editor-toggle"
            className={`pointer-events-auto flex items-center justify-center gap-2 rounded-xl border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] shadow-xl backdrop-blur-md transition ${
                isEditMode
                    ? "border-amber-400/80 bg-amber-400/20 text-amber-100 hover:bg-amber-400/30"
                    : "border-white/15 bg-stone-950/80 text-stone-200 hover:border-amber-400/55 hover:text-amber-200"
            }`}
        >
            <span
                className={`h-2 w-2 rounded-full ${
                    isEditMode ? "bg-amber-300" : "bg-stone-500"
                }`}
            />
            {isEditMode ? "Salir de edicion" : "Modo edicion"}
        </button>
    );
}

export type InGameEditorRenderSlots = {
    sceneConfig: InGameEditorSceneConfig | null;
    canvasOverlay: ReactNode;
    dockPanel: ReactNode;
    bottomBar: ReactNode;
    modal: ReactNode;
};

/**
 * Monta el estado del editor solo cuando la cuenta tiene permiso y abrio el
 * modo edicion al menos una vez. Asi una sesion normal no descarga catalogos ni
 * overrides del editor.
 */
export function InGameEditorSessionHost({
    adminState,
    isEditMode,
    mapNumber,
    panelHeight,
    onExitEditMode,
    children,
}: {
    adminState: GameDataAdminState;
    isEditMode: boolean;
    mapNumber: number;
    panelHeight: string;
    onExitEditMode: () => void;
    children: (slots: InGameEditorRenderSlots) => ReactNode;
}) {
    const [hasActivatedOnce, setHasActivatedOnce] = useState(false);

    useEffect(() => {
        if (adminState === "allowed" && isEditMode) {
            setHasActivatedOnce(true);
        }
    }, [adminState, isEditMode]);

    if (adminState !== "allowed" || (!hasActivatedOnce && !isEditMode)) {
        return <>{children(EMPTY_SLOTS)}</>;
    }

    return (
        <EditorStoreProvider initialMapNum={mapNumber}>
            <InGameEditorActiveController
                enabled={isEditMode}
                mapNumber={mapNumber}
                panelHeight={panelHeight}
                onExitEditMode={onExitEditMode}
            >
                <InGameEditorSlotReader render={children} />
            </InGameEditorActiveController>
        </EditorStoreProvider>
    );
}

const EMPTY_SLOTS: InGameEditorRenderSlots = {
    sceneConfig: null,
    canvasOverlay: null,
    dockPanel: null,
    bottomBar: null,
    modal: null,
};

const InGameEditorSlotsContext =
    createContext<InGameEditorRenderSlots>(EMPTY_SLOTS);

function InGameEditorSlotReader({
    render,
}: {
    render: (slots: InGameEditorRenderSlots) => ReactNode;
}) {
    const slots = useContext(InGameEditorSlotsContext);
    return <>{render(slots)}</>;
}

function InGameEditorActiveController({
    enabled,
    mapNumber,
    panelHeight,
    onExitEditMode,
    children,
}: {
    enabled: boolean;
    mapNumber: number;
    panelHeight: string;
    onExitEditMode: () => void;
    children: ReactNode;
}) {
    const {
        mapNum,
        setMapNum,
        terrain,
        objects,
        npcs,
        status,
        overrides,
        entities,
        draftExits,
        setDraftExit,
        removeDraftExit,
        clearDraftExits,
        tool,
        setTool,
        refreshMapData,
        refreshStatus,
        isLoading,
        loadError,
    } = useEditorStore();

    const [drawMode, setDrawMode] = useState<DrawMode>("brush");
    const [showGrid, setShowGrid] = useState(true);
    const [showBlocked, setShowBlocked] = useState(true);
    const [cursorTile, setCursorTile] = useState<TileCoord | null>(null);
    const [selectionPreview, setSelectionPreview] =
        useState<TileRectBounds | null>(null);
    const [playerCount, setPlayerCount] = useState<PlayerCountSummary>({
        totalPlayers: 0,
        otherPlayers: 0,
    });
    const [exitTarget, setExitTarget] =
        useState<ExitToolTarget>(DEFAULT_EXIT_TARGET);
    const [reloadRevision, setReloadRevision] = useState(0);
    const [operationError, setOperationError] = useState<string | null>(null);
    const [pendingModalAction, setPendingModalAction] =
        useState<ConfirmModalAction | null>(null);
    const [isConfirmBusy, setIsConfirmBusy] = useState(false);

    const bridgeRef = useRef<InGameEditorEngineBridge | null>(null);
    const [history] = useState(() => new InGameEditorHistory(mapNumber));

    const historySnapshot = useSyncExternalStore(
        history.subscribe,
        history.getSnapshot,
        history.getSnapshot,
    );

    const previousMapNumberRef = useRef(mapNumber);

    // Cuando cambia el mapa del jugador, recarga paleta/borradores y limpia la
    // pila de undo/redo del mapa anterior.
    useEffect(() => {
        if (mapNum !== mapNumber) {
            setMapNum(mapNumber);
        }
        if (previousMapNumberRef.current !== mapNumber) {
            previousMapNumberRef.current = mapNumber;
            history.reset(mapNumber);
            setCursorTile(null);
            setSelectionPreview(null);
            setOperationError(null);
            setPendingModalAction(null);
        }
    }, [history, mapNum, mapNumber, setMapNum]);

    // Selecciona el primer pincel de terreno al abrir el editor si todavia no
    // hay una herramienta elegida.
    useEffect(() => {
        if (!enabled || tool !== null || !terrain) {
            return;
        }

        const firstEntry = terrain.palette.find((entry) =>
            entry.graphics.some(
                (graphic) => typeof graphic === "number" && graphic > 0,
            ),
        );
        if (firstEntry) {
            setTool({
                kind: "terrain",
                ...createTerrainBrush(firstEntry),
            });
        }
    }, [enabled, setTool, terrain, tool]);

    const persistenceAdapter = useMemo<EditorPersistenceAdapter>(
        () => ({
            paintTiles,
            clearTileOverride,
            placeTileEntity,
            removeTileEntity,
            setDraftExit,
            removeDraftExit,
            onAfterSync: async () => {
                await refreshMapData();
                await refreshStatus();
            },
        }),
        [refreshMapData, refreshStatus, removeDraftExit, setDraftExit],
    );

    const handleCommitTiles = useCallback(
        (coords: TileCoord[], mode: "stroke" | "rect") => {
            if (!enabled || !tool || coords.length === 0 || mapNum !== mapNumber) {
                return;
            }

            setOperationError(null);

            const executeCommand = async () => {
                try {
                    if (tool.kind === "terrain") {
                        const nextPaints = buildBrushTilePaints(coords, tool);
                        if (nextPaints.length === 0) {
                            return;
                        }
                        const command = createPaintOperationCommand({
                            mapNum,
                            label:
                                mode === "rect"
                                    ? `Pintar area (${coords.length} tiles)`
                                    : `Pintar terreno (${coords.length} tiles)`,
                            nextPaints,
                            currentOverrides: overrides,
                            adapter: persistenceAdapter,
                        });
                        await history.execute(mapNum, command);
                        return;
                    }

                    if (tool.kind === "object" || tool.kind === "npc") {
                        const target = coords[0];
                        const command = createEntityOperationCommand({
                            mapNum,
                            label:
                                tool.kind === "object"
                                    ? `Colocar objeto ${tool.object.name}`
                                    : `Colocar NPC ${tool.npc.name}`,
                            placement: {
                                x: target.x,
                                y: target.y,
                                kind: tool.kind === "object" ? "obj" : "npc",
                                entityId:
                                    tool.kind === "object"
                                        ? tool.object.id
                                        : tool.npc.id,
                            },
                            currentEntities: entities,
                            adapter: persistenceAdapter,
                        });
                        await history.execute(mapNum, command);
                        return;
                    }

                    if (tool.kind === "exit") {
                        const command = createExitOperationCommand({
                            label: `Definir salida hacia mapa ${tool.targetMap}`,
                            coords,
                            target: {
                                targetMap: tool.targetMap,
                                targetX: tool.targetX,
                                targetY: tool.targetY,
                            },
                            currentDraftExits: draftExits,
                            adapter: persistenceAdapter,
                        });
                        await history.execute(mapNum, command);
                        return;
                    }

                    if (tool.kind === "erase") {
                        const command = createEraseOperationCommand({
                            mapNum,
                            label: `Borrar borradores (${coords.length} tiles)`,
                            coords,
                            currentOverrides: overrides,
                            currentEntities: entities,
                            currentDraftExits: draftExits,
                            adapter: persistenceAdapter,
                        });
                        if (command) {
                            await history.execute(mapNum, command);
                        }
                    }
                } catch (error) {
                    setOperationError(
                        error instanceof Error
                            ? error.message
                            : "No se pudo guardar el cambio en el mapa.",
                    );
                }
            };

            void executeCommand();
        },
        [
            draftExits,
            enabled,
            entities,
            history,
            mapNum,
            mapNumber,
            overrides,
            persistenceAdapter,
            tool,
        ],
    );

    const handleUndo = useCallback(async () => {
        setOperationError(null);
        try {
            await history.undo();
        } catch (error) {
            setOperationError(
                error instanceof Error
                    ? error.message
                    : "No se pudo deshacer el cambio.",
            );
        }
    }, [history]);

    const handleRedo = useCallback(async () => {
        setOperationError(null);
        try {
            await history.redo();
        } catch (error) {
            setOperationError(
                error instanceof Error
                    ? error.message
                    : "No se pudo rehacer el cambio.",
            );
        }
    }, [history]);

    useEffect(() => {
        if (!enabled) {
            return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (pendingModalAction !== null) {
                return;
            }

            const shortcut = matchEditorHistoryShortcut(event);
            if (!shortcut) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            if (shortcut === "undo") {
                void handleUndo();
            } else {
                void handleRedo();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [enabled, handleRedo, handleUndo, pendingModalAction]);

    const handleUploadedGraphic = useCallback(
        async (uploaded: UploadedGraphic) => {
            await bridgeRef.current?.registerUploadedGraphic(uploaded);
        },
        [],
    );

    const handleBridgeReady = useCallback(
        (bridge: InGameEditorEngineBridge | null) => {
            bridgeRef.current = bridge;
            if (bridge) {
                setPlayerCount(bridge.getPlayerCountSummary());
            }
        },
        [],
    );

    const openConfirmModal = useCallback((action: ConfirmModalAction) => {
        if (bridgeRef.current) {
            setPlayerCount(bridgeRef.current.getPlayerCountSummary());
        }
        setPendingModalAction(action);
    }, []);

    const handleConfirmModalAction = useCallback(async () => {
        if (!pendingModalAction) {
            return;
        }

        const action = pendingModalAction;
        setIsConfirmBusy(true);
        setOperationError(null);

        try {
            if (action === "publish") {
                await publishMapChanges(mapNum);
            } else {
                await discardMapDrafts(mapNum);
                clearDraftExits();
            }

            invalidateCachedMapData(mapNum);
            history.reset(mapNum);
            setReloadRevision((current) => current + 1);
            await refreshMapData();
            await refreshStatus();
            setPendingModalAction(null);
        } catch (error) {
            setOperationError(
                error instanceof Error
                    ? error.message
                    : action === "publish"
                      ? "No se pudo publicar el mapa."
                      : "No se pudieron descartar los borradores.",
            );
        } finally {
            setIsConfirmBusy(false);
        }
    }, [
        clearDraftExits,
        history,
        mapNum,
        pendingModalAction,
        refreshMapData,
        refreshStatus,
    ]);

    const selectCategory = useCallback(
        (category: ToolCategory) => {
            if (category === "terrain") {
                if (tool?.kind === "terrain") {
                    return;
                }
                const firstEntry = terrain?.palette.find((entry) =>
                    entry.graphics.some(
                        (graphic) => typeof graphic === "number" && graphic > 0,
                    ),
                );
                if (firstEntry) {
                    setTool({
                        kind: "terrain",
                        ...createTerrainBrush(firstEntry),
                    });
                }
                return;
            }

            if (category === "object") {
                if (tool?.kind === "object") {
                    return;
                }
                if (objects[0]) {
                    setTool({ kind: "object", object: objects[0] });
                }
                return;
            }

            if (category === "npc") {
                if (tool?.kind === "npc") {
                    return;
                }
                if (npcs[0]) {
                    setTool({ kind: "npc", npc: npcs[0] });
                }
                return;
            }

            if (category === "exit") {
                setTool({ kind: "exit", ...exitTarget });
                return;
            }

            setTool({ kind: "erase" });
        },
        [exitTarget, npcs, objects, setTool, terrain, tool],
    );

    const updateExitTarget = useCallback(
        (patch: Partial<ExitToolTarget>) => {
            setExitTarget((current) => {
                const next: ExitToolTarget = {
                    targetMap: Math.max(
                        1,
                        Math.floor(patch.targetMap ?? current.targetMap),
                    ),
                    targetX: Math.max(
                        1,
                        Math.min(
                            100,
                            Math.floor(patch.targetX ?? current.targetX),
                        ),
                    ),
                    targetY: Math.max(
                        1,
                        Math.min(
                            100,
                            Math.floor(patch.targetY ?? current.targetY),
                        ),
                    ),
                };

                if (tool?.kind === "exit") {
                    setTool({ kind: "exit", ...next });
                }

                return next;
            });
        },
        [setTool, tool?.kind],
    );

    const draftTiles = status?.draft ?? 0;
    const draftEntities = status?.draftEntities ?? 0;
    const draftServerTotal = draftTiles + draftEntities;
    const draftExitsCount = draftExits.length;

    const sceneConfig = useMemo<InGameEditorSceneConfig>(
        () => ({
            enabled,
            mapNum,
            tool,
            drawMode,
            showGrid,
            showBlocked,
            overrides,
            entities,
            npcs,
            draftExits,
            reloadRevision,
            onCursorTileChange: setCursorTile,
            onSelectionPreviewChange: setSelectionPreview,
            onPlayerCountChange: setPlayerCount,
            onCommitTiles: handleCommitTiles,
            onBridgeReady: handleBridgeReady,
        }),
        [
            draftExits,
            drawMode,
            enabled,
            entities,
            handleBridgeReady,
            handleCommitTiles,
            mapNum,
            npcs,
            overrides,
            reloadRevision,
            showBlocked,
            showGrid,
            tool,
        ],
    );

    if (!enabled) {
        return (
            <InGameEditorSlotsContext.Provider
                value={{
                    sceneConfig,
                    canvasOverlay: null,
                    dockPanel: null,
                    bottomBar: null,
                    modal: null,
                }}
            >
                {children}
            </InGameEditorSlotsContext.Provider>
        );
    }

    const activeCategory: ToolCategory = tool?.kind ?? "terrain";
    const visibleError = operationError ?? loadError;

    const canvasOverlay = (
        <div
            data-testid="ingame-editor-banner"
            className="pointer-events-none absolute inset-0 z-30 rounded-[22px] ring-2 ring-amber-400/85 shadow-[inset_0_0_28px_rgba(251,191,36,0.2)]"
        >
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-3">
                <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-amber-400/60 bg-stone-950/90 px-3 py-1 text-[11px] text-amber-100 shadow-xl backdrop-blur-md">
                    <span className="h-2 w-2 rounded-full bg-amber-400" />
                    <span className="font-semibold uppercase tracking-[0.18em]">
                        Modo edicion
                    </span>
                    <span className="text-stone-400">·</span>
                    <span>Mapa {mapNumber}</span>
                    {selectionPreview ? (
                        <span className="text-amber-300">
                            · Area {selectionPreview.width}x
                            {selectionPreview.height} (
                            {selectionPreview.tileCount})
                        </span>
                    ) : cursorTile ? (
                        <span className="text-stone-300">
                            · Tile {cursorTile.x}, {cursorTile.y}
                        </span>
                    ) : (
                        <span className="text-stone-400">
                            · Movimiento bloqueado
                        </span>
                    )}
                </div>

                <div className="pointer-events-auto flex items-center gap-1.5">
                    <div className="flex items-center rounded-full border border-white/10 bg-stone-950/90 p-0.5 text-[10px] backdrop-blur-md">
                        <button
                            type="button"
                            onClick={() => setDrawMode("brush")}
                            aria-pressed={drawMode === "brush"}
                            className={`rounded-full px-2.5 py-0.5 transition ${
                                drawMode === "brush"
                                    ? "bg-amber-400/20 text-amber-200"
                                    : "text-stone-400 hover:text-stone-200"
                            }`}
                            title="Pintado continuo por arrastre"
                        >
                            Trazo
                        </button>
                        <button
                            type="button"
                            onClick={() => setDrawMode("rect")}
                            aria-pressed={drawMode === "rect"}
                            className={`rounded-full px-2.5 py-0.5 transition ${
                                drawMode === "rect"
                                    ? "bg-amber-400/20 text-amber-200"
                                    : "text-stone-400 hover:text-stone-200"
                            }`}
                            title="Seleccion de area rectangular (o Shift + arrastrar)"
                        >
                            Rectangulo
                        </button>
                    </div>

                    <label className="flex cursor-pointer items-center gap-1 rounded-full border border-white/10 bg-stone-950/90 px-2.5 py-1 text-[10px] text-stone-200 backdrop-blur-md">
                        <input
                            type="checkbox"
                            checked={showGrid}
                            onChange={(event) =>
                                setShowGrid(event.target.checked)
                            }
                            className="accent-amber-400"
                        />
                        Grilla
                    </label>

                    <label className="flex cursor-pointer items-center gap-1 rounded-full border border-white/10 bg-stone-950/90 px-2.5 py-1 text-[10px] text-stone-200 backdrop-blur-md">
                        <input
                            type="checkbox"
                            checked={showBlocked}
                            onChange={(event) =>
                                setShowBlocked(event.target.checked)
                            }
                            className="accent-red-400"
                        />
                        Bloqueos
                    </label>
                </div>
            </div>

            {visibleError ? (
                <div className="pointer-events-auto absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2 rounded-xl border border-red-500/45 bg-stone-950/92 px-3 py-2 text-[11px] text-red-200 shadow-xl backdrop-blur-md">
                    <span>{visibleError}</span>
                    {operationError ? (
                        <button
                            type="button"
                            onClick={() => setOperationError(null)}
                            className="shrink-0 text-red-300/80 hover:text-red-100"
                        >
                            Cerrar
                        </button>
                    ) : null}
                </div>
            ) : historySnapshot.isBusy || isLoading ? (
                <div className="absolute bottom-3 left-3 rounded-full border border-amber-400/35 bg-stone-950/88 px-3 py-1 text-[11px] text-amber-200 backdrop-blur-md">
                    {historySnapshot.isBusy
                        ? "Sincronizando edicion..."
                        : "Cargando datos del editor..."}
                </div>
            ) : null}
        </div>
    );

    const dockPanel = (
        <aside
            aria-label="Panel del editor de mapas"
            style={{ height: panelHeight }}
            className="pointer-events-auto flex w-[320px] flex-col gap-2.5 overflow-hidden rounded-2xl border border-amber-400/35 bg-stone-950/90 p-3 text-stone-100 shadow-2xl backdrop-blur-md"
        >
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-amber-300">
                        Editor en vivo
                    </div>
                    <div className="text-xs text-stone-300">
                        Mapa #{mapNumber} · {playerCount.totalPlayers}{" "}
                        {playerCount.totalPlayers === 1
                            ? "jugador"
                            : "jugadores"}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={onExitEditMode}
                    className="rounded-lg border border-white/10 bg-stone-900/80 px-2.5 py-1 text-[11px] text-stone-300 transition hover:border-white/25 hover:text-white"
                >
                    Cerrar
                </button>
            </div>

            <div
                role="tablist"
                aria-label="Selector de herramienta"
                className="grid grid-cols-5 gap-1 rounded-xl border border-white/10 bg-stone-950/70 p-1"
            >
                {(
                    [
                        { id: "terrain", label: "Terreno" },
                        { id: "object", label: "Objeto" },
                        { id: "npc", label: "NPC" },
                        { id: "exit", label: "Salida" },
                        { id: "erase", label: "Borrar" },
                    ] as const
                ).map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        role="tab"
                        aria-selected={activeCategory === entry.id}
                        onClick={() => selectCategory(entry.id)}
                        className={`rounded-lg px-1.5 py-1.5 text-[10px] font-medium transition ${
                            activeCategory === entry.id
                                ? "bg-amber-400/20 text-amber-200"
                                : "text-stone-400 hover:text-stone-200"
                        }`}
                    >
                        {entry.label}
                    </button>
                ))}
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
                {activeCategory === "terrain" ? (
                    <TerrainPalette onUploadedGraphic={handleUploadedGraphic} />
                ) : null}
                {activeCategory === "object" ? <ObjectsBrowser /> : null}
                {activeCategory === "npc" ? <NpcsBrowser /> : null}
                {activeCategory === "exit" ? (
                    <ExitToolPanel
                        exitTarget={exitTarget}
                        onChangeTarget={updateExitTarget}
                        draftExits={draftExits}
                        onRemoveExit={removeDraftExit}
                    />
                ) : null}
                {activeCategory === "erase" ? (
                    <EraseToolPanel
                        draftTiles={draftTiles}
                        draftEntities={draftEntities}
                        draftExitsCount={draftExitsCount}
                    />
                ) : null}
            </div>
        </aside>
    );

    const bottomBar = (
        <div className="pointer-events-auto flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-amber-400/35 bg-stone-950/88 px-3.5 py-2.5 text-xs text-stone-200 shadow-xl backdrop-blur-md">
                <div className="flex items-center gap-1.5">
                    <button
                        type="button"
                        onClick={() => void handleUndo()}
                        disabled={!historySnapshot.canUndo}
                        title={
                            historySnapshot.undoLabel
                                ? `Deshacer: ${historySnapshot.undoLabel} (Ctrl+Z)`
                                : "Deshacer (Ctrl+Z)"
                        }
                        className="rounded-lg border border-white/10 bg-stone-900/80 px-2.5 py-1.5 text-[11px] text-stone-200 transition hover:border-amber-400/50 hover:text-amber-200 disabled:opacity-40"
                    >
                        Deshacer ({historySnapshot.undoCount})
                    </button>
                    <button
                        type="button"
                        onClick={() => void handleRedo()}
                        disabled={!historySnapshot.canRedo}
                        title={
                            historySnapshot.redoLabel
                                ? `Rehacer: ${historySnapshot.redoLabel} (Ctrl+Y)`
                                : "Rehacer (Ctrl+Y)"
                        }
                        className="rounded-lg border border-white/10 bg-stone-900/80 px-2.5 py-1.5 text-[11px] text-stone-200 transition hover:border-amber-400/50 hover:text-amber-200 disabled:opacity-40"
                    >
                        Rehacer ({historySnapshot.redoCount})
                    </button>
                </div>

                <div className="h-5 w-px bg-white/10" />

                <div className="flex items-center gap-1.5">
                    <button
                        type="button"
                        onClick={() => openConfirmModal("publish")}
                        disabled={
                            isConfirmBusy ||
                            historySnapshot.isBusy ||
                            draftServerTotal === 0
                        }
                        className="rounded-lg border border-emerald-400/45 bg-emerald-400/15 px-3 py-1.5 text-[11px] font-medium text-emerald-200 transition hover:bg-emerald-400/25 disabled:opacity-40"
                    >
                        Publicar
                    </button>
                    <button
                        type="button"
                        onClick={() => openConfirmModal("discard")}
                        disabled={
                            isConfirmBusy ||
                            historySnapshot.isBusy ||
                            draftServerTotal + draftExitsCount === 0
                        }
                        className="rounded-lg border border-red-400/40 bg-red-400/10 px-2.5 py-1.5 text-[11px] font-medium text-red-200 transition hover:bg-red-400/20 disabled:opacity-40"
                    >
                        Descartar borradores
                    </button>
                </div>

                <div className="ml-auto flex items-center gap-3 text-[11px] text-stone-400">
                    <span>
                        Borradores:{" "}
                        <span className="font-semibold text-amber-300">
                            {draftTiles}
                        </span>{" "}
                        tiles ·{" "}
                        <span className="font-semibold text-amber-300">
                            {draftEntities}
                        </span>{" "}
                        entidades
                        {draftExitsCount > 0
                            ? ` · ${draftExitsCount} salidas`
                            : ""}
                    </span>
                </div>
            </div>

            <RecentsStrip />
        </div>
    );

    const modal = pendingModalAction ? (
        <InGamePublishConfirmModal
            action={pendingModalAction}
            mapNum={mapNum}
            draftTiles={draftTiles}
            draftEntities={draftEntities}
            draftExitsCount={draftExitsCount}
            playerCount={playerCount}
            isBusy={isConfirmBusy}
            onCancel={() => {
                if (!isConfirmBusy) {
                    setPendingModalAction(null);
                }
            }}
            onConfirm={() => void handleConfirmModalAction()}
        />
    ) : null;

    return (
        <InGameEditorSlotsContext.Provider
            value={{
                sceneConfig,
                canvasOverlay,
                dockPanel,
                bottomBar,
                modal,
            }}
        >
            {children}
        </InGameEditorSlotsContext.Provider>
    );
}

function ExitToolPanel({
    exitTarget,
    onChangeTarget,
    draftExits,
    onRemoveExit,
}: {
    exitTarget: ExitToolTarget;
    onChangeTarget: (patch: Partial<ExitToolTarget>) => void;
    draftExits: ReadonlyArray<{
        x: number;
        y: number;
        targetMap: number;
        targetX: number;
        targetY: number;
    }>;
    onRemoveExit: (x: number, y: number) => void;
}) {
    return (
        <div className="flex h-full min-h-0 flex-col gap-3 text-xs text-stone-300">
            <p className="rounded-xl border border-white/10 bg-stone-950/60 p-2.5 text-[11px] leading-relaxed text-stone-400">
                Configura el destino y hace click o arrastra sobre el mapa para
                marcar tiles de salida (traslado hacia otro mapa).
            </p>

            <div className="grid grid-cols-3 gap-2">
                <label className="flex flex-col gap-1 text-[10px] uppercase tracking-[0.14em] text-stone-400">
                    Mapa
                    <input
                        type="number"
                        min={1}
                        aria-label="Mapa destino"
                        value={exitTarget.targetMap}
                        onChange={(event) => {
                            const value = Number(event.target.value);
                            if (Number.isFinite(value) && value >= 1) {
                                onChangeTarget({ targetMap: value });
                            }
                        }}
                        className="rounded-lg border border-white/10 bg-stone-950/70 px-2 py-1.5 text-xs text-stone-100 focus:border-amber-400/60 focus:outline-none"
                    />
                </label>
                <label className="flex flex-col gap-1 text-[10px] uppercase tracking-[0.14em] text-stone-400">
                    Destino X
                    <input
                        type="number"
                        min={1}
                        max={100}
                        aria-label="Destino X"
                        value={exitTarget.targetX}
                        onChange={(event) => {
                            const value = Number(event.target.value);
                            if (Number.isFinite(value) && value >= 1) {
                                onChangeTarget({ targetX: value });
                            }
                        }}
                        className="rounded-lg border border-white/10 bg-stone-950/70 px-2 py-1.5 text-xs text-stone-100 focus:border-amber-400/60 focus:outline-none"
                    />
                </label>
                <label className="flex flex-col gap-1 text-[10px] uppercase tracking-[0.14em] text-stone-400">
                    Destino Y
                    <input
                        type="number"
                        min={1}
                        max={100}
                        aria-label="Destino Y"
                        value={exitTarget.targetY}
                        onChange={(event) => {
                            const value = Number(event.target.value);
                            if (Number.isFinite(value) && value >= 1) {
                                onChangeTarget({ targetY: value });
                            }
                        }}
                        className="rounded-lg border border-white/10 bg-stone-950/70 px-2 py-1.5 text-xs text-stone-100 focus:border-amber-400/60 focus:outline-none"
                    />
                </label>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-white/10 bg-stone-950/50 p-2">
                <div className="mb-1.5 text-[10px] uppercase tracking-[0.16em] text-stone-500">
                    Salidas en borrador ({draftExits.length})
                </div>
                {draftExits.length === 0 ? (
                    <p className="py-6 text-center text-[11px] text-stone-500">
                        Todavia no marcaste salidas nuevas en este mapa.
                    </p>
                ) : (
                    <div className="flex flex-col gap-1">
                        {draftExits.map((exit) => (
                            <div
                                key={`${exit.x},${exit.y}`}
                                className="flex items-center justify-between rounded-lg border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1.5 text-[11px]"
                            >
                                <span className="text-emerald-100">
                                    ({exit.x}, {exit.y}) → Mapa{" "}
                                    {exit.targetMap} ({exit.targetX},{" "}
                                    {exit.targetY})
                                </span>
                                <button
                                    type="button"
                                    onClick={() =>
                                        onRemoveExit(exit.x, exit.y)
                                    }
                                    className="text-stone-400 transition hover:text-red-300"
                                >
                                    Quitar
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function EraseToolPanel({
    draftTiles,
    draftEntities,
    draftExitsCount,
}: {
    draftTiles: number;
    draftEntities: number;
    draftExitsCount: number;
}) {
    return (
        <div className="flex h-full flex-col justify-between rounded-xl border border-white/10 bg-stone-950/55 p-3 text-xs text-stone-300">
            <div className="space-y-2">
                <div className="text-xs font-medium text-amber-200">
                    Borrador de cambios sin publicar
                </div>
                <p className="text-[11px] leading-relaxed text-stone-400">
                    Hace click, arrastra o selecciona un rectangulo sobre el
                    mapa para limpiar los tiles, objetos, NPCs y salidas en
                    borrador de esas celdas y devolverlas al mapa publicado.
                </p>
            </div>

            <div className="rounded-lg border border-white/10 bg-stone-950/80 p-2.5 text-[11px] text-stone-400">
                <div>Tiles en borrador: {draftTiles}</div>
                <div>Entidades en borrador: {draftEntities}</div>
                <div>Salidas en borrador: {draftExitsCount}</div>
            </div>
        </div>
    );
}

export function InGamePublishConfirmModal({
    action,
    mapNum,
    draftTiles,
    draftEntities,
    draftExitsCount,
    playerCount,
    isBusy,
    onCancel,
    onConfirm,
}: {
    action: ConfirmModalAction;
    mapNum: number;
    draftTiles: number;
    draftEntities: number;
    draftExitsCount: number;
    playerCount: PlayerCountSummary;
    isBusy: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !isBusy) {
                onCancel();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [isBusy, onCancel]);

    const isPublish = action === "publish";
    const totalPlayers = playerCount.totalPlayers;
    const otherPlayers = playerCount.otherPlayers;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ingame-editor-confirm-title"
        >
            <div className="w-full max-w-md rounded-2xl border border-white/15 bg-stone-950 p-5 text-stone-100 shadow-2xl">
                <h2
                    id="ingame-editor-confirm-title"
                    className="text-sm font-semibold text-stone-100"
                >
                    {isPublish
                        ? `Publicar cambios del mapa ${mapNum}`
                        : `Descartar borradores del mapa ${mapNum}`}
                </h2>

                <p className="mt-2 text-xs leading-relaxed text-stone-300">
                    {isPublish
                        ? `Se van a publicar ${draftTiles} tiles y ${draftEntities} entidades sobre el mapa ${mapNum}.`
                        : `Se van a descartar ${draftTiles} tiles, ${draftEntities} entidades y ${draftExitsCount} salidas en borrador sin tocar lo ya publicado.`}
                </p>

                {isPublish ? (
                    <div
                        data-testid="publish-player-warning"
                        className={`mt-3 rounded-xl border px-3 py-2.5 text-xs leading-relaxed ${
                            otherPlayers > 0
                                ? "border-amber-400/55 bg-amber-400/15 text-amber-100"
                                : "border-cyan-400/30 bg-cyan-400/10 text-cyan-100"
                        }`}
                    >
                        {otherPlayers > 0 ? (
                            <>
                                <strong>Atencion:</strong> hay{" "}
                                <strong>{totalPlayers}</strong>{" "}
                                {totalPlayers === 1
                                    ? "jugador"
                                    : "jugadores"}{" "}
                                en este mapa ({otherPlayers} ademas de tu
                                personaje). Los jugadores presentes van a
                                recibir el mapa actualizado al recargar o
                                reingresar.
                            </>
                        ) : totalPlayers === 1 ? (
                            <>
                                Hay <strong>1 jugador</strong> en este mapa (tu
                                personaje). Ningun otro jugador esta conectado
                                en el mapa {mapNum} en este momento.
                            </>
                        ) : (
                            <>
                                Hay <strong>0 jugadores</strong> conectados en
                                el mapa {mapNum} en este momento.
                            </>
                        )}
                    </div>
                ) : null}

                {isPublish && draftExitsCount > 0 ? (
                    <p className="mt-2.5 rounded-lg border border-white/10 bg-stone-900/70 px-3 py-2 text-[11px] text-stone-400">
                        Nota: las {draftExitsCount} salidas marcadas en el
                        cliente se conservan como previsualizacion local hasta
                        que el endpoint de salidas este habilitado en el
                        servidor.
                    </p>
                ) : null}

                <div className="mt-5 flex justify-end gap-2">
                    <button
                        type="button"
                        disabled={isBusy}
                        onClick={onCancel}
                        className="rounded-lg border border-white/10 bg-stone-900/80 px-3 py-1.5 text-xs text-stone-300 transition hover:border-white/25 hover:text-white disabled:opacity-40"
                    >
                        Cancelar
                    </button>
                    <button
                        type="button"
                        disabled={isBusy}
                        autoFocus
                        onClick={onConfirm}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:opacity-40 ${
                            isPublish
                                ? "border-emerald-400/55 bg-emerald-400/20 text-emerald-100 hover:bg-emerald-400/30"
                                : "border-red-400/55 bg-red-400/20 text-red-100 hover:bg-red-400/30"
                        }`}
                    >
                        {isBusy
                            ? isPublish
                                ? "Publicando..."
                                : "Descartando..."
                            : isPublish
                              ? "Confirmar publicacion"
                              : "Descartar"}
                    </button>
                </div>
            </div>
        </div>
    );
}
