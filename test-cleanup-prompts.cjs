const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const esbuild = require(path.join(process.env.LOCALAPPDATA, "LefferzinBypass/Vencord/node_modules/esbuild"));
const text = fs.readFileSync("vpn-windows.ts", "utf8");
const source = text.slice(text.indexOf("const wait = (ms: number)"), text.indexOf("function nuclearScript("));
const code = esbuild.transformSync(source, { loader: "ts", format: "cjs" }).code;
async function run({ initial, after, elevation = async () => "" }) {
    const scripts = [], mod = { exports: {} };
    let elevated = false;
    vm.runInNewContext(code, {
        module: mod, exports: mod.exports, path, setTimeout: fn => setImmediate(fn),
        isWindows: () => true, logError: String, quotePowerShell: value => `'${value.replace(/'/g, "''")}'`,
        WIRESOCK_SERVICE_NAME: "wiresock-client-service", WIRESOCK_DNS_RESET: "# dns",
        findWireSockCandidate: async () => ({ executable: "C:\\WireSock\\wiresock-client.exe" }),
        inspectWireSockAsync: async () => (elevated ? after : initial),
        runElevatedPowerShell: async script => { scripts.push(script); elevated = true; return elevation(); },
    });
    const result = await mod.exports.stopOwnedWireSock("C:\\data\\wiresock-discord.conf", () => {});
    return { result, scripts };
}
const owned = { active: true, owned: true, foreignRegisteredServices: [], services: ["wiresock-client-service"], processIds: [123] };
const stopped = { active: false, owned: false, foreignRegisteredServices: [], services: [], processIds: [] };
(async () => {
    let f = await run({ initial: owned, after: stopped });
    assert.equal(f.result.stopped, true);
    assert.equal(f.scripts.length, 1, "a normal stop asks for elevation exactly once");
    const script = f.scripts[0];
    assert.ok(script.indexOf("Stop-Service") < script.indexOf("StartupType Disabled"), "clean SCM stop comes first");
    assert.ok(script.indexOf("StartupType Disabled") < script.indexOf("Stop-Process"), "service is disabled before a kill so SCM recovery cannot restart it");
    assert.match(script, /wiresock-discord\.conf/);
    assert.ok(!/taskkill/i.test(script));
    assert.ok(!/ProTUN/.test(script), "Proton's own adapter is not touched");

    f = await run({ initial: owned, after: owned });
    assert.equal(f.result.stopped, false); assert.equal(f.scripts.length, 1);

    f = await run({ initial: owned, after: owned, elevation: async () => { throw Object.assign(new Error("UAC_CANCELLED: cancelado"), { code: "UAC_CANCELLED" }); } });
    assert.equal(f.result.stopped, false); assert.match(f.result.error, /UAC_CANCELLED/); assert.equal(f.scripts.length, 1);

    f = await run({ initial: stopped, after: stopped });
    assert.equal(f.result.stopped, true); assert.equal(f.scripts.length, 0, "nothing running means no UAC prompt");

    f = await run({ initial: { ...owned, owned: false }, after: stopped });
    assert.equal(f.result.stopped, false); assert.equal(f.scripts.length, 0);
    f = await run({ initial: { ...stopped, foreignRegisteredServices: ["external"] }, after: stopped });
    assert.equal(f.result.stopped, false); assert.equal(f.scripts.length, 0);
    console.log("PASS: single elevation per stop, SCM stop before kill, service disabled before kill, UAC refusal reported, no prompt when idle, foreign WireSock preserved");
})().catch(error => { console.error(error); process.exitCode = 1; });
