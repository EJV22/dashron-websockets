// Run with: node --experimental-vm-modules --test test/*.test.js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const source = await readFile(new URL('../src/arcjet.js', import.meta.url), 'utf8');

async function setup(env = { ARCJET_KEY: 'test-key' }) {
    const configurations = [];
    const clients = [];
    const errors = [];
    const context = createContext({ process: { env }, console: { error: (...args) => errors.push(args) } });
    const rule = (type) => (options) => ({ type, ...options });
    const sdk = new SyntheticModule(['default', 'shield', 'detectBot', 'slidingWindow'], function () {
        this.setExport('default', (configuration) => {
            configurations.push(JSON.parse(JSON.stringify(configuration)));
            const client = { protect: async () => ({ isDenied: () => false }) };
            clients.push(client);
            return client;
        });
        this.setExport('shield', rule('shield'));
        this.setExport('detectBot', rule('detectBot'));
        this.setExport('slidingWindow', rule('slidingWindow'));
    }, { context });
    const module = new SourceTextModule(source, { context });
    await module.link((specifier) => {
        assert.equal(specifier, '@arcjet/node');
        return sdk;
    });
    await module.evaluate();
    return { ...module.namespace, configurations, clients, errors };
}

function response() {
    return {
        statusCode: undefined,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; },
    };
}

for (const mode of [undefined, 'DRY_RUN', 'LIVE', 'dry_run', '']) {
    test(`configures separate HTTP and WS rules for mode ${JSON.stringify(mode)}`, async () => {
        const fixture = await setup({ ARCJET_KEY: 'test-key', ARCJET_MODE: mode });
        const expectedMode = mode === 'DRY_RUN' ? 'DRY_RUN' : 'LIVE';
        assert.deepEqual(fixture.configurations, [
            { key: 'test-key', rules: [
                { type: 'shield', mode: expectedMode },
                { type: 'detectBot', mode: expectedMode, allow: ['CATEGORY:SEARCH_ENGINE', 'CATEGORY:PREVIEW'] },
                { type: 'slidingWindow', mode: expectedMode, interval: '10s', max: 50 },
            ] },
            { key: 'test-key', rules: [
                { type: 'shield', mode: expectedMode },
                { type: 'detectBot', mode: expectedMode, allow: ['CATEGORY:SEARCH_ENGINE', 'CATEGORY:PREVIEW'] },
                { type: 'slidingWindow', mode: expectedMode, interval: '2s', max: 5 },
            ] },
        ]);
        assert.equal(fixture.httpArcjet, fixture.clients[0]);
        assert.equal(fixture.wsArcjet, fixture.clients[1]);
        assert.notEqual(fixture.httpArcjet, fixture.wsArcjet);
    });
}

for (const env of [{}, { ARCJET_KEY: '' }]) {
    test(`rejects a missing or empty key: ${JSON.stringify(env)}`, async () => {
        await assert.rejects(setup(env), { message: 'ARCJET_KEY is missing' });
    });
}

test('allowed requests are passed to HTTP protection and continue exactly once', async () => {
    const fixture = await setup();
    const request = { headers: { 'user-agent': 'test' } };
    const res = response();
    const requests = [];
    fixture.httpArcjet.protect = async (req) => {
        requests.push(req);
        return { isDenied: () => false };
    };
    fixture.wsArcjet.protect = () => assert.fail('must use HTTP client');
    let nextCalls = 0;
    await fixture.securityMiddleWare()(request, res, () => nextCalls++);
    assert.deepEqual(requests, [request]);
    assert.equal(nextCalls, 1);
    assert.equal(res.statusCode, undefined);
    assert.equal(res.body, undefined);
});

for (const [rateLimited, statusCode, error] of [
    [true, 429, 'Too many requests '],
    [false, 403, 'Forbidden '],
]) {
    test(`denied HTTP requests return ${statusCode} without continuing`, async () => {
        const fixture = await setup();
        fixture.httpArcjet.protect = async () => ({
            isDenied: () => true,
            reason: { isRateLimit: () => rateLimited },
        });
        const res = response();
        const result = await fixture.securityMiddleWare()({}, res, () => assert.fail('denied request continued'));
        assert.equal(result, res);
        assert.equal(res.statusCode, statusCode);
        assert.deepEqual(res.body, { error });
    });
}

for (const synchronous of [false, true]) {
    test(`HTTP protection ${synchronous ? 'throws' : 'rejects'}: fails closed with 503`, async () => {
        const fixture = await setup();
        const failure = new Error('private provider details');
        fixture.httpArcjet.protect = synchronous
            ? () => { throw failure; }
            : async () => { throw failure; };
        const res = response();
        await fixture.securityMiddleWare()({}, res, () => assert.fail('failed request continued'));
        assert.equal(res.statusCode, 503);
        assert.deepEqual(res.body, { error: 'Service Unavailable' });
        assert.deepEqual(fixture.errors, [['Arcjet Middleware error', failure]]);
    });
}

test('HTTP middleware waits for the security decision before continuing', async () => {
    const fixture = await setup();
    let resolve;
    fixture.httpArcjet.protect = () => new Promise((done) => { resolve = done; });
    let nextCalls = 0;
    const pending = fixture.securityMiddleWare()({}, response(), () => nextCalls++);
    assert.equal(nextCalls, 0);
    resolve({ isDenied: () => false });
    await pending;
    assert.equal(nextCalls, 1);
});
