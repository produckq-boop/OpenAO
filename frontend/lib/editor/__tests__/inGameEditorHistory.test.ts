import { describe, expect, it, vi } from "vitest";
import {
    createEntityOperationCommand,
    createEraseOperationCommand,
    createExitOperationCommand,
    createPaintOperationCommand,
    InGameEditorHistory,
    isEditableKeyboardTarget,
    matchEditorHistoryShortcut,
    type EditorPersistenceAdapter,
} from "../inGameEditorHistory";

function createMockAdapter(): EditorPersistenceAdapter {
    return {
        paintTiles: vi.fn(async () => undefined),
        clearTileOverride: vi.fn(async () => undefined),
        placeTileEntity: vi.fn(async () => undefined),
        removeTileEntity: vi.fn(async () => undefined),
        setDraftExit: vi.fn(),
        removeDraftExit: vi.fn(),
        onAfterSync: vi.fn(async () => undefined),
    };
}

describe("inGameEditorHistory", () => {
    it("ejecuta, deshace y rehace operaciones actualizando los snapshots", async () => {
        const history = new InGameEditorHistory(1);
        const log: string[] = [];

        const executed = await history.execute(1, {
            label: "Pintar tile",
            redo: async () => {
                log.push("redo-1");
            },
            undo: async () => {
                log.push("undo-1");
            },
        });

        expect(executed).toBe(true);
        expect(history.getSnapshot()).toMatchObject({
            mapNum: 1,
            canUndo: true,
            canRedo: false,
            undoCount: 1,
            redoCount: 0,
            undoLabel: "Pintar tile",
        });

        await history.undo();
        expect(history.getSnapshot()).toMatchObject({
            canUndo: false,
            canRedo: true,
            undoCount: 0,
            redoCount: 1,
            redoLabel: "Pintar tile",
        });

        await history.redo();
        expect(history.getSnapshot()).toMatchObject({
            canUndo: true,
            canRedo: false,
            undoCount: 1,
            redoCount: 0,
        });
        expect(log).toEqual(["redo-1", "undo-1", "redo-1"]);
    });

    it("no mueve los punteros si falla la persistencia remota y permite reintentar", async () => {
        const history = new InGameEditorHistory(1);
        let failUndo = true;

        await expect(
            history.execute(1, {
                label: "Operacion fallida",
                redo: async () => {
                    throw new Error("Fallo de red");
                },
                undo: async () => undefined,
            }),
        ).rejects.toThrow("Fallo de red");

        expect(history.getSnapshot().undoCount).toBe(0);
        expect(history.getSnapshot().isBusy).toBe(false);

        await history.execute(1, {
            label: "Operacion valida",
            redo: async () => undefined,
            undo: async () => {
                if (failUndo) {
                    throw new Error("Error temporal");
                }
            },
        });

        await expect(history.undo()).rejects.toThrow("Error temporal");
        expect(history.getSnapshot().undoCount).toBe(1);
        expect(history.getSnapshot().redoCount).toBe(0);

        failUndo = false;
        await expect(history.undo()).resolves.toBe(true);
        expect(history.getSnapshot().undoCount).toBe(0);
        expect(history.getSnapshot().redoCount).toBe(1);
    });

    it("bloquea operaciones concurrentes e invalida promesas en vuelo al cambiar de mapa", async () => {
        const history = new InGameEditorHistory(1);
        let resolveWrite: (() => void) | null = null;

        const inFlight = history.execute(1, {
            label: "Escritura lenta",
            redo: () =>
                new Promise<void>((resolve) => {
                    resolveWrite = resolve;
                }),
            undo: async () => undefined,
        });

        expect(history.getSnapshot().isBusy).toBe(true);
        await expect(
            history.execute(1, {
                label: "Concurrente",
                redo: async () => undefined,
                undo: async () => undefined,
            }),
        ).resolves.toBe(false);

        history.reset(2);
        expect(history.getSnapshot()).toMatchObject({
            mapNum: 2,
            undoCount: 0,
            isBusy: false,
        });

        resolveWrite?.();
        await expect(inFlight).resolves.toBe(false);
        expect(history.getSnapshot()).toMatchObject({
            mapNum: 2,
            undoCount: 0,
            redoCount: 0,
        });
    });

    it("restaura borradores previos o limpia overrides nuevos en createPaintOperationCommand", async () => {
        const adapter = createMockAdapter();
        const command = createPaintOperationCommand({
            mapNum: 1,
            label: "Pintar 2 tiles",
            nextPaints: [
                { x: 5, y: 5, layer: 1, grhIndex: 300, blocked: true },
                { x: 6, y: 5, layer: 1, grhIndex: 300, blocked: true },
            ],
            currentOverrides: [
                {
                    mapNum: 1,
                    x: 5,
                    y: 5,
                    layer: 1,
                    grhIndex: 111,
                    blocked: false,
                    status: "draft",
                },
                {
                    mapNum: 1,
                    x: 6,
                    y: 5,
                    layer: 1,
                    grhIndex: 222,
                    blocked: false,
                    status: "published",
                },
            ],
            adapter,
        });

        await command.redo();
        expect(adapter.paintTiles).toHaveBeenCalledWith(1, [
            { x: 5, y: 5, layer: 1, grhIndex: 300, blocked: true },
            { x: 6, y: 5, layer: 1, grhIndex: 300, blocked: true },
        ]);

        await command.undo();
        expect(adapter.paintTiles).toHaveBeenLastCalledWith(1, [
            { x: 5, y: 5, layer: 1, grhIndex: 111, blocked: false },
        ]);
        expect(adapter.clearTileOverride).toHaveBeenCalledWith(1, 6, 5, 1);
    });

    it("revierte colocacion de entidades, salidas y borrado combinado", async () => {
        const adapter = createMockAdapter();

        const entityCommand = createEntityOperationCommand({
            mapNum: 3,
            label: "Colocar NPC",
            placement: { x: 10, y: 12, kind: "npc", entityId: 500 },
            currentEntities: [],
            adapter,
        });
        await entityCommand.redo();
        expect(adapter.placeTileEntity).toHaveBeenCalledWith(3, {
            x: 10,
            y: 12,
            kind: "npc",
            entityId: 500,
        });
        await entityCommand.undo();
        expect(adapter.removeTileEntity).toHaveBeenCalledWith(3, 10, 12, "npc");

        const exitCommand = createExitOperationCommand({
            label: "Definir salida",
            coords: [{ x: 1, y: 20 }],
            target: { targetMap: 2, targetX: 98, targetY: 20 },
            currentDraftExits: [],
            adapter,
        });
        await exitCommand.redo();
        expect(adapter.setDraftExit).toHaveBeenCalledWith({
            x: 1,
            y: 20,
            targetMap: 2,
            targetX: 98,
            targetY: 20,
        });
        await exitCommand.undo();
        expect(adapter.removeDraftExit).toHaveBeenCalledWith(1, 20);

        const eraseCommand = createEraseOperationCommand({
            mapNum: 3,
            label: "Borrar borradores",
            coords: [{ x: 10, y: 12 }],
            currentOverrides: [
                {
                    mapNum: 3,
                    x: 10,
                    y: 12,
                    layer: 1,
                    grhIndex: 777,
                    blocked: false,
                    status: "draft",
                },
            ],
            currentEntities: [
                {
                    mapNum: 3,
                    x: 10,
                    y: 12,
                    kind: "obj",
                    entityId: 42,
                    status: "draft",
                },
            ],
            currentDraftExits: [
                { x: 10, y: 12, targetMap: 8, targetX: 50, targetY: 50 },
            ],
            adapter,
        });

        expect(eraseCommand).not.toBeNull();
        await eraseCommand?.redo();
        expect(adapter.clearTileOverride).toHaveBeenCalledWith(3, 10, 12, 1);
        expect(adapter.removeTileEntity).toHaveBeenCalledWith(3, 10, 12, "obj");
        expect(adapter.removeDraftExit).toHaveBeenCalledWith(10, 12);

        await eraseCommand?.undo();
        expect(adapter.paintTiles).toHaveBeenLastCalledWith(3, [
            { x: 10, y: 12, layer: 1, grhIndex: 777, blocked: false },
        ]);
        expect(adapter.placeTileEntity).toHaveBeenLastCalledWith(3, {
            x: 10,
            y: 12,
            kind: "obj",
            entityId: 42,
        });
        expect(adapter.setDraftExit).toHaveBeenLastCalledWith({
            x: 10,
            y: 12,
            targetMap: 8,
            targetX: 50,
            targetY: 50,
        });
    });

    it("detecta atajos Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z e ignora campos editables", () => {
        const input = document.createElement("input");
        const editableDiv = document.createElement("div");
        editableDiv.setAttribute("contenteditable", "true");
        const button = document.createElement("button");

        expect(isEditableKeyboardTarget(input)).toBe(true);
        expect(isEditableKeyboardTarget(editableDiv)).toBe(true);
        expect(isEditableKeyboardTarget(button)).toBe(false);

        expect(
            matchEditorHistoryShortcut({
                key: "z",
                ctrlKey: true,
                target: button,
            }),
        ).toBe("undo");
        expect(
            matchEditorHistoryShortcut({
                key: "Z",
                ctrlKey: true,
                shiftKey: true,
                target: button,
            }),
        ).toBe("redo");
        expect(
            matchEditorHistoryShortcut({
                key: "y",
                ctrlKey: true,
                target: button,
            }),
        ).toBe("redo");
        expect(
            matchEditorHistoryShortcut({
                key: "z",
                metaKey: true,
                target: button,
            }),
        ).toBe("undo");
        expect(
            matchEditorHistoryShortcut({
                key: "z",
                ctrlKey: true,
                target: input,
            }),
        ).toBeNull();
    });
});
