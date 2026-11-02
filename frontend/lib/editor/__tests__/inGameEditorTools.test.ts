import { describe, expect, it } from "vitest";
import type { GraphicsDB, MapTile } from "../../../types/game";
import {
    buildBrushTilePaints,
    buildEffectiveMapTile,
    chunkTilePaints,
    clampLocalPixelToTile,
    computeTileRectBounds,
    countPlayersInMap,
    createUploadedGraphicEntry,
    expandTileRectCoords,
    localPixelToTile,
    PAINT_BATCH_SIZE,
    registerUploadedGraphicInCatalog,
    resolveEffectiveTileBlocked,
    tileVisualSignature,
} from "../inGameEditorTools";

describe("inGameEditorTools", () => {
    describe("localPixelToTile y clampLocalPixelToTile", () => {
        const dimensions = { width: 100, height: 100 };

        it("convierte pixeles locales del mundo a coordenadas 1-based", () => {
            expect(localPixelToTile(0, 0, dimensions, 32)).toEqual({
                x: 1,
                y: 1,
            });
            expect(localPixelToTile(31.9, 63.9, dimensions, 32)).toEqual({
                x: 1,
                y: 2,
            });
            expect(localPixelToTile(32 * 99 + 16, 32 * 49 + 8, dimensions, 32)).toEqual({
                x: 100,
                y: 50,
            });
        });

        it("devuelve null fuera de los limites en localPixelToTile pero ajusta al borde en clampLocalPixelToTile", () => {
            expect(localPixelToTile(-1, 10, dimensions, 32)).toBeNull();
            expect(localPixelToTile(3200, 10, dimensions, 32)).toBeNull();
            expect(localPixelToTile(10, -0.1, dimensions, 32)).toBeNull();
            expect(localPixelToTile(10, 3205, dimensions, 32)).toBeNull();
            expect(localPixelToTile(Number.NaN, 10, dimensions, 32)).toBeNull();

            expect(clampLocalPixelToTile(-40, 3500, dimensions, 32)).toEqual({
                x: 1,
                y: 100,
            });
            expect(clampLocalPixelToTile(4000, -12, dimensions, 32)).toEqual({
                x: 100,
                y: 1,
            });
        });
    });

    describe("computeTileRectBounds y expandTileRectCoords", () => {
        it("calcula el rectangulo sin importar la direccion de arrastre", () => {
            const bounds = computeTileRectBounds(
                { x: 14, y: 20 },
                { x: 11, y: 18 },
            );

            expect(bounds).toEqual({
                minX: 11,
                maxX: 14,
                minY: 18,
                maxY: 20,
                width: 4,
                height: 3,
                tileCount: 12,
            });

            const coords = expandTileRectCoords(bounds);
            expect(coords).toHaveLength(12);
            expect(coords[0]).toEqual({ x: 11, y: 18 });
            expect(coords[coords.length - 1]).toEqual({ x: 14, y: 20 });
        });

        it("soporta seleccion de un unico tile", () => {
            const bounds = computeTileRectBounds({ x: 50, y: 50 }, { x: 50, y: 50 });
            expect(bounds.tileCount).toBe(1);
            expect(expandTileRectCoords(bounds)).toEqual([{ x: 50, y: 50 }]);
        });
    });

    describe("buildBrushTilePaints y chunkTilePaints", () => {
        it("expande capas de terreno, aplica bloqueo en capa 1 y elimina duplicados", () => {
            const paints = buildBrushTilePaints(
                [
                    { x: 10, y: 12 },
                    { x: 10, y: 12 },
                    { x: 11, y: 12 },
                ],
                {
                    graphics: [120, 450],
                    blocked: true,
                },
            );

            expect(paints).toEqual([
                { x: 10, y: 12, layer: 1, grhIndex: 120, blocked: true },
                { x: 10, y: 12, layer: 2, grhIndex: 450, blocked: null },
                { x: 11, y: 12, layer: 1, grhIndex: 120, blocked: true },
                { x: 11, y: 12, layer: 2, grhIndex: 450, blocked: null },
            ]);
        });

        it("divide operaciones masivas en lotes compatibles con PAINT_BATCH_SIZE (500)", () => {
            const coords = Array.from({ length: 620 }, (_, index) => ({
                x: (index % 100) + 1,
                y: Math.floor(index / 100) + 1,
            }));
            const paints = buildBrushTilePaints(coords, {
                graphics: [100, 200],
                blocked: false,
            });

            expect(paints).toHaveLength(1240);
            const batches = chunkTilePaints(paints);
            expect(batches).toHaveLength(3);
            expect(batches[0]).toHaveLength(PAINT_BATCH_SIZE);
            expect(batches[1]).toHaveLength(PAINT_BATCH_SIZE);
            expect(batches[2]).toHaveLength(240);
        });
    });

    describe("resolveEffectiveTileBlocked", () => {
        it("respeta el bloqueo base y permite sobreescribirlo con borradores", () => {
            expect(resolveEffectiveTileBlocked(1, [])).toEqual({
                blocked: true,
                overridden: false,
            });
            expect(
                resolveEffectiveTileBlocked(1, [{ blocked: false }]),
            ).toEqual({
                blocked: false,
                overridden: true,
            });
            expect(
                resolveEffectiveTileBlocked(0, [
                    { blocked: null },
                    { blocked: true },
                ]),
            ).toEqual({
                blocked: true,
                overridden: true,
            });
        });
    });

    describe("createUploadedGraphicEntry y registerUploadedGraphicInCatalog", () => {
        it("registra un PNG subido en graphicsDB para usarlo en la misma sesion", () => {
            const db: GraphicsDB = {};
            const entry = registerUploadedGraphicInCatalog(db, {
                grhIndex: 1_000_007,
                width: 64,
                height: 96,
            });

            expect(entry).toEqual(
                createUploadedGraphicEntry({
                    grhIndex: 1_000_007,
                    width: 64,
                    height: 96,
                }),
            );
            expect(db["1000007"]).toEqual({
                numFrames: 1,
                numFile: "1000007",
                sX: 0,
                sY: 0,
                width: 64,
                height: 96,
                frames: { "1": "1000007" },
                offset: { x: 0, y: 0 },
            });
        });
    });

    describe("countPlayersInMap", () => {
        it("cuenta jugadores humanos en el mapa excluyendo NPCs y otros mapas", () => {
            const summary = countPlayersInMap({
                mapNumber: 34,
                user: { id: 10, map: 34, isNpc: false },
                personajes: {
                    "10": { id: 10, map: 34, isNpc: false },
                    "11": { id: 11, map: 34, isNpc: false },
                    "12": { id: 12, map: 34, isNpc: false },
                    "90": { id: 90, map: 34, isNpc: true },
                    "99": { id: 99, map: 1, isNpc: false },
                },
            });

            expect(summary).toEqual({
                totalPlayers: 3,
                otherPlayers: 2,
            });
        });
    });

    describe("buildEffectiveMapTile y tileVisualSignature", () => {
        it("mezcla capas, borra capas con grhIndex null y aplica salidas en borrador", () => {
            const baseTile: MapTile = {
                blocked: 1,
                graphics: { "1": 50, "2": 80 },
                trigger: 4,
            };

            const nextTile = buildEffectiveMapTile(
                baseTile,
                [
                    {
                        mapNum: 1,
                        x: 5,
                        y: 6,
                        layer: 1,
                        grhIndex: 900,
                        blocked: false,
                        status: "draft",
                    },
                    {
                        mapNum: 1,
                        x: 5,
                        y: 6,
                        layer: 2,
                        grhIndex: null,
                        blocked: null,
                        status: "draft",
                    },
                ],
                {
                    x: 5,
                    y: 6,
                    targetMap: 2,
                    targetX: 40,
                    targetY: 60,
                },
            );

            expect(nextTile).toEqual({
                blocked: 0,
                graphics: { "1": 900 },
                trigger: 4,
                tileExit: { map: 2, x: 40, y: 60 },
            });
            expect(tileVisualSignature(nextTile)).not.toBe(
                tileVisualSignature(baseTile),
            );
        });
    });
});
