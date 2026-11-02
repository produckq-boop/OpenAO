import { describe, expect, it } from "vitest";
import {
    assertOfficialWorldMapMutationAllowed,
    buildUserMapClientData,
    isOfficialOrSystemMapId,
    isUserMapId,
    OFFICIAL_WORLD_MAP_MAX_ID,
    USER_MAP_ID_END,
    USER_MAP_ID_START,
    validateUserMapContent,
    validateUserMapNpcAllowed,
    validateUserMapObjectAllowed,
} from "../lib/userMapIsolation";

describe("userMapIsolation - rango reservado y aislamiento económico (#24)", () => {
    it("separa estructuralmente el rango 100.000..999.999 del mundo oficial y sistemas existentes", () => {
        expect(OFFICIAL_WORLD_MAP_MAX_ID).toBe(99_999);
        expect(USER_MAP_ID_START).toBe(100_000);
        expect(USER_MAP_ID_END).toBe(999_999);

        expect(isOfficialOrSystemMapId(1)).toBe(true);
        expect(isOfficialOrSystemMapId(500)).toBe(true);
        expect(isOfficialOrSystemMapId(2_000)).toBe(true);
        expect(isOfficialOrSystemMapId(30_000)).toBe(true);
        expect(isOfficialOrSystemMapId(99_999)).toBe(true);
        expect(isOfficialOrSystemMapId(100_000)).toBe(false);

        expect(isUserMapId(99_999)).toBe(false);
        expect(isUserMapId(100_000)).toBe(true);
        expect(isUserMapId(550_123)).toBe(true);
        expect(isUserMapId(999_999)).toBe(true);
        expect(isUserMapId(1_000_000)).toBe(false);
    });

    it("bloquea mutaciones de mapas de usuario desde las rutas de edición del mundo oficial", () => {
        expect(() => assertOfficialWorldMapMutationAllowed(1)).not.toThrow();
        expect(() => assertOfficialWorldMapMutationAllowed(286)).not.toThrow();
        expect(() =>
            assertOfficialWorldMapMutationAllowed(100_000),
        ).toThrow(/espacio aislado de mapas de usuario/);
    });

    it("prohíbe oro, teleports oficiales, llaves, recursos recolectables y equipamiento en objs.json", () => {
        // 12: Monedas de Oro (objType 5)
        const gold = validateUserMapObjectAllowed(12);
        expect(gold.ok).toBe(false);
        if (!gold.ok) {
            expect(gold.reason).toMatch(/oro ni monedas/i);
        }

        // 144: Teleport a Dungeon Newbie (objType 19)
        const teleport = validateUserMapObjectAllowed(144);
        expect(teleport.ok).toBe(false);
        if (!teleport.ok) {
            expect(teleport.reason).toMatch(/teleports del mundo oficial/i);
        }

        // 14: Llave (objType 9)
        const key = validateUserMapObjectAllowed(14);
        expect(key.ok).toBe(false);
        if (!key.ok) {
            expect(key.reason).toMatch(/llaves/i);
        }

        // 188: Yacimiento de Hierro (objType 22) y 386: Lingote de Hierro (objType 29)
        expect(validateUserMapObjectAllowed(188).ok).toBe(false);
        expect(validateUserMapObjectAllowed(386).ok).toBe(false);

        // 4: Árbol talable (objType 4), 2: Espada Larga (objType 2), 1: Manzana Roja (objType 1), 414: Piel Lobo (objType 30)
        expect(validateUserMapObjectAllowed(4).ok).toBe(false);
        expect(validateUserMapObjectAllowed(2).ok).toBe(false);
        expect(validateUserMapObjectAllowed(1).ok).toBe(false);
        expect(validateUserMapObjectAllowed(414).ok).toBe(false);
    });

    it("admite objetos decorativos y estructurales estáticos del catálogo oficial", () => {
        // 7: Puerta (6), 13: Cartel (8), 34: Foro (10), 63: Fogata (15), 155: Cama (20), 653: Reja (35)
        for (const allowedObjId of [7, 13, 34, 63, 155, 653]) {
            expect(validateUserMapObjectAllowed(allowedObjId)).toEqual({
                ok: true,
            });
        }
    });

    it("sólo admite NPCs ambientales sin combate, experiencia, oro, drops ni comercio", () => {
        // 1: Aldeano (ambient, exp=0, gold=0, maxHit=0, drop=[])
        expect(validateUserMapNpcAllowed(1)).toEqual({ ok: true });
        // 5: Sacerdote (ambient sin comercio ni drops)
        expect(validateUserMapNpcAllowed(5)).toEqual({ ok: true });

        // 2: Gallo (exp=10, maxHit=1)
        const rooster = validateUserMapNpcAllowed(2);
        expect(rooster.ok).toBe(false);

        // 6: Guardia Imperial (maxHit=250)
        expect(validateUserMapNpcAllowed(6).ok).toBe(false);

        // 7: Herrero (comerciante, npcType=10)
        expect(validateUserMapNpcAllowed(7).ok).toBe(false);
    });

    it("rechaza combate habilitado, salidas hacia mapas oficiales y exceso de cuotas por mapa", () => {
        const combatAttempt = validateUserMapContent(
            { combatEnabled: true },
            { maxNpcsPerMap: 10, maxObjectsPerMap: 10 },
        );
        expect(combatAttempt.ok).toBe(false);
        if (!combatAttempt.ok) {
            expect(combatAttempt.code).toBe("ISOLATION_VIOLATION");
        }

        const officialPortalAttempt = validateUserMapContent(
            {
                exits: [
                    { x: 50, y: 10, targetMap: 1, targetX: 50, targetY: 50 },
                ],
            },
            { maxNpcsPerMap: 10, maxObjectsPerMap: 10 },
        );
        expect(officialPortalAttempt.ok).toBe(false);
        if (!officialPortalAttempt.ok) {
            expect(officialPortalAttempt.code).toBe("ISOLATION_VIOLATION");
            expect(officialPortalAttempt.reason).toMatch(/fuera del rango reservado/);
        }

        const npcQuotaAttempt = validateUserMapContent(
            {
                npcs: [
                    { x: 10, y: 10, npcIndex: 1, movement: 0 },
                    { x: 11, y: 10, npcIndex: 1, movement: 0 },
                ],
            },
            { maxNpcsPerMap: 1, maxObjectsPerMap: 10 },
        );
        expect(npcQuotaAttempt.ok).toBe(false);
        if (!npcQuotaAttempt.ok) {
            expect(npcQuotaAttempt.code).toBe("QUOTA_EXCEEDED");
        }

        const objectQuotaAttempt = validateUserMapContent(
            {
                objects: [
                    { x: 20, y: 20, objIndex: 155, amount: 1 },
                    { x: 21, y: 20, objIndex: 155, amount: 1 },
                ],
            },
            { maxNpcsPerMap: 10, maxObjectsPerMap: 1 },
        );
        expect(objectQuotaAttempt.ok).toBe(false);
        if (!objectQuotaAttempt.ok) {
            expect(objectQuotaAttempt.code).toBe("QUOTA_EXCEEDED");
        }
    });

    it("genera MapData 100x100 con bordes bloqueados y descarta salidas hacia mapas oficiales", () => {
        const clientMap = buildUserMapClientData({
            mapNum: 100_000,
            tiles: [{ x: 50, y: 50, layer: 2, grhIndex: 581, blocked: false }],
            objects: [{ x: 40, y: 40, objIndex: 155, amount: 1 }],
            npcs: [{ x: 45, y: 45, npcIndex: 1, movement: 0 }],
            exits: [
                { x: 10, y: 10, targetMap: 1, targetX: 50, targetY: 50 },
                { x: 12, y: 12, targetMap: 100_001, targetX: 50, targetY: 50 },
            ],
        });

        const grid = clientMap["100000"]!;
        expect(grid["1"]!["1"]!.blocked).toBe(1);
        expect(grid["50"]!["50"]!.graphics?.["2"]).toBe(581);
        expect(grid["40"]!["40"]!.objInfo).toEqual({
            objIndex: 155,
            amount: 1,
        });
        expect(grid["45"]!["45"]!.npcIndex).toBe(1);
        expect(grid["10"]!["10"]!.tileExit).toBeUndefined();
        expect(grid["12"]!["12"]!.tileExit).toEqual({
            map: 100_001,
            x: 50,
            y: 50,
        });
    });
});
