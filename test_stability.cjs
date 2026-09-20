// Execute com: node --test test_stability.cjs
// Usa o TypeScript da instalação local do Vencord; TYPESCRIPT_PATH pode substituí-lo.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(process.env.TYPESCRIPT_PATH || path.join(process.env.LOCALAPPDATA,
    'LefferzinBypass/Vencord/node_modules/typescript'));

function load(file, mocks = {}, globals = {}) {
    const exports = {};
    const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
        fileName: file,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
            jsx: ts.JsxEmit.React, esModuleInterop: true }
    }).outputText;
    vm.runInNewContext(code, { exports, process, console, Buffer, URL,
        require: name => Object.hasOwn(mocks, name) ? mocks[name]
            : name.startsWith('./') ? load(name + '.ts', mocks, globals) : require(name),
        ...globals }, { filename: file });
    return exports;
}

const stability = load('stability.ts');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('false/null não indicam transmissão; undefined é desconhecido', () => {
    for (const value of [false, null]) assert.equal(stability.normalizeStreamClaim(value), false);
    assert.equal(stability.normalizeStreamClaim(undefined), null);
    assert.equal(stability.normalizeStreamClaim({ id: 'stream' }), true);
});

test('amostra desconhecida exige uma nova janela contínua de 32 segundos', () => {
    const sample = { now: 1_000, senderClaimed: true, nativeStreamCount: 0 };
    let result = stability.evaluateStreamClaim(sample, stability.initialStreamClaimState());
    result = stability.evaluateStreamClaim({ ...sample, now: 31_000, nativeStreamCount: null }, result.state);
    assert.equal(result.status, 'unknown');
    result = stability.evaluateStreamClaim({ ...sample, now: 50_000 }, result.state);
    assert.equal(result.status, 'warming');
    assert.equal(result.warn, false);
    result = stability.evaluateStreamClaim({ ...sample, now: 82_000 }, result.state);
    assert.equal(result.warn, true);
    result = stability.evaluateStreamClaim({ ...sample, now: 83_000 }, result.state);
    assert.equal(result.warn, false);
    result = stability.evaluateStreamClaim({ ...sample, now: 84_000, nativeStreamCount: 1 }, result.state);
    assert.equal(result.status, 'healthy');
});

test('observação respeita conexão nativa e não inventa inatividade', () => {
    const sample = { senderClaimed: false, visibleStreamCount: 0, nativeStreamCount: 1 };
    assert.equal(stability.evaluateStreamObservation(sample).status, 'native-connected');
    assert.equal(stability.evaluateStreamObservation({ ...sample, nativeStreamCount: null }).status, 'unknown');
    assert.equal(stability.evaluateStreamObservation({ ...sample, nativeStreamCount: 0 }).status, 'idle');
});

function renderer() {
    const settings = deferred();
    const enable = deferred();
    const route = deferred();
    const calls = { enable: 0, presence: 0, errors: [], toasts: [] };
    const timers = new Map();
    const timer = (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; };
    const region = { getPreferredRegion: () => null, getPreferredRegions: () => [], shouldIncludePreferredRegion: () => false };
    const Native = {
        getProtonSettings: () => settings.promise,
        getVpnStatus: async () => ({ state: 'inactive', active: false }),
        enable: () => { calls.enable++; return enable.promise; },
        shutdown: async () => ({}), logFromRenderer: async () => {},
        autoOptimizeRoute: () => route.promise
    };
    const plugin = load('index.tsx', {
        '@api/Commands': {},
        '@api/Settings': { definePluginSettings: () => ({ store: {} }) },
        '@components/Paragraph': {}, '@utils/discord': {}, '@utils/react': {},
        '@utils/Logger': { Logger: class { info() {} error(...args) { calls.errors.push(args); } } },
        '@utils/types': { __esModule: true, default: value => value, OptionType: {} },
        '@webpack': { findStoreLazy: name => name === 'RTCRegionStore' ? region : {} },
        '@webpack/common': { Toasts: { Type: {} }, showToast: (...args) => calls.toasts.push(args) },
        './stability': stability,
        './presence': { startPresence: () => calls.presence++, stopPresence() {}, updateRouteInfo() {} }
    }, {
        VencordNative: { pluginHelpers: { LefferzinBypass: Native } },
        setInterval: timer, setTimeout: timer,
        clearInterval: id => timers.delete(id), clearTimeout: id => timers.delete(id)
    }).default;
    return { plugin, settings, enable, route, calls, timers };
}

test('desativar durante leitura de configurações impede ativação atrasada', async () => {
    const r = renderer();
    r.plugin.start(); r.plugin.stop();
    r.settings.resolve({ protonUsername: 'test' });
    await flush();
    assert.equal(r.calls.enable, 0);
    assert.equal(r.calls.presence, 0);
    assert.equal(r.timers.size, 0);
});

test('resposta de ativação após stop não recria presença ou timers', async () => {
    const r = renderer();
    r.plugin.start(); r.settings.resolve({ protonUsername: 'test' }); await flush();
    assert.equal(r.calls.enable, 1);
    assert.equal(r.calls.presence, 0);
    r.plugin.stop(); r.enable.resolve({ success: true }); await flush();
    assert.equal(r.calls.presence, 0);
    assert.equal(r.timers.size, 0);
    assert.equal(r.calls.errors.length, 0);
});

test('inicialização concluída atualiza status sem ReferenceError e ignora rota após stop', async () => {
    const r = renderer();
    r.plugin.start(); r.settings.resolve({ protonUsername: 'test' }); await flush();
    r.enable.resolve({ success: true }); await flush();
    assert.equal(r.calls.errors.length, 0);
    const routeTimer = [...r.timers.values()].find(t => t.ms === 12_000);
    assert.ok(routeTimer);
    routeTimer.fn();
    r.plugin.stop();
    const toastCount = r.calls.toasts.length;
    r.route.resolve({ changed: true, selectedServer: 'test' }); await flush();
    assert.equal(r.calls.toasts.length, toastCount);
    assert.equal(r.timers.size, 0);
});

function watchdog(samples, onWait = () => {}) {
    let tick;
    let reads = 0;
    const { PluginVpnController } = load('vpn-controller.ts', {
        electron: { app: {} }, './vpn-proton': {},
        './vpn-windows': { inspectWireSockAsync: async () => {
            const value = samples[reads++];
            if (value instanceof Error) throw value;
            assert.ok(value, 'consulta inesperada');
            return value;
        } }
    }, { setInterval: fn => { tick = fn; return { unref() {} }; }, clearInterval() {},
        setTimeout: fn => { onWait(controller); fn(); } });
    const controller = new PluginVpnController({ dataDir: __dirname, guiDataDir: __dirname,
        readSettings: () => ({}), isEnabled: () => true, log() {} });
    controller.state = 'active';
    controller.readOwner = () => null;
    controller.startDiagnostics = () => {};
    controller.startWatchdog();
    return { controller, tick, reads: () => reads };
}
const absent = { active: false, owned: false };
const active = { active: true, owned: true };

test('watchdog ignora ausência transitória', async () => {
    const w = watchdog([absent, active]); await w.tick();
    assert.equal(w.controller.state, 'active'); assert.equal(w.reads(), 2);
});
test('watchdog exige seis leituras ausentes antes de recuperação', async () => {
    const w = watchdog(Array(6).fill(absent)); await w.tick();
    assert.equal(w.controller.state, 'recovery_required'); assert.equal(w.reads(), 6);
});
test('erro na confirmação não prova queda', async () => {
    const w = watchdog([absent, new Error('CIM indisponível')]); await w.tick();
    assert.equal(w.controller.state, 'active');
});
test('polling do painel não interrompe confirmação do watchdog', async () => {
    const w = watchdog([{ ...absent, foreignRegisteredServices: [] }, active]);
    w.controller.initialize = async () => {};
    const status = await w.controller.getStatus();
    assert.equal(status.active, false);
    assert.equal(w.controller.state, 'active');
    assert.ok(w.controller.watchdog);
    await w.tick();
    assert.equal(w.controller.state, 'active');
});
test('inicialização é compartilhada e enable aguarda sua conclusão', async () => {
    const w = watchdog([]);
    const pending = deferred();
    let initializations = 0;
    let starts = 0;
    w.controller.initializeInternal = () => { initializations++; return pending.promise; };
    w.controller.startInternal = async () => { starts++; return { success: true }; };
    const first = w.controller.initialize();
    assert.equal(first, w.controller.initialize());
    const enabled = w.controller.enable(false);
    await flush();
    assert.equal(starts, 0);
    pending.resolve(); await enabled;
    assert.equal(initializations, 1);
    assert.equal(starts, 1);
});
test('watchdog não atua após troca de geração durante confirmação', async () => {
    const w = watchdog([absent], c => { c.generation++; }); await w.tick();
    assert.equal(w.controller.state, 'active'); assert.equal(w.reads(), 1);
});

test('consulta WireSock rejeita estados transitórios e linhas inválidas', async () => {
    let snapshot;
    const windows = load('vpn-windows.ts', {
        child_process: { execFile: (_file, _args, _options, done) => done(null, JSON.stringify(snapshot)) }
    });
    for (const services of [[null], [{ Name: 'wiresock-client-service', State: 'Start Pending', PathName: null }]]) {
        snapshot = { services, processes: [] };
        await assert.rejects(windows.inspectWireSockAsync(), /inconclusivo/);
    }
    snapshot = { services: [], processes: [] };
    assert.equal((await windows.inspectWireSockAsync()).active, false);
});
