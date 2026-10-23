const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const updater = require("./auto-update.cjs");

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-startup-"));
    const base = path.join(root, ".yanineko-updates");
    const write = (name, value) => fs.writeFileSync(path.join(base, name), JSON.stringify(value));
    const read = name => JSON.parse(fs.readFileSync(path.join(base, name), "utf8"));
    let downloads = 0;
    // Offline stand-in: counting attempts is enough, nothing is installed.
    global.fetch = async () => { downloads++; throw new Error("offline test"); };
    try {
        fs.mkdirSync(base, { recursive: true });
        write("active.json", { active: "a".repeat(40), pid: 1111 });
        write("config.json", { node: process.execPath, updateIntervalMs: 3 * 60 * 60 * 1000, updateOnStartupOnly: true });

        await updater.check(root);
        assert.equal(downloads, 1, "first check of a Discord session runs");
        assert.equal(fs.existsSync(path.join(base, "checked.json")), false, "a failed check is retried, not remembered");

        write("checked.json", { at: Date.now() - 6 * 60 * 60 * 1000, session: 1111 });
        await updater.check(root);
        assert.equal(downloads, 1, "the periodic timer never checks again in the same session, even hours later");

        write("active.json", { active: "a".repeat(40), pid: 2222 });
        write("checked.json", { at: Date.now(), session: 1111 });
        await updater.check(root);
        assert.equal(downloads, 2, "a new Discord start checks right away, even minutes after the last check");

        write("checked.json", { at: Date.now(), session: 2222 });
        await updater.check(root, { force: true });
        assert.equal(downloads, 3, "admin force-check still works");

        write("config.json", { node: process.execPath, updateIntervalMs: 3 * 60 * 60 * 1000 });
        write("checked.json", { at: Date.now() - 60 * 60 * 1000, session: 1 });
        await updater.check(root);
        assert.equal(downloads, 3, "3h mode keeps its cooldown across sessions");
        console.log("PASS: startup-only updates check once per Discord session, new session checks immediately, force-check and 3h cadence unaffected");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
