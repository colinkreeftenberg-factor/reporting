// Vercel serverless function backing the team-comments feature.
// Requires a Vercel KV database attached to this project (Storage tab in the
// Vercel dashboard -> Create Database -> KV -> Connect to this project).
// Vercel automatically injects the KV_REST_API_URL / KV_REST_API_TOKEN env
// vars once connected — no manual configuration needed beyond that click.
import { kv } from '@vercel/kv';

const STORE_KEY = 'factor-team-comments';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const comments = (await kv.get(STORE_KEY)) || [];
      return res.status(200).json({ comments });
    }

    if (req.method === 'POST') {
      const { team, market, week, text, author } = req.body || {};
      if (!team || !market || !week || !text || !String(text).trim()) {
        return res.status(400).json({ error: 'team, market, week, and text are required' });
      }
      const comments = (await kv.get(STORE_KEY)) || [];
      const comment = {
        id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        team: String(team).slice(0, 200),
        market: String(market).slice(0, 20),
        week: String(week).slice(0, 20),
        text: String(text).slice(0, 2000),
        author: (author ? String(author) : 'Anonymous').slice(0, 100),
        createdAt: new Date().toISOString(),
      };
      comments.push(comment);
      await kv.set(STORE_KEY, comments);
      return res.status(200).json({ comment });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id is required' });
      let comments = (await kv.get(STORE_KEY)) || [];
      comments = comments.filter(c => c.id !== id);
      await kv.set(STORE_KEY, comments);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
}
