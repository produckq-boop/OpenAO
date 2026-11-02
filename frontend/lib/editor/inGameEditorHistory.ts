import type {
    EntityPlacement,
    MapTileEntity,
    MapTileOverride,
    TilePaint,
} from "./editorApi";
import {
    chunkTilePaints,
    makeTileKey,
    PAINT_BATCH_SIZE,
    type DraftTileExit,
    type TileCoord,
} from "./inGameEditorTools";

export type EditorHistoryCommand = {
    label: string;
    undo: () => Promise<void>;
    redo: () => Promise<void>;
};

export type InGameEditorHistorySnapshot = {
    mapNum: number;
    canUndo: boolean;
    canRedo: boolean;
    undoCount: number;
    redoCount: number;
    undoLabel: string | null;
    redoLabel: string | null;
    isBusy: boolean;
};

type HistoryListener = () => void;

const DEFAULT_MAX_HISTORY = 50;

/**
 * Pila asincrona de undo/redo acotada al mapa activo.
 *
 * Los punteros solo avanzan cuando la persistencia remota termina bien: si la
 * API rechaza una operacion o un undo/redo, el comando queda intacto para poder
 * reintentarlo. Cambiar de mapa invalida `epoch` para que ninguna promesa en
 * vuelo contamine el historial del mapa nuevo.
 */
export class InGameEditorHistory {
    private mapNum: number;
    private readonly maxEntries: number;
    private undoStack: EditorHistoryCommand[] = [];
    private redoStack: EditorHistoryCommand[] = [];
    private busy = false;
    private epoch = 0;
    private readonly listeners = new Set<HistoryListener>();
    private cachedSnapshot: InGameEditorHistorySnapshot;

    constructor(initialMapNum: number, maxEntries = DEFAULT_MAX_HISTORY) {
        this.mapNum = initialMapNum;
        this.maxEntries = Math.max(1, maxEntries);
        this.cachedSnapshot = this.buildSnapshot();
    }

    subscribe = (listener: HistoryListener): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    getSnapshot = (): InGameEditorHistorySnapshot => {
        return this.cachedSnapshot;
    };

    reset(nextMapNum = this.mapNum): void {
        const hasChanges =
            this.mapNum !== nextMapNum ||
            this.undoStack.length > 0 ||
            this.redoStack.length > 0 ||
            this.busy;

        this.epoch += 1;
        this.mapNum = nextMapNum;
        this.undoStack = [];
        this.redoStack = [];
        this.busy = false;

        if (hasChanges) {
            this.emit();
        }
    }

    async execute(
        targetMapNum: number,
        command: EditorHistoryCommand,
    ): Promise<boolean> {
        if (this.busy || targetMapNum !== this.mapNum) {
            return false;
        }

        const startEpoch = this.epoch;
        this.busy = true;
        this.emit();

        try {
            await command.redo();

            if (this.epoch !== startEpoch || this.mapNum !== targetMapNum) {
                return false;
            }

            this.undoStack.push(command);
            if (this.undoStack.length > this.maxEntries) {
                this.undoStack.shift();
            }
            this.redoStack = [];
            return true;
        } finally {
            if (this.epoch === startEpoch) {
                this.busy = false;
                this.emit();
            }
        }
    }

    async undo(): Promise<boolean> {
        if (this.busy || this.undoStack.length === 0) {
            return false;
        }

        const startEpoch = this.epoch;
        const command = this.undoStack[this.undoStack.length - 1];
        this.busy = true;
        this.emit();

        try {
            await command.undo();

            if (this.epoch !== startEpoch) {
                return false;
            }

            this.undoStack.pop();
            this.redoStack.push(command);
            return true;
        } finally {
            if (this.epoch === startEpoch) {
                this.busy = false;
                this.emit();
            }
        }
    }

    async redo(): Promise<boolean> {
        if (this.busy || this.redoStack.length === 0) {
            return false;
        }

        const startEpoch = this.epoch;
        const command = this.redoStack[this.redoStack.length - 1];
        this.busy = true;
        this.emit();

        try {
            await command.redo();

            if (this.epoch !== startEpoch) {
                return false;
            }

            this.redoStack.pop();
            this.undoStack.push(command);
            return true;
        } finally {
            if (this.epoch === startEpoch) {
                this.busy = false;
                this.emit();
            }
        }
    }

    private buildSnapshot(): InGameEditorHistorySnapshot {
        const lastUndo = this.undoStack[this.undoStack.length - 1] ?? null;
        const lastRedo = this.redoStack[this.redoStack.length - 1] ?? null;

        return {
            mapNum: this.mapNum,
            canUndo: !this.busy && this.undoStack.length > 0,
            canRedo: !this.busy && this.redoStack.length > 0,
            undoCount: this.undoStack.length,
            redoCount: this.redoStack.length,
            undoLabel: lastUndo?.label ?? null,
            redoLabel: lastRedo?.label ?? null,
            isBusy: this.busy,
        };
    }

    private emit(): void {
        this.cachedSnapshot = this.buildSnapshot();
        for (const listener of this.listeners) {
            listener();
        }
    }
}

export function isEditableKeyboardTarget(
    target: EventTarget | null | undefined,
): boolean {
    if (!target || typeof target !== "object") {
        return false;
    }

    const element = target as {
        tagName?: unknown;
        isContentEditable?: unknown;
        getAttribute?: (name: string) => string | null;
        closest?: (selector: string) => unknown;
    };

    if (element.isContentEditable === true) {
        return true;
    }

    const contentEditableAttr =
        typeof element.getAttribute === "function"
            ? element.getAttribute("contenteditable")
            : null;
    if (contentEditableAttr === "" || contentEditableAttr === "true") {
        return true;
    }

    if (typeof element.tagName === "string") {
        const normalizedTag = element.tagName.toUpperCase();
        if (
            normalizedTag === "INPUT" ||
            normalizedTag === "TEXTAREA" ||
            normalizedTag === "SELECT"
        ) {
            return true;
        }
    }

    if (
        typeof element.closest === "function" &&
        element.closest(
            'input, textarea, select, [contenteditable="true"], [contenteditable=""]',
        )
    ) {
        return true;
    }

    return false;
}

export function matchEditorHistoryShortcut(event: {
    key?: string;
    code?: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    target?: EventTarget | null;
}): "undo" | "redo" | null {
    if (isEditableKeyboardTarget(event.target)) {
        return null;
    }

    const hasPrimaryModifier = Boolean(event.ctrlKey || event.metaKey);
    if (!hasPrimaryModifier || event.altKey) {
        return null;
    }

    const normalizedKey = (event.key ?? "").toLowerCase();
    const isZ = normalizedKey === "z" || event.code === "KeyZ";
    const isY = normalizedKey === "y" || event.code === "KeyY";

    if (isZ) {
        return event.shiftKey ? "redo" : "undo";
    }

    if (isY && !event.shiftKey) {
        return "redo";
    }

    return null;
}

export type EditorPersistenceAdapter = {
    paintTiles: (mapNum: number, tiles: TilePaint[]) => Promise<void>;
    clearTileOverride: (
        mapNum: number,
        x: number,
        y: number,
        layer: number,
    ) => Promise<void>;
    placeTileEntity: (
        mapNum: number,
        placement: EntityPlacement,
    ) => Promise<void>;
    removeTileEntity: (
        mapNum: number,
        x: number,
        y: number,
        kind: "obj" | "npc",
    ) => Promise<void>;
    setDraftExit: (exit: DraftTileExit) => void;
    removeDraftExit: (x: number, y: number) => void;
    onAfterSync: () => Promise<void>;
};

async function runBatchedPaintTiles(
    adapter: Pick<EditorPersistenceAdapter, "paintTiles">,
    mapNum: number,
    tiles: ReadonlyArray<TilePaint>,
): Promise<void> {
    for (const batch of chunkTilePaints(tiles, PAINT_BATCH_SIZE)) {
        await adapter.paintTiles(mapNum, batch);
    }
}

/**
 * Construye un comando reversible de pintado de terreno (trazo o rectangulo).
 * Si una capa ya tenia un borrador previo, `undo` restaura ese borrador; si no
 * tenia borrador, `undo` llama a `clearTileOverride` para no dejar borradores
 * fantasma sobre el mapa publicado.
 */
export function createPaintOperationCommand(params: {
    mapNum: number;
    label: string;
    nextPaints: ReadonlyArray<TilePaint>;
    currentOverrides: ReadonlyArray<MapTileOverride>;
    adapter: EditorPersistenceAdapter;
}): EditorHistoryCommand {
    const draftByLayerKey = new Map<string, MapTileOverride>();
    for (const entry of params.currentOverrides) {
        if (entry.status === "draft") {
            draftByLayerKey.set(`${entry.x},${entry.y},${entry.layer}`, entry);
        }
    }

    const restorePaints: TilePaint[] = [];
    const clearTargets: Array<{ x: number; y: number; layer: number }> = [];

    for (const paint of params.nextPaints) {
        const previousDraft = draftByLayerKey.get(
            `${paint.x},${paint.y},${paint.layer}`,
        );
        if (previousDraft) {
            restorePaints.push({
                x: paint.x,
                y: paint.y,
                layer: paint.layer,
                grhIndex: previousDraft.grhIndex,
                blocked: previousDraft.blocked,
            });
        } else {
            clearTargets.push({
                x: paint.x,
                y: paint.y,
                layer: paint.layer,
            });
        }
    }

    return {
        label: params.label,
        redo: async () => {
            await runBatchedPaintTiles(
                params.adapter,
                params.mapNum,
                params.nextPaints,
            );
            await params.adapter.onAfterSync();
        },
        undo: async () => {
            if (restorePaints.length > 0) {
                await runBatchedPaintTiles(
                    params.adapter,
                    params.mapNum,
                    restorePaints,
                );
            }
            if (clearTargets.length > 0) {
                await Promise.all(
                    clearTargets.map((target) =>
                        params.adapter.clearTileOverride(
                            params.mapNum,
                            target.x,
                            target.y,
                            target.layer,
                        ),
                    ),
                );
            }
            await params.adapter.onAfterSync();
        },
    };
}

export function createEntityOperationCommand(params: {
    mapNum: number;
    label: string;
    placement: EntityPlacement;
    currentEntities: ReadonlyArray<MapTileEntity>;
    adapter: EditorPersistenceAdapter;
}): EditorHistoryCommand {
    const previousDraft =
        params.currentEntities.find(
            (entry) =>
                entry.status === "draft" &&
                entry.x === params.placement.x &&
                entry.y === params.placement.y &&
                entry.kind === params.placement.kind,
        ) ?? null;

    return {
        label: params.label,
        redo: async () => {
            await params.adapter.placeTileEntity(
                params.mapNum,
                params.placement,
            );
            await params.adapter.onAfterSync();
        },
        undo: async () => {
            if (previousDraft) {
                await params.adapter.placeTileEntity(params.mapNum, {
                    x: previousDraft.x,
                    y: previousDraft.y,
                    kind: previousDraft.kind,
                    entityId: previousDraft.entityId,
                });
            } else {
                await params.adapter.removeTileEntity(
                    params.mapNum,
                    params.placement.x,
                    params.placement.y,
                    params.placement.kind,
                );
            }
            await params.adapter.onAfterSync();
        },
    };
}

export function createExitOperationCommand(params: {
    label: string;
    coords: ReadonlyArray<TileCoord>;
    target: { targetMap: number; targetX: number; targetY: number };
    currentDraftExits: ReadonlyArray<DraftTileExit>;
    adapter: Pick<
        EditorPersistenceAdapter,
        "setDraftExit" | "removeDraftExit" | "onAfterSync"
    >;
}): EditorHistoryCommand {
    const previousByTile = new Map<string, DraftTileExit | null>();
    const existingLookup = new Map(
        params.currentDraftExits.map((exit) => [
            makeTileKey(exit.x, exit.y),
            exit,
        ]),
    );

    const uniqueCoords: TileCoord[] = [];
    for (const coord of params.coords) {
        const key = makeTileKey(coord.x, coord.y);
        if (previousByTile.has(key)) {
            continue;
        }
        previousByTile.set(key, existingLookup.get(key) ?? null);
        uniqueCoords.push(coord);
    }

    return {
        label: params.label,
        redo: async () => {
            for (const coord of uniqueCoords) {
                params.adapter.setDraftExit({
                    x: coord.x,
                    y: coord.y,
                    targetMap: params.target.targetMap,
                    targetX: params.target.targetX,
                    targetY: params.target.targetY,
                });
            }
            await params.adapter.onAfterSync();
        },
        undo: async () => {
            for (const coord of uniqueCoords) {
                const previous =
                    previousByTile.get(makeTileKey(coord.x, coord.y)) ?? null;
                if (previous) {
                    params.adapter.setDraftExit(previous);
                } else {
                    params.adapter.removeDraftExit(coord.x, coord.y);
                }
            }
            await params.adapter.onAfterSync();
        },
    };
}

export function createEraseOperationCommand(params: {
    mapNum: number;
    label: string;
    coords: ReadonlyArray<TileCoord>;
    currentOverrides: ReadonlyArray<MapTileOverride>;
    currentEntities: ReadonlyArray<MapTileEntity>;
    currentDraftExits: ReadonlyArray<DraftTileExit>;
    adapter: EditorPersistenceAdapter;
}): EditorHistoryCommand | null {
    const coordKeys = new Set(
        params.coords.map((coord) => makeTileKey(coord.x, coord.y)),
    );

    const overridesToClear = params.currentOverrides.filter(
        (entry) =>
            entry.status === "draft" &&
            coordKeys.has(makeTileKey(entry.x, entry.y)),
    );
    const entitiesToRemove = params.currentEntities.filter(
        (entry) =>
            entry.status === "draft" &&
            coordKeys.has(makeTileKey(entry.x, entry.y)),
    );
    const exitsToRemove = params.currentDraftExits.filter((entry) =>
        coordKeys.has(makeTileKey(entry.x, entry.y)),
    );

    if (
        overridesToClear.length === 0 &&
        entitiesToRemove.length === 0 &&
        exitsToRemove.length === 0
    ) {
        return null;
    }

    const restorePaints: TilePaint[] = overridesToClear.map((entry) => ({
        x: entry.x,
        y: entry.y,
        layer: entry.layer,
        grhIndex: entry.grhIndex,
        blocked: entry.blocked,
    }));

    return {
        label: params.label,
        redo: async () => {
            await Promise.all([
                ...overridesToClear.map((entry) =>
                    params.adapter.clearTileOverride(
                        params.mapNum,
                        entry.x,
                        entry.y,
                        entry.layer,
                    ),
                ),
                ...entitiesToRemove.map((entry) =>
                    params.adapter.removeTileEntity(
                        params.mapNum,
                        entry.x,
                        entry.y,
                        entry.kind,
                    ),
                ),
            ]);

            for (const exit of exitsToRemove) {
                params.adapter.removeDraftExit(exit.x, exit.y);
            }

            await params.adapter.onAfterSync();
        },
        undo: async () => {
            if (restorePaints.length > 0) {
                await runBatchedPaintTiles(
                    params.adapter,
                    params.mapNum,
                    restorePaints,
                );
            }

            if (entitiesToRemove.length > 0) {
                await Promise.all(
                    entitiesToRemove.map((entry) =>
                        params.adapter.placeTileEntity(params.mapNum, {
                            x: entry.x,
                            y: entry.y,
                            kind: entry.kind,
                            entityId: entry.entityId,
                        }),
                    ),
                );
            }

            for (const exit of exitsToRemove) {
                params.adapter.setDraftExit(exit);
            }

            await params.adapter.onAfterSync();
        },
    };
}
