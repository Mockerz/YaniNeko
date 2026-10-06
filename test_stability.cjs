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

function logoutNative(shutdownSuccess, cleanupSuccess = true, settingsFail = false) {
    const calls = [];
    const plugins = { LefferzinBypass: { protonUsername: 'saved' }, 'Lefferzin Bypass': { protonUsername: 'legacy' } };
    if (settingsFail) Object.defineProperty(plugins.LefferzinBypass, 'protonUsername', { set() { throw new Error('write failed'); } });
    const native = load('native.ts', {
        '@main/settings': { RendererSettings: { store: { plugins }, plain: { plugins } } },
        electron: { app: { on() {}, whenReady: () => new Promise(() => {}) } },
        fs: { mkdirSync() {}, existsSync: () => false, appendFileSync() {}, writeFileSync() {} },
        './vpn-proton': {},
        './vpn-controller': {
            defaultPluginVpnDataDir: () => __dirname,
            PluginVpnController: class {
                async shutdown(relaunch, nuclear) { calls.push(['shutdown', relaunch, nuclear]); return { success: shutdownSuccess }; }
                logoutProton() { calls.push(['cleanup']); return cleanupSuccess; }
            }
        }
    }, { process: { ...process, on() {} } });
    return { native, calls, plugins };
}

test('sair encerra a VPN antes de limpar a sessão e as duas configurações de conta', async () => {
    const fixture = logoutNative(true);
    assert.equal((await fixture.native.fullLogout()).success, true);
    assert.deepEqual(fixture.calls, [['shutdown', false, false], ['cleanup']]);
    for (const settings of Object.values(fixture.plugins)) assert.equal(settings.protonUsername, '');
});

test('sair preserva a conta quando não consegue encerrar a VPN', async () => {
    const fixture = logoutNative(false);
    assert.equal((await fixture.native.fullLogout()).success, false);
    assert.deepEqual(fixture.calls, [['shutdown', false, false]]);
    assert.equal(fixture.plugins.LefferzinBypass.protonUsername, 'saved');
});

test('sair não anuncia sucesso quando arquivos ou configurações não podem ser limpos', async () => {
    for (const fixture of [logoutNative(true, false), logoutNative(true, true, true)]) {
        const result = await fixture.native.fullLogout();
        assert.equal(result.success, false);
        assert.match(result.error, /limpeza.*incompleta/);
    }
});

test('limpeza remove também o perfil do serviço e detecta arquivo bloqueado', () => {
    for (const blocked of [false, true]) {
        const config = path.join(__dirname, 'wiresock-discord.conf');
        const files = new Set([config, path.join(__dirname, 'wireguard.conf')]);
        const { PluginVpnController } = load('vpn-controller.ts', {
            electron: { app: {} }, './vpn-windows': {},
            './vpn-proton': { removeProtonSession: () => true, protonSessionFile: () => path.join(__dirname, 'session') },
            fs: { existsSync: file => files.has(file), rmSync: file => {
                if (blocked && file === config) throw new Error('locked');
                files.delete(file);
            } }
        });
        const controller = new PluginVpnController({ dataDir: __dirname, guiDataDir: __dirname,
            readSettings: () => ({}), isEnabled: () => true, log() {} });
        assert.equal(controller.logoutProton(), !blocked);
        assert.equal(files.size, blocked ? 1 : 0);
    }
});

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

function renderer(options = {}) {
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
    Object.assign(Native, options.native);
    const hookState = [];
    let hookIndex = 0;
    const element = (type, props, ...children) => ({ type, props: { ...props, children } });
    const Button = Object.assign(() => {}, { Looks: {} });
    const TextInput = () => {};
    const plugin = load('index.tsx', {
        '@api/Commands': {},
        '@api/Settings': { definePluginSettings: () => ({ store: {} }) },
        '@components/Paragraph': {}, '@utils/discord': {}, '@utils/react': {},
        '@utils/Logger': { Logger: class { info() {} error(...args) { calls.errors.push(args); } } },
        '@utils/types': { __esModule: true, default: value => value, OptionType: {} },
        '@webpack': { findStoreLazy: name => name === 'RTCRegionStore' ? region : {} },
        '@webpack/common': {
            // Current Vencord has no Toasts.Type enum.
            Toasts: {}, showToast: (...args) => {
                if (options.toastFails) throw new Error('toast unavailable');
                calls.toasts.push(args);
            },
            React: { createElement: element }, Button, TextInput, useEffect() {},
            useState: initial => {
                const index = hookIndex++;
                if (!(index in hookState)) hookState[index] = initial;
                return [hookState[index], value => { hookState[index] = value; }];
            }
        },
        './stability': stability,
        './presence': { startPresence: () => calls.presence++, stopPresence() {}, updateRouteInfo() {} }
    }, {
        VencordNative: { pluginHelpers: { LefferzinBypass: options.noNative ? undefined : Native } },
        setInterval: timer, setTimeout: timer,
        clearInterval: id => timers.delete(id), clearTimeout: id => timers.delete(id)
    }).default;
    const renderPanel = () => {
        hookIndex = 0;
        const panel = plugin.settingsAboutComponent();
        const tree = panel.type();
        const nodes = [];
        const visit = node => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { node.forEach(visit); return; }
            nodes.push(node);
            visit(node.props?.children);
        };
        visit(tree);
        return { nodes, button: label => nodes.find(n => n.type === Button && n.props.children.includes(label)),
            inputs: nodes.filter(n => n.type === TextInput) };
    };
    return { plugin, settings, enable, route, calls, timers, renderPanel };
}

test('clique em Logar chama o backend sem Toasts.Type, mesmo se a notificação falhar', async () => {
    for (const toastFails of [false, true]) {
        let logins = 0;
        const r = renderer({ toastFails, native: { loginProton: async () => {
            logins++;
            return { success: false, message: 'Login recusado para teste' };
        } } });
        r.renderPanel().inputs[0].props.onChange('test');
        const button = r.renderPanel().button('Logar');
        assert.equal(button.props.disabled, false);
        button.props.onClick();
        await flush();
        assert.equal(logins, 1);
        const panel = r.renderPanel();
        assert.match(panel.nodes.find(n => n.props.role === 'status').props.children[0], /Login recusado/);
        assert.equal(panel.button('Logar').props.disabled, false);
    }
});

test('clique em Sair alcança fullLogout sem Toasts.Type', async () => {
    let logouts = 0;
    const r = renderer({ native: { fullLogout: async () => { logouts++; return { success: true }; } } });
    r.settings.resolve({});
    r.renderPanel().button('Sair').props.onClick();
    await flush();
    assert.equal(logouts, 1);
    assert.ok(r.calls.toasts.some(([message, type]) => type === 'success' && message.includes('conta salva removida')));
});

test('componente nativo ausente gera aviso no painel ao clicar em Sair', () => {
    const r = renderer({ noNative: true });
    r.renderPanel().button('Sair').props.onClick();
    assert.match(r.renderPanel().nodes.find(n => n.props.role === 'status').props.children[0], /componente desktop não carregou/);
});

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
