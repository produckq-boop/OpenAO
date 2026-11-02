import { afterEach, describe, expect, it, vi } from "vitest";
import {
    clearLoadedMapCache,
    DYNAMIC_INSTANCE_MAP_END,
    getBaseMapIdFromDynamicInstance,
    isUserMapId,
    loadMapData,
    USER_MAP_ID_END,
    USER_MAP_ID_START,
} from "../gameLoader";

describe("gameLoader - ruteo del rango reservado de mapas de usuario (#24)", () => {
    afterEach(() => {
        clearLoadedMapCache();
        vi.restoreAllMocks();
    });

    it("acota instancias dinámicas a 30.000..99.999 para no interceptar mapas de usuario", () => {
        expect(DYNAMIC_INSTANCE_MAP_END).toBe(99_999);
        expect(USER_MAP_ID_START).toBe(100_000);
        expect(USER_MAP_ID_END).toBe(999_999);

        expect(getBaseMapIdFromDynamicInstance(29_999)).toBeNull();
        expect(getBaseMapIdFromDynamicInstance(30_050)).toBe(1);
        expect(getBaseMapIdFromDynamicInstance(99_999)).toBe(1399);

        // El rango 100.000..999.999 pertenece exclusivamente a mapas de usuario
        expect(getBaseMapIdFromDynamicInstance(100_000)).toBeNull();
        expect(getBaseMapIdFromDynamicInstance(250_000)).toBeNull();
        expect(getBaseMapIdFromDynamicInstance(999_999)).toBeNull();

        expect(isUserMapId(99_999)).toBe(false);
        expect(isUserMapId(100_000)).toBe(true);
        expect(isUserMapId(999_999)).toBe(true);
        expect(isUserMapId(1_000_000)).toBe(false);
    });

    it("carga mapas de usuario desde /user-maps/:mapNum/map-data y filtra salidas hacia mapas oficiales", async () => {
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        map: { mapNum: 100_001, status: "published" },
                        mapData: {
                            "100001": {
                                "50": {
                                    "50": {
                                        blocked: 0,
                                        graphics: { "1": 5500 },
                                        tileExit: { map: 1, x: 50, y: 50 },
                                    },
                                    "51": {
                                        blocked: 0,
                                        graphics: { "1": 5500 },
                                        tileExit: {
                                            map: 100_002,
                                            x: 20,
                                            y: 20,
                                        },
                                    },
                                },
                            },
                        },
                    }),
                    {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    },
                ),
            );

        const loaded = await loadMapData(100_001);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const requestedUrl = String(fetchSpy.mock.calls[0]?.[0] ?? "");
        expect(requestedUrl).toMatch(/\/user-maps\/100001\/map-data$/);

        expect(loaded["100001"]?.["50"]?.["50"]?.tileExit).toBeUndefined();
        expect(loaded["100001"]?.["50"]?.["51"]?.tileExit).toEqual({
            map: 100_002,
            x: 20,
            y: 20,
        });
    });
});
