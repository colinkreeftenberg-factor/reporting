// Vercel serverless function backing the comments feature.
// Uses @upstash/redis directly for flexible env var detection (see findEnv).
//
// Schema: { id, scope, scopeLabel, entity, market, week, value, valueType,
//           text, author, createdAt }
// - scope: which table/context the comment belongs to (e.g. 'general-team',
//   'logistics-issue', 'logistics-carrier', 'logistics-compensation',
//   'category-drill') — prevents an entity name collision across contexts
//   (e.g. a team and a carrier both happening to be named the same thing).
// - entity: the row label (team, subcategory, carrier, complaint, etc.)
// - market: a specific market code (e.g. 'FA-NL') or 'FA-EU' for combined view.
// - value/valueType: a SNAPSHOT of the number shown when the comment was
//   added ('pct' | 'money' | 'count'), so the comments overview can display
//   it without needing to recompute anything later.
import { Redis } from '@upstash/redis';

const STORE_KEY = 'factor-team-comments';

function findEnv(...candidates) {
  for (const name of candidates) {
    if (process.env[name]) return process.env[name];
  }
  for (const name of candidates) {
    const found = Object.keys(process.env).find(k => k.endsWith(name));
    if (found) return process.env[found];
  }
  return undefined;
}

function getRedisClientOrThrow() {
  const url = findEnv('KV_REST_API_URL', 'REDIS_REST_URL', 'UPSTASH_REDIS_REST_URL', '_REST_API_URL', '_REDIS_REST_URL');
  const token = findEnv('KV_REST_API_TOKEN', 'REDIS_REST_TOKEN', 'UPSTASH_REDIS_REST_TOKEN', '_REST_API_TOKEN', '_REDIS_REST_TOKEN');
  if (!url || !token) {
    const relevantKeys = Object.keys(process.env).filter(k => /KV|REDIS|UPSTASH/i.test(k));
    throw new Error(
      `Could not find Redis/KV REST API credentials in environment variables. ` +
      `Env var names containing KV/REDIS/UPSTASH found on this deployment: [${relevantKeys.join(', ') || 'none'}]. ` +
      `Check the Storage tab in Vercel to confirm the database is connected to THIS project, and redeploy after connecting.`
    );
  }
  return new Redis({ url, token });
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET' && req.query && req.query.debug) {
      const relevantKeys = Object.keys(process.env).filter(k => /KV|REDIS|UPSTASH/i.test(k)).sort();
      let clientOk = false, clientError = null;
      try { getRedisClientOrThrow(); clientOk = true; } catch (e) { clientError = e.message; }
      return res.status(200).json({ relevantEnvVarNames: relevantKeys, clientInitialized: clientOk, clientError });
    }

    const redis = getRedisClientOrThrow();

    if (req.method === 'GET') {
      const comments = (await redis.get(STORE_KEY)) || [];
      return res.status(200).json({ comments });
    }

    if (req.method === 'POST') {
      const { scope, scopeLabel, entity, market, week, value, valueType, text, author } = req.body || {};
      if (!scope || !entity || !market || !week || !text || !String(text).trim()) {
        return res.status(400).json({ error: 'scope, entity, market, week, and text are required' });
      }
      const comments = (await redis.get(STORE_KEY)) || [];
      const comment = {
        id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        scope: String(scope).slice(0, 60),
        scopeLabel: String(scopeLabel || scope).slice(0, 120),
        entity: String(entity).slice(0, 200),
        market: String(market).slice(0, 20),
        week: String(week).slice(0, 20),
        value: typeof value === 'number' ? value : null,
        valueType: valueType ? String(valueType).slice(0, 20) : null,
        text: String(text).slice(0, 2000),
        author: (author ? String(author) : 'Anonymous').slice(0, 100),
        createdAt: new Date().toISOString(),
      };
      comments.push(comment);
      await redis.set(STORE_KEY, comments);
      return res.status(200).json({ comment });
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id is required' });
      let comments = (await redis.get(STORE_KEY)) || [];
      comments = comments.filter(c => c.id !== id);
      await redis.set(STORE_KEY, comments);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
}
