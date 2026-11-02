import { cleanup, render, waitFor } from "@testing-library/react";
import type { FederatedPointerEvent } from "pixi.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapData } from "../../../../types/game";
import type { Engine } from "../../engine/Engine";
import type {
    InGameEditorEngineBridge,
    InGameEditorSceneConfig,
} from "../inGameEditorTypes";
import { useInGameEditorScene } from "../useInGameEditorScene";

const pixiMocks = vi.hoisted(() => {
    class MockContainer {
        children: unknown[] = [];
        parent: MockContainer | null = null;
        visible = true;
        zIndex = 0;
        sortableChildren = false;
        eventMode = "auto";
        interactiveChildren = true;
        position = {
            x: 0,
            y: 0,
            set(x: number, y: number) {
                this.x = x;
                this.y = y;
            },
        };
        scale = {
            x: 1,
            y: 1,
            set(x: number, y = x) {
                this.x = x;
                this.y = y;
            },
        };

        addChild(...items: Array<{ parent?: unknown }>) {
            for (const item of items) {
                item.parent = this;
                this.children.push(item);
            }
            return items[0];
        }

        removeChild(item: unknown) {
            this.children = this.children.filter((entry) => entry !== item);
            return item;
        }

        removeChildren() {
            const removed = [...this.children];
            this.children = [];
            return removed;
        }

        destroy() {
            this.children = [];
        }

        toLocal(point: { x: number; y: number }) {
            return { x: point.x, y: point.y };
        }
    }

    class MockGraphics extends MockContainer {
        clear() {
            return this;
        }
        rect() {
            return this;
        }
        roundRect() {
            return this;
        }
        moveTo() {
            return this;
        }
        lineTo() {
            return this;
        }
        stroke() {
            return this;
        }
        fill() {
            return this;
        }
    }

    class MockSprite extends MockContainer {
        alpha = 1;
        width = 32;
        height = 32;
    }

    class MockText extends MockContainer {
        width = 24;
        height = 10;
    }

    class MockTextStyle {}

    return {
        Container: MockContainer,
        Graphics: MockGraphics,
        Sprite: MockSprite,
        Text: MockText,
        TextStyle: MockTextStyle,
    };
});

const loaderMocks = vi.hoisted(() => ({
    loadRawBaseMapData: vi.fn(),
    invalidateCachedMapData: vi.fn(),
}));

const sceneRendererMocks = vi.hoisted(() => ({
    removeSceneLayerSprite: vi.fn(),
    removeRoofSpritesForTile: vi.fn(),
    removeObjectSprite: vi.fn(),
}));

vi.mock("pixi.js", () => ({
    ...pixiMocks,
    FederatedPointerEvent: class {},
}));

vi.mock("../../../../utils/gameLoader", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../../../utils/gameLoader")>();
    return {
        ...actual,
        ...loaderMocks,
    };
});

vi.mock("../../rendering/sceneRenderer", async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import("../../rendering/sceneRenderer")
        >();
    return {
        ...actual,
        ...sceneRendererMocks,
    };
});

function createFakePointerEvent(
    localX: number,
    localY: number,
    options?: { shiftKey?: boolean; button?: number },
): FederatedPointerEvent {
    return {
        button: options?.button ?? 0,
        shiftKey: options?.shiftKey ?? false,
        global: { x: localX, y: localY },
        getLocalPosition: () => ({ x: localX, y: localY }),
    } as unknown as FederatedPointerEvent;
}

function createFakeEngine(baseMap: MapData): Engine {
    const stage = new pixiMocks.Container();
    const mapContainer = new pixiMocks.Container();

    return {
        isDestroyed: false,
        mapNumber: 1,
        app: {
            stage,
            ticker: {
                add: vi.fn(),
                remove: vi.fn(),
            },
        },
        mapContainer,
        mapDimensions: { width: 10, height: 10 },
        mapData: structuredClone(baseMap),
        graphicsDB: {},
        bodiesDB: {},
        headsDB: {},
        objectsDB: {},
        updateCulling: vi.fn(),
        updateRoofVisibility: vi.fn(),
        user: { id: 1, map: 1, isNpc: false },
        personajes: {
            "1": { id: 1, map: 1, isNpc: false },
            "2": { id: 2, map: 1, isNpc: false },
            "99": { id: 99, map: 1, isNpc: true },
        },
    } as unknown as Engine;
}

describe("useInGameEditorScene", () => {
    let baseMap: MapData;

    beforeEach(() => {
        vi.clearAllMocks();
        baseMap = {
            "1": {
                "3": {
                    "2": { blocked: 0, graphics: { "1": 100 } },
                    "3": { blocked: 0, graphics: { "1": 100 } },
                },
            },
        };
        loaderMocks.loadRawBaseMapData.mockImplementation(async () =>
            structuredClone(baseMap),
        );
    });

    afterEach(() => {
        cleanup();
    });

    it("soporta pintado continuo por arrastre y seleccion rectangular sobre el lienzo de PixiJS", async () => {
        const engine = createFakeEngine(baseMap);
        const onCommitTiles = vi.fn();
        const onSelectionPreviewChange = vi.fn();
        let handlers: ReturnType<typeof useInGameEditorScene> | null = null;

        function Probe({ config }: { config: InGameEditorSceneConfig }) {
            handlers = useInGameEditorScene({
                engineRef: { current: engine },
                isSceneReady: true,
                mapNumber: 1,
                config,
                clearMovementInputState: vi.fn(),
                clearTargetingMode: vi.fn(),
                updateCanvasCursor: vi.fn(),
                preloadGraphicIds: vi.fn(async () => undefined),
                renderMap: vi.fn(async () => undefined),
            });
            return null;
        }

        const baseConfig: InGameEditorSceneConfig = {
            enabled: true,
            mapNum: 1,
            tool: {
                kind: "terrain",
                paletteId: 1,
                grhIndex: 500,
                graphics: [500],
                blocked: false,
            },
            drawMode: "brush",
            showGrid: true,
            showBlocked: true,
            overrides: [],
            entities: [],
            npcs: [],
            draftExits: [],
            reloadRevision: 0,
            onCursorTileChange: vi.fn(),
            onSelectionPreviewChange,
            onPlayerCountChange: vi.fn(),
            onCommitTiles,
            onBridgeReady: vi.fn(),
        };

        const { rerender } = render(<Probe config={baseConfig} />);

        // Arrastre continuo por los tiles (2,3) -> (2,3) repetido -> (3,3) -> (3,4)
        expect(
            handlers!.handleEditorPointerDown(createFakePointerEvent(35, 70)),
        ).toBe(true);
        handlers!.handleEditorPointerMove(createFakePointerEvent(40, 72));
        handlers!.handleEditorPointerMove(createFakePointerEvent(70, 72));
        handlers!.handleEditorPointerMove(createFakePointerEvent(70, 104));
        expect(handlers!.handleEditorPointerUp()).toBe(true);

        expect(onCommitTiles).toHaveBeenCalledWith(
            [
                { x: 2, y: 3 },
                { x: 3, y: 3 },
                { x: 3, y: 4 },
            ],
            "stroke",
        );

        // Seleccion rectangular con Shift + arrastrar desde (2,2) hasta fuera del borde derecho (10,3)
        onCommitTiles.mockClear();
        rerender(<Probe config={{ ...baseConfig, drawMode: "brush" }} />);

        expect(
            handlers!.handleEditorPointerDown(
                createFakePointerEvent(35, 35, { shiftKey: true }),
            ),
        ).toBe(true);
        handlers!.handleEditorPointerMove(createFakePointerEvent(400, 70));
        expect(onSelectionPreviewChange).toHaveBeenCalledWith({
            minX: 2,
            maxX: 10,
            minY: 2,
            maxY: 3,
            width: 9,
            height: 2,
            tileCount: 18,
        });
        handlers!.handleEditorPointerUp();

        expect(onCommitTiles).toHaveBeenCalledTimes(1);
        const [rectCoords, rectMode] = onCommitTiles.mock.calls[0];
        expect(rectMode).toBe("rect");
        expect(rectCoords).toHaveLength(18);
    });

    it("sincroniza borradores en vivo en engine.mapData, revierte a lo publicado al salir y registra PNGs nuevos", async () => {
        const engine = createFakeEngine(baseMap);
        const engineRef = { current: engine };
        const preloadGraphicIds = vi.fn(async () => undefined);
        const renderMap = vi.fn(async () => undefined);
        let bridge: InGameEditorEngineBridge | null = null;

        function Probe({ config }: { config: InGameEditorSceneConfig }) {
            useInGameEditorScene({
                engineRef,
                isSceneReady: true,
                mapNumber: 1,
                config,
                clearMovementInputState: vi.fn(),
                clearTargetingMode: vi.fn(),
                updateCanvasCursor: vi.fn(),
                preloadGraphicIds,
                renderMap,
            });
            return null;
        }

        const draftOverride = {
            x: 2,
            y: 3,
            layer: 1,
            grhIndex: 888,
            blocked: true,
            status: "draft" as const,
        };

        const activeConfig: InGameEditorSceneConfig = {
            enabled: true,
            mapNum: 1,
            tool: null,
            drawMode: "brush",
            showGrid: true,
            showBlocked: true,
            overrides: [draftOverride],
            entities: [],
            npcs: [],
            draftExits: [],
            reloadRevision: 0,
            onCursorTileChange: vi.fn(),
            onSelectionPreviewChange: vi.fn(),
            onPlayerCountChange: vi.fn(),
            onCommitTiles: vi.fn(),
            onBridgeReady: (nextBridge) => {
                bridge = nextBridge;
            },
        };

        const { rerender } = render(<Probe config={activeConfig} />);

        await waitFor(() => {
            expect(engine.mapData?.["1"]?.["3"]?.["2"]).toEqual({
                blocked: 1,
                graphics: { "1": 888 },
            });
        });
        expect(renderMap).toHaveBeenCalledWith(engine, {
            includeLayers: ["1", "2", "3", "4"],
            includeObjects: true,
            bounds: { minX: 2, maxX: 2, minY: 3, maxY: 3 },
        });

        // Registra un PNG subido en la sesion actual y precarga su textura
        expect(bridge).not.toBeNull();
        expect(bridge!.getPlayerCountSummary()).toEqual({
            totalPlayers: 2,
            otherPlayers: 1,
        });

        await bridge!.registerUploadedGraphic({
            grhIndex: 1_000_012,
            width: 64,
            height: 64,
            byteSize: 1024,
            deduped: false,
            url: "/api/editor/graphics/1000012.png",
        });

        expect(engine.graphicsDB?.["1000012"]).toMatchObject({
            numFile: "1000012",
            width: 64,
            height: 64,
        });
        expect(preloadGraphicIds).toHaveBeenCalledWith(engine, ["1000012"]);

        // Al salir del modo edicion sin recargar, el mapa vuelve a su estado publicado
        rerender(<Probe config={{ ...activeConfig, enabled: false }} />);

        await waitFor(() => {
            expect(engine.mapData?.["1"]?.["3"]?.["2"]).toEqual({
                blocked: 0,
                graphics: { "1": 100 },
            });
        });
    });
});
