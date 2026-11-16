import { WebSocket, WebSocketServer } from 'ws';
import {wsArcjet} from "../arcjet.js";

const matchSubscribers = new Map();

function subscribe(matchId, socket) {
    if(!matchSubscribers.has(matchId)) {
        matchSubscribers.set(matchId, new Set());
    }

    matchSubscribers.get(matchId).add(socket);
}

function unsubscribe(matchId, socket) {
    const subscribers = matchSubscribers.get(matchId);

    if(!subscribers) return;

    subscribers.delete(socket);

    if(subscribers.size === 0) {
        matchSubscribers.delete(matchId);
    }
}

function cleanupSubscriptions(socket) {
    for(const matchId of socket.subscriptions) {
        unsubscribe(matchId, socket);
    }
}

function broadcastToMatch(matchId, payload) {
    const subscribers = matchSubscribers.get(matchId);
    if(!subscribers || subscribers.size === 0) return;

    const message = JSON.stringify(payload);

    for(const client of subscribers) {
        if(client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}

function sendJson(socket, payload) {
    if (socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify(payload));
}

function broadcastToAll(wss, payload) {
    for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        if (!client.admitted) continue;

        client.send(JSON.stringify(payload));
    }
}

const HEARTBEAT_INTERVAL_MS = 30_000;

function handleMessage(socket, data) {

    let message;

    try{
        message = JSON.parse(data.toString());
    } catch {
        sendJson(socket, {type : 'error', message: 'invalid JSON'})
    }

    if (message?.type === "subscribe" && Number.isInteger(message.matchId)) {
        subscribe(message.matchId, socket);
        socket.subscriptions.add(message.matchId);
        sendJson(socket, {type : 'subscribed', matchId: message.matchId});
        return;
    }

    if (message?.type === "unsubscribe" && Number.isInteger(message.matchId)) {
        unsubscribe(message.matchId, socket);
        socket.subscriptions.delete(message.matchId);
        sendJson(socket, {type : 'unsubscribed', matchId: message.matchId});
    }
}

export function attachWebSocketServer(server) {
    const wss = new WebSocketServer({
        server,
        path: '/ws',
        maxPayload: 1024 * 1024,
    });

    wss.on('connection', async (socket, req) => {
        socket.subscriptions = new Set();
        socket.isAlive = true;

        socket.on('error', () => socket.terminate());
        socket.on('pong', () => { socket.isAlive = true; });
        socket.on('message', (data) => handleMessage(socket, data));
        socket.on('close', () => cleanupSubscriptions(socket));

        if (wsArcjet) {
            try {
                const decision = await wsArcjet.protect(req);
                if (decision.isDenied()) {
                    const code = decision.reason.isRateLimit() ? 1013 : 1008;
                    const reason = decision.reason.isRateLimit() ? 'Rate limit exceeded' : 'Access Denied';
                    socket.close(code, reason);
                    return;
                }
            } catch (e) {
                console.error('WS connection error', e);
                socket.close(1011, 'Server security error');
                return;
            }
        }

        socket.admitted = true;
        sendJson(socket, { type: 'welcome' });
    });

    const heartbeat = setInterval(() => {
        for (const socket of wss.clients) {
            if (socket.isAlive === false) {
                socket.terminate();
                continue;
            }

            socket.isAlive = false;
            socket.ping();
        }
    }, HEARTBEAT_INTERVAL_MS);

    wss.on('close', () => clearInterval(heartbeat));

    function broadcastMatchCreated(match) {
        broadcastToAll(wss, { type: 'match_created', data: match });
    }

    function broadcastCommentary(matchId, comment) {
        broadcastToMatch(matchId, {type: 'commentary', data: comment});
    }
    function broadcastScoreUpdate(match) {
        broadcastToAll(wss, { type: 'score_update', data: match });
    }

    return { broadcastMatchCreated, broadcastCommentary, broadcastScoreUpdate };
}