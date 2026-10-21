const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require(path.join(process.env.LOCALAPPDATA, "LefferzinBypass/Vencord/node_modules/esbuild"));
const source = fs.readFileSync(path.join(__dirname, "index.tsx"), "utf8");
const functions = source.slice(source.indexOf("function showToast("), source.indexOf("interface RegionStore"))
    + source.slice(source.indexOf("let lastVpnNotification:"), source.indexOf("async function checkRouteAutomatically"));
const code = esbuild.transformSync(functions, { loader: "ts", format: "cjs" }).code;
function fixture() {
    const toasts = [], errors = [], timers = new Set();
    const context = {
        Date, Set, logger: { error() {} },
        UserStore: { getCurrentUser: () => ({ username: "joao123" }) },
        Native: {
            setReportUsername: async () => {},
            reportRendererError: async text => errors.push(text),
            getAutoUpdateNotifications: async () => []
        },
        discordShowToast: data => {
            assert.equal(typeof data, "object", "Discord expects ToastData, not positional arguments");
            assert.equal(typeof data.text, "string");
            assert.ok(["default", "success", "critical"].includes(data.variant));
            toasts.push(data);
        },
        setInterval: fn => { timers.add(fn); return fn; },
        clearInterval: fn => timers.delete(fn)
    };
    vm.runInNewContext(code, context);
    return { context, toasts, errors, timers };
}
(async () => {
    let f = fixture();
    for (const type of ["message", "success", "failure"]) f.context.showToast(type, type);
    assert.deepEqual(f.toasts.map(t => t.variant), ["default", "success", "critical"]);
    assert.equal(f.errors.length, 1);
    // Reporting is optional: older native helpers and IPC failures cannot hide the toast.
    f.context.Native = {};
    f.context.showToast("old native", "failure");
    f.context.Native = { setReportUsername() { throw Error("IPC unavailable"); }, reportRendererError() { throw Error("IPC unavailable"); } };
    f.context.showToast("IPC unavailable", "failure");
    f.context.Native = undefined;
    f.context.showToast("no native", "failure");
    assert.equal(f.toasts.length, 6);

    f = fixture();
    const active = { state: "active", active: true, routeId: "US-1" };
    f.context.notifyVpnStatus(active);
    f.context.notifyVpnStatus(active);
    assert.equal(f.toasts.length, 1, "unchanged VPN status must not repeat");
    f.context.notifyVpnStatus({ state: "recovery_required", active: false, routeId: "US-1", message: "limpeza incompleta" });
    assert.equal(f.toasts.at(-1).variant, "critical");
    assert.match(f.toasts.at(-1).text, /limpeza incompleta/);
    assert.ok(!f.toasts.at(-1).text.includes("rede normal"));
    f.context.notifyVpnStatus(active);
    f.context.notifyVpnStatus({ state: "inactive", active: false });
    assert.equal(f.toasts.at(-1).text, "VPN desconectada.");

    f = fixture();
    let current = true;
    f.context.Native.getAutoUpdateNotifications = async () => ["checking", "available", "ready", "error", "restart_delayed"].map((phase, i) => ({ id: String(i), at: Date.now(), phase }));
    f.context.startUpdateNotifications(() => current);
    await new Promise(setImmediate);
    assert.equal(f.toasts.length, 5);
    assert.match(f.toasts.at(-1).text, /nova tentativa em 1 minuto/);
    const tick = [...f.timers][0];
    await tick(); assert.equal(f.toasts.length, 5, "same event IDs must not repeat");
    current = false; await tick(); assert.equal(f.toasts.length, 5);

    f = fixture();
    let resolve;
    current = true;
    f.context.Native.getAutoUpdateNotifications = () => new Promise(r => { resolve = r; });
    f.context.startUpdateNotifications(() => current);
    current = false;
    resolve([{ id: "late", phase: "error" }]);
    await new Promise(setImmediate);
    assert.equal(f.toasts.length, 0, "late IPC result after stop must not notify");
    console.log("PASS: Discord toast contract, variants, optional reporting, VPN failure priority, deduplication, stopped plugin and late IPC results");
})().catch(error => { console.error(error); process.exitCode = 1; });
