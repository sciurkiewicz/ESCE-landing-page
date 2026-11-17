import { api, ApiError, escapeHtml, type Post, type ContentKind } from '../api';
import { renderMarkdown } from '../markdown';
import { site } from '../site.config';
import { createContentPanel, createSettingsPanel, type CmsPanel } from './cms';

type Session = { authenticated: boolean; configured: boolean; csrfToken?: string };
type Draft = Pick<Post, 'title' | 'category' | 'excerpt' | 'content'>;
const blank = (): Draft => ({ title: '', category: 'Devlog', excerpt: '', content: '' });
const fields = (post: Post): Draft => ({ title: post.title, category: post.category, excerpt: post.excerpt, content: post.content });
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Nie udało się wykonać operacji. Spróbuj ponownie.';

export async function renderAdmin(main: HTMLElement): Promise<void> {
  let csrfToken = '';
  let posts: Post[] = [];
  let selected: Post | null = null;
  let draft: Draft | null = null;
  let baseline = '';
  let busy = false;
  type Tab = 'blog' | ContentKind | 'settings';
  let active: Tab = 'blog';
  let cmsPanel: CmsPanel | null = null;
  const tabs: Record<Tab, string> = { blog: 'Blog', projects: 'Projekty', tools: 'Narzędzia', videos: 'Filmy', settings: 'Ustawienia' };
  const dirty = () => active === 'blog' ? draft !== null && JSON.stringify(draft) !== baseline : cmsPanel?.dirty() ?? false;
  const discard = () => !dirty() || window.confirm('Masz niezapisane zmiany. Opuścić edytor bez zapisywania?');
  const cmsHost = { token: () => csrfToken, busy: () => busy, lock, notice: (text: string) => notice(text), report };

  window.addEventListener('beforeunload', (event) => {
    if (dirty()) { event.preventDefault(); event.returnValue = ''; }
  });

  function shell(content: string) {
    main.innerHTML = `<div class="page-heading"><h1>Panel CMS</h1><p class="page-description"><a href="/blog">← Wróć na blog</a></p></div>
      <div id="admin-notice" class="admin-notice" role="status" hidden></div>${content}`;
  }

  function notice(text: string, error = false, action?: { label: string; run: () => void }) {
    const element = main.querySelector<HTMLElement>('#admin-notice');
    if (!element) return;
    element.hidden = !text;
    element.classList.toggle('admin-error', error);
    element.setAttribute('role', error ? 'alert' : 'status');
    element.replaceChildren(document.createTextNode(text));
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'admin-text-button';
      button.textContent = action.label;
      button.addEventListener('click', action.run);
      element.append(button);
    }
    if (error) element.scrollIntoView({ block: 'nearest' });
  }

  function report(error: unknown, retry?: () => void) {
    const expired = error instanceof ApiError && error.status === 401;
    notice(errorText(error), true, expired
      ? { label: 'Zaloguj się ponownie', run: () => login(true) }
      : retry ? { label: 'Spróbuj ponownie', run: retry } : undefined);
  }

  function lock(value: boolean) {
    busy = value;
    main.setAttribute('aria-busy', String(value));
    main.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>('button, input, textarea').forEach((element) => { element.disabled = value; });
  }

  function list() {
    const container = main.querySelector<HTMLElement>('#admin-posts');
    if (!container) return;
    container.innerHTML = posts.length ? [...posts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((post) => `
      <li><button type="button" class="admin-post" data-post="${escapeHtml(post.id)}" ${selected?.id === post.id ? 'aria-current="true"' : ''}>
        <strong>${escapeHtml(post.title)}</strong><span>${post.status === 'published' ? 'Opublikowany' : 'Szkic'} · ${escapeHtml(post.category)}</span>
      </button></li>`).join('') : '<li class="admin-empty">Brak wpisów.</li>';
    container.querySelectorAll<HTMLButtonElement>('[data-post]').forEach((button) => button.addEventListener('click', () => {
      if (busy || !discard()) return;
      const post = posts.find((item) => item.id === button.dataset.post);
      if (post) openEditor(post);
    }));
  }

  function sync() {
    const form = main.querySelector<HTMLFormElement>('#admin-editor-form');
    if (!form || !draft) return;
    const data = new FormData(form);
    draft = { title: String(data.get('title') ?? ''), category: String(data.get('category') ?? ''), excerpt: String(data.get('excerpt') ?? ''), content: String(data.get('content') ?? '') };
    const status = main.querySelector('#admin-unsaved');
    if (status) status.textContent = dirty() ? 'Niezapisane zmiany' : selected ? 'Zmiany zapisane' : 'Nowy wpis';
  }

  function openEditor(post: Post | null) {
    selected = post;
    draft = post ? fields(post) : blank();
    baseline = JSON.stringify(draft);
    list();
    editor();
    notice('');
    main.querySelector<HTMLInputElement>('#admin-title')?.focus();
  }

  function editor() {
    const container = main.querySelector<HTMLElement>('#admin-editor')!;
    if (!draft) {
      container.innerHTML = '<p class="admin-empty">Wybierz wpis z listy lub utwórz nowy.</p>';
      return;
    }
    container.innerHTML = `<form id="admin-editor-form" novalidate>
      <div class="admin-editor-heading"><h2>${selected ? 'Edytuj wpis' : 'Nowy wpis'}</h2><span id="admin-unsaved">${dirty() ? 'Niezapisane zmiany' : selected ? 'Zmiany zapisane' : 'Nowy wpis'}</span></div>
      <label class="admin-field" for="admin-title">Tytuł<input id="admin-title" name="title" maxlength="160" required value="${escapeHtml(draft.title)}"></label>
      <label class="admin-field" for="admin-category">Kategoria<input id="admin-category" name="category" maxlength="48" required value="${escapeHtml(draft.category)}"></label>
      <label class="admin-field" for="admin-excerpt">Krótki opis <span>(maks. 400 znaków)</span><textarea id="admin-excerpt" name="excerpt" rows="3" maxlength="400">${escapeHtml(draft.excerpt)}</textarea></label>
      <div class="admin-content-heading"><label for="admin-content">Treść wpisu</label><div class="admin-view-buttons" role="group" aria-label="Widok treści">
        <button type="button" data-view="edit" aria-pressed="true">Edytor</button><button type="button" data-view="preview" aria-pressed="false">Podgląd</button>
      </div></div>
      <p class="admin-hint" id="admin-format-help">Markdown: ## nagłówek, **pogrubienie**, [tekst](https://adres.pl), - lista.</p>
      <textarea id="admin-content" name="content" class="admin-content" rows="16" maxlength="100000" aria-describedby="admin-format-help">${escapeHtml(draft.content)}</textarea>
      <div id="admin-preview" class="admin-preview" aria-label="Podgląd wpisu" hidden></div>
      <div class="admin-editor-actions"><div>${selected ? '<button type="button" class="admin-delete" id="admin-delete">Usuń wpis</button>' : ''}</div><div class="admin-save-actions">
        <button type="submit" data-status="draft">${selected?.status === 'published' ? 'Przenieś do szkiców' : 'Zapisz szkic'}</button>
        <button type="submit" class="admin-primary" data-status="published">${selected?.status === 'published' ? 'Zapisz zmiany' : 'Opublikuj wpis'}</button>
      </div></div></form>`;
    const form = container.querySelector<HTMLFormElement>('form')!;
    form.addEventListener('input', sync);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const button = (event as SubmitEvent).submitter as HTMLButtonElement | null;
      void save(button?.dataset.status === 'published' ? 'published' : 'draft', button);
    });
    container.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.addEventListener('click', () => {
      sync();
      const showPreview = button.dataset.view === 'preview';
      container.querySelector<HTMLTextAreaElement>('#admin-content')!.hidden = showPreview;
      const output = container.querySelector<HTMLElement>('#admin-preview')!;
      output.hidden = !showPreview;
      if (showPreview) output.innerHTML = draft!.content.trim() ? renderMarkdown(draft!.content) : '<p class="admin-hint">Podgląd pojawi się po wpisaniu treści.</p>';
      container.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((tab) => tab.setAttribute('aria-pressed', String((tab.dataset.view === 'preview') === showPreview)));
    }));
    container.querySelector('#admin-delete')?.addEventListener('click', () => { void remove(); });
  }

  async function save(status: Post['status'], button: HTMLButtonElement | null) {
    if (busy || !draft) return;
    sync();
    const form = main.querySelector<HTMLFormElement>('#admin-editor-form')!;
    const content = form.querySelector<HTMLTextAreaElement>('#admin-content')!;
    content.required = status === 'published';
    if (!content.validity.valid && content.hidden) form.querySelector<HTMLButtonElement>('[data-view="edit"]')!.click();
    if (!form.reportValidity()) return;
    const previousLabel = button?.textContent;
    lock(true);
    if (button) button.textContent = 'Zapisywanie…';
    notice('');
    try {
      const result = await api<{ post: Post }>(selected ? `/api/admin/posts/${encodeURIComponent(selected.id)}` : '/api/admin/posts', {
        method: selected ? 'PUT' : 'POST', headers: { 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ ...draft, status }),
      });
      posts = [result.post, ...posts.filter((post) => post.id !== result.post.id)];
      selected = result.post;
      draft = fields(result.post);
      baseline = JSON.stringify(draft);
      list();
      editor();
      notice(status === 'published' ? 'Wpis zapisany i opublikowany.' : 'Szkic zapisany.');
    } catch (error) { report(error); if (button && previousLabel) button.textContent = previousLabel; }
    finally { lock(false); }
  }

  async function remove() {
    if (busy || !selected || !window.confirm(`Usunąć wpis „${selected.title}”? Tej operacji nie można cofnąć.`)) return;
    lock(true);
    const button = main.querySelector<HTMLButtonElement>('#admin-delete')!;
    button.textContent = 'Usuwanie…';
    try {
      await api(`/api/admin/posts/${encodeURIComponent(selected.id)}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } });
      posts = posts.filter((post) => post.id !== selected!.id);
      selected = null;
      draft = null;
      baseline = '';
      list();
      editor();
      notice('Wpis usunięty.');
    } catch (error) { report(error); button.textContent = 'Usuń wpis'; }
    finally { lock(false); }
  }

  async function loadPosts() {
    lock(true);
    notice('Wczytywanie wpisów…');
    try {
      posts = (await api<{ posts: Post[] }>('/api/admin/posts')).posts;
      list();
      notice('');
    } catch (error) { report(error, () => { void loadPosts(); }); }
    finally { lock(false); }
  }

  async function workspace() {
    shell(`<div class="admin-navigation"><nav class="admin-tabs" aria-label="Sekcje CMS">${Object.entries(tabs).map(([key, label]) => `<button type="button" data-tab="${key}" ${active === key ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</nav><button type="button" id="admin-logout">Wyloguj</button></div><div id="admin-panel"></div>`);
    main.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => button.addEventListener('click', async () => {
      const next = button.dataset.tab as Tab;
      if (busy || next === active || !discard()) return;
      selected = null;
      draft = null;
      baseline = '';
      active = next;
      cmsPanel = next === 'blog' ? null : next === 'settings' ? createSettingsPanel(cmsHost) : createContentPanel(next, cmsHost);
      await workspace();
    }));
    main.querySelector('#admin-logout')!.addEventListener('click', async () => {
      if (busy || !discard()) return;
      lock(true);
      try {
        await api('/api/admin/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } });
        csrfToken = '';
        selected = null;
        draft = null;
        baseline = '';
        posts = [];
        active = 'blog';
        cmsPanel = null;
        login();
      } catch (error) { report(error); }
      finally { lock(false); }
    });
    const panel = main.querySelector<HTMLElement>('#admin-panel')!;
    if (active !== 'blog') {
      await cmsPanel!.mount(panel);
    } else {
      panel.innerHTML = `<div class="admin-topbar"><button type="button" class="admin-primary" id="admin-new">Nowy wpis</button></div>
        <div class="admin-layout"><aside class="admin-sidebar" aria-label="Lista wpisów"><h2>Wpisy</h2><ul id="admin-posts"></ul></aside><section id="admin-editor" aria-label="Edytor wpisu"></section></div>`;
      editor();
      main.querySelector('#admin-new')!.addEventListener('click', () => { if (!busy && discard()) openEditor(null); });
      await loadPosts();
    }
  }

  function login(expired = false) {
    shell(`<section class="admin-login"><h2>Logowanie</h2><p>${expired ? 'Zaloguj się ponownie. Niezapisane zmiany zostaną zachowane.' : `Zarządzaj treściami na stronie ${escapeHtml(site.name)}.`}</p>
      <form id="admin-login-form"><label class="admin-field" for="admin-password">Hasło<input id="admin-password" name="password" type="password" autocomplete="current-password" required></label><button class="admin-primary" type="submit">Zaloguj się</button></form></section>`);
    main.querySelector<HTMLFormElement>('#admin-login-form')!.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      const input = main.querySelector<HTMLInputElement>('#admin-password')!;
      const password = input.value;
      const button = main.querySelector<HTMLButtonElement>('[type="submit"]')!;
      lock(true);
      button.textContent = 'Logowanie…';
      notice('');
      try {
        const session = await api<Session>('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
        csrfToken = session.csrfToken ?? '';
        input.value = '';
        await workspace();
      } catch (error) { notice(errorText(error), true); button.textContent = 'Zaloguj się'; }
      finally { lock(false); }
    });
  }

  async function initialize() {
    shell('<p class="admin-empty" role="status">Wczytywanie panelu…</p>');
    try {
      const session = await api<Session>('/api/admin/session');
      csrfToken = session.csrfToken ?? '';
      if (!session.configured) {
        shell(`<section class="admin-setup"><h2>Ustaw hasło do panelu</h2><p>Ustaw zmienną środowiskową <code>ADMIN_PASSWORD</code> na własne hasło zawierające co najmniej 12 znaków.</p>
          <p>Lokalnie dodaj ją do pliku <code>.env</code> w katalogu projektu. Na hostingu użyj ustawień zmiennych środowiskowych. Następnie uruchom ponownie serwer.</p>
          <p>Nie dodawaj hasła do repozytorium ani do zmiennych zaczynających się od <code>VITE_</code>.</p><button type="button" id="admin-retry">Sprawdź ponownie</button></section>`);
        main.querySelector('#admin-retry')!.addEventListener('click', () => { void initialize(); });
      } else if (session.authenticated) await workspace();
      else login();
    } catch (error) { shell(''); report(error, () => { void initialize(); }); }
  }

  await initialize();
}
