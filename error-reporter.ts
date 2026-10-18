// Only plugin diagnostics are uploaded; never read account/session or VPN files.
export function redactReport(value: string): string {
    return value
        .replace(/https?:\/\/[^\s"'<>]+/gi, "<url removida>")
        .replace(/(["']?(?:password|senha|token|accessToken|refreshToken|secret|authorization|cookie|privatekey|presharedkey|publickey|protonUsername|username)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, "$1<removido>")
        .replace(/\bBearer\s+\S+/gi, "Bearer <removido>")
        .replace(/\b[A-Za-z0-9+/]{43}=/g, "<chave removida>")
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<email removido>")
        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip removido>")
        .replace(/\b(?:[a-f0-9]{0,4}:){2,}[a-f0-9:]{0,39}\b/gi, "<ipv6 removido>")
        .replace(/[A-Z]:\\Users\\[^\\\r\n]+/gi, "<perfil local>")
        .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, "<token removido>");
}

export function reportFilename(username: string): string {
    const name = username.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/\.+/g, ".").slice(0, 64) || "usuario-desconhecido";
    return `erro.${name}.log`;
}

export function validWebhook(value: string): boolean {
    return /^https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(value);
}

export class ErrorReporter {
    private username = "";
    private pending: string[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private nextSend = 0;
    private busy = false;
    constructor(private options: {
        webhook: () => string;
        enabled: () => boolean;
        version: string;
        diagnostic: () => string;
        status: (message: string) => void;
        send?: typeof fetch;
        now?: () => number;
    }) {}

    setUsername(value: unknown): void {
        const next = typeof value === "string" ? value.slice(0, 64) : "";
        if (!next || (this.username && this.username !== next)) this.pending = [];
        this.username = next;
        this.schedule();
    }
    capture(message: string): void {
        if (!this.options.enabled()) { this.pending = []; return; }
        const safe = redactReport(message).slice(0, 2000);
        if (!this.pending.includes(safe)) this.pending.push(safe);
        this.pending = this.pending.slice(-20);
        this.schedule();
    }
    private schedule(): void {
        if (this.timer || !this.username || !this.pending.length) return;
        const now = this.options.now?.() ?? Date.now();
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.flush();
        }, Math.max(5000, this.nextSend - now));
        this.timer.unref?.();
    }
    async flush(): Promise<void> {
        const now = this.options.now?.() ?? Date.now();
        if (this.busy || !this.username || !this.pending.length || now < this.nextSend) return;
        if (!this.options.enabled()) { this.pending = []; return; }
        const webhook = this.options.webhook();
        if (!validWebhook(webhook)) { this.pending = []; return; }
        const events = this.pending.splice(0);
        this.busy = true;
        this.nextSend = now + 5 * 60_000;
        try {
            const text = `Yani Neko ${this.options.version}\n${new Date(now).toISOString()}\n\nErros:\n${events.join("\n")}\n\nDiagnóstico recente:\n${redactReport(this.options.diagnostic()).slice(-30000)}`;
            const form = new FormData();
            form.append("payload_json", JSON.stringify({ content: `Erro no Yani Neko ${this.options.version}. Diagnóstico anexado.`, allowed_mentions: { parse: [] } }));
            form.append("files[0]", new Blob([text], { type: "text/plain;charset=utf-8" }), reportFilename(this.username));
            const response = await (this.options.send ?? fetch)(`${webhook}?wait=true`, {
                method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(15000)
            });
            if (!response.ok) {
                if (response.status === 429) {
                    const retry = Number((await response.json()).retry_after);
                    if (Number.isFinite(retry)) this.nextSend = now + Math.max(300000, Math.min(retry * 1000, 3600000));
                }
                throw new Error(`HTTP ${response.status}`);
            }
            this.options.status("relatório de erro enviado");
        } catch {
            // Do not recursively report upload failures or persist sensitive queues.
            this.options.status("não foi possível enviar o relatório; diagnóstico preservado no log local");
        } finally {
            this.busy = false;
            this.schedule();
        }
    }
}
