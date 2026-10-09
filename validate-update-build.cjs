const fs = require("node:fs");
const path = require("node:path");
const u = require("./auto-update.cjs");
const installed = path.join(process.env.LOCALAPPDATA, "LefferzinBypass/Vencord");
const testRoot = path.join(__dirname, "build", "update-validation-" + Date.now());
const source = path.join(testRoot, "source");
fs.mkdirSync(source, { recursive: true });
for (const file of ["manifest.json", "index.tsx", "native.ts", "presence.ts", "stability.ts", "vpn-controller.ts", "vpn-proton.ts", "vpn-types.ts", "vpn-windows.ts", "auto-update.cjs", "bin/win32-x64/proton-confgen.exe"]) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.copyFileSync(path.join(__dirname, file), path.join(source, file));
}
const work = path.join(testRoot, "build");
u.prepareBuild(installed, work, source);
fs.symlinkSync(path.join(installed, "node_modules"), path.join(work, "node_modules"), "junction");
u.compile(installed, work);
const dist = path.join(work, "dist");
fs.mkdirSync(path.join(dist, "bin/win32-x64"), { recursive: true });
fs.copyFileSync(path.join(source, "bin/win32-x64/proton-confgen.exe"), path.join(dist, "bin/win32-x64/proton-confgen.exe"));
u.seal(dist); u.validateRelease(dist);
const renderer = fs.readFileSync(path.join(dist, "renderer.js"), "utf8");
if (!renderer.includes(JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8")).version) || !renderer.includes("Bypass de Tela/Cam - V")) throw new Error("Versioned presence missing");
console.log("PASS full Vencord build, isolated staging, artifact hashes, versioned presence");
console.log(dist);