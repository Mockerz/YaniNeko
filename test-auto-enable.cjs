const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require(path.join(process.env.LOCALAPPDATA, "LefferzinBypass/Vencord/node_modules/esbuild"));
const source = fs.readFileSync(path.join(__dirname, "index.tsx"), "utf8");
const slice = source.slice(source.indexOf("let autoEnableTimer"), source.indexOf("async function checkRouteAutomatically"));
const code = esbuild.transformSync(slice + "\nthis.start = startAutoEnable; this.paused = () => autoEnablePaused;", { loader: "ts" }).code;
function fixture(results) {
    let now = 0, tick;
    const enables = [], toasts = [];
    const status = { state: "inactive", active: false };
    const context = {
        Date: { now: () => now },
        setInterval: fn => { tick = fn; return 1; }, clearInterval() {},
        Native: {
            getVpnStatus: async () => status,
            getProtonSettings: async () => ({ protonUsername: "user" }),
            enable: async (...args) => { enables.push(args); const result = results.shift() ?? { success: true }; if (result.success) Object.assign(status, { state: "active", active: true }); return result; },
        },
        showToast: (text, type) => toasts.push([text, type]),
        refreshPresenceStatus: async () => {}, startAutomaticRouteMonitor() {}, recordError() {},
    };
    vm.runInNewContext(code, context);
    context.start(() => true);
    return { enables, toasts, status, context, at: async ms => { now = ms; await tick(); } };
}
(async () => {
    let f = fixture([{ success: true }]);
    await f.at(1000); await f.at(3000);
    assert.equal(f.enables.length, 0, "waits ~3s of inactivity first");
    await f.at(5000);
    assert.deepEqual(f.enables, [[false, true]], "automatic enable respects the broken-route marker");
    await f.at(7000); assert.equal(f.enables.length, 1, "active VPN is left alone");

    f = fixture([{ success: false, error: "UAC_CANCELLED: cancelado" }]);
    await f.at(1000); await f.at(5000);
    assert.equal(f.enables.length, 1);
    assert.equal(f.context.paused(), true);
    for (const t of [20_000, 60_000, 400_000]) await f.at(t);
    assert.equal(f.enables.length, 1, "a refused UAC is never re-prompted automatically");

    f = fixture([{ success: false, error: "falhou" }, { success: false, error: "falhou" }, { success: true }]);
    await f.at(1000); await f.at(5000);
    await f.at(10_000); assert.equal(f.enables.length, 1, "backoff after a failure");
    await f.at(20_000); assert.equal(f.enables.length, 2);
    await f.at(40_000); assert.equal(f.enables.length, 2, "backoff doubles");
    await f.at(51_000); assert.equal(f.enables.length, 3);
    assert.equal(f.toasts.length, 1, "only the first failure is announced");
    console.log("PASS: re-enable after 3s inactive, broken-route aware, UAC refusal pauses, exponential backoff, single toast");
})().catch(error => { console.error(error); process.exitCode = 1; });
