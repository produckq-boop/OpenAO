"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import type {
    EditorNpc,
    EditorObject,
    MapStatus,
    MapTileEntity,
    MapTileOverride,
    TerrainPalette,
    TerrainPaletteEntry,
} from "./editorApi";
import {
    getMapOverrides,
    getMapStatus,
    getMapTerrainPalette,
    listEditorNpcs,
    listEditorObjects,
} from "./editorApi";
import type { DraftTileExit } from "./inGameEditorTools";
import { UPLOADED_GRAPHIC_INDEX_START } from "../../utils/gameLoader";

/**
 * Pincel de terreno.
 *
 * Una entrada de la paleta describe el tile completo, no un solo grafico: lleva
 * un grafico por capa y si bloquea el paso. Pintar solo la capa 1 dejaria el
 * arbol de la capa 3 encima del piso nuevo.
 */
export type TerrainBrush = {
    paletteId: number;
    /** Grafico por capa, desde la capa 1. `null` vacia esa capa. */
    graphics: Array<number | null>;
    blocked: boolean;
    /** Grafico representativo, para miniaturas y recientes. */
    grhIndex: number;
};

/**
 * Pincel de una entrada de la paleta del mapa.
 *
 * Las capas que la entrada no menciona quedan fuera del pincel y no se tocan al
 * pintar; los `null` internos si vacian esa capa, porque forman parte de como se
 * ve el tile (un piso con arbol en la capa 3 y nada en la 2).
 */
export function createTerrainBrush(entry: TerrainPaletteEntry): TerrainBrush {
    const representative = entry.graphics.find(
        (graphic): graphic is number =>
            typeof graphic === "number" && graphic > 0,
    );

    return {
        paletteId: entry.id,
        graphics: entry.graphics,
        blocked: entry.blocked,
        grhIndex: representative ?? 0,
    };
}

/**
 * Pincel de un grafico subido. Cada PNG subido es un tile entero, asi que ocupa
 * la capa del piso y no bloquea por si mismo.
 */
export function createUploadedGraphicBrush(grhIndex: number): TerrainBrush {
    return {
        paletteId: grhIndex,
        graphics: [grhIndex],
        blocked: false,
        grhIndex,
    };
}

/**
 * Rearma un pincel a partir de su id. Lo necesitan los recientes y la barra de
 * herramientas, que guardan el id y no el pincel entero.
 */
export function findTerrainBrush(
    terrain: TerrainPalette | null,
    paletteId: number,
): TerrainBrush | null {
    const entry = terrain?.palette.find(
        (candidate) => candidate.id === paletteId,
    );

    if (entry) {
        return createTerrainBrush(entry);
    }

    // Un grafico subido se puede pintar igual aunque no venga en la paleta de
    // este mapa: la lista de subidos tiene tope y el indice ya alcanza.
    if (paletteId >= UPLOADED_GRAPHIC_INDEX_START) {
        return createUploadedGraphicBrush(paletteId);
    }

    return null;
}

export type ExitToolTarget = {
    targetMap: number;
    targetX: number;
    targetY: number;
};

export type EditorTool =
    | ({ kind: "terrain" } & TerrainBrush)
    | { kind: "object"; object: EditorObject }
    | { kind: "npc"; npc: EditorNpc }
    | ({ kind: "exit" } & ExitToolTarget)
    | { kind: "erase" };

export type RecentsEntry = {
    kind: "terrain" | "object" | "npc";
    id: number;
    grhIndex: number;
    name: string;
};

type EditorStoreValue = {
    mapNum: number;
    setMapNum: (mapNum: number) => void;
    objects: EditorObject[];
    npcs: EditorNpc[];
    terrain: TerrainPalette | null;
    status: MapStatus | null;
    overrides: MapTileOverride[];
    entities: MapTileEntity[];
    draftExits: DraftTileExit[];
    setDraftExit: (exit: DraftTileExit) => void;
    removeDraftExit: (x: number, y: number) => void;
    clearDraftExits: () => void;
    tool: EditorTool | null;
    setTool: (tool: EditorTool | null) => void;
    recents: RecentsEntry[];
    addRecent: (entry: RecentsEntry) => void;
    refreshMapData: () => Promise<void>;
    refreshStatus: () => Promise<void>;
    isLoading: boolean;
    loadError: string | null;
};

const RECENTS_STORAGE_KEY = "editor.recents.v1";
const DRAFT_EXITS_STORAGE_PREFIX = "editor.draftExits.v1.";
const DEFAULT_MAP_NUM = 1;

const EditorStoreContext = createContext<EditorStoreValue | null>(null);

function draftExitsStorageKey(mapNum: number): string {
    return `${DRAFT_EXITS_STORAGE_PREFIX}${mapNum}`;
}

function readDraftExitsFromStorage(mapNum: number): DraftTileExit[] {
    if (typeof window === "undefined") {
        return [];
    }

    try {
        const raw = window.localStorage.getItem(draftExitsStorageKey(mapNum));

        if (!raw) {
            return [];
        }

        const parsed = JSON.parse(raw) as unknown;

        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed.filter(
            (entry): entry is DraftTileExit =>
                typeof entry === "object" &&
                entry !== null &&
                Number.isInteger((entry as DraftTileExit).x) &&
                Number.isInteger((entry as DraftTileExit).y) &&
                Number.isInteger((entry as DraftTileExit).targetMap) &&
                Number.isInteger((entry as DraftTileExit).targetX) &&
                Number.isInteger((entry as DraftTileExit).targetY),
        );
    } catch {
        return [];
    }
}

function writeDraftExitsToStorage(
    mapNum: number,
    exits: DraftTileExit[],
): void {
    if (typeof window === "undefined") {
        return;
    }

    try {
        if (exits.length === 0) {
            window.localStorage.removeItem(draftExitsStorageKey(mapNum));
        } else {
            window.localStorage.setItem(
                draftExitsStorageKey(mapNum),
                JSON.stringify(exits),
            );
        }
    } catch {
        // El almacenamiento puede estar lleno o bloqueado; se ignora.
    }
}

function readRecentsFromStorage(): RecentsEntry[] {
    if (typeof window === "undefined") {
        return [];
    }

    try {
        const raw = window.localStorage.getItem(RECENTS_STORAGE_KEY);

        if (!raw) {
            return [];
        }

        const parsed = JSON.parse(raw) as unknown;

        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed.filter(
            (entry): entry is RecentsEntry =>
                typeof entry === "object" &&
                entry !== null &&
                ["terrain", "object", "npc"].includes(
                    (entry as RecentsEntry).kind,
                ) &&
                typeof (entry as RecentsEntry).id === "number" &&
                typeof (entry as RecentsEntry).grhIndex === "number",
        );
    } catch {
        return [];
    }
}

function writeRecentsToStorage(recents: RecentsEntry[]): void {
    try {
        window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(recents));
    } catch {
        // El almacenamiento puede estar lleno o bloqueado; se ignora.
    }
}

export function EditorStoreProvider({
    initialMapNum = DEFAULT_MAP_NUM,
    children,
}: {
    initialMapNum?: number;
    children: ReactNode;
}) {
    const [mapNum, setMapNumState] = useState(initialMapNum);
    const [objects, setObjects] = useState<EditorObject[]>([]);
    const [npcs, setNpcs] = useState<EditorNpc[]>([]);
    const [terrain, setTerrain] = useState<TerrainPalette | null>(null);
    const [status, setStatus] = useState<MapStatus | null>(null);
    const [overrides, setOverrides] = useState<MapTileOverride[]>([]);
    const [entities, setEntities] = useState<MapTileEntity[]>([]);
    const [draftExits, setDraftExits] = useState<DraftTileExit[]>(() =>
        readDraftExitsFromStorage(initialMapNum),
    );
    const [tool, setTool] = useState<EditorTool | null>(null);
    const [recents, setRecents] = useState<RecentsEntry[]>(() =>
        readRecentsFromStorage(),
    );
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const refreshTokenRef = useRef(0);

    const refreshMapData = useCallback(async () => {
        const token = ++refreshTokenRef.current;
        setIsLoading(true);
        setLoadError(null);

        try {
            const [overridesData, statusData, terrainData] = await Promise.all([
                getMapOverrides(mapNum),
                getMapStatus(mapNum),
                getMapTerrainPalette(mapNum),
            ]);

            if (refreshTokenRef.current !== token) {
                return;
            }

            setOverrides(overridesData.overrides ?? []);
            setEntities(overridesData.entities ?? []);
            setStatus(statusData);
            setTerrain(terrainData);
        } catch (error) {
            if (refreshTokenRef.current !== token) {
                return;
            }

            setLoadError(
                error instanceof Error
                    ? error.message
                    : "No se pudo cargar el mapa.",
            );
        } finally {
            if (refreshTokenRef.current === token) {
                setIsLoading(false);
            }
        }
    }, [mapNum]);

    const refreshStatus = useCallback(async () => {
        try {
            const statusData = await getMapStatus(mapNum);
            setStatus(statusData);
        } catch {
            // El estado se refresca solo; si falla se conserva el anterior.
        }
    }, [mapNum]);

    const setMapNum = useCallback((nextMapNum: number) => {
        setMapNumState(nextMapNum);
        setOverrides([]);
        setEntities([]);
        setDraftExits(readDraftExitsFromStorage(nextMapNum));
        setStatus(null);
        setTerrain(null);
        setTool(null);
    }, []);

    const setDraftExit = useCallback(
        (exit: DraftTileExit) => {
            setDraftExits((current) => {
                const withoutTarget = current.filter(
                    (existing) =>
                        existing.x !== exit.x || existing.y !== exit.y,
                );
                const next = [...withoutTarget, exit];
                writeDraftExitsToStorage(mapNum, next);
                return next;
            });
        },
        [mapNum],
    );

    const removeDraftExit = useCallback(
        (x: number, y: number) => {
            setDraftExits((current) => {
                const next = current.filter(
                    (existing) => existing.x !== x || existing.y !== y,
                );
                if (next.length === current.length) {
                    return current;
                }
                writeDraftExitsToStorage(mapNum, next);
                return next;
            });
        },
        [mapNum],
    );

    const clearDraftExits = useCallback(() => {
        setDraftExits([]);
        writeDraftExitsToStorage(mapNum, []);
    }, [mapNum]);

    const addRecent = useCallback((entry: RecentsEntry) => {
        setRecents((current) => {
            const withoutDuplicate = current.filter(
                (existing) =>
                    existing.kind !== entry.kind || existing.id !== entry.id,
            );
            const next = [entry, ...withoutDuplicate].slice(0, 12);
            writeRecentsToStorage(next);
            return next;
        });
    }, []);

    useEffect(() => {
        let cancelled = false;

        Promise.all([listEditorObjects(), listEditorNpcs()])
            .then(([objectsData, npcsData]) => {
                if (cancelled) {
                    return;
                }

                setObjects(objectsData);
                setNpcs(npcsData);
            })
            .catch((error) => {
                if (!cancelled) {
                    setLoadError(
                        error instanceof Error
                            ? error.message
                            : "No se pudo cargar el catalogo.",
                    );
                }
            });

        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        void refreshMapData();
    }, [mapNum, refreshMapData]);

    const value = useMemo<EditorStoreValue>(
        () => ({
            mapNum,
            setMapNum,
            objects,
            npcs,
            terrain,
            status,
            overrides,
            entities,
            draftExits,
            setDraftExit,
            removeDraftExit,
            clearDraftExits,
            tool,
            setTool,
            recents,
            addRecent,
            refreshMapData,
            refreshStatus,
            isLoading,
            loadError,
        }),
        [
            addRecent,
            clearDraftExits,
            draftExits,
            entities,
            isLoading,
            loadError,
            mapNum,
            npcs,
            objects,
            overrides,
            recents,
            refreshMapData,
            refreshStatus,
            removeDraftExit,
            setDraftExit,
            setMapNum,
            status,
            terrain,
            tool,
        ],
    );

    return (
        <EditorStoreContext.Provider value={value}>
            {children}
        </EditorStoreContext.Provider>
    );
}

export function useEditorStore(): EditorStoreValue {
    const context = useContext(EditorStoreContext);

    if (!context) {
        throw new Error(
            "useEditorStore debe usarse dentro de EditorStoreProvider",
        );
    }

    return context;
}