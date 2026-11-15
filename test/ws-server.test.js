// Run with: node --experimental-vm-modules --test test/*.test.js
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test, mock } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const source = await readFile(new URL('../src/ws/server.js', import.meta.url), 'utf8');

async function setup(protect = async () => ({ isDenied: () => false })) {
    let wss;
    let tick;
    let interval;
    const timer = {};
    const clearInterval = mock.fn();
    const logError = mock.fn();
    const context = createContext({
        console: { error: logError },
        setInterval(callback, delay) { tick = callback; interval = delay; return timer; },
        clearInterval,
    });
    class WebSocketServer extends EventEmitter {
        constructor(options) { super(); this.options = options; this.clients = new Set(); wss = this; }
    }
    const ws = new SyntheticModule(['WebSocket', 'WebSocketServer'], function () {
        this.setExport('WebSocket', { OPEN: 1 });
        this.setExport('WebSocketServer', WebSocketServer);
    }, { context });
    const security = new SyntheticModule(['wsArcjet'], function () {
        this.setExport('wsArcjet', protect === null ? null : { protect });
    }, { context });
    const module = new SourceTextModule(source, { context });
    await module.link((specifier) => {
        if (specifier === 'ws') return ws;
        assert.equal(specifier, '../arcjet.js');
        return security;
    });
    await module.evaluate();
    const server = {};
    const api = module.namespace.attachWebSocketServer(server);
    return {
        ...api, wss, server, timer, clearInterval, logError,
        tick: () => tick(), get interval() { return interval; },
        // EventEmitter.emit discards the async handler's promise; await it directly.
        async connect(socket, request = {}) {
            wss.clients.add(socket);
            await wss.listeners('connection')[0](socket, request);
        },
    };
}

function socket(readyState = 1) {
    return Object.assign(new EventEmitter(), {
        readyState, send: mock.fn(), close: mock.fn(), ping: mock.fn(), terminate: mock.fn(),
    });
}

test('attaches to the supplied HTTP server at /ws with a bounded payload', async () => {
    const fixture = await setup();
    assert.equal(fixture.wss.options.server, fixture.server);
    assert.equal(fixture.wss.options.path, '/ws');
    assert.equal(fixture.wss.options.maxPayload, 1024 * 1024);
});

test('allowed connections protect the upgrade request before welcoming the client', async () => {
    let resolve;
    const protect = mock.fn(() => new Promise((done) => { resolve = done; }));
    const fixture = await setup(protect);
    const client = socket();
    const request = { url: '/ws', headers: {} };
    const pending = fixture.connect(client, request);
    assert.equal(protect.mock.calls[0].arguments[0], request);
    assert.equal(client.send.mock.callCount(), 0);
    assert.equal(client.isAlive, undefined);
    resolve({ isDenied: () => false });
    await pending;
    assert.equal(protect.mock.callCount(), 1);
    assert.equal(client.send.mock.callCount(), 1);
    assert.deepEqual(JSON.parse(client.send.mock.calls[0].arguments[0]), { type: 'welcome' });
    assert.equal(client.isAlive, true);
    assert.equal(client.close.mock.callCount(), 0);
    const error = new Error('socket failure');
    client.emit('error', error);
    assert.equal(fixture.logError.mock.calls[0].arguments[0], error);
});

for (const [rateLimited, code, reason] of [
    [true, 1013, 'Rate limit exceeded'],
    [false, 1008, 'Access Denied'],
]) {
    test(`denied WS connections close with ${code} and never receive a welcome`, async () => {
        const fixture = await setup(async () => ({
            isDenied: () => true, reason: { isRateLimit: () => rateLimited },
        }));
        const client = socket();
        await fixture.connect(client);
        assert.equal(client.close.mock.callCount(), 1);
        assert.deepEqual(client.close.mock.calls[0].arguments, [code, reason]);
        assert.equal(client.send.mock.callCount(), 0);
        assert.equal(client.listenerCount('pong'), 0);
        assert.equal(client.isAlive, undefined);
    });
}

for (const synchronous of [false, true]) {
    test(`WS protection ${synchronous ? 'throws' : 'rejects'}: closes with 1011`, async () => {
        const failure = new Error('private provider details');
        const fixture = await setup(synchronous
            ? () => { throw failure; }
            : async () => { throw failure; });
        const client = socket();
        await fixture.connect(client);
        assert.equal(client.close.mock.callCount(), 1);
        assert.deepEqual(client.close.mock.calls[0].arguments, [1011, 'Server security error']);
        assert.equal(client.send.mock.callCount(), 0);
        assert.equal(client.listenerCount('pong'), 0);
        assert.deepEqual(fixture.logError.mock.calls[0].arguments, ['WS connection error', failure]);
    });
}

test('connections can initialize when no WS security client is configured', async () => {
    const fixture = await setup(null);
    const client = socket();
    await fixture.connect(client);
    assert.equal(client.isAlive, true);
    assert.deepEqual(JSON.parse(client.send.mock.calls[0].arguments[0]), { type: 'welcome' });
});

for (const state of [0, 2, 3]) {
    test(`does not welcome a socket that becomes unavailable during protection (state ${state})`, async () => {
        const client = socket();
        const fixture = await setup(async () => {
            client.readyState = state;
            return { isDenied: () => false };
        });
        await fixture.connect(client);
        assert.equal(client.send.mock.callCount(), 0);
    });
}

test('regression: broadcasts reach open clients after unavailable clients', async () => {
    const fixture = await setup();
    const clients = [socket(0), socket(), socket(2), socket(3), socket()];
    clients.forEach((client) => fixture.wss.clients.add(client));
    const match = { id: 7, homeTeam: 'A', awayTeam: 'B' };
    fixture.broadcastMatchCreated(match);
    for (const client of clients) {
        assert.equal(client.send.mock.callCount(), client.readyState === 1 ? 1 : 0);
        if (client.readyState === 1) {
            assert.deepEqual(JSON.parse(client.send.mock.calls[0].arguments[0]), {
                type: 'match_created', data: match,
            });
        }
    }
});

test('broadcasting with no clients is harmless', async () => {
    const fixture = await setup();
    assert.doesNotThrow(() => fixture.broadcastMatchCreated({ id: 1 }));
});

test('heartbeat pings at 30 seconds and terminates clients missing the next pong', async () => {
    const fixture = await setup();
    const stale = socket();
    const responsive = socket();
    await fixture.connect(stale);
    await fixture.connect(responsive);
    assert.equal(fixture.interval, 30_000);
    fixture.tick();
    for (const client of [stale, responsive]) {
        assert.equal(client.isAlive, false);
        assert.equal(client.ping.mock.callCount(), 1);
        assert.equal(client.terminate.mock.callCount(), 0);
    }
    responsive.emit('pong');
    assert.equal(responsive.isAlive, true);
    fixture.tick();
    assert.equal(stale.terminate.mock.callCount(), 1);
    assert.equal(stale.ping.mock.callCount(), 1);
    assert.equal(responsive.terminate.mock.callCount(), 0);
    assert.equal(responsive.ping.mock.callCount(), 2);
    assert.equal(responsive.isAlive, false);
});

test('server close clears its heartbeat interval', async () => {
    const fixture = await setup();
    assert.equal(fixture.clearInterval.mock.callCount(), 0);
    fixture.wss.emit('close');
    assert.equal(fixture.clearInterval.mock.callCount(), 1);
    assert.deepEqual(fixture.clearInterval.mock.calls[0].arguments, [fixture.timer]);
});
