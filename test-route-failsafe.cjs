const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require(path.join(process.env.LOCALAPPDATA, "LefferzinBypass/Vencord/node_modules/esbuild"));
const source = fs.readFileSync(path.join(__dirname, "vpn-controller.ts"), "utf8");
const code = esbuild.transformSync(source, { loader: "ts", format: "cjs" }).code;
const ROUTE_FAILURE = "A rota da VPN não passou no teste do Discord; o Discord segue na rede normal.";

function load({ probes = [], proton = {}, windows = {} } = {}) {
    const queue = [...probes];
    const module = { exports: {} };
    vm.runInNewContext(code, {
        module, exports: module.exports, AbortController,
        process: { platform: "win32", arch: "x64", pid: 123, execPath: "C:/Discord/Discord.exe", kill() {} },
        require(name) {
            if (name === "electron") return { app: {} };
            if (name === "./vpn-proton") return { savedSessionUsername: () => "user", ...proton };
            if (name === "./vpn-windows") return { runRouteProbe: async () => queue.shift() ?? null, removeRouteProbe() {}, ...windows };
            if (name === "./vpn-types") return { safeDiagnosticDetail: String, normalizeVpnSettings: value => ({ ...value }) };
            return require(name);
        },
        setTimeout: fn => setImmediate(fn), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {},
    });
    return module.exports.PluginVpnController;
}

function fixture(probes, dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-failsafe-"))) {
    const Controller = load({ probes });
    const calls = [];
    const c = new Controller({ dataDir, guiDataDir: dataDir, isEnabled: () => true, readSettings: () => ({ protonUsername: "user" }), log() {} });
    c.readOwner = () => ({ probePath: __filename });
    c.stopInternal = async () => { calls.push("stop"); c.state = "inactive"; return { success: true, state: "inactive" }; };
    c.startWithFailover = async () => { calls.push("failover"); return { success: true, state: "active" }; };
    c.state = "active";
    return { c, calls, dataDir, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("dead adopted route is stopped and replaced automatically", async () => {
    const f = fixture([{ success: false }, { success: false }]);
    try {
        f.c.verifyAdoptedRoute("adoption"); await f.c.operationQueue;
        assert.deepEqual(f.calls, ["stop", "failover"]);
    } finally { f.cleanup(); }
});

test("Discord reachable through the tunnel keeps the route", async () => {
    const f = fixture([{ success: false }, { success: true, discordOk: true }]);
    try {
        f.c.verifyAdoptedRoute("adoption"); await f.c.operationQueue;
        assert.deepEqual(f.calls, []);
    } finally { f.cleanup(); }
});

test("IPv4 exit without Discord (Cloudflare-blocked exit) is a dead route", async () => {
    const blocked = { success: true, discordOk: false, observations: [{ source: "ipv4/ipify", ip: "205.147.22.18" }] };
    const f = fixture([blocked, blocked]);
    try {
        f.c.verifyAdoptedRoute("adoption"); await f.c.operationQueue;
        assert.deepEqual(f.calls, ["stop", "failover"]);
    } finally { f.cleanup(); }
});

test("broken probe output is not evidence", async () => {
    const f = fixture([null]);
    try {
        f.c.verifyAdoptedRoute("adoption"); await f.c.operationQueue;
        assert.deepEqual(f.calls, []);
    } finally { f.cleanup(); }
});

test("stale check after a newer activation is ignored", async () => {
    const f = fixture([{ success: false }, { success: false }]);
    try {
        f.c.verifyAdoptedRoute("adoption"); f.c.generation++; await f.c.operationQueue;
        assert.deepEqual(f.calls, []);
    } finally { f.cleanup(); }
});

test("quarantine is per server; a city only after two of its servers fail", async () => {
    const f = fixture([]);
    try {
        Object.assign(f.c, { routeId: "MX-FREE#11", routeCountry: "MX", routeCity: "Mexico City" });
        f.c.quarantineCurrentRoute();
        assert.equal(f.c.routeQuarantined({ name: "MX-FREE#11", country: "MX", city: "Mexico City" }), true);
        assert.equal(f.c.routeQuarantined({ name: "MX-FREE#17", country: "MX", city: "Mexico City" }), false, "a sibling server is still tried");
        Object.assign(f.c, { routeId: "MX-FREE#3" });
        f.c.quarantineCurrentRoute();
        assert.equal(f.c.routeQuarantined({ name: "MX-FREE#17", country: "MX", city: "Mexico City" }), true, "two failures take the city out");
        assert.equal(f.c.routeQuarantined({ name: "NL-FREE#1", country: "NL", city: "Amsterdam" }), false);
    } finally { f.cleanup(); }
});

test("boot does not retry a broken route inside the retry window; Start Bypass always does", async () => {
    const f = fixture([]);
    try {
        f.c.profilePath = path.join(f.dataDir, "wireguard.conf");
        fs.writeFileSync(f.c.profilePath, "profile");
        f.c.rememberRouteFailure();
        f.c.initialize = async () => {};
        f.c.state = "inactive";
        f.c.routeRetryAt = Date.now() + 60_000;
        const skipped = await f.c.enable(false, true);
        assert.match(skipped.error, /não passou no teste do Discord/);
        assert.deepEqual(f.calls, []);
        await f.c.enable(false, false);
        assert.deepEqual(f.calls, ["failover"]);
        f.c.routeRetryAt = Date.now() - 1;
        await f.c.enable(false, true);
        assert.deepEqual(f.calls, ["failover", "failover"], "after the window the boot tries again");
    } finally { f.cleanup(); }
});

test("failover generates new routes until one reaches Discord", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-failover-"));
    try {
        const requested = [];
        const list = [
            { id: "MX-FREE#11", name: "MX-FREE#11", country: "MX", city: "Mexico City", score: 1 },
            { id: "MX-FREE#17", name: "MX-FREE#17", country: "MX", city: "Mexico City", score: 2 },
            { id: "US-FREE#88", name: "US-FREE#88", country: "US", city: "Miami", score: 3 },
        ];
        const Controller = load({ proton: {
            isOptimizationRouteAllowed: () => true,
            listAvailableServers: async () => ({ success: true, servers: list }),
            generateOptimalProtonConfig: async (_dir, options) => {
                requested.push(options.serverId);
                const server = list.find(entry => entry.name === options.serverId);
                return { success: true, server: server.name, country: server.country, city: server.city };
            },
        } });
        const c = new Controller({ dataDir, guiDataDir: dataDir, isEnabled: () => true, readSettings: () => ({ protonUsername: "user" }), log() {} });
        Object.assign(c, { routeId: "MX-FREE#11", routeCountry: "MX", routeCity: "Mexico City" });
        const started = [];
        c.startInternal = async () => {
            started.push(c.routeId);
            if (c.routeId === "MX-FREE#17") return { success: true, state: "active" };
            c.quarantineCurrentRoute();
            return { success: false, state: "inactive", error: ROUTE_FAILURE };
        };
        const result = await c.startWithFailover(false);
        assert.equal(result.success, true);
        assert.deepEqual(started, ["MX-FREE#11", "MX-FREE#17"]);
        assert.deepEqual(requested, ["MX-FREE#17"], "another server of the same country first (keeps ping); the failed one is never requested");
        assert.equal(c.routeRetryAt, 0);
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("no working route: Discord stays on the normal network and retry is deferred", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-exhausted-"));
    try {
        let generated = 0;
        const Controller = load({ proton: {
            isOptimizationRouteAllowed: () => true,
            listAvailableServers: async () => ({ success: true, servers: [1, 2, 3, 4, 5].map(n => ({ id: `X#${n}`, name: `X#${n}`, country: "US", city: `City${n}`, score: n })) }),
            generateOptimalProtonConfig: async (_dir, options) => { generated++; return { success: true, server: options.serverId, country: "US" }; },
        } });
        const c = new Controller({ dataDir, guiDataDir: dataDir, isEnabled: () => true, readSettings: () => ({ protonUsername: "user" }), log() {} });
        let starts = 0;
        c.startInternal = async () => { starts++; c.quarantineCurrentRoute(); return { success: false, state: "inactive", error: ROUTE_FAILURE }; };
        const result = await c.startWithFailover(false);
        assert.equal(result.success, false);
        assert.equal(starts, 4, "current route + 3 automatic alternatives");
        assert.ok(c.routeRetryAt > Date.now(), "next boot attempt is deferred");
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("a new route that fails during manual optimization rolls back to the working one", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-rollback-"));
    try {
        const Controller = load({ proton: {
            generateOptimalProtonConfig: async dir => { fs.writeFileSync(path.join(dir, "wireguard.conf"), "NEW"); return { success: true, server: "US-FREE#134", country: "US", city: "New York" }; },
        } });
        const c = new Controller({ dataDir, guiDataDir: dataDir, isEnabled: () => true, readSettings: () => ({ protonUsername: "user" }), log() {} });
        fs.writeFileSync(c.profilePath, "GOOD");
        Object.assign(c, { routeId: "MX-FREE#17", routeCountry: "MX", routeCity: "Mexico City" });
        c.getStatus = async () => ({ active: true });
        c.stopInternal = async () => ({ success: true, state: "inactive" });
        const started = [];
        c.startInternal = async () => {
            const profile = fs.readFileSync(c.profilePath, "utf8");
            started.push(profile);
            return profile === "NEW" ? { success: false, state: "inactive", error: ROUTE_FAILURE } : { success: true, state: "active" };
        };
        const result = await c.optimizeProton({ serverId: "US-FREE#134" });
        assert.equal(result.success, false);
        assert.match(result.error, /rota anterior foi restaurada\./);
        assert.deepEqual(started, ["NEW", "GOOD"]);
        assert.equal(fs.readFileSync(c.profilePath, "utf8"), "GOOD");
        assert.equal(c.routeId, "MX-FREE#17");
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("route dying mid-session is detected by the periodic health check", async () => {
    const f = fixture([{ success: false, error: "nenhuma familia" }]);
    try {
        const verified = [];
        f.c.verifyAdoptedRoute = stage => verified.push(stage);
        f.c.checkRouteHealth();
        await new Promise(setImmediate); await new Promise(setImmediate);
        assert.deepEqual(verified, ["watchdog"], "a probe without Discord starts the confirm + failover path");
        f.c.checkRouteHealth();
        await new Promise(setImmediate);
        assert.deepEqual(verified, ["watchdog"], "health check is rate limited");
    } finally { f.cleanup(); }
});

test("healthy route or unreadable probe output never triggers a swap", async () => {
    for (const probe of [{ success: true, discordOk: true }, null]) {
        const f = fixture([probe]);
        try {
            const verified = [];
            f.c.verifyAdoptedRoute = stage => verified.push(stage);
            f.c.checkRouteHealth();
            await new Promise(setImmediate); await new Promise(setImmediate);
            assert.deepEqual(verified, []);
        } finally { f.cleanup(); }
    }
});

test("optimize without a chosen server replaces a quarantined ping pick with a plugin-chosen route", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-optimize-"));
    try {
        const requests = [];
        const Controller = load({ proton: {
            isOptimizationRouteAllowed: () => true,
            listAvailableServers: async () => ({ success: true, servers: [
                { id: "US-FREE#138", name: "US-FREE#138", country: "US", city: "New York", score: 1 },
                { id: "US-FREE#131", name: "US-FREE#131", country: "US", city: "Secaucus", score: 2 },
            ] }),
            generateOptimalProtonConfig: async (_dir, options) => {
                requests.push(options.serverId ?? "auto-ping");
                if (!options.serverId) return { success: false, error: "A rota escolhida pelo Proton está em quarentena (sem acesso ao Discord)." };
                return { success: true, server: options.serverId, country: "US" };
            },
        } });
        const c = new Controller({ dataDir, guiDataDir: dataDir, isEnabled: () => true, readSettings: () => ({ protonUsername: "user" }), log() {} });
        Object.assign(c, { routeId: "US-FREE#138", routeCountry: "US", routeCity: "New York" });
        c.quarantineCurrentRoute();
        c.getStatus = async () => ({ active: false });
        const result = await c.optimizeProton({ autoPing: true, speedTest: false, relaunch: false });
        assert.equal(result.success, true);
        assert.deepEqual(requests, ["auto-ping", "US-FREE#131"], "falls back to a non-quarantined server instead of failing");
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); }
        catch (error) { console.error(`FAIL: ${name}`); throw error; }
    }
    console.log(`PASS: ${tests.length} route fail-safe scenarios (dead/blocked route replaced automatically, quarantine per server, retry window, failover, rollback)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
