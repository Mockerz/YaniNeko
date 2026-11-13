import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SESSION_BACKUP_AAD = Buffer.from("YaniNeko Proton session backup v1", "utf8");
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface SessionBackupEnvelope {
    version: 1;
    algorithm: "aes-256-gcm";
    iv: string;
    tag: string;
    ciphertext: string;
}

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

function backupKey(secret: string): Buffer {
    if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error("Invalid device secret");
    return createHash("sha256").update(SESSION_BACKUP_AAD).update(secret, "hex").digest();
}

export function encryptSessionBackup(secret: string, plaintext: string): SessionBackupEnvelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", backupKey(secret), iv);
    cipher.setAAD(SESSION_BACKUP_AAD);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
        version: 1,
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
    };
}

export function decryptSessionBackup(secret: string, value: unknown): string | null {
    try {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
        const raw = value as Partial<SessionBackupEnvelope>;
        if (raw.version !== 1 || raw.algorithm !== "aes-256-gcm"
            || typeof raw.iv !== "string" || !BASE64.test(raw.iv)
            || typeof raw.tag !== "string" || !BASE64.test(raw.tag)
            || typeof raw.ciphertext !== "string" || !BASE64.test(raw.ciphertext)) return null;
        const iv = Buffer.from(raw.iv, "base64");
        const tag = Buffer.from(raw.tag, "base64");
        const ciphertext = Buffer.from(raw.ciphertext, "base64");
        if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0 || ciphertext.length > 64 * 1024) return null;
        const decipher = createDecipheriv("aes-256-gcm", backupKey(secret), iv);
        decipher.setAAD(SESSION_BACKUP_AAD);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch { return null; }
}

export async function sessionBackupRequest(
    base: string,
    dir: string,
    action: "put" | "get" | "delete",
    backup?: SessionBackupEnvelope,
) {
    return fetch(`${base}/session-backup`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" },
        body: JSON.stringify({ action, ...(backup ? { backup } : {}), ...deviceCredentials(dir) }),
    });
}
