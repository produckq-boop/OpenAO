import express from "express";
import { MAX_PNG_BYTES } from "../lib/pngValidation";
import {
    isUserMapId,
    USER_MAP_ID_END,
    USER_MAP_ID_START,
} from "../lib/userMapIsolation";
import {
    createUserMap,
    getDefaultUserMapQuotas,
    getUserMapClientPayloadForViewer,
    getUserMapForViewer,
    listAccountUserMaps,
    listPublicUserMaps,
    transitionUserMapStatus,
    transitionUserMapStatusSchema,
    updateUserMap,
    uploadUserMapGraphic,
    type UserMapDependencies,
    UserMapError,
} from "../repositories/userMaps";

export type ResolvedUserMapSession = {
    accountId: string;
    isAdmin: boolean;
};

export type CreateUserMapsRouterOptions = {
    resolveSession: (
        request: express.Request,
    ) => Promise<ResolvedUserMapSession | null>;
    repositoryDeps?: UserMapDependencies;
};

function parseMapNumParam(raw: string | string[] | undefined): number | null {
    const text = Array.isArray(raw) ? raw[0] : raw;
    if (typeof text !== "string" || !/^\d+$/.test(text.trim())) {
        return null;
    }
    const parsed = Number.parseInt(text.trim(), 10);
    return isUserMapId(parsed) ? parsed : null;
}

function sendUserMapError(
    response: express.Response,
    error: unknown,
): void {
    if (error instanceof UserMapError) {
        response.status(error.statusCode).json({
            error: error.message,
            code: error.code,
        });
        return;
    }

    const message =
        error instanceof Error ? error.message : "Error inesperado.";
    response.status(400).json({ error: message });
}

export function createUserMapsRouter(
    options: CreateUserMapsRouterOptions,
): express.Router {
    const router = express.Router();
    const deps = options.repositoryDeps ?? {};

    router.get("/user-maps/quotas", (_request, response) => {
        const quotas = {
            ...getDefaultUserMapQuotas(),
            ...deps.quotas,
        };
        response.json({
            range: {
                start: USER_MAP_ID_START,
                end: USER_MAP_ID_END,
            },
            combatEnabled: false,
            quotas,
        });
    });

    router.get("/user-maps", async (request, response) => {
        try {
            const rawLimit =
                typeof request.query.limit === "string"
                    ? Number.parseInt(request.query.limit, 10)
                    : 50;
            const limit =
                Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50;
            const maps = await listPublicUserMaps(limit, deps);
            response.json({ maps });
        } catch (error) {
            sendUserMapError(response, error);
        }
    });

    router.get("/user-maps/mine", async (request, response) => {
        try {
            const session = await options.resolveSession(request);
            if (!session) {
                response.status(401).json({ error: "Unauthorized" });
                return;
            }

            const maps = await listAccountUserMaps(session.accountId, deps);
            response.json({ maps });
        } catch (error) {
            sendUserMapError(response, error);
        }
    });

    router.post("/user-maps", async (request, response) => {
        try {
            const session = await options.resolveSession(request);
            if (!session) {
                response.status(401).json({ error: "Unauthorized" });
                return;
            }

            const created = await createUserMap(
                session.accountId,
                request.body ?? {},
                deps,
            );
            response.status(201).json({ map: created });
        } catch (error) {
            sendUserMapError(response, error);
        }
    });

    router.post(
        "/user-maps/graphics",
        express.raw({
            type: ["image/png", "application/octet-stream"],
            limit: MAX_PNG_BYTES,
        }),
        async (request, response) => {
            try {
                const session = await options.resolveSession(request);
                if (!session) {
                    response.status(401).json({ error: "Unauthorized" });
                    return;
                }

                if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
                    response.status(400).json({
                        error: "Enviá el archivo PNG crudo con Content-Type: image/png.",
                        code: "INVALID_PNG",
                    });
                    return;
                }

                const uploaded = await uploadUserMapGraphic(
                    request.body,
                    session.accountId,
                    deps,
                );
                response.status(uploaded.deduped ? 200 : 201).json({
                    grhIndex: uploaded.graphic.grhIndex,
                    width: uploaded.graphic.width,
                    height: uploaded.graphic.height,
                    byteSize: uploaded.graphic.byteSize,
                    deduped: uploaded.deduped,
                    totalAccountUploadBytes: uploaded.totalAccountUploadBytes,
                    url: `/game-data/graphics/${uploaded.graphic.grhIndex}.png`,
                });
            } catch (error) {
                sendUserMapError(response, error);
            }
        },
    );

    router.get("/user-maps/:mapNum/map-data", async (request, response) => {
        try {
            const mapNum = parseMapNumParam(request.params.mapNum);
            if (!mapNum) {
                response.status(400).json({
                    error: `El número de mapa debe pertenecer al rango reservado de mapas de usuario (${USER_MAP_ID_START}..${USER_MAP_ID_END}).`,
                    code: "INVALID_USER_MAP_RANGE",
                });
                return;
            }

            let viewerAccountId: string | null = null;
            let isAdmin = false;
            try {
                const session = await options.resolveSession(request);
                if (session) {
                    viewerAccountId = session.accountId;
                    isAdmin = session.isAdmin;
                }
            } catch {
                // Visitante sin sesión válida: sólo accede si el mapa está publicado.
            }

            const payload = await getUserMapClientPayloadForViewer(
                mapNum,
                viewerAccountId,
                { isAdmin, deps },
            );

            if (!payload) {
                response.status(404).json({
                    error: "Mapa de usuario no encontrado o no disponible.",
                    code: "MAP_NOT_FOUND",
                });
                return;
            }

            response.json(payload);
        } catch (error) {
            sendUserMapError(response, error);
        }
    });

    router.get("/user-maps/:mapNum", async (request, response) => {
        try {
            const mapNum = parseMapNumParam(request.params.mapNum);
            if (!mapNum) {
                response.status(400).json({
                    error: `El número de mapa debe pertenecer al rango reservado de mapas de usuario (${USER_MAP_ID_START}..${USER_MAP_ID_END}).`,
                    code: "INVALID_USER_MAP_RANGE",
                });
                return;
            }

            let viewerAccountId: string | null = null;
            let isAdmin = false;
            try {
                const session = await options.resolveSession(request);
                if (session) {
                    viewerAccountId = session.accountId;
                    isAdmin = session.isAdmin;
                }
            } catch {
                // Visitante público.
            }

            const record = await getUserMapForViewer(mapNum, viewerAccountId, {
                isAdmin,
                deps,
            });

            if (!record) {
                response.status(404).json({
                    error: "Mapa de usuario no encontrado o no disponible.",
                    code: "MAP_NOT_FOUND",
                });
                return;
            }

            response.json({ map: record });
        } catch (error) {
            sendUserMapError(response, error);
        }
    });

    router.put("/user-maps/:mapNum", async (request, response) => {
        try {
            const session = await options.resolveSession(request);
            if (!session) {
                response.status(401).json({ error: "Unauthorized" });
                return;
            }

            const mapNum = parseMapNumParam(request.params.mapNum);
            if (!mapNum) {
                response.status(400).json({
                    error: `El número de mapa debe pertenecer al rango reservado de mapas de usuario (${USER_MAP_ID_START}..${USER_MAP_ID_END}).`,
                    code: "INVALID_USER_MAP_RANGE",
                });
                return;
            }

            const updated = await updateUserMap(
                mapNum,
                session.accountId,
                request.body ?? {},
                deps,
            );
            response.json({ map: updated });
        } catch (error) {
            sendUserMapError(response, error);
        }
    });

    router.post("/user-maps/:mapNum/status", async (request, response) => {
        try {
            const session = await options.resolveSession(request);
            if (!session) {
                response.status(401).json({ error: "Unauthorized" });
                return;
            }

            const mapNum = parseMapNumParam(request.params.mapNum);
            if (!mapNum) {
                response.status(400).json({
                    error: `El número de mapa debe pertenecer al rango reservado de mapas de usuario (${USER_MAP_ID_START}..${USER_MAP_ID_END}).`,
                    code: "INVALID_USER_MAP_RANGE",
                });
                return;
            }

            const parsed = transitionUserMapStatusSchema.safeParse(
                request.body ?? {},
            );
            if (!parsed.success) {
                response.status(400).json({
                    error: "Estado de mapa inválido.",
                    code: "INVALID_STATUS",
                });
                return;
            }

            const updated = await transitionUserMapStatus(
                mapNum,
                session.accountId,
                parsed.data.status,
                {
                    isAdmin: session.isAdmin,
                    deps,
                },
            );
            response.json({ map: updated });
        } catch (error) {
            sendUserMapError(response, error);
        }
    });

    return router;
}
