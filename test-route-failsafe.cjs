const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require(path.join(process.env.LOCALAPPDATA, "LefferzinBypass/Vencord/node_modules/esbuild"));
const source = fs.readFileSync(path.join(__dirname, "vpn-controller.ts"), "utf8");
const code = esbuild.transformSync(source, { loader: "ts", format: "cjs" }).code;
function fixture(probeResults) {
    const probes = [...probeResults];
    const windows = { runRouteProbe: async () => probes.shift() ?? null };
    const module = { exports: {} };
    vm.runInNewContext(code, {
        module, exports: module.exports, process: { platform: "win32", pid: 123, execPath: "C:/Discord/Discord.exe", kill() {} },
        require(name) {
            if (name === "electron") return { app: {} };
            if (name === "./vpn-proton") return {};
            if (name === "./vpn-windows") return windows;
            if (name === "./vpn-types") return { safeDiagnosticDetail: String, normalizeVpnSettings: value => ({ ...value }) };
            return require(name);
        },
        setTimeout: fn => setImmediate(fn), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {},
    });
    const logs = [], calls = [];
    const c = new module.exports.PluginVpnController({ dataDir: __dirname, guiDataDir: __dirname, isEnabled: () => true, readSettings: () => ({ protonUsername: "user" }), log: (level, message) => logs.push([level, message]) });
    c.readOwner = () => ({ probePath: __filename });
    c.stopInternal = async () => { calls.push("stop"); c.state = "inactive"; return { success: true, state: "inactive" }; };
    c.state = "active";
    return { c, calls, logs };
}
(async () => {
    // Two explicit probe failures prove the tunnel carries nothing: only our session is stopped.
    let f = fixture([{ success: false, error: "nenhuma familia" }, { success: false, error: "nenhuma familia" }]);
    f.c.verifyAdoptedRoute("adoption"); await f.c.operationQueue;
    assert.deepEqual(f.calls, ["stop"]);

    // One failure followed by success (handshake still settling) keeps the VPN.
    f = fixture([{ success: false }, { success: true, discordOk: true }]);
    f.c.verifyAdoptedRoute("adoption"); await f.c.operationQueue;
    assert.deepEqual(f.calls, []);

    // IPv6 leaking direct reports success, but Discord unreachable through the tunnel is still a dead route.
    f = fixture([{ success: true, discordOk: false }, { success: true, discordOk: false }]);
    f.c.verifyAdoptedRoute("adoption"); await f.c.operationQueue;
    assert.deepEqual(f.calls, ["stop"]);

    // A broken/missing probe is not evidence: never tear down on unreadable output.
    f = fixture([null]);
    f.c.verifyAdoptedRoute("adoption"); await f.c.operationQueue;
    assert.deepEqual(f.calls, []);

    // A newer activation in the meantime must not be torn down by an old check.
    f = fixture([{ success: false }, { success: false }]);
    f.c.verifyAdoptedRoute("adoption"); f.c.generation++; await f.c.operationQueue;
    assert.deepEqual(f.calls, []);
    console.log("PASS: dead tunnel stopped after two probe failures, transient failure tolerated, broken probe ignored, stale check ignored");
})().catch(error => { console.error(error); process.exitCode = 1; });
(async () => {
    const os = require("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-marker-"));
    try {
        const f = fixture([{ success: false }, { success: false }]);
        Object.assign(f.c, { dataDir: dir, profilePath: path.join(dir, "wireguard.conf") });
        fs.writeFileSync(f.c.profilePath, "profile");
        f.c.initialize = async () => {};
        let starts = 0;
        f.c.startInternal = async () => { starts++; return { success: false, state: "inactive", error: "x" }; };
        Object.assign(f.c, { routeId: "US-FREE#134", routeCountry: "US", routeCity: "New York" });
        f.c.verifyAdoptedRoute("adoption"); await f.c.operationQueue;
        assert.equal(f.c.routeQuarantined({ name: "US-FREE#134", country: "US", city: "New York" }), true);
        assert.equal(f.c.routeQuarantined({ name: "US-FREE#142", country: "US", city: "New York" }), true, "same datacenter city is avoided");
        assert.equal(f.c.routeQuarantined({ name: "MX-FREE#11", country: "MX", city: "Mexico City" }), false);
        f.c.state = "inactive";
        const skipped = await f.c.enable(false, true);
        assert.equal(starts, 0, "boot must not retry a profile that proved broken");
        assert.match(skipped.error, /não passou no teste do Discord/);
        await f.c.enable(false, false);
        assert.ok(starts > 0, "Start Bypass always retries");
        fs.utimesSync(f.c.profilePath, new Date(), new Date(Date.now() + 5000));
        starts = 0; await f.c.enable(false, true);
        assert.ok(starts > 0, "a new profile (optimization) releases automatic activation");
        console.log("PASS: broken profile remembered, boot activation skipped, manual retry allowed, new profile clears it");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
(async () => {
    const os = require("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-rollback-"));
    try {
        const proton = {
            generateOptimalProtonConfig: async dataDir => { fs.writeFileSync(path.join(dataDir, "wireguard.conf"), "NEW-NY"); return { success: true, server: "US-FREE#134", country: "US", city: "New York" }; },
            savedSessionUsername: () => "user",
        };
        const module = { exports: {} };
        vm.runInNewContext(code, {
            module, exports: module.exports, process: { platform: "win32", arch: "x64", pid: 123, execPath: "C:/Discord/Discord.exe", kill() {} },
            require(name) {
                if (name === "electron") return { app: {} };
                if (name === "./vpn-proton") return proton;
                if (name === "./vpn-windows") return {};
                if (name === "./vpn-types") return { safeDiagnosticDetail: String, normalizeVpnSettings: value => ({ ...value }) };
                return require(name);
            },
            setTimeout: fn => setImmediate(fn), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {}, AbortController,
        });
        const c = new module.exports.PluginVpnController({ dataDir: dir, guiDataDir: dir, isEnabled: () => true, readSettings: () => ({ protonUsername: "user" }), log() {} });
        fs.writeFileSync(c.profilePath, "GOOD-MX");
        Object.assign(c, { routeId: "MX-FREE#11", routeCountry: "MX", routeCity: "Mexico City" });
        c.getStatus = async () => ({ active: true });
        c.stopInternal = async () => ({ success: true, state: "inactive" });
        const started = [];
        c.startInternal = async () => {
            const profile = fs.readFileSync(c.profilePath, "utf8");
            started.push(profile);
            return profile === "NEW-NY"
                ? { success: false, state: "inactive", error: "A rota da VPN não passou no teste do Discord; o túnel foi desligado." }
                : { success: true, state: "active" };
        };
        const result = await c.optimizeProton({ serverId: "US-FREE#134" });
        assert.equal(result.success, false);
        assert.match(result.error, /rota anterior foi restaurada\./);
        assert.deepEqual(started, ["NEW-NY", "GOOD-MX"]);
        assert.equal(fs.readFileSync(c.profilePath, "utf8"), "GOOD-MX");
        assert.equal(c.routeId, "MX-FREE#11");
        console.log("PASS: a new route that fails the Discord test is rolled back to the working profile and route");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
