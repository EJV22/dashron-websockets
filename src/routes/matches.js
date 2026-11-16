import { Router } from 'express';
import {
    createMatchSchema,
    listMatchesQuerySchema,
    updateScoreSchema,
    matchIdParamSchema,
} from "../validation/matches.js";
import { matches } from "../db/schema.js";
import { db } from "../db/db.js";
import { getMatchStatus } from "../utils/match-status.js";
import { desc, eq } from "drizzle-orm";

export const matchRouter = Router();

const MAX_LIMIT = 100;

matchRouter.post('/', async (req, res) => {
    const parsed = createMatchSchema.safeParse(req.body);

    if (!parsed.success) {
        return res.status(400).json({ message: 'Invalid payload', details: JSON.stringify(parsed.error) });
    }

    const { data: { startTime, endTime, homeScore, awayScore } } = parsed;

    try {
        const [event] = await db.insert(matches).values({
            ...parsed.data,
            startTime: new Date(startTime),
            endTime: new Date(endTime),
            homeScore: homeScore ?? 0,
            awayScore: awayScore ?? 0,
            status: getMatchStatus(startTime, endTime),
        }).returning();

        if (res.app.locals.broadcastMatchCreated) {
            res.app.locals.broadcastMatchCreated(event);
        }

        res.status(201).json({ data: event });
    } catch (e) {
        res.status(400).json({ message: 'Failed to create match', details: JSON.stringify(e) });
    }
});

matchRouter.get('/', async (req, res) => {
    const parsed = listMatchesQuerySchema.safeParse(req.query);

    if (!parsed.success) {
        return res.status(400).json({ message: 'Invalid query', details: JSON.stringify(parsed.error) });
    }

    const limit = Math.min(parsed.data.limit ?? 50, MAX_LIMIT);

    try {
        const data = await db
            .select()
            .from(matches)
            .orderBy(desc(matches.createdAt))
            .limit(limit);

        res.json({ data });
    } catch (e) {
        res.status(400).json({ error: 'Failed to list matches' });
    }
});

// NEW: update a match's score and push it to all connected clients
matchRouter.patch('/:id/score', async (req, res) => {
    const params = matchIdParamSchema.safeParse(req.params);
    if (!params.success) {
        return res.status(400).json({ message: 'Invalid match id', details: params.error.issues });
    }

    const body = updateScoreSchema.safeParse(req.body);
    if (!body.success) {
        return res.status(400).json({ message: 'Invalid payload', details: body.error.issues });
    }

    try {
        const [updated] = await db
            .update(matches)
            .set({ homeScore: body.data.homeScore, awayScore: body.data.awayScore })
            .where(eq(matches.id, params.data.id))
            .returning();

        if (!updated) {
            return res.status(404).json({ message: 'Match not found' });
        }

        if (res.app.locals.broadcastScoreUpdate) {
            res.app.locals.broadcastScoreUpdate(updated);
        }

        res.json({ data: updated });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Failed to update score' });
    }
});