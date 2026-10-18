import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const statuses = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
];
const priorities = ['low', 'medium', 'high'];

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error ?? `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function App() {
  const [user, setUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [items, setItems] = useState([]);
  const [users, setUsers] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [login, setLogin] = useState({ email: 'admin@newtonite.local', password: '' });
  const [loginError, setLoginError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [assigneeId, setAssigneeId] = useState('');
  const [memberDraft, setMemberDraft] = useState({ displayName: '', email: '', password: '' });
  const [loadError, setLoadError] = useState('');
  const createAttempt = useRef(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (search.trim()) params.set('search', search.trim());
    return params.size ? `?${params.toString()}` : '';
  }, [statusFilter, search]);

  const loadItems = useCallback(async () => {
    try {
      const result = await api(`/api/work-items${query}`);
      setItems(result.items);
      setLoadError('');
    } catch (error) {
      setLoadError(error.message);
    }
  }, [query]);

  useEffect(() => {
    api('/api/auth/me')
      .then(({ user: currentUser }) => setUser(currentUser))
      .catch(() => setUser(null))
      .finally(() => setCheckingSession(false));
  }, []);

  useEffect(() => {
    if (user) loadItems();
  }, [user, loadItems]);

  useEffect(() => {
    if (user?.role === 'admin') {
      api('/api/users').then(({ users: team }) => setUsers(team)).catch((error) => setNotice(error.message));
    }
  }, [user]);

  async function handleLogin(event) {
    event.preventDefault();
    setBusy(true);
    setLoginError('');
    try {
      const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(login) });
      setUser(result.user);
    } catch (error) {
      setLoginError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
    setItems([]);
    setNotice('You have signed out.');
  }

  async function handleCreate(event) {
    event.preventDefault();
    setBusy(true);
    setNotice('');
    const requestBody = JSON.stringify({ title, description, priority, assigneeId: assigneeId || null });
    if (!createAttempt.current || createAttempt.current.body !== requestBody) {
      createAttempt.current = { body: requestBody, key: crypto.randomUUID() };
    }
    try {
      await api('/api/work-items', {
        method: 'POST',
        headers: { 'idempotency-key': createAttempt.current.key },
        body: requestBody,
      });
      createAttempt.current = null;
      setTitle('');
      setDescription('');
      setPriority('medium');
      setAssigneeId('');
      setNotice('Work item added.');
      await loadItems();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateMember(event) {
    event.preventDefault();
    setBusy(true);
    setNotice('');
    try {
      const result = await api('/api/users', { method: 'POST', body: JSON.stringify(memberDraft) });
      setUsers((current) => [...current, result.user].sort((a, b) => a.displayName.localeCompare(b.displayName)));
      setMemberDraft({ displayName: '', email: '', password: '' });
      setNotice(`${result.user.displayName} was added to the team.`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function updateStatus(item, nextStatus) {
    if (nextStatus === item.status) return;
    setNotice('');
    try {
      await api(`/api/work-items/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus, version: item.version }),
      });
      await loadItems();
    } catch (error) {
      setNotice(error.status === 409 ? 'This item changed elsewhere. The latest data has been reloaded.' : error.message);
      await loadItems();
    }
  }

  const counts = useMemo(() => Object.fromEntries(
    statuses.map(({ value }) => [value, items.filter((item) => item.status === value).length]),
  ), [items]);

  if (checkingSession) return <main className="loading-screen">Loading Newtonite Ops…</main>;

  if (!user) {
    return (
      <main className="login-shell">
        <section className="login-card" aria-labelledby="login-heading">
          <div className="brand-mark" aria-hidden="true">N</div>
          <p className="eyebrow">NEWTONITE OPERATIONS</p>
          <h1 id="login-heading">Welcome back</h1>
          <p className="muted">Sign in to keep the team's work moving.</p>
          <form className="login-form" onSubmit={handleLogin}>
            <label htmlFor="email">Work email</label>
            <input id="email" type="email" autoComplete="username" value={login.email}
              onChange={(event) => setLogin({ ...login, email: event.target.value })} required />
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" value={login.password}
              onChange={(event) => setLogin({ ...login, password: event.target.value })} required />
            {loginError && <p className="form-error" role="alert">{loginError}</p>}
            <button className="primary-button full-width" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
          <p className="login-footnote">Use the admin email and password configured for your local API.</p>
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#top" aria-label="Newtonite Ops home">
          <span className="brand-mark small" aria-hidden="true">N</span>
          <span>newtonite<span className="brand-light">ops</span></span>
        </a>
        <div className="workspace-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <a className="nav-link active" href="#work-items"><span className="nav-icon">▦</span> Work items <span className="nav-count">{items.length}</span></a>
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card"><span className="help-icon">↗</span><div><strong>Keep work clear</strong><p>One place for the next step.</p></div></div>
          <div className="profile-row">
            <div className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</div>
            <div className="profile-copy"><strong>{user.displayName}</strong><span>{user.role}</span></div>
            <button className="icon-button logout-button" onClick={handleLogout} aria-label="Sign out" title="Sign out">↪</button>
          </div>
        </div>
      </aside>

      <main className="main-content" id="top">
        <header className="topbar"><div><span className="breadcrumb">Workspace</span><span className="crumb-slash">/</span><strong>Work items</strong></div><span className="live-pill"><span /> All systems ready</span></header>
        <section className="page-content" id="work-items">
          <div className="page-heading">
            <div><p className="eyebrow">OPERATIONS OVERVIEW</p><h1>Work items</h1><p className="muted">A clear view of what needs attention and what comes next.</p></div>
            <div className="updated-stamp"><span className="refresh-symbol">↻</span> Live workspace</div>
          </div>

          <div className="summary-grid" aria-label="Work item totals">
            <SummaryCard label="Open" value={counts.open ?? 0} tone="blue" icon="○" />
            <SummaryCard label="In progress" value={counts.in_progress ?? 0} tone="violet" icon="◷" />
            <SummaryCard label="Blocked" value={counts.blocked ?? 0} tone="amber" icon="Ⅱ" />
            <SummaryCard label="Completed" value={counts.done ?? 0} tone="green" icon="✓" />
          </div>

          <section className="create-panel" aria-labelledby="create-heading">
            <div className="panel-title-row"><div><span className="section-icon">＋</span><div><h2 id="create-heading">Add a work item</h2><p>Capture the task so the team can move it forward.</p></div></div><span className="required-note">* Required</span></div>
            <form className="create-form" onSubmit={handleCreate}>
              <div className="field title-field"><label htmlFor="item-title">Title <span>*</span></label><input id="item-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} placeholder="e.g. Review weekly inventory report" required /></div>
              <div className="field priority-field"><label htmlFor="item-priority">Priority</label><select id="item-priority" value={priority} onChange={(event) => setPriority(event.target.value)}>{priorities.map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></div>
              {user.role === 'admin' && <div className="field assignee-field"><label htmlFor="item-assignee">Assignee <span className="optional">Optional</span></label><select id="item-assignee" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}><option value="">Unassigned</option>{users.filter((candidate) => candidate.role === 'member').map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayName}</option>)}</select></div>}
              <div className="field description-field"><label htmlFor="item-description">Details <span className="optional">Optional</span></label><textarea id="item-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={5000} rows={2} placeholder="Add context, a handoff, or a useful link…" /></div>
              <div className="submit-row"><span>New items start in <strong>Open</strong>.</span><button className="primary-button" disabled={busy || !title.trim()}><span>＋</span> {busy ? 'Adding…' : 'Add item'}</button></div>
            </form>
          </section>

          {user.role === 'admin' && <details className="team-panel">
            <summary><span><strong>Manage team</strong><small>{users.filter((candidate) => candidate.role === 'member').length} members · Add or create a teammate account</small></span><span className="team-chevron">⌄</span></summary>
            <div className="team-content">
              <form className="member-form" onSubmit={handleCreateMember}>
                <div className="field"><label htmlFor="member-name">Name</label><input id="member-name" value={memberDraft.displayName} onChange={(event) => setMemberDraft({ ...memberDraft, displayName: event.target.value })} maxLength={80} required /></div>
                <div className="field"><label htmlFor="member-email">Email</label><input id="member-email" type="email" value={memberDraft.email} onChange={(event) => setMemberDraft({ ...memberDraft, email: event.target.value })} required /></div>
                <div className="field"><label htmlFor="member-password">Temporary password</label><input id="member-password" type="password" minLength={12} autoComplete="new-password" value={memberDraft.password} onChange={(event) => setMemberDraft({ ...memberDraft, password: event.target.value })} required /></div>
                <button className="primary-button" disabled={busy || !memberDraft.password}>Add member</button>
              </form>
              <ul className="member-list">{users.filter((candidate) => candidate.role === 'member').map((member) => <li key={member.id}><span className="avatar">{member.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{member.displayName}</strong><small>{member.email}</small></span><span className="member-role">Member</span></li>)}</ul>
            </div>
          </details>}

          <section className="items-panel" aria-labelledby="items-heading">
            <div className="items-header"><div><h2 id="items-heading">Team queue <span className="total-pill">{items.length}</span></h2><p>Keep owners aligned and update status as work moves.</p></div><div className="item-controls"><label className="search-box"><span aria-hidden="true">⌕</span><input aria-label="Search work items" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search items" /></label><label className="filter-select"><span className="sr-only">Filter by status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option>{statuses.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label></div></div>
            {notice && <div className="notice" role="status">{notice}<button className="notice-close" onClick={() => setNotice('')} aria-label="Dismiss message">×</button></div>}
            {loadError && <div className="notice error-notice" role="alert">{loadError}<button className="text-button" onClick={loadItems}>Try again</button></div>}
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Work item</th><th scope="col">Priority</th><th scope="col">Status</th><th scope="col">Updated</th></tr></thead>
                <tbody>
                  {items.map((item) => <WorkItemRow key={item.id} item={item} user={user} onStatusChange={updateStatus} />)}
                  {!items.length && !loadError && <tr><td colSpan="4" className="empty-state"><span className="empty-icon">▧</span><strong>{search || statusFilter !== 'all' ? 'No matching work items' : 'Your queue is clear'}</strong><span>{search || statusFilter !== 'all' ? 'Try changing the filters.' : 'Add a work item above to get started.'}</span></td></tr>}
                </tbody>
              </table>
            </div>
            <div className="table-footer"><span>Showing {items.length} {items.length === 1 ? 'item' : 'items'} · maximum 200</span><span>Changes save as you make them</span></div>
          </section>
          <footer className="page-footer">Newtonite Ops <span>·</span> A calmer way to move work forward.</footer>
        </section>
      </main>
    </div>
  );
}

function SummaryCard({ label, value, tone, icon }) {
  return <article className="summary-card"><span className={`summary-icon ${tone}`}>{icon}</span><div><span className="summary-label">{label}</span><strong>{value}</strong></div><span className={`summary-accent ${tone}`} /></article>;
}

function WorkItemRow({ item, user, onStatusChange }) {
  const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(item.updatedAt));
  const canEdit = user.role === 'admin' || item.createdBy === user.id || item.assigneeId === user.id;
  return (
    <tr>
      <td><div className="work-title">{item.title}</div>{(item.description || item.assigneeName) && <div className="work-description">{item.assigneeName ? `Assigned to ${item.assigneeName}` : ''}{item.assigneeName && item.description ? ' · ' : ''}{item.description}</div>}</td>
      <td><span className={`priority-tag ${item.priority}`}><span />{item.priority}</span></td>
      <td><label className={`status-control ${item.status}`}><span className="sr-only">Status for {item.title}</span><select value={item.status} disabled={!canEdit} onChange={(event) => onStatusChange(item, event.target.value)}>{statuses.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select><span aria-hidden="true" className="select-chevron">⌄</span></label></td>
      <td><span className="date-cell">{date}</span></td>
    </tr>
  );
}

export default App;
