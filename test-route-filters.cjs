const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require(path.join(process.env.LOCALAPPDATA, "LefferzinBypass/Vencord/node_modules/esbuild"));
let source = fs.readFileSync(path.join(__dirname, "vpn-proton.ts"), "utf8")
    .replace("export function runConfgen(", "function unusedRunConfgen(")
    .replace("export async function runIsolatedSpeedSelection(", "async function unusedSpeedSelection(");
source += "\nconst runConfgen = globalThis.mockRun; const runIsolatedSpeedSelection = (args) => globalThis.mockRun({args});";
const code = esbuild.transformSync(source, { loader: "ts", format: "cjs" }).code;
const dir = fs.mkdtempSync(path.join(__dirname, "route-filter-test-"));
let servers, result, calls;
const moduleStub = { exports: {} };
vm.runInNewContext(code, {
    module: moduleStub, exports: moduleStub.exports, process,
    require: name => name === "./vpn-types" ? { safeDiagnosticDetail: String } : require(name),
    mockRun: async ({ args }) => {
        calls.push(args);
        if (args.includes("-list-servers")) return { code: 0, stdout: JSON.stringify(servers) };
        fs.writeFileSync(args[args.indexOf("-output") + 1], "new profile");
        return { code: 0, json: { success: true, country: "US", server: "US#1", load: 85, downloadMbps: 5, uploadMbps: 5, ...result } };
    },
});
const api = moduleStub.exports;
function reset() {
    calls = []; result = {};
    servers = [
        ...["JP", "CH", "PL", "RO", "BR"].map(country => ({ name: `${country}#1`, country, load: 10 })),
        { name: "US#1", country: "US", load: 85 },
        { name: "US#2", country: "US", load: 86 },
        { name: "NL#1", country: "NL", load: 0 },
    ];
    fs.writeFileSync(path.join(dir, "wireguard.conf"), "old profile");
}
(async () => {
    try {
        for (const speedTest of [false, true]) {
            reset();
            assert.equal((await api.generateOptimalProtonConfig(dir, { username: "test", speedTest })).success, true);
            const args = calls[1];
            assert.equal(args[args.indexOf("-exclude-countries") + 1], "BR,JP,CH,PL,RO");
            const excluded = args[args.indexOf("-exclude-servers") + 1].split(",");
            assert.ok(excluded.includes("US#2"));
            assert.ok(!excluded.includes("US#1"));
            assert.ok(!excluded.includes("NL#1"));
            assert.equal(args.includes("-speed-test"), speedTest);
        }
        for (const serverId of ["JP#1", "CH#1", "PL#1", "RO#1", "US#2"]) {
            reset();
            assert.equal((await api.generateOptimalProtonConfig(dir, { username: "test", serverId })).success, false);
            assert.equal(calls.length, 1);
        }
        reset(); servers = servers.filter(s => s.country === "JP");
        assert.equal((await api.generateOptimalProtonConfig(dir, { username: "test" })).success, false);
        assert.equal(calls.length, 1);
        for (const changed of [{ country: "jp" }, { load: 95 }]) {
            reset(); result = changed;
            assert.equal((await api.generateOptimalProtonConfig(dir, { username: "test" })).success, false);
            assert.equal(fs.readFileSync(path.join(dir, "wireguard.conf"), "utf8"), "old profile");
            assert.equal(fs.readdirSync(dir).filter(n => n.endsWith(".tmp")).length, 0);
        }
        console.log("PASS: excluded countries, 85% boundary, zero load, speed-test flags, manual selection, no eligible routes, changed result preserves profile");
    } finally {
        assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(__dirname) + path.sep));
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
