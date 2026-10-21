const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const esbuild = require(path.join(process.env.LOCALAPPDATA, "LefferzinBypass/Vencord/node_modules/esbuild"));
const text = fs.readFileSync("vpn-windows.ts", "utf8");
const source = text.slice(text.indexOf("export async function stopOwnedWireSock"), text.indexOf("function isWireSockProcessAliveGlobal"));
const code = esbuild.transformSync(source, { loader: "ts", format: "cjs" }).code;
async function run(disappears, foreign = false) {
    let inspections = 0;
    const calls = [], mod = { exports: {} };
    vm.runInNewContext(code, {
        module: mod, exports: mod.exports, isWindows: () => true,
        inspectWireSock: () => { inspections++; return { active: !(disappears && inspections > 1), owned: !foreign, foreignRegisteredServices: foreign ? ["external"] : [], services: ["owned"], processIds: [123] }; },
        containsConfig: () => true, serviceCommand: () => "config", runAsAdministrator: () => true,
        wait: async ms => calls.push(["wait", ms]), killOwnProcesses: pids => { for (const pid of pids) calls.push(["kill", pid]); },
        findWireSockCandidate: () => null, clearWireSockDns: () => true, execFileSync() {}, logError: String,
    });
    const result = await mod.exports.stopOwnedWireSock("config", () => {});
    return { result, calls };
}
(async () => {
    let f = await run(false); assert.equal(f.result.stopped, false);
    assert.equal(f.calls.filter(c => c[0] === "kill").length, 1, "same PID is attempted only once, even after denial/failure");
    assert.deepEqual(f.calls[0], ["wait", 5000]);
    f = await run(true); assert.equal(f.result.stopped, true); assert.equal(f.calls.filter(c => c[0] === "kill").length, 0);
    f = await run(false, true); assert.equal(f.result.stopped, false); assert.equal(f.calls.length, 0);
    console.log("PASS: normal stop grace period, no taskkill after graceful stop, one attempt per PID, foreign process preserved");
})().catch(error => { console.error(error); process.exitCode = 1; });
