import config from "../config";

export type GameServerReloadNotificationResult = {
    notified: boolean;
    status?: number;
    error?: string;
};

const GAME_SERVER_NOTIFY_TIMEOUT_MS = 3000;

export async function notifyGameServerMapReload(
    mapNum: number,
    version: number,
    options?: {
        baseUrl?: string;
        tokenAuth?: string;
        timeoutMs?: number;
    },
): Promise<GameServerReloadNotificationResult> {
    const baseUrl = (
        options?.baseUrl ?? config.gameServerInternalUrl
    ).replace(/\/+$/, "");

    if (!baseUrl) {
        return {
            notified: false,
            error: "GAME_SERVER_INTERNAL_URL no configurado",
        };
    }

    const tokenAuth = options?.tokenAuth ?? config.tokenAuth;
    const timeoutMs = options?.timeoutMs ?? GAME_SERVER_NOTIFY_TIMEOUT_MS;
    const targetUrl = `${baseUrl}/internal/maps/${mapNum}/reload`;

    try {
        const response = await fetch(targetUrl, {
            method: "POST",
            headers: {
                Authorization: tokenAuth,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ mapNum, version }),
            signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            const errorMessage = detail
                ? `HTTP ${response.status}: ${detail}`
                : `HTTP ${response.status}`;
            console.warn(
                `[API] No se pudo sincronizar mapa ${mapNum} (v${version}) en el game server: ${errorMessage}`,
            );
            return {
                notified: false,
                status: response.status,
                error: errorMessage,
            };
        }

        return {
            notified: true,
            status: response.status,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
            `[API] Game server no disponible al notificar recarga de mapa ${mapNum} (v${version}): ${message}`,
        );
        return {
            notified: false,
            error: message,
        };
    }
}
