// routes/commentary.js
import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/db.js';
import { commentary, matches } from '../db/schema.js';
import { createCommentarySchema, listCommentaryQuerySchema } from '../validation/commentary.js';
import { matchIdParamSchema } from '../validation/matches.js';

export const commentaryRouter = Router({ mergeParams: true });

const MAX_LIMIT = 100;

commentaryRouter.get('/', async (req, res) => {
    const params = matchIdParamSchema.safeParse(req.params);
    if (!params.success) {
        return res.status(400).json({ message: 'Invalid match id', details: params.error.issues });
    }

    const query = listCommentaryQuerySchema.safeParse(req.query);
    if (!query.success) {
        return res.status(400).json({ message: 'Invalid query', details: query.error.issues });
    }

    const limit = Math.min(query.data.limit ?? 100, MAX_LIMIT);

    try {
        const data = await db
            .select()
            .from(commentary)
            .where(eq(commentary.matchId, params.data.id))
            .orderBy(desc(commentary.createdAt))
            .limit(limit);

        res.json({ data });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Failed to list commentary' });
    }
});

commentaryRouter.post('/', async (req, res) => {
    const params = matchIdParamSchema.safeParse(req.params);
    if (!params.success) {
        return res.status(400).json({ message: 'Invalid match id', details: params.error.issues });
    }

    const body = createCommentarySchema.safeParse(req.body);
    if (!body.success) {
        return res.status(400).json({ message: 'Invalid payload', details: body.error.issues });
    }

    try {
        const [match] = await db
            .select({ id: matches.id })
            .from(matches)
            .where(eq(matches.id, params.data.id));

        if (!match) {
            return res.status(404).json({ message: 'Match not found' });
        }

        const [entry] = await db
            .insert(commentary)
            .values({ ...body.data, matchId: params.data.id })
            .returning();

        if (res.app.locals.broadcastCommentary) {
            res.app.locals.broadcastCommentary(entry.matchId, entry);
        }

        res.status(201).json({ data: entry });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Failed to create commentary' });
    }
});