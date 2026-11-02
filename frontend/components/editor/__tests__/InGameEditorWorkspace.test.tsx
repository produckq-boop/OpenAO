import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOTKEY_SETTINGS } from "../../../lib/hotkeys";
import type {
    MapTileEntity,
    MapTileOverride,
    TerrainPalette,
    UploadedGraphic,
} from "../../../lib/editor/editorApi";
import type { GameDataAdminState } from "../../../lib/editor/useGameDataAdmin";
import { useKeyboardGameplay } from "../../game/core/useKeyboardGameplay";
import type {
    InGameEditorEngineBridge,
    InGameEditorSceneConfig,
} from "../../game/editor/inGameEditorTypes";
import {
    InGameEditorSessionHost,
    InGameEditorToggleButton,
} from "../InGameEditorWorkspace";

const apiMocks = vi.hoisted(() => ({
    listEditorObjects: vi.fn(),
    listEditorNpcs: vi.fn(),
    getMapTerrainPalette: vi.fn(),
    getMapOverrides: vi.fn(),
    getMapStatus: vi.fn(),
    paintTiles: vi.fn(),
    clearTileOverride: vi.fn(),
    placeTileEntity: vi.fn(),
    removeTileEntity: vi.fn(),
    publishMapChanges: vi.fn(),
    discardMapDrafts: vi.fn(),
    uploadGraphicPng: vi.fn(),
}));

const graphicTextureMocks = vi.hoisted(() => ({
    invalidateSharedGraphicsDB: vi.fn(),
    getSharedGraphicsDB: vi.fn(async () => ({})),
    loadGraphicImage: vi.fn(async () => new Image()),
    resolveGraphicFrame: vi.fn(() => null),
}));

const gameLoaderMocks = vi.hoisted(() => ({
    invalidateCachedMapData: vi.fn(),
}));

vi.mock("../../../lib/editor/editorApi", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../../lib/editor/editorApi")>();
    return {
        ...actual,
        ...apiMocks,
    };
});

vi.mock("../../../lib/graphicTextures", () => graphicTextureMocks);

vi.mock("../../../utils/gameLoader", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../../utils/gameLoader")>();
    return {
        ...actual,
        ...gameLoaderMocks,
    };
});

let currentOverrides: MapTileOverride[] = [];
let currentEntities: MapTileEntity[] = [];
let currentUploadedGraphics: UploadedGraphic[] = [];

function buildTerrainCatalog(mapNum: number): TerrainPalette {
    return {
        mapNum,
        palette: [
            {
                id: 1,
                graphics: [500],
                blocked: false,
            },
            {
                id: 2,
                graphics: [500, 620],
                blocked: true,
            },
        ],
        uploadedGraphics: currentUploadedGraphics.map((graphic) => ({
            grhIndex: graphic.grhIndex,
            width: graphic.width,
            height: graphic.height,
            byteSize: graphic.byteSize,
            createdAt: "2026-11-03T00:00:00.000Z",
        })),
    };
}

function EditorHarness({
    adminState,
    initialEditMode = false,
    initialMapNumber = 1,
    onSceneConfig,
}: {
    adminState: GameDataAdminState;
    initialEditMode?: boolean;
    initialMapNumber?: number;
    onSceneConfig?: (config: InGameEditorSceneConfig | null) => void;
}) {
    const [isEditMode, setIsEditMode] = useState(initialEditMode);
    const [mapNumber, setMapNumber] = useState(initialMapNumber);

    return (
        <div>
            <InGameEditorToggleButton
                adminState={adminState}
                isEditMode={adminState === "allowed" && isEditMode}
                onToggle={() => setIsEditMode((current) => !current)}
            />
            <button
                type="button"
                data-testid="switch-map-2"
                onClick={() => setMapNumber(2)}
            >
                Ir a mapa 2
            </button>
            <InGameEditorSessionHost
                adminState={adminState}
                isEditMode={adminState === "allowed" && isEditMode}
                mapNumber={mapNumber}
                panelHeight="672px"
                onExitEditMode={() => setIsEditMode(false)}
            >
                {(slots) => {
                    onSceneConfig?.(slots.sceneConfig);
                    return (
                        <div>
                            <div data-testid="canvas-slot">
                                {slots.canvasOverlay}
                            </div>
                            <div data-testid="dock-slot">{slots.dockPanel}</div>
                            <div data-testid="bottom-slot">
                                {slots.bottomBar}
                            </div>
                            {slots.modal}
                        </div>
                    );
                }}
            </InGameEditorSessionHost>
        </div>
    );
}

describe("InGameEditorWorkspace", () => {
    beforeEach(() => {
        window.localStorage.clear();
        currentOverrides = [];
        currentEntities = [];
        currentUploadedGraphics = [];

        vi.clearAllMocks();

        HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;

        apiMocks.listEditorObjects.mockResolvedValue([
            {
                id: 10,
                name: "Manzana Roja",
                objType: 1,
                grhIndex: 701,
                version: 1,
                updatedAt: "2026-11-03T00:00:00.000Z",
            },
        ]);
        apiMocks.listEditorNpcs.mockResolvedValue([
            {
                id: 500,
                name: "Lobo Gris",
                npcType: 0,
                idBody: 12,
                idHead: 0,
                movement: 3,
                version: 1,
                updatedAt: "2026-11-03T00:00:00.000Z",
            },
        ]);
        apiMocks.getMapTerrainPalette.mockImplementation(
            async (mapNum: number) => buildTerrainCatalog(mapNum),
        );
        apiMocks.getMapOverrides.mockImplementation(async (mapNum: number) => ({
            mapNum,
            includeDrafts: true,
            overrides: [...currentOverrides],
            entities: [...currentEntities],
        }));
        apiMocks.getMapStatus.mockImplementation(async (mapNum: number) => {
            const draftTiles = currentOverrides.filter(
                (entry) => entry.status === "draft",
            ).length;
            const draftEntities = currentEntities.filter(
                (entry) => entry.status === "draft",
            ).length;
            return {
                mapNum,
                draft: draftTiles,
                published: 0,
                draftEntities,
                publishedEntities: 0,
            };
        });
        apiMocks.paintTiles.mockImplementation(async (_mapNum, tiles) => {
            for (const tile of tiles) {
                currentOverrides = currentOverrides.filter(
                    (entry) =>
                        !(
                            entry.x === tile.x &&
                            entry.y === tile.y &&
                            entry.layer === tile.layer &&
                            entry.status === "draft"
                        ),
                );
                currentOverrides.push({
                    x: tile.x,
                    y: tile.y,
                    layer: tile.layer,
                    grhIndex: tile.grhIndex,
                    blocked: tile.blocked ?? null,
                    status: "draft",
                });
            }
        });
        apiMocks.clearTileOverride.mockImplementation(
            async (_mapNum, x, y, layer) => {
                currentOverrides = currentOverrides.filter(
                    (entry) =>
                        !(
                            entry.x === x &&
                            entry.y === y &&
                            entry.layer === layer &&
                            entry.status === "draft"
                        ),
                );
            },
        );
        apiMocks.publishMapChanges.mockImplementation(async () => {
            currentOverrides = currentOverrides.map((entry) => ({
                ...entry,
                status: "published",
            }));
        });
        apiMocks.discardMapDrafts.mockImplementation(async () => {
            currentOverrides = [];
            currentEntities = [];
        });
    });

    afterEach(() => {
        cleanup();
    });

    it("oculta controles y no realiza requests de editor cuando la cuenta no tiene permisos", () => {
        const { rerender } = render(<EditorHarness adminState="loading" />);
        expect(screen.queryByTestId("ingame-editor-toggle")).toBeNull();

        rerender(<EditorHarness adminState="denied" />);
        expect(screen.queryByTestId("ingame-editor-toggle")).toBeNull();
        expect(screen.queryByTestId("ingame-editor-banner")).toBeNull();

        expect(apiMocks.listEditorObjects).not.toHaveBeenCalled();
        expect(apiMocks.listEditorNpcs).not.toHaveBeenCalled();
        expect(apiMocks.getMapTerrainPalette).not.toHaveBeenCalled();
        expect(apiMocks.getMapOverrides).not.toHaveBeenCalled();
    });

    it("activa el modo edicion sin recargar y expone las 5 herramientas, seleccion de area y overlays", async () => {
        let latestConfig: InGameEditorSceneConfig | null = null;
        render(
            <EditorHarness
                adminState="allowed"
                onSceneConfig={(cfg) => {
                    latestConfig = cfg;
                }}
            />,
        );

        // Antes de abrir el modo edicion una sesion admin tampoco descarga catalogos.
        expect(apiMocks.listEditorObjects).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId("ingame-editor-toggle"));

        await waitFor(() => {
            expect(screen.getByTestId("ingame-editor-banner")).toBeTruthy();
        });

        expect(screen.getByTestId("ingame-editor-toggle").textContent).toContain(
            "Salir de edicion",
        );

        // Las 5 herramientas requeridas por el alcance estan presentes como pestañas:
        expect(screen.getByRole("tab", { name: "Terreno" })).toBeTruthy();
        expect(screen.getByRole("tab", { name: "Objeto" })).toBeTruthy();
        expect(screen.getByRole("tab", { name: "NPC" })).toBeTruthy();
        expect(screen.getByRole("tab", { name: "Salida" })).toBeTruthy();
        expect(screen.getByRole("tab", { name: "Borrar" })).toBeTruthy();

        // Cambio a seleccion rectangular y conmutacion de overlays Grilla / Bloqueos:
        expect(latestConfig?.drawMode).toBe("brush");
        expect(latestConfig?.showGrid).toBe(true);
        expect(latestConfig?.showBlocked).toBe(true);

        fireEvent.click(screen.getByRole("button", { name: "Rectangulo" }));
        expect(latestConfig?.drawMode).toBe("rect");

        fireEvent.click(screen.getByRole("checkbox", { name: "Grilla" }));
        expect(latestConfig?.showGrid).toBe(false);

        fireEvent.click(screen.getByRole("checkbox", { name: "Bloqueos" }));
        expect(latestConfig?.showBlocked).toBe(false);

        // Herramienta de salida: permite configurar mapa y coordenadas destino
        fireEvent.click(screen.getByRole("tab", { name: "Salida" }));
        expect(latestConfig?.tool).toEqual({
            kind: "exit",
            targetMap: 1,
            targetX: 50,
            targetY: 50,
        });

        fireEvent.change(screen.getByLabelText(/Mapa destino/i), {
            target: { value: "34" },
        });
        expect(latestConfig?.tool).toEqual({
            kind: "exit",
            targetMap: 34,
            targetX: 50,
            targetY: 50,
        });
    });

    it("permite subir un PNG desde /play, lo registra en el motor y lo selecciona como pincel en la misma sesion", async () => {
        let latestConfig: InGameEditorSceneConfig | null = null;
        const registerUploadedGraphic = vi.fn(async () => undefined);
        const bridge: InGameEditorEngineBridge = {
            registerUploadedGraphic,
            getPlayerCountSummary: () => ({ totalPlayers: 1, otherPlayers: 0 }),
        };

        render(
            <EditorHarness
                adminState="allowed"
                initialEditMode
                onSceneConfig={(cfg) => {
                    latestConfig = cfg;
                }}
            />,
        );

        await waitFor(() => {
            expect(latestConfig?.enabled).toBe(true);
            expect(screen.getByText("Subir PNG nuevo")).toBeTruthy();
        });

        latestConfig!.onBridgeReady(bridge);

        const uploadedGraphic: UploadedGraphic = {
            grhIndex: 1_000_005,
            width: 32,
            height: 32,
            byteSize: 512,
            deduped: false,
            url: "/api/editor/graphics/1000005.png",
        };
        apiMocks.uploadGraphicPng.mockImplementation(async () => {
            currentUploadedGraphics = [uploadedGraphic];
            return uploadedGraphic;
        });

        const fileInput = document.querySelector(
            'input[type="file"][accept="image/png"]',
        ) as HTMLInputElement;
        expect(fileInput).toBeTruthy();

        const pngFile = new File(
            [new Uint8Array([137, 80, 78, 71])],
            "pasto.png",
            {
                type: "image/png",
            },
        );
        Object.defineProperty(pngFile, "arrayBuffer", {
            value: async () => new Uint8Array([137, 80, 78, 71]).buffer,
        });

        fireEvent.change(fileInput, { target: { files: [pngFile] } });

        await waitFor(() => {
            expect(apiMocks.uploadGraphicPng).toHaveBeenCalledTimes(1);
            expect(
                graphicTextureMocks.invalidateSharedGraphicsDB,
            ).toHaveBeenCalledTimes(1);
            expect(registerUploadedGraphic).toHaveBeenCalledWith(
                uploadedGraphic,
            );
            expect(latestConfig?.tool).toMatchObject({
                kind: "terrain",
                paletteId: 1_000_005,
                grhIndex: 1_000_005,
            });
        });
    });

    it("ejecuta pintado, soporta Ctrl+Z / Ctrl+Y ignorando inputs y advierte jugadores conectados al publicar", async () => {
        let latestConfig: InGameEditorSceneConfig | null = null;
        const bridge: InGameEditorEngineBridge = {
            registerUploadedGraphic: vi.fn(async () => undefined),
            getPlayerCountSummary: () => ({ totalPlayers: 4, otherPlayers: 3 }),
        };

        render(
            <EditorHarness
                adminState="allowed"
                initialEditMode
                onSceneConfig={(cfg) => {
                    latestConfig = cfg;
                }}
            />,
        );

        await waitFor(() => {
            expect(latestConfig?.tool?.kind).toBe("terrain");
        });

        latestConfig!.onBridgeReady(bridge);

        latestConfig!.onCommitTiles(
            [
                { x: 10, y: 15 },
                { x: 11, y: 15 },
            ],
            "rect",
        );

        await waitFor(() => {
            expect(apiMocks.paintTiles).toHaveBeenCalledTimes(1);
            expect(
                screen
                    .getByRole("button", { name: /^Deshacer/i })
                    .hasAttribute("disabled"),
            ).toBe(false);
        });

        // Ctrl+Z dentro de un campo de texto NO debe deshacer cambios del mapa
        fireEvent.click(screen.getByRole("tab", { name: "Objeto" }));
        const searchInput = await screen.findByPlaceholderText(
            /Buscar objeto por nombre o id/i,
        );
        fireEvent.keyDown(searchInput, { key: "z", ctrlKey: true });
        expect(apiMocks.clearTileOverride).not.toHaveBeenCalled();

        // Ctrl+Z fuera de inputs deshace el pintado remoto
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
        await waitFor(() => {
            expect(apiMocks.clearTileOverride).toHaveBeenCalledTimes(2);
        });

        // Ctrl+Y rehace el pintado remoto
        fireEvent.keyDown(window, { key: "y", ctrlKey: true });
        await waitFor(() => {
            expect(apiMocks.paintTiles).toHaveBeenCalledTimes(2);
        });

        // Publicar abre modal con advertencia de los 4 jugadores presentes en el mapa
        fireEvent.click(screen.getByRole("button", { name: "Publicar" }));

        const warning = await screen.findByTestId("publish-player-warning");
        expect(warning.textContent).toContain("4 jugadores");
        expect(warning.textContent).toContain("3 ademas de tu personaje");

        fireEvent.click(
            screen.getByRole("button", { name: "Confirmar publicacion" }),
        );

        await waitFor(() => {
            expect(apiMocks.publishMapChanges).toHaveBeenCalledWith(1);
            expect(
                gameLoaderMocks.invalidateCachedMapData,
            ).toHaveBeenCalledWith(1);
        });
    });

    it("sincroniza automaticamente el editor al cambiar de mapa", async () => {
        let latestConfig: InGameEditorSceneConfig | null = null;
        render(
            <EditorHarness
                adminState="allowed"
                initialEditMode
                initialMapNumber={1}
                onSceneConfig={(cfg) => {
                    latestConfig = cfg;
                }}
            />,
        );

        await waitFor(() => {
            expect(latestConfig?.mapNum).toBe(1);
        });

        fireEvent.click(screen.getByTestId("switch-map-2"));

        await waitFor(() => {
            expect(latestConfig?.mapNum).toBe(2);
            expect(apiMocks.getMapTerrainPalette).toHaveBeenCalledWith(2);
        });
    });
});

describe("useKeyboardGameplay en modo edicion", () => {
    afterEach(() => {
        cleanup();
    });

    it("bloquea el movimiento y atajos del personaje mientras el modo edicion esta activo", () => {
        const sendSpy = vi.fn();
        const syncSpy = vi.fn();

        function CustomProbe({ editing }: { editing: boolean }) {
            useKeyboardGameplay({
                isMounted: true,
                engineRef: {
                    current: {
                        KEY_CODES: { W: 1, A: 2, S: 3, D: 4 },
                    } as never,
                },
                websocketRef: {
                    current: {
                        readyState: WebSocket.OPEN,
                        send: sendSpy,
                    } as never,
                },
                hotkeySettingsRef: { current: DEFAULT_HOTKEY_SETTINGS },
                playerHudRef: { current: null },
                movementKeyMapRef: { current: new Map() },
                movementPressCountsRef: { current: new Map() },
                movementKeyPriorityRef: { current: [] },
                canProcessMovementInput: () => !editing,
                isGameplayInputDisabled: () => editing,
                clearMovementInputState: vi.fn(),
                clearTargetingMode: vi.fn(),
                hasEquippedMeleeWeapon: () => true,
                hasEquippedRangedWeapon: () => false,
                recordClientGameAction: vi.fn(),
                resolveBlockedGameplayKeyboardReason: () => null,
                setTargetingMode: vi.fn(),
                syncMovementState: syncSpy,
                setIsDebugMode: vi.fn(),
            });
            return null;
        }

        const { rerender } = render(<CustomProbe editing />);

        fireEvent.keyDown(document, { code: "KeyW", key: "w" });
        fireEvent.keyDown(document, { code: "KeyQ", key: "q" });
        expect(syncSpy).not.toHaveBeenCalled();
        expect(sendSpy).not.toHaveBeenCalled();

        rerender(<CustomProbe editing={false} />);
        fireEvent.keyDown(document, { code: "KeyW", key: "w" });
        expect(syncSpy).toHaveBeenCalledTimes(1);
    });
});
