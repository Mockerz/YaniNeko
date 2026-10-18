import { randomBytes, randomUUID } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export function deviceCredentials(dir: string): { installationId: string; secret: string } {
    mkdirSync(dir, { recursive: true });
    const read = (name: string, valid: RegExp, generate: () => string) => {
        const file = join(dir, name);
        try { const value = readFileSync(file, "utf8").trim(); if (valid.test(value)) return value; } catch {}
        const value = generate(); writeFileSync(file, value, { mode: 0o600 }); return value;
    };
    return {
        installationId: read("online-installation-id.txt", /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i, randomUUID),
        secret: read("device-secret.txt", /^[a-f0-9]{64}$/, () => randomBytes(32).toString("hex")),
    };
}

export async function devicePost(base: string, dir: string, path: string, data: object) {
    return fetch(`${base}${path}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
        headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" },
        body: JSON.stringify({ ...data, ...deviceCredentials(dir) }),
    });
}
