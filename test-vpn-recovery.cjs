const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require(path.join(process.env.LOCALAPPDATA, "LefferzinBypass/Vencord/node_modules/esbuild"));
const source = fs.readFileSync(path.join(__dirname, "vpn-controller.ts"), "utf8");
const code = esbuild.transformSync(source, { loader: "ts", format: "cjs" }).code;
function fixture() {
    const timers = new Set();
    let tick;
    const windows = { inspectWireSockAsync: async () => ({ active: false, owned: true, foreignRegisteredServices: [] }) };
    const module = { exports: {} };
    const context = {
        module, exports: module.exports, process: { platform: "win32", pid: 123, kill() {} },
        require(name) {
            if (name === "electron") return { app: {} };
            if (name === "./vpn-proton") return {};
            if (name === "./vpn-windows") return windows;
            if (name === "./vpn-types") return { safeDiagnosticDetail: String };
            return require(name);
        },
        setTimeout(fn, delay) { const timer = { fn, delay, unref() {} }; timers.add(timer); return timer; },
        clearTimeout(timer) { timers.delete(timer); },
        setInterval(fn) { tick = fn; return { unref() {} }; }, clearInterval() {},
    };
    vm.runInNewContext(code, context);
    let enabled = true;
    const c = new module.exports.PluginVpnController({ dataDir: __dirname, guiDataDir: __dirname, isEnabled: () => enabled, log() {} });
    c.readOwner = () => null;
    const calls = [];
    c.stopInternal = async () => { calls.push("stop"); c.stopWatchdog(); return { success: true }; };
    c.startInternal = async relaunch => { calls.push(["start", relaunch]); c.state = "active"; return { success: true }; };
    async function fire() {
        const timer = [...timers][0]; assert.ok(timer); timers.delete(timer); timer.fn(); await c.operationQueue;
        return timer.delay;
    }
    return { c, windows, timers, calls, fire, disable() { enabled = false; }, tick: () => tick() };
}
(async () => {
    let f = fixture();
    f.c.state = "active"; f.c.startWatchdog();
    const watchdog = f.tick();
    for (let i = 0; i < 5; i++) { await new Promise(setImmediate); assert.equal(await f.fire(), 1000); }
    await watchdog;
    assert.equal(f.c.state, "recovery_required");
    assert.equal(await f.fire(), 5000);
    assert.deepEqual(f.calls, ["stop", ["start", false]]);
    assert.equal(f.c.state, "active"); assert.equal(f.timers.size, 0);

    f = fixture(); f.c.startInternal = async () => ({ success: false, state: "inactive" });
    f.c.scheduleRecovery(0);
    for (const delay of [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000]) {
        assert.equal(await f.fire(), delay); assert.equal(f.c.state, "recovery_required");
    }
    f.c.stopWatchdog(); assert.equal(f.timers.size, 0);

    f = fixture(); f.c.scheduleRecovery(0);
    const stale = [...f.timers][0]; f.c.stopWatchdog(); stale.fn(); await f.c.operationQueue;
    assert.deepEqual(f.calls, []);

    f = fixture(); f.c.scheduleRecovery(0); f.disable(); await f.fire(); assert.deepEqual(f.calls, []);
    for (const inspection of [
        { active: true, owned: false, foreignRegisteredServices: [] },
        { active: false, owned: false, foreignRegisteredServices: ["foreign"] },
    ]) {
        f = fixture(); f.windows.inspectWireSockAsync = async () => inspection;
        f.c.scheduleRecovery(0); await f.fire();
        assert.equal(f.c.state, "blocked_external"); assert.deepEqual(f.calls, []); assert.equal(f.timers.size, 0);
    }
    f = fixture(); f.c.readOwner = () => ({ pid: 456 }); f.c.scheduleRecovery(0); await f.fire();
    assert.equal(f.c.state, "blocked_external"); assert.deepEqual(f.calls, []);

    f = fixture(); f.windows.inspectWireSockAsync = async () => { throw new Error("query failed"); };
    f.c.scheduleRecovery(0); await f.fire(); assert.equal([...f.timers][0].delay, 10000);
    console.log("PASS: watchdog recovery, retry backoff/cap, cancellation, disabled plugin, external ownership, other instance, query failure");
})();