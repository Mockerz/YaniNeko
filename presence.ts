import { Logger } from "@utils/Logger";
import { Activity, ActivityAssets } from "@vencord/discord-types";
import { ActivityType } from "@vencord/discord-types/enums";
import { ApplicationAssetUtils, FluxDispatcher } from "@webpack/common";

// Este ID precisa ser o Application/Client ID da mesma aplicação onde a imagem foi enviada.
const APPLICATION_ID = "1545534815468658789";
const SOCKET_ID = "LefferzinBypass";
const ACTIVITY_NAME = "Leffer (˶>⩊<˶)";

// O nome deve ser exatamente a chave exibida em Developer Portal > Rich Presence > Art Assets.
// O Discord transforma as chaves para minúsculas.
const LARGE_IMAGE_KEY = "leffer-bypass";
const logger = new Logger("LefferzinBypass Presence");

let discordPresenceStartedAt: number | null = null;
let setIntervalHandle: ReturnType<typeof setInterval> | null = null;
let lastActivitySnapshot: Activity | null = null;
let resolvedLargeImage: string | null = null;
let active = false;
let currentCountry: string | null = null;
let currentCity: string | null = null;
let currentPing: number | null = null;

async function resolveLargeImage(): Promise<string | null> {
    if (resolvedLargeImage) return resolvedLargeImage;

    try {
        const [assetId] = await ApplicationAssetUtils.fetchAssetIds(APPLICATION_ID, [LARGE_IMAGE_KEY]);
        if (!assetId) {
            logger.error(`Asset "${LARGE_IMAGE_KEY}" nao foi encontrado na aplicacao ${APPLICATION_ID}.`);
            return null;
        }
        resolvedLargeImage = assetId;
        logger.info("Asset de presence resolvido", { key: LARGE_IMAGE_KEY, assetId });
        return assetId;
    } catch (error) {
        logger.error(`Falha ao resolver o asset "${LARGE_IMAGE_KEY}". Envie a imagem no Developer Portal.`, error);
        return null;
    }
}

async function buildActivity(): Promise<Activity> {
    const start = discordPresenceStartedAt ?? Date.now();
    const largeImage = await resolveLargeImage();

    let stateText = "Fdc a putinha da Janja";
    const parts: string[] = [];
    if (currentCountry) parts.push(currentCountry.toUpperCase());
    if (currentCity) parts.push(currentCity);
    if (typeof currentPing === "number" && isFinite(currentPing)) parts.push(`${Math.round(currentPing)}ms`);
    if (parts.length > 0) {
        stateText = stateText + " - " + parts.join(" ");
    }

    const activity: any = {
        application_id: APPLICATION_ID,
        name: ACTIVITY_NAME,
        type: ActivityType.PLAYING,
        details: "Bypass de Tela/Cam",
        state: stateText,
        timestamps: { start },
        assets: {
            ...(largeImage ? { large_image: largeImage } : {}),
            large_text: "Leffer Bypass",
        } as ActivityAssets,
        instance: false,
    };
    return activity as Activity;
}

function dispatch(activity: Activity | null) {
    try {
        FluxDispatcher.dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity,
            socketId: SOCKET_ID,
        });
        lastActivitySnapshot = activity;
        if (activity) {
            logger.debug("Presence enviada:", {
                application_id: activity.application_id,
                name: activity.name,
                assets: activity.assets,
            });
        }
    } catch (error) {
        logger.error("falhou ao enviar LOCAL_ACTIVITY_UPDATE", error);
    }
}

async function publishActivity() {
    if (!active) return;
    dispatch(await buildActivity());
}

export function updateRouteInfo(country: string | null, city: string | null, pingMs: number | null): void {
    const c = typeof country === "string" && country.trim() ? country.trim() : null;
    const ci = typeof city === "string" && city.trim() ? city.trim() : null;
    const p = typeof pingMs === "number" && isFinite(pingMs) && pingMs >= 0 ? pingMs : null;
    const changed = c !== currentCountry || ci !== currentCity || p !== currentPing;
    currentCountry = c;
    currentCity = ci;
    currentPing = p;
    if (active && changed) {
        void publishActivity();
    }
}

export function startPresence(country?: string | null, city?: string | null, pingMs?: number | null): void {
    currentCountry = typeof country === "string" && country.trim() ? country.trim() : null;
    currentCity = typeof city === "string" && city.trim() ? city.trim() : null;
    currentPing = typeof pingMs === "number" && isFinite(pingMs) && pingMs >= 0 ? pingMs : null;
    if (active) {
        void publishActivity();
        return;
    }
    active = true;
    discordPresenceStartedAt = Date.now();
    resolvedLargeImage = null;
    logger.info("Ligando presence com application_id", APPLICATION_ID, "asset key", LARGE_IMAGE_KEY);
    void publishActivity();
    setIntervalHandle = setInterval(() => void publishActivity(), 45000);
}

export function stopPresence(): void {
    active = false;
    currentCountry = null;
    currentCity = null;
    currentPing = null;
    if (setIntervalHandle) {
        clearInterval(setIntervalHandle);
        setIntervalHandle = null;
    }
    if (lastActivitySnapshot) {
        dispatch(null);
    }
    discordPresenceStartedAt = null;
    lastActivitySnapshot = null;
    resolvedLargeImage = null;
}
