const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require(path.join(process.env.LOCALAPPDATA, "LefferzinBypass/Vencord/node_modules/esbuild"));
const transform = source => esbuild.transformSync(source, { loader: "ts", format: "cjs" }).code;
(async () => {
    let now = 1000000, enabled = true, fail = false, calls = 0, saved = "";
    const native = fs.readFileSync(path.join(__dirname, "native.ts"), "utf8");
    const mod = { exports: {} };
    vm.runInNewContext(transform(native.slice(native.indexOf("const ONLINE_COUNTER_URL"), native.indexOf("export function getAutoUpdateNotifications"))), {
        module: mod, exports: mod.exports, Date: { now: () => now }, AbortSignal,
        pluginEnabled: () => enabled, pluginSettings: () => ({ participateOnlineCounter: false }),
        join: path.join, VPN_DATA_DIR: "test", mkdirSync() {},
        readFileSync: () => saved, writeFileSync: (_, value) => { saved = value; },
        randomUUID: () => "12345678-1234-4123-8123-123456789abc",
        controller: { getStatus: async () => ({ active: true, routeId: "BR-1", routeCountry: "BR", routeCity: "Sao Paulo", routeLabel: "BR-1 · Sao Paulo", configPath: "private-config" }) },
        fetch: async (_, options) => {
            calls++;
            const payload = JSON.parse(options.body);
            assert.ok(Object.keys(payload).every(key => ["installationId", "username", "sessionId", "route"].includes(key)));
            assert.equal(payload.route.server, "BR-1");
            assert.equal(payload.route.country, "BR");
            assert.ok(!options.body.includes("private-config"));
            assert.equal(payload.sessionId, "12345678-1234-4123-8123-123456789abc");
            if (calls === 1) assert.equal(payload.username, "joao123");
            assert.equal(options.headers["ngrok-skip-browser-warning"], "1");
            if (fail) throw Error("offline");
            return { ok: true, json: async () => ({ online: 12 }) };
        }
    });
    const heartbeat = mod.exports.heartbeatOnlineCounter;
    assert.equal(await heartbeat(null, "joao123"), 12); assert.equal(await heartbeat(), 12); assert.equal(calls, 1);
    now += 60000; await Promise.all([heartbeat(), heartbeat()]); assert.equal(calls, 2);
    enabled = false; assert.equal(await heartbeat(), null); assert.equal(calls, 2);
    enabled = true; fail = true; now += 60000; assert.equal(await heartbeat(), null);
    const activity = [], presenceMod = { exports: {} };
    vm.runInNewContext(transform(fs.readFileSync(path.join(__dirname, "presence.ts"), "utf8")), {
        module: presenceMod, exports: presenceMod.exports, Date: { now: () => now },
        setInterval: () => 1, clearInterval() {},
        require: name => {
            if (name === "@utils/Logger") return { Logger: class { info() {} debug() {} error() {} } };
            if (name.endsWith("/enums")) return { ActivityType: { PLAYING: 0 } };
            if (name === "./manifest.json") return { version: "test" };
            if (name === "@webpack/common") return { ApplicationAssetUtils: { fetchAssetIds: async () => ["image"] }, FluxDispatcher: { dispatch: value => activity.push(value.activity) } };
            throw Error(name);
        }
    });
    const p = presenceMod.exports;
    p.updateOnlineUsers(12); p.startPresence(); await new Promise(setImmediate);
    assert.match(activity.at(-1).state, /12 usuários online/);
    assert.equal(activity.at(-1).details, "Bypass de Tela/Cam - Vtest");
    assert.ok(!activity.at(-1).state.includes("github.com"));
    p.updateOnlineUsers(null); await new Promise(setImmediate); assert.equal(activity.at(-1).state, "Contador indisponível");
    p.updateOnlineUsers(1); await new Promise(setImmediate); assert.match(activity.at(-1).state, /1 usuário online/);
    now += 180001; p.updateRouteInfo("server", "BR", null, 10); await new Promise(setImmediate);
    assert.ok(!activity.at(-1).state.includes("online"));
    p.stopPresence(); assert.equal(activity.at(-1), null);
    assert.ok(!fs.readFileSync(path.join(__dirname, "index.tsx"), "utf8").includes("participateOnlineCounter:"));
    assert.ok(!native.includes("pluginSettings().automaticErrorReports"));
    assert.match(native, /enabled: \(\) => true/);
    console.log("PASS client and presence: heartbeat cooldown, stable installation ID, legacy opt-out ignored, plugin disable, offline handling, count display and stale count removal");
})().catch(error => { console.error(error); process.exitCode = 1; });
