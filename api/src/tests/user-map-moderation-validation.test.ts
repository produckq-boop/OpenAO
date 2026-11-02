import { afterEach, describe, expect, it, vi } from "vitest";
import {
    MAX_CUSTOM_GRAPHICS_PER_MAP,
    MAX_EXITS_PER_MAP,
    MAX_MAPS_PER_ACCOUNT,
    MAX_NPCS_PER_MAP,
    MAX_OBJECTS_PER_MAP,
    MAX_SIGNS_PER_MAP,
    OFFICIAL_WORLD_MAP_MAX_ID,
    UPLOADED_GRAPHIC_INDEX_START,
    canTransitionUserMapState,
    mapGeometryChecks,
    resolveNextUserMapState,
    runAutomatedMapChecks,
    validateBannedWords,
    validateBoundsAndQuotas,
} from "../lib/mapModerationValidation";

function buildCleanMapInput(overrides: Record<string, unknown> = {}) {
    return {
        name: "Bosque de Practica",
        description: "Mapa abierto para duelos amistosos.",
        width: 12,
        height: 12,
        spawn: { x: 2, y: 2 },
        mapData: {
            tiles: [
                {
                    x: 2,
                    y: 2,
                    layer: 1,
                    grhIndex: UPLOADED_GRAPHIC_INDEX_START,
                },
            ],
            blockedTiles: [],
            npcs: [
                {
                    x: 4,
                    y: 4,
                    npcId: 10,
                    name: "Guardia del Bosque",
                    dialogue: "Bienvenido viajero.",
                },
            ],
            objects: [{ x: 5, y: 5, objectId: 1, amount: 2 }],
            signs: [{ x: 3, y: 2, text: "Zona de entrenamiento libre." }],
            exits: [{ x: 12, y: 12, targetMap: OFFICIAL_WORLD_MAP_MAX_ID + 10 }],
            teleports: [],
        },
        ...overrides,
    };
}

describe("mapModerationValidation", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("state transitions", () => {
        it("permite las transiciones validas del flujo completo", () => {
            expect(resolveNextUserMapState("draft", "propose")).toBe(
                "proposed",
            );
            expect(resolveNextUserMapState("proposed", "start_review")).toBe(
                "in_review",
            );
            expect(resolveNextUserMapState("in_review", "approve")).toBe(
                "published",
            );
            expect(resolveNextUserMapState("in_review", "reject")).toBe(
                "rejected",
            );
            expect(resolveNextUserMapState("published", "report")).toBe(
                "proposed",
            );
            expect(resolveNextUserMapState("published", "unpublish")).toBe(
                "unpublished",
            );
            expect(resolveNextUserMapState("rejected", "edit_reset")).toBe(
                "draft",
            );
            expect(resolveNextUserMapState("unpublished", "edit_reset")).toBe(
                "draft",
            );
        });

        it("bloquea saltos de estado invalidos", () => {
            expect(canTransitionUserMapState("draft", "approve")).toBe(false);
            expect(canTransitionUserMapState("proposed", "approve")).toBe(
                false,
            );
            expect(canTransitionUserMapState("proposed", "reject")).toBe(false);
            expect(canTransitionUserMapState("in_review", "edit_reset")).toBe(
                false,
            );
            expect(canTransitionUserMapState("published", "edit_reset")).toBe(
                false,
            );
            expect(canTransitionUserMapState("rejected", "propose")).toBe(
                false,
            );
        });
    });

    describe("short-circuit de limites y cuotas antes del BFS", () => {
        it("corta dimensiones gigantes, decimales o no finitas sin ejecutar BFS", () => {
            const bfsSpy = vi.spyOn(
                mapGeometryChecks,
                "validateGeometryAndReachability",
            );

            for (const badSize of [
                { width: 50_000, height: 50_000 },
                { width: 20.5, height: 20 },
                { width: Number.NaN, height: 20 },
                { width: Number.POSITIVE_INFINITY, height: 20 },
                { width: 5, height: 20 },
            ]) {
                const result = runAutomatedMapChecks(
                    buildCleanMapInput(badSize),
                );
                expect(result.ok).toBe(false);
                if (!result.ok) {
                    expect(result.stage).toBe("bounds_and_quotas");
                    expect(result.violations[0]?.code).toBe(
                        "invalid_dimensions",
                    );
                }
            }

            expect(bfsSpy).not.toHaveBeenCalled();
        });

        it("corta excesos de cuotas (cuenta, NPCs, objetos, carteles, salidas y graficos) antes del BFS", () => {
            const bfsSpy = vi.spyOn(
                mapGeometryChecks,
                "validateGeometryAndReachability",
            );

            const overAccountQuota = runAutomatedMapChecks(
                buildCleanMapInput(),
                {
                    authorMapCount: MAX_MAPS_PER_ACCOUNT,
                },
            );
            expect(overAccountQuota.ok).toBe(false);
            if (!overAccountQuota.ok) {
                expect(overAccountQuota.stage).toBe("bounds_and_quotas");
                expect(
                    overAccountQuota.violations.some(
                        (v) => v.code === "account_map_quota_exceeded",
                    ),
                ).toBe(true);
            }

            const tooManyNpcs = Array.from(
                { length: MAX_NPCS_PER_MAP + 1 },
                (_, idx) => ({
                    x: (idx % 10) + 1,
                    y: Math.floor(idx / 10) + 1,
                    npcId: 1,
                }),
            );
            const overNpcQuota = runAutomatedMapChecks(
                buildCleanMapInput({
                    mapData: { npcs: tooManyNpcs },
                }),
            );
            expect(overNpcQuota.ok).toBe(false);
            if (!overNpcQuota.ok) {
                expect(
                    overNpcQuota.violations.some(
                        (v) => v.code === "npc_quota_exceeded",
                    ),
                ).toBe(true);
            }

            const tooManyObjects = Array.from(
                { length: MAX_OBJECTS_PER_MAP + 1 },
                () => ({ x: 1, y: 1, objectId: 1 }),
            );
            expect(
                validateBoundsAndQuotas(
                    buildCleanMapInput({
                        mapData: { objects: tooManyObjects },
                    }),
                ).ok,
            ).toBe(false);

            const tooManySigns = Array.from(
                { length: MAX_SIGNS_PER_MAP + 1 },
                () => ({ x: 1, y: 1, text: "Cartel" }),
            );
            expect(
                validateBoundsAndQuotas(
                    buildCleanMapInput({
                        mapData: { signs: tooManySigns },
                    }),
                ).ok,
            ).toBe(false);

            const tooManyExits = Array.from(
                { length: MAX_EXITS_PER_MAP + 1 },
                () => ({ x: 1, y: 1 }),
            );
            expect(
                validateBoundsAndQuotas(
                    buildCleanMapInput({
                        mapData: { exits: tooManyExits },
                    }),
                ).ok,
            ).toBe(false);

            const tooManyCustomGraphics = Array.from(
                { length: MAX_CUSTOM_GRAPHICS_PER_MAP + 1 },
                (_, idx) => ({
                    x: (idx % 12) + 1,
                    y: (Math.floor(idx / 12) % 12) + 1,
                    layer: 1,
                    grhIndex: UPLOADED_GRAPHIC_INDEX_START + idx,
                }),
            );
            const overCustomGraphics = runAutomatedMapChecks(
                buildCleanMapInput({
                    mapData: { tiles: tooManyCustomGraphics },
                }),
            );
            expect(overCustomGraphics.ok).toBe(false);
            if (!overCustomGraphics.ok) {
                expect(
                    overCustomGraphics.violations.some(
                        (v) => v.code === "custom_graphic_quota_exceeded",
                    ),
                ).toBe(true);
            }

            expect(bfsSpy).not.toHaveBeenCalled();
        });

        it("impide abrir salidas directas hacia mapas del mundo oficial (1..599)", () => {
            const bfsSpy = vi.spyOn(
                mapGeometryChecks,
                "validateGeometryAndReachability",
            );

            const result = runAutomatedMapChecks(
                buildCleanMapInput({
                    mapData: {
                        exits: [{ x: 10, y: 10, targetMap: 1 }],
                    },
                }),
            );

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.stage).toBe("bounds_and_quotas");
                expect(result.violations[0]?.code).toBe(
                    "forbidden_official_world_exit",
                );
            }
            expect(bfsSpy).not.toHaveBeenCalled();
        });
    });

    describe("filtro de palabras prohibidas", () => {
        it("detecta insultos con acentos o leet en nombre, descripcion, carteles y NPCs sin correr BFS", () => {
            const bfsSpy = vi.spyOn(
                mapGeometryChecks,
                "validateGeometryAndReachability",
            );

            const dirtyInput = buildCleanMapInput({
                name: "Valle de m13rd4",
                description: "Zona para pútás batallas",
                mapData: {
                    signs: [{ x: 3, y: 3, text: "Cuidado pendejo" }],
                    npcs: [
                        {
                            x: 4,
                            y: 4,
                            npcId: 25,
                            dialogue: "Fuera cabrón",
                        },
                    ],
                },
            });

            const result = runAutomatedMapChecks(dirtyInput, {
                catalogNpcNames: new Map([[25, "Mercader Boludo"]]),
            });

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.stage).toBe("banned_words");
                const fields = result.violations.map((v) => v.field);
                expect(fields).toContain("name");
                expect(fields).toContain("description");
                expect(fields).toContain("mapData.signs[0].text");
                expect(fields).toContain("mapData.npcs[0].name");
                expect(fields).toContain("mapData.npcs[0].dialogue");
            }
            expect(bfsSpy).not.toHaveBeenCalled();
        });

        it("no genera falsos positivos en palabras validas como computadora o disputa", () => {
            const bounds = validateBoundsAndQuotas(
                buildCleanMapInput({
                    name: "Sala de Computadoras",
                    description:
                        "Disputa y disputas honorables por la reputacion.",
                    mapData: {
                        signs: [
                            {
                                x: 3,
                                y: 3,
                                text: "Computadora central sin insultos.",
                            },
                        ],
                    },
                }),
            );
            expect(bounds.ok).toBe(true);
            if (bounds.ok) {
                const violations = validateBannedWords(bounds.normalized);
                expect(violations).toEqual([]);
            }
        });
    });

    describe("geometria y alcanzabilidad BFS", () => {
        it("aprueba un mapa limpio y devuelve diagnosticos completos", () => {
            const result = runAutomatedMapChecks(buildCleanMapInput());

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.stage).toBe("passed");
                expect(result.diagnostics.totalTiles).toBe(144);
                expect(result.diagnostics.isolatedRegionCount).toBe(0);
                expect(result.diagnostics.trapTileCount).toBe(0);
            }
        });

        it("rechaza mapas con el punto de entrada bloqueado o encerrado sin camino", () => {
            const blockedSpawn = runAutomatedMapChecks(
                buildCleanMapInput({
                    spawn: { x: 2, y: 2 },
                    mapData: {
                        blockedTiles: [{ x: 2, y: 2 }],
                    },
                }),
            );
            expect(blockedSpawn.ok).toBe(false);
            if (!blockedSpawn.ok) {
                expect(blockedSpawn.stage).toBe("geometry");
                expect(
                    blockedSpawn.violations.some(
                        (v) => v.code === "spawn_blocked",
                    ),
                ).toBe(true);
            }

            const boxedSpawn = runAutomatedMapChecks(
                buildCleanMapInput({
                    spawn: { x: 1, y: 1 },
                    mapData: {
                        blockedTiles: [
                            { x: 2, y: 1 },
                            { x: 1, y: 2 },
                        ],
                    },
                }),
            );
            expect(boxedSpawn.ok).toBe(false);
            if (!boxedSpawn.ok) {
                expect(
                    boxedSpawn.violations.some(
                        (v) => v.code === "no_path_from_entry",
                    ),
                ).toBe(true);
            }
        });

        it("rechaza regiones transitables aisladas por paredes de tiles bloqueados", () => {
            const wallAcrossColumn6 = Array.from({ length: 10 }, (_, idx) => ({
                x: 6,
                y: idx + 1,
            }));

            const result = runAutomatedMapChecks(
                buildCleanMapInput({
                    width: 10,
                    height: 10,
                    spawn: { x: 2, y: 2 },
                    mapData: {
                        blockedTiles: wallAcrossColumn6,
                    },
                }),
            );

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.stage).toBe("geometry");
                expect(
                    result.violations.some(
                        (v) => v.code === "isolated_walkable_region",
                    ),
                ).toBe(true);
                expect(result.diagnostics?.isolatedRegionCount).toBe(1);
                expect(result.diagnostics?.isolatedTileCount).toBe(40);
            }
        });

        it("detecta trampas sin salida por teleport de ida y acepta teleports bidireccionales", () => {
            const wallAcrossColumn6 = Array.from({ length: 10 }, (_, idx) => ({
                x: 6,
                y: idx + 1,
            }));

            const oneWayTrap = runAutomatedMapChecks(
                buildCleanMapInput({
                    width: 10,
                    height: 10,
                    spawn: { x: 2, y: 2 },
                    mapData: {
                        blockedTiles: wallAcrossColumn6,
                        teleports: [{ fromX: 3, fromY: 3, toX: 8, toY: 8 }],
                    },
                }),
            );

            expect(oneWayTrap.ok).toBe(false);
            if (!oneWayTrap.ok) {
                expect(oneWayTrap.stage).toBe("geometry");
                expect(
                    oneWayTrap.violations.some(
                        (v) => v.code === "inescapable_trap",
                    ),
                ).toBe(true);
                expect(oneWayTrap.diagnostics?.trapTileCount).toBeGreaterThan(
                    0,
                );
            }

            const twoWayConnected = runAutomatedMapChecks(
                buildCleanMapInput({
                    width: 10,
                    height: 10,
                    spawn: { x: 2, y: 2 },
                    mapData: {
                        blockedTiles: wallAcrossColumn6,
                        teleports: [
                            { fromX: 3, fromY: 3, toX: 8, toY: 8 },
                            { fromX: 9, fromY: 8, toX: 2, toY: 3 },
                        ],
                    },
                }),
            );

            expect(twoWayConnected.ok).toBe(true);
        });

        it("impide desbloquear una pared de blockedTiles con una capa superior en false y valida targetX/targetY", () => {
            const wallAcrossColumn6 = Array.from({ length: 10 }, (_, idx) => ({
                x: 6,
                y: idx + 1,
            }));

            const roofBypassAttempt = runAutomatedMapChecks(
                buildCleanMapInput({
                    width: 10,
                    height: 10,
                    spawn: { x: 2, y: 2 },
                    mapData: {
                        blockedTiles: wallAcrossColumn6,
                        tiles: [
                            {
                                x: 6,
                                y: 5,
                                layer: 3,
                                grhIndex: 100,
                                blocked: false,
                            },
                        ],
                    },
                }),
            );

            expect(roofBypassAttempt.ok).toBe(false);
            if (!roofBypassAttempt.ok) {
                expect(roofBypassAttempt.stage).toBe("geometry");
                expect(
                    roofBypassAttempt.violations.some(
                        (v) => v.code === "isolated_walkable_region",
                    ),
                ).toBe(true);
            }

            const badExitTarget = validateBoundsAndQuotas(
                buildCleanMapInput({
                    mapData: {
                        exits: [
                            {
                                x: 10,
                                y: 10,
                                targetMap: OFFICIAL_WORLD_MAP_MAX_ID + 10,
                                targetX: 250,
                                targetY: 10,
                            },
                        ],
                    },
                }),
            );
            expect(badExitTarget.ok).toBe(false);
            if (!badExitTarget.ok) {
                expect(badExitTarget.violations[0]?.code).toBe(
                    "invalid_exit_entry",
                );
            }
        });
    });
});
