/* ============================================================
   COMMENTS STORE
   Comments across every table (team, subcategory, carrier,
   compensation, etc.), persisted server-side via /api/comments
   (Vercel serverless function + Upstash Redis). Shared across
   everyone viewing the dashboard, not per-browser.

   Each comment is a snapshot: it stores the value/valueType shown
   at the moment it was added, so later pages (like the Comments
   overview) can display it without recomputing anything.
   ============================================================ */

const CommentsStore = {
  comments: [],
  loaded: false,
  loadError: null,

  async load() {
    try {
      const res = await fetch('/api/comments');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      this.comments = data.comments || [];
      this.loaded = true;
    } catch (e) {
      console.error('CommentsStore.load failed:', e);
      this.loadError = e.message || 'Failed to load comments';
    }
  },

  getFor(scope, entity, market, week) {
    return this.comments.filter(c => c.scope === scope && c.entity === entity && c.market === market && c.week === week);
  },

  async add({ scope, scopeLabel, entity, market, week, value, valueType, text, author }) {
    const res = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, scopeLabel, entity, market, week, value, valueType, text, author }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    this.comments.push(data.comment);
    return data.comment;
  },

  async remove(id) {
    const res = await fetch('/api/comments', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    this.comments = this.comments.filter(c => c.id !== id);
  },
};
