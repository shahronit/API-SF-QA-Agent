/* Global app state: meta, projects, current project/environment, theme, notifications. */
(() => {
  const QA = window.QA;
  const listeners = new Map();
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(`qa.${k}`); localStorage.setItem(`qa.${k}`, v); } catch { return null; } return v; };

  const state = {
    meta: null,
    projects: [],
    projectId: store('projectId'),
    theme: store('theme') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    notifications: [],

    get project() { return this.projects.find((p) => p.id === this.projectId) || null; },
    get isProduction() { return Boolean(this.project && this.project.environment === 'Production'); },

    on(evt, fn) { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); return () => listeners.get(evt).delete(fn); },
    emit(evt, data) { (listeners.get(evt) || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },

    async load() {
      const [meta, projects] = await Promise.all([QA.api.get('/api/meta'), QA.api.get('/api/projects')]);
      this.meta = meta;
      this.projects = projects;
      if (!this.projects.some((p) => p.id === this.projectId)) this.projectId = this.defaultProjectId();
      this.emit('projects', this.projects);
    },
    /** Prefer a non-production project as the default so nobody lands in Production by accident. */
    defaultProjectId() {
      const p = this.projects.find((x) => x.environment !== 'Production') || this.projects[0];
      return p ? p.id : null;
    },
    async reloadProjects() {
      this.projects = await QA.api.get('/api/projects');
      if (!this.projects.some((p) => p.id === this.projectId)) this.projectId = this.defaultProjectId();
      this.emit('projects', this.projects);
      this.emit('project', this.project);
    },
    setProject(id) {
      if (id === this.projectId) return;
      this.projectId = id;
      store('projectId', id);
      this.emit('project', this.project);
    },
    setTheme(t) {
      this.theme = t;
      store('theme', t);
      document.documentElement.setAttribute('data-theme', t);
      this.emit('theme', t);
    },
    notify(n) {
      this.notifications.unshift({ ...n, at: new Date().toISOString(), read: false });
      this.notifications = this.notifications.slice(0, 30);
      this.emit('notifications', this.notifications);
    },
  };
  document.documentElement.setAttribute('data-theme', state.theme);
  QA.state = state;
})();
