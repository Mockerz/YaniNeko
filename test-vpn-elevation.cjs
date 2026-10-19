const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const esbuild = require(path.join(process.env.LOCALAPPDATA, "LefferzinBypass/Vencord/node_modules/esbuild"));
const source = fs.readFileSync(path.join(__dirname, "vpn-windows.ts"), "utf8");
const code = esbuild.transformSync(source, { loader: "ts", format: "cjs" }).code;
fs.mkdirSync(path.join(__dirname, "build"), { recursive: true });
const root = fs.mkdtempSync(path.join(__dirname, "build", "elevation-test-"));
const quote = value => `'${value.replace(/'/g, "''")}'`;
let execution;
const mod = { exports: {} };
vm.runInNewContext(code + "\nmodule.exports.test = { elevatedPowerShellArgs, runElevatedPowerShell, serviceScript };", {
    module: mod, exports: mod.exports, process, Buffer,
    require: name => {
        if (name === "child_process") return { execFile: (...args) => execution(...args) };
        if (name === "os") return { tmpdir: () => root };
        if (name === "./vpn-types") return {};
        return require(name);
    },
});
const api = mod.exports.test;
// Run only generated wrappers with all launch/service calls replaced by test doubles.
// These tests never request elevation or touch a real service.
function ps(script) {
    script = "$ProgressPreference='SilentlyContinue'\n" + script;
    try { return { status: 0, output: execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", stdio: "pipe", windowsHide: true, timeout: 15000 }) }; }
    catch (error) { return { status: error.status, output: String(error.stderr || error.message) }; }
}
(async () => {
    const scriptPath = path.join(root, "service.ps1"), diagnostic = path.join(root, "error.txt");
    for (const [exception, expected] of [
        ["[System.ComponentModel.Win32Exception]::new(1223)", 1223],
        ["[System.ComponentModel.Win32Exception]::new(5)", 5],
        ["[System.Exception]::new('outer', [System.ComponentModel.Win32Exception]::new(1223))", 1223],
        ["[System.Exception]::new('path cancel-1223 is missing')", 1],
    ]) {
        let wrapper = Buffer.from(api.elevatedPowerShellArgs(scriptPath, diagnostic).at(-1), "base64").toString("utf16le");
        wrapper = wrapper.replace("$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)", "$false");
        const result = ps(`function Start-Process { throw ${exception} }\n${wrapper}`);
        assert.equal(result.status, expected, result.output);
        assert.match(fs.readFileSync(diagnostic, "utf8"), /stage=elevation nativeCode=/);
    }
    for (const child of ["$null", "[pscustomobject]@{ExitCode=$null}"]) {
        let wrapper = Buffer.from(api.elevatedPowerShellArgs(scriptPath, diagnostic).at(-1), "base64").toString("utf16le");
        wrapper = wrapper.replace("$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)", "$false");
        const result = ps(`function Start-Process { return ${child} }\n${wrapper}`);
        assert.equal(result.status, 1, result.output);
        assert.match(fs.readFileSync(diagnostic, "utf8"), /stage=execution/);
    }
    for (const scenario of ["success", "warning", "cancel", "denied", "timeout", "false-success", "generic"]) {
        execution = (_file, args, _opts, callback) => {
            const wrapper = Buffer.from(args.at(-1), "base64").toString("utf16le");
            const match = /\$scriptPath='((?:''|[^'])*)'/.exec(wrapper);
            const file = match[1].replace(/''/g, "'");
            const dir = path.dirname(file), content = fs.readFileSync(file, "utf16le");
            assert.match(content, /\$env:YANI_ELEVATED_ERROR_FILE=/, "child owns diagnostic destination");
            assert.match(content, /\$env:YANI_ELEVATED_WARNING_FILE=/);
            if (["success", "warning"].includes(scenario)) fs.writeFileSync(path.join(dir, "completed.txt"), "ok");
            if (scenario === "warning") fs.writeFileSync(path.join(dir, "warning.txt"), "recovery unavailable");
            if (["cancel", "denied", "generic"].includes(scenario)) fs.writeFileSync(path.join(dir, "error.txt"), "original Windows diagnostic");
            const codes = { cancel: 1223, denied: 5, timeout: 1, generic: 1 };
            callback(codes[scenario] ? { code: codes[scenario], killed: scenario === "timeout", signal: "SIGTERM" } : null, "", "");
        };
        const kinds = { cancel: "UAC_CANCELLED", denied: "ELEVATION_DENIED", timeout: "ELEVATION_TIMEOUT", "false-success": "POWERSHELL_FAILED", generic: "POWERSHELL_FAILED" };
        if (kinds[scenario]) await assert.rejects(api.runElevatedPowerShell("# test", 1000), error => error.code === kinds[scenario] && (!['cancel', 'denied', 'generic'].includes(scenario) || error.message.includes("original Windows diagnostic")));
        else assert.equal(await api.runElevatedPowerShell("# test", 1000), scenario === "warning" ? "recovery unavailable" : "");
    }
    const config = path.join(root, "test.conf"), executable = "C:\\Test\\WireSock.exe";
    const expected = `"${executable}" service -config "${config}" -log-level info -network-lock disabled`;
    const setup = `$env:YANI_ELEVATED_WARNING_FILE=${quote(path.join(root, "warning.txt"))}
$script:state='Stopped'
function Get-Service { $s=[pscustomobject]@{Status=$script:state}; $s | Add-Member -MemberType ScriptMethod -Name WaitForStatus -Value { param($state,$timeout) if($script:state -ne $state){ throw 'bad service state' } }; return $s }
function Get-CimInstance { [pscustomobject]@{PathName=${quote(expected)}} }
function Invoke-CimMethod { [pscustomobject]@{ReturnValue=0} }
function Stop-Service { $script:state='Stopped' }
function Start-Service { $script:state='Running' }
function Mock-Recovery { if($script:state -ne 'Running'){ throw 'recovery must run after start' }; $global:LASTEXITCODE=5 }
`;
    const service = api.serviceScript(executable, config).replace(/\$sc=Join-Path[^\r\n]+/, "$sc='Mock-Recovery'");
    const result = ps(setup + service + "\nif($script:state -ne 'Running'){ exit 99 }; exit 0");
    assert.equal(result.status, 0, result.output);
    assert.match(fs.readFileSync(path.join(root, "warning.txt"), "utf8"), /recuperação/);
    assert.equal(fs.existsSync(config + ".recovery-v1"), false);
    const success = ps(setup.replace("$global:LASTEXITCODE=5", "$global:LASTEXITCODE=0") + service);
    assert.equal(success.status, 0, success.output);
    assert.equal(fs.readFileSync(config + ".recovery-v1", "utf8"), "wiresock-service-recovery-v1");
    const failedStart = ps(setup.replace("$script:state='Running'", "throw 'service start failed'") + service);
    assert.equal(failedStart.status, 1, failedStart.output);
    assert.match(failedStart.output, /service start failed/);
    console.log("PASS: native UAC codes, no cancellation inferred from text, preserved diagnostics, timeout, completion proof, optional recovery cannot block activation; no real elevation or VPN changes");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    assert.ok(fs.realpathSync(root).startsWith(fs.realpathSync(path.join(__dirname, "build")) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
});
