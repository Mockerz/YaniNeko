const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require(path.join(process.env.LOCALAPPDATA, "LefferzinBypass/Vencord/node_modules/esbuild"));
const native = fs.readFileSync(path.join(__dirname, "native.ts"), "utf8");
const source = native.slice(native.indexOf("function startAutomaticUpdateRestart():"), native.indexOf('app.on("before-quit"'));
const code = esbuild.transformSync(source, { loader: "ts", format: "cjs" }).code;
function fixture(result = { success: true }) {
    const calls = [];
    let tick, now = 0;
    const data = { active: { pid: 123, active: "b".repeat(40) }, pending: { id: "a".repeat(40) } };
    const context = {
        __dirname: __dirname, join: path.join, dirname: path.dirname,
        process: { pid: 123 }, Date: { now: () => now }, quitting: false,
        existsSync: () => true,
        readFileSync: file => JSON.stringify(file.endsWith("active.json") ? data.active : data.pending),
        controller: { isRelaunching: () => false, shutdown: async (...args) => { calls.push(["shutdown", ...args]); return result; } },
        app: { relaunch() { calls.push("relaunch"); }, exit(code) { calls.push(["exit", code]); } },
        log() {}, safeDiagnosticDetail: String,
        setInterval(fn) { tick = fn; return { unref() {} }; },
    };
    vm.runInNewContext(code + "\nstartAutomaticUpdateRestart();", context);
    return { calls, data, context, tick: () => tick(), time: value => { now = value; } };
}
(async () => {
    let f = fixture();
    await f.tick(); f.time(9999); await f.tick(); assert.equal(f.calls.length, 0);
    f.time(10000); await f.tick();
    assert.deepEqual(f.calls, [["shutdown", false, false], "relaunch", ["exit", 0]]);
    await f.tick(); assert.equal(f.calls.length, 3);

    f = fixture({ success: false, state: "recovery_required", error: "cleanup failed" });
    await f.tick(); f.time(10000); await f.tick();
    assert.deepEqual(f.calls, [["shutdown", false, false]]);
    assert.equal(f.context.quitting, false);
    f.time(69999); await f.tick(); assert.equal(f.calls.length, 1);
    f.time(70000); await f.tick(); assert.equal(f.calls.length, 2);

    f = fixture({ success: false, state: "blocked_external" });
    await f.tick(); f.time(10000); await f.tick(); assert.equal(f.calls[1], "relaunch");

    f = fixture(); f.data.active.pid = 456;
    await f.tick(); f.time(20000); await f.tick(); assert.equal(f.calls.length, 0);

    f = fixture(); await f.tick(); f.data.pending = null;
    f.time(10000); await f.tick(); assert.equal(f.calls.length, 0);

    f = fixture(); await f.tick();
    f.context.controller.shutdown = async () => { f.data.pending = null; return { success: true }; };
    f.time(10000); await f.tick(); assert.equal(f.calls.length, 0); assert.equal(f.context.quitting, false);
    console.log("PASS: automatic restart delay, VPN cleanup ordering, retry on failure, duplicate prevention, ownership, pending cancellation");
})().catch(error => { console.error(error); process.exitCode = 1; });