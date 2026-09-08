import { Logger } from "@utils/Logger";
import { Activity, ActivityAssets } from "@vencord/discord-types";
import { ActivityType } from "@vencord/discord-types/enums";
import { FluxDispatcher } from "@webpack/common";

const APPLICATION_ID = "1545534815468658789";
const SOCKET_ID = "LefferzinBypass";
const ACTIVITY_NAME = "Leffer (˶>⩊<˶)";
const LARGE_IMAGE_KEY = "leffer-bypass";
const logger = new Logger("LefferzinBypass Presence");

let discordPresenceStartedAt: number | null = null;
let setIntervalHandle: ReturnType<typeof setInterval> | null = null;
let lastActivitySnapshot: Activity | null = null;
let active = false;

function buildActivity(): Activity {
    const start = discordPresenceStartedAt ?? Date.now();
    const activity: any = {
        application_id: APPLICATION_ID,
        name: ACTIVITY_NAME,
        type: ActivityType.PLAYING,
        details: "Bypass de Tela/Cam",
        state: "Fdc a putinha da Janja",
        timestamps: { start },
        assets: {
            large_image: LARGE_IMAGE_KEY,
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

export function startPresence(): void {
    if (active) {
        dispatch(buildActivity());
        return;
    }
    active = true;
    discordPresenceStartedAt = Date.now();
    const a = buildActivity();
    logger.info("Ligando presence com application_id", APPLICATION_ID, "asset", LARGE_IMAGE_KEY);
    dispatch(a);
    setIntervalHandle = setInterval(() => {
        if (!active) return;
        dispatch(buildActivity());
    }, 45000);
}

export function stopPresence(): void {
    active = false;
    if (setIntervalHandle) {
        clearInterval(setIntervalHandle);
        setIntervalHandle = null;
    }
    if (lastActivitySnapshot) {
        dispatch(null);
    }
    discordPresenceStartedAt = null;
    lastActivitySnapshot = null;
}
