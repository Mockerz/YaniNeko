"use strict";
// Runs with Node for staging; Electron only selects an already-built version at boot.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const REPO = "Mockerz/YaniNeko";
const BRANCH = "main";
const INTERVAL = 60 * 60 * 1000;
const REQUIRED = ["manifest.json", "index.tsx", "native.ts", "presence.ts", "stability.ts", "vpn-controller.ts", "vpn-proton.ts", "vpn-types.ts", "vpn-windows.ts", "bin/win32-x64/proton-confgen.exe"];
const ARTIFACTS = ["patcher.js", "preload.js", "renderer.js", "bin/win32-x64/proton-confgen.exe"];
const validId = id => typeof id === "string" && /^(?:[a-f0-9]{40}|local-[a-f0-9]{32})$/.test(id);
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const home = root => path.join(root, ".yanineko-updates");
function read(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2));
    fs.renameSync(temp, file);
}
function log(root, message) {
    try {
        const file = path.join(home(root), "updater.log");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + ".previous");
        fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
    } catch { /* Updating must never prevent Discord from opening. */ }
}
function alive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function inside(base, relative) {
    if (typeof relative !== "string" || relative.includes("\\") || relative.includes(":")) throw new Error("Invalid relative path");
    const target = path.resolve(base, relative);
    if (!target.startsWith(path.resolve(base) + path.sep)) throw new Error("Path outside update directory");
    let cursor = target;
    while (cursor !== path.resolve(base)) {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Linked update path");
        cursor = path.dirname(cursor);
    }
    return target;
}
function release(root, id) {
    if (!validId(id)) throw new Error("Invalid revision");
    return inside(home(root), `releases/${id}`);
}
function files(dir, prefix = "") {
    return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap(entry => {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error("Linked artifact");
        return entry.isDirectory() ? files(dir, relative) : [relative];
    });
}
function seal(dir) {
    const hashes = {};
    for (const name of files(dir).filter(n => n !== "update-hashes.json")) hashes[name] = hash(fs.readFileSync(inside(dir, name)));
    write(path.join(dir, "update-hashes.json"), hashes);
}
function validateRelease(dir) {
    const hashes = read(path.join(dir, "update-hashes.json"));
    if (!hashes || ARTIFACTS.some(name => !hashes[name])) throw new Error("Incomplete build manifest");
    for (const [name, expected] of Object.entries(hashes)) {
        const data = fs.readFileSync(inside(dir, name));
        if (hash(data) !== expected) throw new Error(`Corrupted build: ${name}`);
    }
    if (!fs.readFileSync(path.join(dir, "renderer.js"), "utf8").includes("LefferzinBypass")) throw new Error("Plugin missing from build");
}
function copyTree(source, target) {
    fs.cpSync(source, target, { recursive: true, filter(file) {
        if (path.basename(file) === "node_modules") return false;
        if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Linked source: ${file}`);
        return true;
    } });
}
function install(root, source, node = process.execPath) {
    root = fs.realpathSync(root);
    const revision = read(path.join(source, ".source-commit.json"))?.sha;
    const id = `local-${crypto.randomUUID().replaceAll("-", "")}`;
    const target = release(root, id);
    if (fs.existsSync(target)) throw new Error("Revision already installed; rebuild with a fresh local revision");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    copyTree(path.join(root, "dist"), target);
    fs.copyFileSync(path.join(source, "auto-update.cjs"), path.join(target, "auto-update.cjs"));
    seal(target); validateRelease(target);
    fs.copyFileSync(path.join(source, "auto-update.cjs"), path.join(root, "yanineko-updater.cjs"));
    write(path.join(home(root), "config.json"), { node });
    write(path.join(home(root), "active.json"), { active: id, commit: validId(revision) ? revision : null });
    fs.rmSync(path.join(home(root), "pending.json"), { force: true });
    // Stable entry point kept at the path already referenced by the official injector.
    fs.writeFileSync(path.join(root, "dist/patcher.js"), '"use strict";\nrequire("../yanineko-updater.cjs").boot(require("node:path").resolve(__dirname, ".."));\n');
    log(root, `Installed updater; baseline ${id}`);
}
function choose(root) {
    const statePath = path.join(home(root), "active.json");
    const state = read(statePath);
    if (!validId(state?.active)) throw new Error("No installed update baseline");
    // Another Discord process can still be using the active version.
    if (alive(state.pid) && state.pid !== process.pid) return state.active;
    const pendingPath = path.join(home(root), "pending.json");
    const pending = read(pendingPath);
    if (pending) {
        try {
            validateRelease(release(root, pending.id));
            if (pending.id !== state.rejected) {
                state.previous = state.active;
                state.active = pending.id;
                state.commit = pending.id;
                log(root, `Applying ${pending.id} on startup`);
            }
        } catch (error) { log(root, `Pending update rejected: ${error.message}`); }
        fs.rmSync(pendingPath, { force: true });
    }
    state.pid = process.pid;
    write(statePath, state);
    return state.active;
}
function boot(root) {
    let id;
    try { id = choose(root); }
    catch (error) {
        log(root, `Could not select update: ${error.message}`);
        id = read(path.join(home(root), "active.json"))?.active;
        if (!validId(id)) throw error;
    }
    try {
        require(path.join(release(root, id), "patcher.js"));
    } catch (error) {
        const state = read(path.join(home(root), "active.json"));
        if (state?.active === id && validId(state.previous)) {
            write(path.join(home(root), "active.json"), { active: state.previous, rejected: id });
            log(root, `Startup failed; restored previous version for next launch: ${error.message}`);
        }
        throw error;
    }
    const check = () => {
        try {
            const node = read(path.join(home(root), "config.json"))?.node;
            if (!node || !fs.existsSync(node)) return;
            const worker = path.join(release(root, id), "auto-update.cjs");
            const child = spawn(node, [worker, "--check", root], { detached: true, windowsHide: true, stdio: "ignore" });
            child.on("error", error => log(root, `Worker could not start: ${error.message}`));
            child.unref();
        } catch (error) { log(root, `Update check unavailable: ${error.message}`); }
    };
    const timer = setTimeout(() => {
        check();
        const periodic = setInterval(check, INTERVAL); periodic.unref();
    }, 30_000);
    timer.unref();
}
async function download(url, limit = 4 * 1024 * 1024) {
    const response = await fetch(url, { headers: { "User-Agent": "YaniNeko-auto-update", Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Download HTTP ${response.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new Error("Download too large");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
function pluginFile(name) {
    return !name.split("/").some(p => p.startsWith(".") || ["node_modules", "build", "dist", "tests"].includes(p))
        && !/(^|\/)test[-_.]/.test(name)
        && (/\.(?:tsx?|m?js|cjs|json|css|svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|wasm)$/.test(name) || name === REQUIRED.at(-1));
}
async function fetchSource(target, sha, get = download) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid GitHub commit");
    const tree = JSON.parse(await get(`https://api.github.com/repos/${REPO}/git/trees/${sha}?recursive=1`));
    if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("Incomplete repository tree");
    const entries = tree.tree.filter(e => e.type === "blob" && pluginFile(e.path));
    if (entries.length > 500 || entries.reduce((sum, e) => sum + (e.size || 0), 0) > 64 * 1024 * 1024) throw new Error("Repository exceeds update limits");
    if (REQUIRED.some(name => !entries.some(e => e.path === name))) throw new Error("Required plugin file missing");
    for (const entry of entries) {
        if (!["100644", "100755"].includes(entry.mode)) throw new Error("Unsupported Git file mode");
        const file = inside(target, entry.path);
        const data = await get(`https://raw.githubusercontent.com/${REPO}/${sha}/${entry.path}`, 32 * 1024 * 1024);
        const actual = crypto.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
        if (actual !== entry.sha) throw new Error(`Source hash mismatch: ${entry.path}`);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data);
    }
    const binary = fs.readFileSync(path.join(target, REQUIRED.at(-1)));
    if (binary.length < 4096 || binary.subarray(0, 2).toString() !== "MZ") throw new Error("Invalid Proton helper");
}
function prepareBuild(root, work, source) {
    for (const name of ["src", "scripts", "packages", "package.json", "tsconfig.json"]) {
        if (fs.existsSync(path.join(root, name))) copyTree(path.join(root, name), path.join(work, name));
    }
    const plugin = inside(work, "src/userplugins/LefferzinBypass");
    fs.rmSync(plugin, { recursive: true, force: true });
    copyTree(source, plugin);
}
function compile(root, work) {
    const result = spawnSync(process.execPath, ["--require=./scripts/suppressExperimentalWarnings.js", "scripts/build/build.mjs", "--disable-updater"], {
        cwd: work, windowsHide: true, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, VENCORD_HASH: "yanineko", VENCORD_REMOTE: "Vendicated/Vencord" },
    });
    if (result.status !== 0) throw new Error(`Build failed: ${(result.stderr || result.error?.message || result.stdout || "unknown").slice(-4000)}`);
}
async function check(root) {
    const base = home(root); fs.mkdirSync(base, { recursive: true });
    const lock = path.join(base, "worker.lock");
    let fd;
    try { fd = fs.openSync(lock, "wx"); }
    catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = read(lock);
        if (alive(owner?.pid) || Date.now() - fs.statSync(lock).mtimeMs < 60_000) return;
        fs.unlinkSync(lock); return check(root);
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd);
    let work;
    try {
        const state = read(path.join(base, "active.json"));
        if (!validId(state?.active) || read(path.join(base, "pending.json"))) return;
        const checked = read(path.join(base, "checked.json"));
        if (checked && Date.now() - checked.at < INTERVAL - 5_000) return;
        write(path.join(base, "checked.json"), { at: Date.now() });
        const commit = JSON.parse(await download(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`));
        const sha = commit.sha;
        if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid commit response");
        if (sha === state.active || sha === state.commit || sha === state.rejected) return;
        log(root, `Preparing revision ${sha}`);
        work = inside(base, `work-${crypto.randomUUID()}`);
        const source = path.join(work, "plugin"); fs.mkdirSync(source, { recursive: true });
        await fetchSource(source, sha);
        const build = path.join(work, "build");
        prepareBuild(root, build, source);
        compile(root, build);
        const dist = path.join(build, "dist");
        const bin = path.join(dist, "bin/win32-x64"); fs.mkdirSync(bin, { recursive: true });
        fs.copyFileSync(path.join(source, REQUIRED.at(-1)), path.join(bin, "proton-confgen.exe"));
        fs.copyFileSync(path.join(source, "auto-update.cjs"), path.join(dist, "auto-update.cjs"));
        seal(dist); validateRelease(dist);
        const target = release(root, sha);
        if (fs.existsSync(target)) validateRelease(target);
        else fs.renameSync(dist, target);
        write(path.join(base, "pending.json"), { id: sha, preparedAt: Date.now() });
        log(root, `Revision ${sha} ready for next Discord launch`);
    } catch (error) { log(root, `Update failed; current version preserved: ${error.message}`); }
    finally {
        if (work && fs.existsSync(work)) fs.rmSync(inside(base, path.basename(work)), { recursive: true, force: true });
        fs.rmSync(lock, { force: true });
    }
}
module.exports = { install, boot, choose, check, fetchSource, prepareBuild, compile, seal, validateRelease, inside, release, pluginFile };
if (require.main === module) {
    const [mode, root, source] = process.argv.slice(2);
    if (mode === "--install" && root && source) install(path.resolve(root), path.resolve(source));
    else if (mode === "--check" && root) check(path.resolve(root)).catch(error => { log(root, error.message); process.exitCode = 1; });
    else { console.error("Usage: auto-update.cjs --install VENCORD SOURCE | --check VENCORD"); process.exitCode = 1; }
}