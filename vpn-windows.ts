import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import https from "https";
import { promises as dns } from "dns";
import { execFile } from "child_process";

import {
    VPN_SERVICE_NAMES,
    formatAllowedApps,
    safeDiagnosticDetail,
    sanitizeWireGuardConfig,
    validateWireGuardConfig,
    type WireGuardConfigValidation,
} from "./vpn-types";

export const WIRESOCK_VERSION = "3.4.8.1";
const WIRESOCK_DOWNLOAD = "https://wiresock.net/_api/download-release.php?product=wiresock-secure-connect-sdk&platform=x64&version=3.4.8.1&channel=winget";
const WIRESOCK_INSTALLER_SHA256 = "abfeebdc645de36b95fabbed00c7fdb0bf4d0c68c5518608450619c61876d33e";
const WIRESOCK_EXECUTABLE = "wiresock-client.exe";
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const WIRESOCK_SERVICE_NAME = "wiresock-client-service";
const WIRESOCK_RECOVERY_MARKER = "wiresock-service-recovery-v1";
const WIRESOCK_RECOVERY_ATTEMPT_MARKER = "wiresock-service-recovery-attempted-v1";
// Só o adaptador do WireSock: "ProTUN" é do app oficial da Proton e não é nosso.
const WIRESOCK_DNS_RESET = "Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'WireSock' -or $_.InterfaceDescription -match 'WireSock' } | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ResetServerAddresses -ErrorAction SilentlyContinue }";

export type WireSockLogger = (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;

export interface WireSockCandidate {
    executable: string;
    booster: string;
    executableVersion: string;
    boosterVersion: string;
}

export interface WireSockInspection {
    active: boolean;
    owned: boolean;
    services: string[];
    registeredServices: string[];
    foreignRegisteredServices: string[];
    processIds: number[];
    reason: string | null;
}

export interface WireSockCleanupResult {
    stopped: boolean;
    servicesResidual: string[];
    processResidual: number[];
    networkLockReset: boolean;
    dnsCleared: boolean;
    dnsFlushed: boolean;
    error?: string;
}

export interface WireSockStartResult {
    executable: string;
    configPath: string;
    allowedApps: string;
}

export interface WindowsNetworkDiagnostic {
    ok: boolean;
    dnsOk: boolean;
    httpsOk: boolean;
    detail: string;
}

function logError(error: unknown): string {
    const value = error as { stderr?: unknown; stdout?: unknown; message?: unknown; code?: unknown } | null;
    return safeDiagnosticDetail(value?.stderr || value?.stdout || value?.message || error, 500);
}

function isWindows(): boolean {
    return process.platform === "win32";
}

function quotePowerShell(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function normalizedPath(value: string): string {
    return value.trim().replace(/^"|"$/g, "").replace(/[\\/]+/g, "\\").toLowerCase();
}

function containsConfig(commandLine: string | null, configPath: string): boolean {
    if (!commandLine) return false;
    return normalizedPath(commandLine).includes(normalizedPath(configPath));
}

interface ExecResult {
    code: number | null;
    stdout: string;
    stderr: string;
    killed: boolean;
}

// Nada aqui pode bloquear a thread principal do Electron: cada consulta ao
// Windows roda em processo filho assíncrono.
function execFileText(file: string, args: string[], timeout = 10_000): Promise<ExecResult> {
    return new Promise(resolve => {
        execFile(file, args, { encoding: "utf8", windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
            resolve({
                code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0,
                stdout: String(stdout ?? ""),
                stderr: String(stderr ?? ""),
                killed: Boolean(failure?.killed),
            });
        });
    });
}

function powerShell(script: string, timeout = 10_000): Promise<ExecResult> {
    return execFileText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], timeout);
}

// Compartilha apenas a consulta em andamento: ações de controle nunca usam cache.
let pendingInspection: Promise<WireSockSnapshot> | null = null;
interface WireSockSnapshot {
    services: Array<{ Name: string; State: string; PathName: string | null }>;
    processes: Array<{ ProcessId: number; CommandLine: string | null }>;
}

export function parseWireSockSnapshot(output: string): WireSockSnapshot {
    // Only parse our framed record; PowerShell startup/shutdown messages are not JSON.
    const records = output.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.startsWith("YANI_WIRESOCK="));
    if (records.length !== 1) throw new Error("Consulta WireSock sem resposta única válida.");
    return JSON.parse(records[0].slice("YANI_WIRESOCK=".length));
}

export async function inspectWireSockAsync(configPath?: string): Promise<WireSockInspection> {
    if (!isWindows()) return { active: false, owned: false, services: [], registeredServices: [], foreignRegisteredServices: [], processIds: [], reason: null };
    if (!pendingInspection) {
        const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $services=@(Get-CimInstance Win32_Service -Filter "Name='wiresock-client-service' OR Name='wiresock-pro-client-service'" | Select-Object Name,State,PathName); $processes=@(Get-CimInstance Win32_Process -Filter "Name='wiresock-client.exe'" | Select-Object ProcessId,CommandLine); $json=(@{services=$services;processes=$processes} | ConvertTo-Json -Depth 4 -Compress); [Console]::WriteLine('YANI_WIRESOCK=' + $json)`;
        pendingInspection = new Promise<WireSockSnapshot>((resolve, reject) => {
            execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
                encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
            }, (error, stdout, stderr) => {
                if (error) return reject(new Error(`Consulta WireSock falhou: code=${error.code ?? "unknown"} killed=${error.killed} signal=${error.signal ?? "none"}; ${safeDiagnosticDetail(stderr || error.message, 600)}`));
                try {
                    const snapshot = parseWireSockSnapshot(stdout);
                    if (!Array.isArray(snapshot.services) || !Array.isArray(snapshot.processes))
                        throw new Error("Resposta inválida ao consultar WireSock.");
                    // Estado transitório ou resposta parcial não comprovam queda.
                    if (snapshot.services.some(row => !row || typeof row.Name !== "string"
                        || !VPN_SERVICE_NAMES.includes(row.Name as typeof VPN_SERVICE_NAMES[number])
                        || !["Running", "Stopped"].includes(row.State)
                        || (row.PathName !== null && typeof row.PathName !== "string"))
                        || snapshot.processes.some(row => !row || !Number.isInteger(row.ProcessId) || row.ProcessId <= 0
                            || (row.CommandLine !== null && typeof row.CommandLine !== "string")))
                        throw new Error("Estado do WireSock inconclusivo; aguardando nova consulta.");
                    resolve(snapshot);
                } catch (parseError) { reject(parseError); }
            });
        }).finally(() => { pendingInspection = null; });
    }
    const snapshot = await pendingInspection;
    return classifyWireSock(configPath, snapshot.services.map(row => row.Name),
        snapshot.services.filter(row => row.State === "Running").map(row => row.Name),
        snapshot.processes.map(row => ({ pid: row.ProcessId, commandLine: row.CommandLine })),
        name => snapshot.services.find(row => row.Name === name)?.PathName ?? null);
}

function classifyWireSock(configPath: string | undefined, registeredServices: string[], services: string[],
    processes: Array<{ pid: number; commandLine: string | null }>, serviceCommand: (name: string) => string | null): WireSockInspection {
    const foreignRegisteredServices = configPath
        ? registeredServices.filter(name => !containsConfig(serviceCommand(name), configPath))
        : registeredServices;
    const processIds = processes.map(process => process.pid);
    const active = services.length > 0 || processes.length > 0;
    if (!active) return {
        active: false,
        owned: false,
        services: [],
        registeredServices,
        foreignRegisteredServices,
        processIds: [],
        reason: foreignRegisteredServices.length > 0
            ? "Um serviço WireSock está registrado com outro perfil, GUI ou plugin."
            : null,
    };
    if (!configPath) return {
        active,
        owned: false,
        services,
        registeredServices,
        foreignRegisteredServices,
        processIds,
        reason: "WireSock já está ativo fora do perfil do plugin.",
    };

    const ownService = services.filter(name => containsConfig(serviceCommand(name), configPath));
    const ownProcess = processes.filter(process => containsConfig(process.commandLine, configPath));
    const explicitForeignService = services.filter(name => {
        const cmd = serviceCommand(name);
        if (!cmd) return false;
        return !containsConfig(cmd, configPath);
    });
    // WMI/CIM frequentemente não devolve CommandLine para um processo de
    // serviço quando o Discord não está elevado. Linha ausente é desconhecida,
    // não evidência de outro perfil. Só um caminho explicitamente diferente
    // deve transformar o estado em conflito.
    const hasExplicitForeignProcess = processes.some(process => Boolean(process.commandLine) && !containsConfig(process.commandLine, configPath));
    const ownedByPositiveProof = (ownService.length > 0 || ownProcess.length > 0)
        && explicitForeignService.length === 0
        && !hasExplicitForeignProcess
        && foreignRegisteredServices.length === 0;
    // Postura conservadora por exclusão: se NÃO temos nenhuma evidência
    // explícita de coisa externa (nenhum serviço com perfil diferente
    // confirmado, nenhum processo estranho confirmado, zero serviços
    // registrados em slots que não são os nossos), assumimos ownership
    // para evitar o bug do "falso externo" quando o WMI demora para
    // devolver CommandLine logo após o start do serviço.
    const ownedByExclusion = !ownedByPositiveProof
        && explicitForeignService.length === 0
        && !hasExplicitForeignProcess
        && foreignRegisteredServices.length === 0
        && registeredServices.every(name => VPN_SERVICE_NAMES.includes(name as typeof VPN_SERVICE_NAMES[number]));
    if (ownedByPositiveProof || ownedByExclusion)
        return { active, owned: true, services, registeredServices, foreignRegisteredServices, processIds, reason: null };
    return {
        active,
        owned: false,
        services,
        registeredServices,
        foreignRegisteredServices,
        processIds,
        reason: ownService.length > 0 || ownProcess.length > 0
            ? foreignRegisteredServices.length > 0 || explicitForeignService.length > 0
                ? "WireSock próprio e um serviço externo foram detectados ao mesmo tempo; a operação foi bloqueada."
                : "WireSock próprio e externo foram detectados ao mesmo tempo; a operação foi bloqueada."
            : "WireSock já está ativo por outro perfil, pela GUI ou por outro plugin.",
    };
}

export function wireSockSearchRoots(env: NodeJS.ProcessEnv = process.env): string[] {
    const programFiles = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files"]
        .filter((value): value is string => Boolean(value));
    const roots = new Set<string>();
    for (const directory of programFiles) roots.add(path.join(directory, "WireSock Secure Connect"));
    if (env.LOCALAPPDATA) roots.add(path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages"));
    return [...roots];
}

function pairIfPresent(executable: string): { executable: string; booster: string } | null {
    const booster = path.join(path.dirname(executable), "wgbooster.dll");
    return fs.existsSync(executable) && fs.existsSync(booster) ? { executable, booster } : null;
}

function candidatePairs(env: NodeJS.ProcessEnv = process.env): Array<{ executable: string; booster: string }> {
    const pairs: Array<{ executable: string; booster: string }> = [];
    const seen = new Set<string>();
    const add = (executable: string) => {
        const pair = pairIfPresent(executable);
        const key = executable.toLowerCase();
        if (pair && !seen.has(key)) {
            seen.add(key);
            pairs.push(pair);
        }
    };
    for (const root of wireSockSearchRoots(env)) {
        for (const relative of [WIRESOCK_EXECUTABLE, path.join("sdk", WIRESOCK_EXECUTABLE)]) add(path.join(root, relative));
        if (!/Packages$/i.test(root)) continue;
        try {
            for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
                if (!entry.isDirectory() || !/wiresock|ntkernel\.wiresock/i.test(entry.name)) continue;
                const packageRoot = path.join(root, entry.name);
                for (const layout of [packageRoot, path.join(packageRoot, "x64")]) {
                    add(path.join(layout, WIRESOCK_EXECUTABLE));
                    add(path.join(layout, "sdk", WIRESOCK_EXECUTABLE));
                }
            }
        } catch {}
    }
    return pairs;
}

async function versionOf(file: string): Promise<string | null> {
    const result = await powerShell(`(Get-Item -LiteralPath ${quotePowerShell(file)}).VersionInfo.FileVersion`, 5000);
    const output = result.stdout.trim();
    return result.code === 0 && /^\d+\.\d+\.\d+\.\d+$/.test(output) ? output : null;
}

function compareVersions(left: string, right: string): number {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let i = 0; i < 4; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) ? 1 : -1;
    }
    return 0;
}

export function selectWireSockCandidate(candidates: WireSockCandidate[]): WireSockCandidate | null {
    return candidates
        .filter(candidate => compareVersions(candidate.executableVersion, WIRESOCK_VERSION) >= 0)
        .filter(candidate => compareVersions(candidate.boosterVersion, WIRESOCK_VERSION) >= 0)
        .filter(candidate => candidate.executableVersion === candidate.boosterVersion)
        .sort((a, b) => compareVersions(b.executableVersion, a.executableVersion))[0] ?? null;
}

export async function findWireSockCandidate(env: NodeJS.ProcessEnv = process.env): Promise<WireSockCandidate | null> {
    if (!isWindows()) return null;
    const candidates: WireSockCandidate[] = [];
    for (const pair of candidatePairs(env)) {
        const [executableVersion, boosterVersion] = await Promise.all([versionOf(pair.executable), versionOf(pair.booster)]);
        if (executableVersion && boosterVersion) candidates.push({ ...pair, executableVersion, boosterVersion });
    }
    return selectWireSockCandidate(candidates);
}

function downloadInstaller(target: string, url = WIRESOCK_DOWNLOAD, redirects = 0): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== "https:" || !/(^|\.)wiresock\.net$/i.test(parsed.hostname)) {
                reject(new Error("Redirecionamento para host não autorizado do instalador WireSock."));
                return;
            }
        } catch {
            reject(new Error("URL oficial do WireSock inválida."));
            return;
        }
        const request = https.get(url, response => {
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                if (redirects >= 3) { reject(new Error("Muitos redirecionamentos no instalador WireSock.")); return; }
                // O endpoint oficial pode apontar para o CDN do próprio wiresock.net.
                const next = new URL(response.headers.location, url).toString();
                void downloadInstaller(target, next, redirects + 1).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`Download WireSock retornou HTTP ${response.statusCode ?? "desconhecido"}.`));
                return;
            }
            const output = fs.createWriteStream(target, { flags: "wx" });
            let total = 0;
            let done = false;
            const fail = (error: Error) => {
                if (done) return;
                done = true;
                response.destroy();
                output.destroy();
                reject(error);
            };
            response.on("data", (chunk: Buffer) => {
                total += chunk.length;
                if (total > MAX_DOWNLOAD_BYTES) fail(new Error("O instalador WireSock excede o limite de tamanho."));
            });
            response.once("error", fail);
            output.once("error", fail);
            response.pipe(output);
            output.once("finish", () => output.close(error => {
                if (error) fail(error);
                else if (!done) {
                    done = true;
                    resolve();
                }
            }));
        });
        request.setTimeout(120_000, () => request.destroy(new Error("Timeout ao baixar o instalador WireSock.")));
        request.once("error", reject);
    });
}

function sha256(file: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runElevatedInstaller(installer: string): Promise<void> {
    const command = `try { $p=Start-Process -FilePath ${quotePowerShell(installer)} -ArgumentList @('/quiet','/norestart') -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop; if($null -eq $p){ exit 1223 }; exit [int]$p.ExitCode } catch { if($_.Exception.NativeErrorCode -eq 1223){ exit 1223 }; Write-Error $_; exit 1 }`;
    return new Promise((resolve, reject) => {
        const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
            windowsHide: true,
            timeout: 120_000,
        }, error => error ? reject(error) : resolve());
        child.once("error", reject);
    });
}

let installInFlight: Promise<string> | null = null;

export function ensureWireSockInstalled(log: WireSockLogger): Promise<string> {
    installInFlight ??= ensureWireSockInstalledOnce(log).finally(() => { installInFlight = null; });
    return installInFlight;
}

async function ensureWireSockInstalledOnce(log: WireSockLogger): Promise<string> {
    if (!isWindows()) throw new Error("A VPN do plugin nesta versão exige Windows x64.");
    if (process.arch !== "x64") throw new Error("A VPN do plugin nesta versão exige Windows x64.");
    const existing = await findWireSockCandidate();
    if (existing) {
        log("info", "WireSock SDK compatível encontrado", { version: existing.executableVersion });
        return existing.executable;
    }

    const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "golive-plugin-wiresock-"));
    const installer = path.join(temporary, "wiresock-sdk.exe");
    try {
        log("info", "baixando instalador oficial do WireSock", { version: WIRESOCK_VERSION });
        await downloadInstaller(installer);
        if (sha256(installer).toLowerCase() !== WIRESOCK_INSTALLER_SHA256)
            throw new Error("Hash do instalador WireSock não corresponde ao release oficial fixado.");
        log("info", "instalando WireSock com elevação do Windows");
        await runElevatedInstaller(installer);
        const installed = await findWireSockCandidate();
        if (!installed) throw new Error("O instalador WireSock terminou, mas não deixou uma instalação SDK compatível.");
        return installed.executable;
    } catch (error) {
        const code = Number((error as { code?: unknown })?.code);
        if (code === 1223) throw new Error("UAC_CANCELLED: O Windows cancelou a solicitação de administrador para instalar o WireSock (1223).");
        throw new Error(`Não foi possível preparar o WireSock: ${logError(error)}`);
    } finally {
        await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
}

export function validateWireGuardProfile(raw: string): WireGuardConfigValidation {
    return validateWireGuardConfig(raw);
}

function serviceScript(executable: string, configPath: string): string {
    const expected = `"${executable}" service -config "${configPath}" -log-level info -network-lock disabled`;
    return `$ErrorActionPreference='Stop'
try {
  $name=${quotePowerShell(WIRESOCK_SERVICE_NAME)}
  $expected=${quotePowerShell(expected)}
  $config=${quotePowerShell(configPath)}
  $service=Get-Service -Name $name -ErrorAction SilentlyContinue
  $info=Get-CimInstance Win32_Service -Filter "Name='$name'"
  if($info -and $service -and $service.Status -ne 'Stopped' -and (-not $info.PathName -or $info.PathName.IndexOf($config,[System.StringComparison]::OrdinalIgnoreCase) -lt 0)){ throw 'O serviço WireSock já está registrado com outro perfil' }
  if($service -and $service.Status -ne 'Stopped') { Stop-Service -Name $name -Force; $service.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(20)) }
  if(-not $service) {
    & ${quotePowerShell(executable)} install -start-type 3 -config ${quotePowerShell(configPath)} -log-level info -network-lock disabled
    if($LASTEXITCODE -ne 0){ throw 'Falha ao instalar o serviço WireSock' }
  }
  $info=Get-CimInstance Win32_Service -Filter "Name='$name'"
  if(-not $info){ throw 'Serviço WireSock não encontrado após instalação' }
  $change=Invoke-CimMethod -InputObject $info -MethodName Change -Arguments @{PathName=$expected;StartMode='Manual'}
  if($change.ReturnValue -ne 0){ throw "Falha ao atualizar o perfil do serviço: $($change.ReturnValue)" }
  $actual=Get-CimInstance Win32_Service -Filter "Name='$name'"
  if($actual.PathName -cne $expected){ throw 'O serviço WireSock permaneceu com outra configuração' }
  Start-Service -Name $name
  (Get-Service -Name $name).WaitForStatus('Running',[TimeSpan]::FromSeconds(20))
  try { ${WIRESOCK_DNS_RESET} } catch {}
  try {
    $sc=Join-Path $env:SystemRoot 'System32\\sc.exe'
    & $sc failure $name reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
    if($LASTEXITCODE -ne 0){ throw "Falha ao configurar a recuperação automática do serviço WireSock: $LASTEXITCODE" }
    [System.IO.File]::WriteAllText(${quotePowerShell(recoveryMarkerPath(configPath))},${quotePowerShell(WIRESOCK_RECOVERY_MARKER)},[System.Text.Encoding]::ASCII)
  } catch {
    try { if($env:YANI_ELEVATED_WARNING_FILE){ [System.IO.File]::WriteAllText($env:YANI_ELEVATED_WARNING_FILE,$_.Exception.ToString(),[System.Text.Encoding]::UTF8) } } catch {}
  }
} catch {
  $detail=$_.Exception.ToString()
  if($env:YANI_ELEVATED_ERROR_FILE){ try { [System.IO.File]::WriteAllText($env:YANI_ELEVATED_ERROR_FILE,$detail,[System.Text.Encoding]::UTF8) } catch {} }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;
}

function elevatedPowerShellArgs(scriptPath: string, diagnosticPath: string): string[] {
    const wrapper = `$ErrorActionPreference='Stop'
$scriptPath=${quotePowerShell(scriptPath)}
$powershell=Join-Path $PSHOME 'powershell.exe'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=New-Object Security.Principal.WindowsPrincipal($identity)
$stage='elevation'
try {
  if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
    $stage='execution'
    & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath
    exit $LASTEXITCODE
  }
  $arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $scriptPath + '"'
  $child=Start-Process $powershell -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop -ArgumentList $arguments
  $stage='execution'
  if($null -eq $child -or $null -eq $child.ExitCode){ throw 'O Windows não retornou o código de saída do processo elevado.' }
  exit $child.ExitCode
} catch {
  $nativeCode=0
  $exception=$_.Exception
  while($null -ne $exception){
    if($exception -is [System.ComponentModel.Win32Exception]){ $nativeCode=$exception.NativeErrorCode; break }
    if($exception.HResult -eq -2147023673){ $nativeCode=1223; break }
    if($exception.HResult -eq -2147024891){ $nativeCode=5; break }
    $exception=$exception.InnerException
  }
  $detail="stage=$stage nativeCode=$nativeCode hresult=$($_.Exception.HResult) " + $_.Exception.ToString()
  try { [System.IO.File]::WriteAllText(${quotePowerShell(diagnosticPath)},$detail,[System.Text.Encoding]::UTF8) } catch {}
  if($stage -eq 'elevation' -and $nativeCode -eq 1223){ exit 1223 }
  if($stage -eq 'elevation' -and $nativeCode -eq 5){ exit 5 }
  [Console]::Error.WriteLine($detail)
  exit 1
}`;
    return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(wrapper, "utf16le").toString("base64")];
}

function recoveryMarkerPath(configPath: string): string {
    return `${path.resolve(configPath)}.recovery-v1`;
}

function writeRecoveryMarker(configPath: string, log: WireSockLogger): void {
    try {
        const marker = recoveryMarkerPath(configPath);
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, WIRESOCK_RECOVERY_MARKER, "utf8");
    } catch (error) {
        log("warn", "não consegui salvar o marcador da recuperação automática do WireSock", { erro: logError(error) });
    }
}

function writeRecoveryAttemptMarker(configPath: string, log: WireSockLogger): void {
    try {
        const marker = recoveryMarkerPath(configPath);
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, WIRESOCK_RECOVERY_ATTEMPT_MARKER, "utf8");
    } catch (error) {
        log("warn", "não consegui salvar o marcador da tentativa de recuperação automática do WireSock", { erro: logError(error) });
    }
}

function runElevatedPowerShell(script: string, timeoutMs: number): Promise<string> {
    const diagnosticDir = fs.mkdtempSync(path.join(os.tmpdir(), "yanineko-wiresock-elevation-"));
    const diagnosticPath = path.join(diagnosticDir, "error.txt");
    const scriptPath = path.join(diagnosticDir, "elevated.ps1");
    const warningPath = path.join(diagnosticDir, "warning.txt");
    const completedPath = path.join(diagnosticDir, "completed.txt");
    try {
        // Set these in the elevated script itself: RunAs may use another environment/account.
        const scriptBytes = Buffer.from(`$env:YANI_ELEVATED_ERROR_FILE=${quotePowerShell(diagnosticPath)}\n$env:YANI_ELEVATED_WARNING_FILE=${quotePowerShell(warningPath)}\n${script}\n[System.IO.File]::WriteAllText(${quotePowerShell(completedPath)},'ok')\nexit 0`, "utf16le");
        fs.writeFileSync(scriptPath, Buffer.concat([Buffer.from([0xff, 0xfe]), scriptBytes]));
    } catch (error) {
        try { fs.rmSync(diagnosticDir, { recursive: true, force: true }); } catch {}
        throw error;
    }
    return new Promise((resolve, reject) => {
        execFile("powershell.exe", elevatedPowerShellArgs(scriptPath, diagnosticPath), {
            windowsHide: true, timeout: timeoutMs, encoding: "utf8",
        }, (error, _stdout, stderr) => {
            try {
                if (!error && fs.existsSync(completedPath)) {
                    let warning = "";
                    try { warning = fs.readFileSync(warningPath, "utf8").replace(/^\uFEFF/, "").trim(); } catch {}
                    resolve(warning); return;
                }
                let childDetail = "";
                try { childDetail = fs.readFileSync(diagnosticPath, "utf8").replace(/^\uFEFF/, "").trim(); } catch {}
                const detail = childDetail || String(stderr || "").trim();
                const code = (error as NodeJS.ErrnoException | null)?.code;
                const codeText = code === undefined ? "" : String(code);
                const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | null;
                const fail = (kind: string, message: string) => reject(Object.assign(new Error(`${kind}: ${message}${detail ? ` | ${detail}` : ""}`), { code: kind }));
                if (failure?.killed) {
                    fail("ELEVATION_TIMEOUT", `Tempo de autorização/execução excedido (${failure.signal || "timeout"}).`);
                    return;
                }
                if (codeText === "1223") {
                    fail("UAC_CANCELLED", "O Windows cancelou a solicitação de administrador (1223). Tente novamente pelo botão Ativar bypass e autorize a janela do Windows.");
                    return;
                }
                if (codeText === "5") { fail("ELEVATION_DENIED", "O Windows negou a solicitação de administrador (5)."); return; }
                fail("POWERSHELL_FAILED", code !== undefined ? `PowerShell encerrou com código ${codeText}.` : "PowerShell não confirmou a conclusão do script.");
            } finally {
                try { fs.rmSync(diagnosticDir, { recursive: true, force: true }); } catch {}
            }
        });
    });
}

export async function ensureWireSockRecovery(configPath: string, log: WireSockLogger): Promise<boolean> {
    if (!isWindows()) return false;
    const marker = recoveryMarkerPath(configPath);
    try {
        const existingMarker = fs.readFileSync(marker, "utf8");
        if (existingMarker === WIRESOCK_RECOVERY_MARKER) return true;
        if (existingMarker === WIRESOCK_RECOVERY_ATTEMPT_MARKER) return false;
    } catch { /* Instalações anteriores ainda não têm a configuração. */ }
    const script = `$ErrorActionPreference='Stop'
try {
  $name=${quotePowerShell(WIRESOCK_SERVICE_NAME)}
  $service=Get-Service -Name $name -ErrorAction Stop
  $sc=Join-Path $env:SystemRoot 'System32\\sc.exe'
  & $sc failure $name reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
  if($LASTEXITCODE -ne 0){ throw "Falha ao configurar a recuperação automática do serviço WireSock: $LASTEXITCODE" }
} catch {
  $detail=$_.Exception.ToString()
  if($env:YANI_ELEVATED_ERROR_FILE){ try { [System.IO.File]::WriteAllText($env:YANI_ELEVATED_ERROR_FILE,$detail,[System.Text.Encoding]::UTF8) } catch {} }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;
    try {
        await runElevatedPowerShell(script, 30_000);
        writeRecoveryMarker(configPath, log);
        log("info", "recuperação automática do WireSock configurada pelo Windows", { service: WIRESOCK_SERVICE_NAME });
        return true;
    } catch (error) {
        writeRecoveryAttemptMarker(configPath, log);
        log("warn", "não foi possível migrar a recuperação automática do WireSock", { erro: logError(error) });
        return false;
    }
}

export async function startWireSockService(
    configPath: string,
    rawConfig: string,
    allowedAppPaths: string[],
    log: WireSockLogger,
): Promise<WireSockStartResult> {
    if (!isWindows() || process.arch !== "x64") throw new Error("A VPN do plugin nesta versão exige Windows x64.");
    const allowedApps = formatAllowedApps(allowedAppPaths);
    const validation = validateWireGuardProfile(rawConfig);
    if (!validation.valid) throw new Error(validation.error);

    const current = await inspectWireSockAsync(configPath);
    if (current.active && !current.owned) throw new Error(current.reason || "WireSock externo já está ativo.");
    const executable = await ensureWireSockInstalled(log);
    // A instalação do SDK pode demorar e outro plugin/GUI pode registrar o
    // slot nesse intervalo. Reinspecione imediatamente antes de escrever e
    // iniciar o serviço; o script elevado também recusa um serviço em execução
    // registrado com outro perfil.
    const beforeStart = await inspectWireSockAsync(configPath);
    if (beforeStart.active && !beforeStart.owned) throw new Error(beforeStart.reason || "WireSock externo já está ativo.");
    const target = path.resolve(configPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const sanitized = sanitizeWireGuardConfig(rawConfig, allowedApps);
    const staging = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(staging, sanitized, "utf8");
    fs.renameSync(staging, target);

    try {
        const warning = await runElevatedPowerShell(serviceScript(executable, target), 120_000);
        if (warning) {
            writeRecoveryAttemptMarker(target, log);
            log("warn", "VPN iniciada; recuperação automática do serviço não configurada", { erro: safeDiagnosticDetail(warning, 800) });
        }
    } catch (error) {
        const detail = logError(error);
        const consent = ["UAC_CANCELLED", "ELEVATION_DENIED", "ELEVATION_TIMEOUT"].includes(String((error as { code?: unknown })?.code));
        log(consent ? "warn" : "error", "falha ao iniciar o serviço WireSock", { erro: detail });
        if (consent) throw error;
        throw new Error(`Não foi possível configurar/iniciar o serviço WireSock: ${detail}`);
    }

    let inspection: WireSockInspection | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
        await wait(attempt < 3 ? 500 : 900);
        try {
            inspection = await inspectWireSockAsync(target);
        } catch (error) {
            inspection = null;
            log("warn", "consulta inconclusiva durante partida do WireSock", { tentativa: attempt + 1, erro: logError(error) });
            continue;
        }
        if (inspection.active && inspection.owned) break;
        log("warn", "aguardando WireSock confirmar perfil próprio após ativação", { tentativa: attempt + 1, active: inspection.active, owned: inspection.owned, motivo: inspection.reason });
    }
    if (!inspection || !inspection.active) {
        log("error", "WireSock não ficou ativo após a ativação", { motivo: inspection?.reason || "serviço ausente" });
        throw new Error("O serviço WireSock não ficou ativo após a ativação. Rode 0-LIMPAR-WIRESOCK.bat e tente novamente.");
    }
    if (!inspection.owned) {
        log("error", "WireSock não confirmou ownership e há conflito externo detectado", { motivo: inspection.reason });
        throw new Error(`WireSock em conflito: ${inspection.reason || "serviço externo"}. Feche a GUI do WireSock/Outro plugin e tente novamente.`);
    }
    log("info", "serviço WireSock ativo com filtro por aplicativo", { config: target, allowedApps });
    return { executable, configPath: target, allowedApps };
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function cleanupResult(stopped: boolean, inspection: Pick<WireSockInspection, "services" | "processIds"> | null, error?: string): WireSockCleanupResult {
    return {
        stopped,
        servicesResidual: inspection?.services ?? [],
        processResidual: inspection?.processIds ?? [],
        networkLockReset: stopped,
        dnsCleared: stopped,
        dnsFlushed: stopped,
        ...(error ? { error } : {}),
    };
}

function powerShellArray(values: Array<string | number>): string {
    return `@(${values.map(value => typeof value === "number" ? String(value) : quotePowerShell(value)).join(",")})`;
}

// Executado elevado, em um único pedido de UAC. Stop-Service é uma parada limpa
// e não aciona as ações de recuperação do SCM. Só se o processo não sair é que
// o serviço vira Disabled antes do kill: matar o processo de um serviço com
// "restart" configurado faria o Windows recriá-lo 5s depois. O próximo start
// do plugin volta o StartMode para Manual.
function ownedStopScript(configPath: string, processIds: number[], executable: string | undefined): string {
    return `$ErrorActionPreference='Stop'
try {
  $name=${quotePowerShell(WIRESOCK_SERVICE_NAME)}
  $config=${quotePowerShell(configPath)}
  $known=${powerShellArray(processIds)}
  $info=Get-CimInstance Win32_Service -Filter "Name='$name'"
  $ownService=[bool]($info -and $info.PathName -and $info.PathName.IndexOf($config,[System.StringComparison]::OrdinalIgnoreCase) -ge 0)
  if($ownService -and $info.State -ne 'Stopped'){
    Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
    try { (Get-Service -Name $name).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(15)) } catch {}
  }
  $servicePid=if($ownService){ [int]$info.ProcessId } else { 0 }
  $left=@(Get-CimInstance Win32_Process -Filter "Name='wiresock-client.exe'" | Where-Object {
    ($_.CommandLine -and $_.CommandLine.IndexOf($config,[System.StringComparison]::OrdinalIgnoreCase) -ge 0) -or
    (-not $_.CommandLine -and (($servicePid -gt 0 -and [int]$_.ProcessId -eq $servicePid) -or $known -contains [int]$_.ProcessId))
  })
  if($left.Count -gt 0){
    if($ownService){ Set-Service -Name $name -StartupType Disabled -ErrorAction SilentlyContinue }
    $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
  }
  ${executable ? `try { & ${quotePowerShell(executable)} reset-network-lock | Out-Null } catch {}` : ""}
  try { ${WIRESOCK_DNS_RESET} } catch {}
  try { & (Join-Path $env:SystemRoot 'System32\\ipconfig.exe') /flushdns | Out-Null } catch {}
} catch {
  $detail=$_.Exception.ToString()
  if($env:YANI_ELEVATED_ERROR_FILE){ try { [System.IO.File]::WriteAllText($env:YANI_ELEVATED_ERROR_FILE,$detail,[System.Text.Encoding]::UTF8) } catch {} }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;
}

async function confirmStopped(configPath: string | undefined): Promise<WireSockInspection | null> {
    let last: WireSockInspection | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
        await wait(attempt === 0 ? 300 : 1000);
        try {
            last = await inspectWireSockAsync(configPath);
            if (!last.active) return last;
        } catch { /* estado transitório: tenta de novo */ }
    }
    return last;
}

export async function stopOwnedWireSock(configPath: string, log: WireSockLogger): Promise<WireSockCleanupResult> {
    if (!isWindows()) return cleanupResult(true, null);
    let initial: WireSockInspection;
    try {
        initial = await inspectWireSockAsync(configPath);
    } catch (error) {
        return cleanupResult(false, null, `Estado do WireSock inconclusivo: ${logError(error)}`);
    }
    if (initial.foreignRegisteredServices.length > 0) {
        const error = initial.reason || "Serviço WireSock externo registrado";
        log("warn", "limpeza recusada para preservar serviço WireSock externo", { motivo: error });
        return cleanupResult(false, initial, error);
    }
    if (initial.active && !initial.owned) {
        const error = initial.reason || "WireSock externo detectado";
        log("warn", "limpeza recusada para preservar WireSock externo", { motivo: error });
        return cleanupResult(false, initial, error);
    }
    if (!initial.active) {
        log("info", "WireSock próprio já estava parado");
        return cleanupResult(true, initial);
    }

    const executable = (await findWireSockCandidate())?.executable;
    try {
        await runElevatedPowerShell(ownedStopScript(path.resolve(configPath), initial.processIds, executable), 90_000);
    } catch (error) {
        const detail = logError(error);
        log("warn", "parada elevada do WireSock próprio falhou", { erro: detail });
        const residual = await confirmStopped(configPath);
        if (residual && !residual.active) return cleanupResult(true, residual);
        return cleanupResult(false, residual ?? initial, `Não foi possível parar o WireSock próprio: ${detail}`);
    }
    const residual = await confirmStopped(configPath);
    const stopped = Boolean(residual && !residual.active);
    if (stopped) log("info", "WireSock próprio e processo verificados como parados");
    else log("error", "limpeza deixou resíduo WireSock próprio", { services: residual?.services, pids: residual?.processIds });
    return cleanupResult(stopped, residual ?? initial, stopped ? undefined : "O WireSock próprio ainda permanece ativo.");
}

function nuclearScript(executable: string | undefined, deleteServices: boolean): string {
    return `$ErrorActionPreference='SilentlyContinue'
$names=${powerShellArray([...VPN_SERVICE_NAMES])}
foreach($name in $names){
  if(Get-Service -Name $name -ErrorAction SilentlyContinue){
    Set-Service -Name $name -StartupType Disabled
    Stop-Service -Name $name -Force
  }
}
Get-Process -Name 'wiresock-client' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 1500
${deleteServices ? "foreach($name in $names){ & (Join-Path $env:SystemRoot 'System32\\sc.exe') delete $name | Out-Null }" : ""}
${executable ? `try { & ${quotePowerShell(executable)} reset-network-lock | Out-Null } catch {}` : ""}
try { ${WIRESOCK_DNS_RESET} } catch {}
& (Join-Path $env:SystemRoot 'System32\\ipconfig.exe') /flushdns | Out-Null
exit 0`;
}

async function runNuclear(log: WireSockLogger, deleteServices: boolean): Promise<{ result: WireSockCleanupResult; inspection: WireSockInspection | null }> {
    const executable = (await findWireSockCandidate())?.executable;
    try {
        await runElevatedPowerShell(nuclearScript(executable, deleteServices), 90_000);
    } catch (error) {
        log("warn", "limpeza global elevada do WireSock falhou", { erro: logError(error) });
    }
    const inspection = await confirmStopped(undefined);
    const stopped = Boolean(inspection && !inspection.active);
    if (stopped) log("info", "limpeza global: serviço e processos WireSock verificados como parados");
    else log("error", "limpeza global deixou resíduo WireSock", { services: inspection?.services, pids: inspection?.processIds });
    return { result: cleanupResult(stopped, inspection, stopped ? undefined : "WireSock residual detectado após limpeza global."), inspection };
}

export async function stopAllWireSockNuclear(log: WireSockLogger): Promise<WireSockCleanupResult> {
    if (!isWindows()) return cleanupResult(true, null);
    return (await runNuclear(log, false)).result;
}

export async function wipeWireSockHard(log: WireSockLogger): Promise<{ stopped: boolean; servicesDeletedCount: number }> {
    if (!isWindows()) return { stopped: true, servicesDeletedCount: 0 };
    const { result, inspection } = await runNuclear(log, true);
    const remaining = inspection?.registeredServices.length ?? VPN_SERVICE_NAMES.length;
    return { stopped: result.stopped, servicesDeletedCount: VPN_SERVICE_NAMES.length - remaining };
}

function httpsCheck(url: string): Promise<boolean> {
    return new Promise(resolve => {
        const request = https.get(url, { timeout: 7000 }, response => {
            response.resume();
            response.once("end", () => resolve(true));
        });
        request.once("timeout", () => { request.destroy(); resolve(false); });
        request.once("error", () => resolve(false));
    });
}

export async function diagnoseWindowsNetwork(log: WireSockLogger): Promise<WindowsNetworkDiagnostic> {
    if (!isWindows()) return { ok: true, dnsOk: true, httpsOk: true, detail: "plataforma fora do escopo Windows" };
    const dnsOk = await Promise.all(["www.microsoft.com", "gateway.discord.gg", "updates.discord.com"].map(host => dns.lookup(host).then(() => true).catch(() => false))).then(results => results.every(Boolean));
    const httpsResults = await Promise.all([
        httpsCheck("https://www.microsoft.com/generate_204"),
        httpsCheck("https://discord.com/api/v9/gateway"),
        httpsCheck("https://updates.discord.com/"),
    ]);
    const httpsOk = httpsResults.some(Boolean);
    const result = { ok: dnsOk && httpsOk, dnsOk, httpsOk, detail: dnsOk && httpsOk ? "diagnóstico concluído" : "DNS/HTTPS apresentou falha" };
    log(result.ok ? "info" : "warn", "diagnóstico assíncrono da rede", { ...result, mode: "log-only" });
    return result;
}

export function routeProbeExecutablePath(directory: string): string {
    return path.join(directory, `.golive-route-probe-${process.pid}-${Date.now()}.exe`);
}

export function copyRouteProbe(source: string, target: string): void {
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error("Helper de diagnóstico Proton não encontrado.");
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}

export function removeRouteProbe(target: string): void {
    try { fs.rmSync(target, { force: true }); } catch {}
}

export function runRouteProbe(executable: string): Promise<Record<string, unknown> | null> {
    return new Promise(resolve => {
        execFile(executable, ["-route-probe"], { windowsHide: true, timeout: 12_000, encoding: "utf8" }, (_error, stdout) => {
            try {
                const parsed = JSON.parse(String(stdout).trim()) as unknown;
                return resolve(parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : null);
            } catch {
                return resolve(null);
            }
        });
    });
}

export interface EndpointPingResult {
    host: string;
    port: number;
    pingMs: number;
}

// O endpoint WireGuard só escuta UDP; um connect TCP nunca mede nada. Usa ICMP
// (ping.exe), cuja saída traz "tempo=XXms"/"time<1ms" em qualquer idioma.
export async function pingEndpoint(host: string, port = 51820, timeoutMs = 2500): Promise<EndpointPingResult | null> {
    if (!isWindows() || !host || !host.trim()) return null;
    const normalized = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
    if (!/^[a-z0-9.:-]+$/.test(normalized) || normalized.startsWith("-")) return null;
    const result = await execFileText("ping.exe", ["-n", "1", "-w", String(timeoutMs), normalized], timeoutMs + 3000);
    if (result.code !== 0) return null;
    const match = /[=<]\s*(\d+)\s*ms\b/i.exec(result.stdout);
    if (!match) return null;
    const pingMs = Math.max(1, Number(match[1]));
    return Number.isFinite(pingMs) && pingMs <= timeoutMs * 4 ? { host: normalized, port, pingMs } : null;
}

export function extractEndpointFromWireGuardConfig(raw: string): { host: string; port: number } | null {
    for (const line of String(raw || "").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const match = /^Endpoint\s*=\s*(?:\[([^\]]+)\]|([^\s:]+))(?::(\d+))?/i.exec(trimmed);
        if (!match) continue;
        const host = (match[1] ?? match[2] ?? "").trim();
        const port = match[3] ? parseInt(match[3], 10) : 51820;
        if (!host) continue;
        return { host, port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 51820 };
    }
    return null;
}
