import AgentAPI from "apminsight";
AgentAPI.config();

import {attachWebSocketServer} from './ws/server.js';
import express from 'express';
import http from 'http';
import {matchRouter} from "./routes/matches.js";
import {securityMiddleWare} from "./arcjet.js";
import {commentaryRouter} from "./routes/commentary.js";
import cors from 'cors';

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);

app.use(express.json());

app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true }));

app.get('/', (req, res) => {
  res.json({ message: 'Hello from Express!' });
});

app.use(securityMiddleWare());

app.use('/matches', matchRouter);
app.use('/matches/:id/commentary', commentaryRouter );

const { broadcastMatchCreated, broadcastCommentary, broadcastScoreUpdate } = attachWebSocketServer(server);
app.locals.broadcastScoreUpdate = broadcastScoreUpdate;
app.locals.broadcastMatchCreated = broadcastMatchCreated;
app.locals.broadcastCommentary = broadcastCommentary;

server.listen(PORT, HOST, () => {
  const baseUrl = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`Server is running on ${baseUrl}`);
  console.log(`Websocket server running on ${baseUrl.replace('http', 'ws')}/ws`);
})