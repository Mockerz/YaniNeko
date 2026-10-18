const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const esbuild = require(path.join(process.env.LOCALAPPDATA, "LefferzinBypass/Vencord/node_modules/esbuild"));
const code = esbuild.transformSync(fs.readFileSync(path.join(__dirname, "error-reporter.ts"), "utf8"), { loader: "ts", format: "cjs" }).code;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, FormData, Blob, AbortSignal, Date, setTimeout: () => ({ unref() {} }) });
const { ErrorReporter, redactReport, reportFilename, validWebhook } = mod.exports;
(async () => {
    const secret = 'password="my secret password" token=abcdef PrivateKey=secretkey PresharedKey=peerkey user@example.com 192.168.1.2 C:\\Users\\joao\\file https://discord.com/api/webhooks/123/SECRET';
    const redacted = redactReport(secret);
    assert.ok(redactReport("2026-10-18T16:04:03.559Z 16:04:03.559 2001:db8::1").includes("16:04:03.559"));
    assert.ok(!redactReport("2001:db8::1").includes("2001:db8"));
    for (const value of ["my secret password", "abcdef", "secretkey", "peerkey", "user@example.com", "192.168.1.2", "joao", "SECRET"]) assert.ok(!redacted.includes(value), value);
    assert.equal(reportFilename("joao123"), "erro.joao123.log");
    assert.ok(!reportFilename("../../evil\r\n").includes("/"));
    assert.equal(validWebhook("https://discord.com.evil.test/api/webhooks/123/token"), false);
    assert.equal(validWebhook("https://discord.com/api/webhooks/123/token?redirect=evil"), false);
    let now = 1000000, enabled = true, statusCode = 200;
    const sends = [], statuses = [];
    const reporter = new ErrorReporter({
        webhook: () => "https://discord.com/api/webhooks/123/test-token",
        enabled: () => enabled, version: "test", diagnostic: () => secret,
        now: () => now, status: message => statuses.push(message),
        send: async (url, options) => { sends.push({ url, options }); return { ok: statusCode === 200, status: statusCode, json: async () => ({ retry_after: 600 }) }; }
    });
    reporter.capture("VPN failed"); await reporter.flush(); assert.equal(sends.length, 0);
    reporter.setUsername("joao123"); reporter.capture("VPN failed"); await reporter.flush();
    assert.equal(sends.length, 1);
    const file = sends[0].options.body.get("files[0]");
    assert.equal(file.name, "erro.joao123.log");
    const text = await file.text();
    assert.equal(text.split("VPN failed").length, 2, "duplicate errors grouped");
    assert.ok(!text.includes("SECRET"));
    assert.deepEqual(JSON.parse(sends[0].options.body.get("payload_json")).allowed_mentions, { parse: [] });
    assert.equal(sends[0].options.redirect, "error");
    reporter.capture("another error"); await reporter.flush(); assert.equal(sends.length, 1);
    now += 300000; await reporter.flush(); assert.equal(sends.length, 2);
    enabled = false; now += 300000; reporter.capture("disabled"); await reporter.flush(); assert.equal(sends.length, 2);
    enabled = true; statusCode = 429; reporter.capture("rate limited"); await reporter.flush(); assert.equal(sends.length, 3);
    reporter.capture("later"); now += 300000; await reporter.flush(); assert.equal(sends.length, 3);
    now += 300000; statusCode = 200; await reporter.flush(); assert.equal(sends.length, 4);
    assert.match(await sends[3].options.body.get("files[0]").text(), /rate limited/, "failed reports are retried");
    assert.ok(statuses.some(s => s.includes("não foi possível")));
    reporter.capture("old account error");
    reporter.setUsername("outro_usuario");
    now += 300000; await reporter.flush();
    assert.equal(sends.length, 4, "account switch must discard the previous user's pending errors");
    reporter.capture("logout error"); reporter.setUsername(""); reporter.setUsername("joao123");
    await reporter.flush(); assert.equal(sends.length, 4);
    // Source wiring is bundled as a separate check, with no network delivery.
    esbuild.buildSync({ entryPoints: [path.join(__dirname, "index.tsx"), path.join(__dirname, "native.ts")], bundle: true, packages: "external", platform: "node", format: "cjs", write: false, outdir: path.join(__dirname, "build/report-validation"), logLevel: "warning" });
    console.log("PASS: redaction, filename, endpoint validation, grouping, cooldown, opt-out, rate limit, failure isolation, plugin bundling; no real webhook messages sent");
})().catch(error => { console.error(error); process.exitCode = 1; });
