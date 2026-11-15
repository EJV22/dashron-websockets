// Run with: node --experimental-vm-modules --test test/*.test.js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, mock } from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');

test('registers security after the public greeting and before the matches router', async () => {
    const registrations = [];
    const app = {
        locals: {},
        use: (...args) => registrations.push(['use', ...args]),
        get: (...args) => registrations.push(['get', ...args]),
    };
    const jsonParser = () => {};
    const securityMiddleware = () => {};
    const matchRouter = () => {};
    const securityMiddleWare = mock.fn(() => securityMiddleware);
    const server = { listen: mock.fn() };
    const broadcastMatchCreated = () => {};
    const attachWebSocketServer = mock.fn(() => ({ broadcastMatchCreated }));
    const express = Object.assign(() => app, { json: () => jsonParser });
    const createServer = mock.fn(() => server);
    const context = createContext({ process: { env: {} }, console: { log() {} } });
    const imports = new Map([
        ['./ws/server.js', { attachWebSocketServer }],
        ['express', { default: express }],
        ['http', { default: { createServer } }],
        ['./routes/matches.js', { matchRouter }],
        ['./arcjet.js', { securityMiddleWare }],
    ]);
    const module = new SourceTextModule(source, { context });
    await module.link((specifier) => {
        assert.ok(imports.has(specifier), `Unexpected import: ${specifier}`);
        const exports = imports.get(specifier);
        return new SyntheticModule(Object.keys(exports), function () {
            for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context });
    });
    await module.evaluate();
    assert.equal(securityMiddleWare.mock.callCount(), 1);
    assert.equal(registrations.length, 4);
    assert.deepEqual(registrations[0], ['use', jsonParser]);
    assert.equal(registrations[1][0], 'get');
    assert.equal(registrations[1][1], '/');
    assert.deepEqual(registrations[2], ['use', securityMiddleware]);
    assert.deepEqual(registrations[3], ['use', '/matches', matchRouter]);
    assert.equal(createServer.mock.calls[0].arguments[0], app);
    assert.equal(attachWebSocketServer.mock.calls[0].arguments[0], server);
    assert.equal(app.locals.broadcastMatchCreated, broadcastMatchCreated);
});
