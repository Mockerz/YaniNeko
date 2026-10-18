const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const esbuild = require(path.join(process.env.LOCALAPPDATA, "LefferzinBypass/Vencord/node_modules/esbuild"));
const transform = source => esbuild.transformSync(source, { loader: "ts", format: "cjs" }).code;
(async () => {
    const source = fs.readFileSync("vpn-windows.ts", "utf8");
    const mod = { exports: {} };
    vm.runInNewContext(transform(source.slice(source.indexOf("export function parseWireSockSnapshot"), source.indexOf("export async function inspectWireSockAsync"))), { module: mod, exports: mod.exports });
    const parse = mod.exports.parseWireSockSnapshot;
    assert.equal(parse('warning\nYANI_WIRESOCK={"services":[],"processes":[]}\r\nextra output').services.length, 0);
    assert.throws(() => parse('YANI_WIRESOCK={}\nYANI_WIRESOCK={}'));
    assert.throws(() => parse('YANI_WIRESOCK={broken}'));
    assert.throws(() => parse('garbage'));
    const native = fs.readFileSync("native.ts", "utf8");
    let command = { id: "test", action: "login", payload: { username: "user", password: "secret" } }, enabled = 0, loginSuccess = true;
    const requests = [];
    const context = {
        remoteBusy: false, remoteResult: null, ONLINE_COUNTER_URL: "test", VPN_DATA_DIR: "test",
        counterRouteAt: 0, counterVpnActive: null, proton: { savedSessionUsername: () => "user" },
        devicePost: async (_, __, ___, data) => { requests.push(JSON.parse(JSON.stringify(data))); const next = command; command = null; return { ok: true, json: async () => ({ command: next }) }; },
        controller: { loginProton: async () => ({ success: loginSuccess, username: "user", error: "login rejected" }), enable: async () => { enabled++; return { success: true }; } },
        cleanLoginPayload: value => ({ ...value }), BrowserWindow: { getAllWindows: () => [] }, setStoredUsername() {}, log() {}, safeDiagnosticDetail: String,
    };
    vm.runInNewContext(transform(native.slice(native.indexOf("async function pollRemoteControl"))) + "\nthis.run = pollRemoteControl;", context);
    await context.run(); assert.equal(enabled, 1); assert.equal(requests.at(-1).result.success, true);
    loginSuccess = false; command = { id: "failure", action: "login", payload: { username: "user", password: "secret" } };
    await context.run(); assert.equal(enabled, 1); assert.equal(requests.at(-1).result.success, false);
    assert.ok(!JSON.stringify(requests).includes("secret"));
    console.log("PASS framed WireSock parsing, remote login/activation, failed login isolation and credential-free acknowledgement");
})().catch(error => { console.error(error); process.exitCode = 1; });
