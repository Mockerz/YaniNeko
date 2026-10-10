"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const updater = require("./auto-update.cjs");
const root = fs.mkdtempSync(path.join(__dirname, "build-update-test-"));
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data)); };
const state = () => JSON.parse(fs.readFileSync(path.join(root, ".yanineko-updates/active.json")));
const sha = "a".repeat(40);
(async () => {
    try {
        for (const name of ["patcher.js", "renderer.js", "preload.js", "bin/win32-x64/proton-confgen.exe"]) write(path.join(root, "dist", name), "// LefferzinBypass baseline");
        updater.install(root, __dirname);
        // Fast transitions remain separate, ordered events; history stays bounded.
        for (const phase of ["checking", "available", "ready"]) updater.notify(root, phase);
        const notificationFile = path.join(root, ".yanineko-updates/notifications.json");
        let notifications = JSON.parse(fs.readFileSync(notificationFile));
        assert.deepEqual(notifications.map(e => e.phase), ["checking", "available", "ready"]);
        assert.equal(new Set(notifications.map(e => e.id)).size, 3);
        for (let i = 0; i < 25; i++) updater.notify(root, "checking");
        notifications = JSON.parse(fs.readFileSync(notificationFile));
        assert.equal(notifications.length, 20);
        assert.ok(notifications.every(e => Number.isFinite(e.at)));
        const baseline = state().active;
        assert.match(fs.readFileSync(path.join(root, "dist/patcher.js"), "utf8"), /yanineko-updater/);
        updater.validateRelease(updater.release(root, baseline));
        assert.equal(updater.choose(root), baseline);
        const next = updater.release(root, sha);
        fs.cpSync(updater.release(root, baseline), next, { recursive: true });
        write(path.join(next, "renderer.js"), "// LefferzinBypass new"); updater.seal(next);
        write(path.join(root, ".yanineko-updates/pending.json"), { id: sha });
        // Preparing an update leaves the current code untouched.
        assert.equal(state().active, baseline);
        assert.match(fs.readFileSync(path.join(updater.release(root, baseline), "renderer.js"), "utf8"), /baseline/);
        assert.equal(updater.choose(root), sha); assert.equal(state().previous, baseline);
        assert.ok(!fs.existsSync(path.join(root, ".yanineko-updates/pending.json")));
        // A corrupt download cannot replace the active version.
        const badSha = "b".repeat(40), bad = updater.release(root, badSha);
        fs.cpSync(next, bad, { recursive: true }); write(path.join(bad, "renderer.js"), "corrupt");
        write(path.join(root, ".yanineko-updates/pending.json"), { id: badSha });
        assert.equal(updater.choose(root), sha);
        assert.throws(() => updater.inside(root, "../escape"));
        assert.throws(() => updater.release(root, "../../escape"));
        // Synchronous startup failure retains the old version for the next launch.
        write(path.join(next, "patcher.js"), 'throw new Error("boot failure");');
        assert.throws(() => updater.boot(root), /boot failure/);
        assert.equal(state().active, baseline); assert.equal(state().rejected, sha);
        // File downloads must match the Git blob hash of the pinned commit.
        const required = ["manifest.json", "index.tsx", "native.ts", "presence.ts", "stability.ts", "vpn-controller.ts", "vpn-proton.ts", "vpn-types.ts", "vpn-windows.ts", "bin/win32-x64/proton-confgen.exe"];
        const payloads = new Map(required.map(name => [name, Buffer.from(name.endsWith(".exe") ? "MZ" + "x".repeat(4096) : "content")]));
        const tree = [...payloads].map(([name, data]) => ({ type: "blob", mode: "100644", path: name, size: data.length, sha: crypto.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex") }));
        const get = async url => url.includes("git/trees") ? Buffer.from(JSON.stringify({ tree })) : payloads.get(url.split(`/${sha}/`)[1]);
        await updater.fetchSource(path.join(root, "source"), sha, get);
        await assert.rejects(updater.fetchSource(path.join(root, "bad-source"), sha, async url => url.includes("git/trees") ? get(url) : Buffer.from("tampered")), /hash mismatch/);
        assert.equal(updater.pluginFile("tests/file.ts"), false);
        assert.equal(updater.pluginFile("vpn-controller.ts"), true);
        // A new Discord launch checks even when the previous launch checked recently.
        const activePath = path.join(root, ".yanineko-updates/active.json");
        write(activePath, { active: baseline, commit: sha, pid: process.pid });
        const originalFetch = global.fetch;
        let requests = 0;
        global.fetch = async () => {
            requests++;
            return { ok: true, body: (async function* () { yield Buffer.from(JSON.stringify({ sha })); })() };
        };
        try {
            await updater.check(root);
            assert.equal(requests, 1);
            await updater.check(root);
            assert.equal(requests, 1, "same session must respect three-hour cooldown");
            const nextBootTime = new Date(Date.now() + 2000);
            fs.utimesSync(activePath, nextBootTime, nextBootTime);
            await updater.check(root);
            assert.equal(requests, 2, "new launch must bypass previous session cooldown");
            const checkedPath = path.join(root, ".yanineko-updates/checked.json");
            const checked = JSON.parse(fs.readFileSync(checkedPath));
            write(checkedPath, { ...checked, at: Date.now() - 60 * 60 * 1000 });
            await updater.check(root);
            assert.equal(requests, 2, "one hour must not trigger another check");
            write(checkedPath, { ...checked, at: Date.now() - 3 * 60 * 60 * 1000 });
            await updater.check(root);
            assert.equal(requests, 3, "open Discord checks again after three hours");
        } finally { global.fetch = originalFetch; }
        console.log("PASS: installation, deferred activation, preserved baseline, corrupt build rejection, rollback, path validation, pinned source hashes");
    } finally {
        const resolved = fs.realpathSync(root);
        assert.ok(resolved.startsWith(fs.realpathSync(__dirname) + path.sep));
        fs.rmSync(resolved, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
