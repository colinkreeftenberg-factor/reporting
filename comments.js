/* ============================================================
   COMMENTS STORE
   Team/market/week comments, persisted server-side via /api/comments
   (a Vercel serverless function backed by Vercel KV). Comments are
   shared across everyone viewing the dashboard, not per-browser.
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

  getFor(team, market, week) {
    return this.comments.filter(c => c.team === team && c.market === market && c.week === week);
  },

  async add(team, market, week, text, author) {
    const res = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team, market, week, text, author }),
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
