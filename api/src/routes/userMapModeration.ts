import type { Express, Request, Response } from "express";
import config from "../config";
import {
    UserMapDomainError,
    approveUserMap,
    createUserMap,
    getAccountModerationAccess,
    getUserMapForViewer,
    getUserMapModerationPreview,
    grantMapModerator,
    isRootGameDataAdmin,
    listMapModerators,
    listModerationQueue,
    listOwnUserMaps,
    listPublicPublishedUserMaps,
    proposeUserMap,
    rejectUserMap,
    reportPublishedUserMap,
    resolveMapAccountByToken,
    revokeMapModerator,
    startUserMapReview,
    unpublishUserMap,
    updateUserMap,
    type AccountModerationAccess,
    type MapAuthenticatedAccount,
    type MapViewerContext,
} from "../repositories/userMaps";

function getBearerToken(request: Request): string {
    const authorization = request.header("Authorization") || "";
    return authorization.startsWith("Bearer ")
        ? authorization.slice(7).trim()
        : "";
}

function getParamString(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
        return value[0] ?? "";
    }
    return value ?? "";
}

async function requireAuthenticatedAccount(
    request: Request,
    response: Response,
): Promise<MapAuthenticatedAccount | null> {
    const token = getBearerToken(request);
    if (!token) {
        response.status(401).json({ error: "Unauthorized" });
        return null;
    }

    const account = await resolveMapAccountByToken(token);
    if (!account) {
        response.status(401).json({ error: "Unauthorized" });
        return null;
    }

    return account;
}

async function resolveViewerContext(
    request: Request,
): Promise<MapViewerContext> {
    const token = getBearerToken(request);
    if (!token) {
        return { accountId: null, isModerator: false };
    }

    const account = await resolveMapAccountByToken(token);
    if (!account) {
        return { accountId: null, isModerator: false };
    }

    const access = await getAccountModerationAccess(account);
    return {
        accountId: account.id,
        isModerator: access.isModerator,
    };
}

async function requireModerator(
    request: Request,
    response: Response,
): Promise<{
    account: MapAuthenticatedAccount;
    access: AccountModerationAccess;
} | null> {
    const account = await requireAuthenticatedAccount(request, response);
    if (!account) {
        return null;
    }

    const access = await getAccountModerationAccess(account);
    if (!access.isModerator) {
        response
            .status(403)
            .json({ error: "No autorizado para moderar mapas." });
        return null;
    }

    return { account, access };
}

async function requireRootModeratorAdmin(
    request: Request,
    response: Response,
): Promise<MapAuthenticatedAccount | null> {
    if (
        config.gameDataAdminProxyToken &&
        (request.header("x-game-data-admin-token")?.trim() || "") !==
            config.gameDataAdminProxyToken
    ) {
        response.status(403).json({ error: "No autorizado." });
        return null;
    }

    const account = await requireAuthenticatedAccount(request, response);
    if (!account) {
        return null;
    }

    if (!isRootGameDataAdmin(account)) {
        response.status(403).json({
            error: "Solo el administrador principal puede gestionar moderadores.",
        });
        return null;
    }

    return account;
}

function handleRouteError(response: Response, error: unknown): void {
    if (error instanceof UserMapDomainError) {
        response.status(error.statusCode).json({
            error: error.message,
            ...(error.details !== undefined ? { details: error.details } : {}),
        });
        return;
    }

    response.status(500).json({
        error: error instanceof Error ? error.message : "Unexpected error",
    });
}

export function registerUserMapModerationRoutes(app: Express): void {
    app.get("/user-maps", async (_request, response) => {
        try {
            const maps = await listPublicPublishedUserMaps();
            response.json({ maps });
        } catch (error) {
            handleRouteError(response, error);
        }
    });

    app.get("/user-maps/mine", async (request, response) => {
        try {
            const account = await requireAuthenticatedAccount(
                request,
                response,
            );
            if (!account) {
                return;
            }

            const maps = await listOwnUserMaps(account.id);
            response.json({ maps });
        } catch (error) {
            handleRouteError(response, error);
        }
    });

    app.post("/user-maps", async (request, response) => {
        try {
            const account = await requireAuthenticatedAccount(
                request,
                response,
            );
            if (!account) {
                return;
            }

            const map = await createUserMap(account.id, request.body);
            response.status(201).json({ map });
        } catch (error) {
            handleRouteError(response, error);
        }
    });

    app.get("/user-maps/:mapId", async (request, response) => {
        try {
            const viewer = await resolveViewerContext(request);
            const map = await getUserMapForViewer(
                getParamString(request.params.mapId),
                viewer,
            );
            response.json({ map });
        } catch (error) {
            handleRouteError(response, error);
        }
    });

    app.put("/user-maps/:mapId", async (request, response) => {
        try {
            const account = await requireAuthenticatedAccount(
                request,
                response,
            );
            if (!account) {
                return;
            }

            const map = await updateUserMap(
                getParamString(request.params.mapId),
                account.id,
                request.body,
            );
            response.json({ map });
        } catch (error) {
            handleRouteError(response, error);
        }
    });

    app.post("/user-maps/:mapId/propose", async (request, response) => {
        try {
            const account = await requireAuthenticatedAccount(
                request,
                response,
            );
            if (!account) {
                return;
            }

            const result = await proposeUserMap(
                getParamString(request.params.mapId),
                account.id,
            );
            response.json(result);
        } catch (error) {
            handleRouteError(response, error);
        }
    });

    app.post("/user-maps/:mapId/report", async (request, response) => {
        try {
            const account = await requireAuthenticatedAccount(
                request,
                response,
            );
            if (!account) {
                return;
            }

            const result = await reportPublishedUserMap(
                getParamString(request.params.mapId),
                account.id,
                request.body?.reason,
            );
            response.status(201).json(result);
        } catch (error) {
            handleRouteError(response, error);
        }
    });

    app.get("/moderation/moderators", async (request, response) => {
        try {
            const admin = await requireRootModeratorAdmin(request, response);
            if (!admin) {
                return;
            }

            const moderators = await listMapModerators();
            response.json({ moderators });
        } catch (error) {
            handleRouteError(response, error);
        }
    });

    app.post("/moderation/moderators", async (request, response) => {
        try {
            const admin = await requireRootModeratorAdmin(request, response);
            if (!admin) {
                return;
            }

            const moderator = await grantMapModerator(request.body, admin.id);
            response.status(201).json({ moderator });
        } catch (error) {
            handleRouteError(response, error);
        }
    });

    app.delete(
        "/moderation/moderators/:accountId",
        async (request, response) => {
            try {
                const admin = await requireRootModeratorAdmin(
                    request,
                    response,
                );
                if (!admin) {
                    return;
                }

                await revokeMapModerator(
                    getParamString(request.params.accountId),
                );
                response.json({ ok: true });
            } catch (error) {
                handleRouteError(response, error);
            }
        },
    );

    app.get("/moderation/maps/queue", async (request, response) => {
        try {
            const moderator = await requireModerator(request, response);
            if (!moderator) {
                return;
            }

            const rawState =
                typeof request.query.state === "string"
                    ? request.query.state.trim()
                    : undefined;

            const maps = await listModerationQueue(
                rawState as "proposed" | "in_review" | undefined,
            );
            response.json({ maps });
        } catch (error) {
            handleRouteError(response, error);
        }
    });

    app.get("/moderation/maps/:mapId/preview", async (request, response) => {
        try {
            const moderator = await requireModerator(request, response);
            if (!moderator) {
                return;
            }

            const preview = await getUserMapModerationPreview(
                getParamString(request.params.mapId),
            );
            response.json({ preview });
        } catch (error) {
            handleRouteError(response, error);
        }
    });

    app.post("/moderation/maps/:mapId/review", async (request, response) => {
        try {
            const moderator = await requireModerator(request, response);
            if (!moderator) {
                return;
            }

            const map = await startUserMapReview(
                getParamString(request.params.mapId),
                moderator.account.id,
            );
            response.json({ map });
        } catch (error) {
            handleRouteError(response, error);
        }
    });

    app.post("/moderation/maps/:mapId/approve", async (request, response) => {
        try {
            const moderator = await requireModerator(request, response);
            if (!moderator) {
                return;
            }

            const map = await approveUserMap(
                getParamString(request.params.mapId),
                moderator.account.id,
                moderator.access.isRootAdmin,
            );
            response.json({ map });
        } catch (error) {
            handleRouteError(response, error);
        }
    });

    app.post("/moderation/maps/:mapId/reject", async (request, response) => {
        try {
            const moderator = await requireModerator(request, response);
            if (!moderator) {
                return;
            }

            const map = await rejectUserMap(
                getParamString(request.params.mapId),
                moderator.account.id,
                request.body?.reason,
                moderator.access.isRootAdmin,
            );
            response.json({ map });
        } catch (error) {
            handleRouteError(response, error);
        }
    });

    app.post("/moderation/maps/:mapId/unpublish", async (request, response) => {
        try {
            const moderator = await requireModerator(request, response);
            if (!moderator) {
                return;
            }

            const map = await unpublishUserMap(
                getParamString(request.params.mapId),
                moderator.account.id,
                request.body?.reason,
            );
            response.json({ map });
        } catch (error) {
            handleRouteError(response, error);
        }
    });
}
