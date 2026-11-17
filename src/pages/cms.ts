import { api, escapeHtml, type ContentItem, type ContentKind, type SiteSettings } from '../api';
import { renderMarkdown } from '../markdown';

export interface CmsHost {
  token: () => string;
  busy: () => boolean;
  lock: (value: boolean) => void;
  notice: (text: string) => void;
  report: (error: unknown, retry?: () => void) => void;
}
export interface CmsPanel {
  dirty: () => boolean;
  mount: (container: HTMLElement) => Promise<void>;
}
type ItemDraft = Pick<ContentItem, 'title' | 'description' | 'url' | 'image' | 'category'>;
const itemFields = (item: ContentItem): ItemDraft => ({ title: item.title, description: item.description, url: item.url, image: item.image, category: item.category });
const itemLabels = {
  projects: { heading: 'Projekty', create: 'Nowy projekt', edit: 'Edytuj projekt', empty: 'Brak projektów.' },
  tools: { heading: 'Narzędzia', create: 'Nowe narzędzie', edit: 'Edytuj narzędzie', empty: 'Brak narzędzi.' },
  videos: { heading: 'Filmy', create: 'Nowy film', edit: 'Edytuj film', empty: 'Brak ręcznie dodanych filmów.' },
};
const input = (id: string, label: string, value: string, attributes: string) => `<label class="admin-field" for="${id}">${label}<input id="${id}" ${attributes} value="${escapeHtml(value)}"></label>`;
const settingsFields = (settings: SiteSettings): SiteSettings => ({ siteName: settings.siteName, email: settings.email, youtubeUrl: settings.youtubeUrl, youtubeChannelId: settings.youtubeChannelId, githubUrl: settings.githubUrl, discordUrl: settings.discordUrl, about: settings.about });

export function createContentPanel(kind: ContentKind, host: CmsHost): CmsPanel {
  let root: HTMLElement;
  let items: ContentItem[] = [];
  let selected: ContentItem | null = null;
  let draft: ItemDraft | null = null;
  let baseline = '';
  const labels = itemLabels[kind];
  const path = `/api/admin/content/${kind}`;
  const dirty = () => draft !== null && JSON.stringify(draft) !== baseline;
  const discard = () => !dirty() || window.confirm('Masz niezapisane zmiany. Opuścić edytor bez zapisywania?');

  function list() {
    const listElement = root.querySelector<HTMLElement>('#cms-items')!;
    listElement.innerHTML = items.length ? [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((item) => `<li>
      <button type="button" class="admin-post" data-item="${escapeHtml(item.id)}" ${item.id === selected?.id ? 'aria-current="true"' : ''}>
      <strong>${escapeHtml(item.title)}</strong><span>${item.status === 'published' ? 'Opublikowany' : 'Szkic'}${item.category ? ` · ${escapeHtml(item.category)}` : ''}</span></button></li>`).join('') : `<li class="admin-empty">${labels.empty}</li>`;
    listElement.querySelectorAll<HTMLButtonElement>('[data-item]').forEach((button) => button.addEventListener('click', () => {
      if (host.busy() || !discard()) return;
      const item = items.find((entry) => entry.id === button.dataset.item);
      if (item) open(item);
    }));
  }

  function sync() {
    const form = root.querySelector<HTMLFormElement>('#cms-item-form');
    if (!form || !draft) return;
    const data = new FormData(form);
    draft = { title: String(data.get('title') ?? ''), description: String(data.get('description') ?? ''), url: String(data.get('url') ?? ''), image: String(data.get('image') ?? ''), category: String(data.get('category') ?? '') };
    root.querySelector('#cms-unsaved')!.textContent = dirty() ? 'Niezapisane zmiany' : selected ? 'Zmiany zapisane' : 'Nowa treść';
  }

  function open(item: ContentItem | null) {
    selected = item;
    draft = item ? itemFields(item) : { title: '', description: '', url: '', image: '', category: '' };
    baseline = JSON.stringify(draft);
    list();
    editor();
    host.notice('');
    root.querySelector<HTMLInputElement>('#cms-title')?.focus();
  }

  function editor() {
    const container = root.querySelector<HTMLElement>('#cms-editor')!;
    if (!draft) { container.innerHTML = '<p class="admin-empty">Wybierz element z listy lub dodaj nowy.</p>'; return; }
    container.innerHTML = `<form id="cms-item-form" novalidate>
      <div class="admin-editor-heading"><h2>${selected ? labels.edit : labels.create}</h2><span id="cms-unsaved" class="admin-unsaved">${dirty() ? 'Niezapisane zmiany' : selected ? 'Zmiany zapisane' : 'Nowa treść'}</span></div>
      ${input('cms-title', 'Tytuł', draft.title, 'name="title" maxlength="160" required')}
      <label class="admin-field" for="cms-description">Opis <span>(maks. 4000 znaków)</span><textarea id="cms-description" name="description" rows="6" maxlength="4000">${escapeHtml(draft.description)}</textarea></label>
      ${input('cms-url', kind === 'videos' ? 'Link do filmu na YouTube' : 'Link', draft.url, 'name="url" maxlength="2048" inputmode="url"')}
      <p class="admin-hint">${kind === 'videos' ? 'Podaj adres filmu YouTube: watch, shorts lub youtu.be. Link jest wymagany przy publikacji.' : 'Adres HTTPS lub ścieżka na stronie zaczynająca się od /. Pole może pozostać puste.'}</p>
      ${input('cms-image', 'Obraz / miniatura', draft.image, 'name="image" maxlength="2048" inputmode="url"')}
      <p class="admin-hint">Adres grafiki HTTPS lub ścieżka do pliku na stronie, np. /grafika.png. Pole może pozostać puste.</p>
      ${input('cms-category', 'Kategoria', draft.category, 'name="category" maxlength="80"')}
      <div class="admin-editor-actions"><button type="button" class="admin-delete" id="cms-delete" ${selected ? '' : 'hidden'}>Usuń</button><div class="admin-save-actions">
        <button type="submit" data-status="draft">${selected?.status === 'published' ? 'Przenieś do szkiców' : 'Zapisz szkic'}</button>
        <button type="submit" class="admin-primary" data-status="published">${selected?.status === 'published' ? 'Zapisz zmiany' : 'Opublikuj'}</button>
      </div></div></form>`;
    const form = container.querySelector<HTMLFormElement>('form')!;
    form.addEventListener('input', sync);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const button = (event as SubmitEvent).submitter as HTMLButtonElement | null;
      void save(button?.dataset.status === 'published' ? 'published' : 'draft', button);
    });
    container.querySelector('#cms-delete')!.addEventListener('click', () => { void remove(); });
  }

  async function save(status: ContentItem['status'], button: HTMLButtonElement | null) {
    if (host.busy() || !draft) return;
    sync();
    const form = root.querySelector<HTMLFormElement>('#cms-item-form')!;
    form.querySelector<HTMLInputElement>('#cms-url')!.required = kind === 'videos' && status === 'published';
    if (!form.reportValidity()) return;
    const previous = button?.textContent;
    host.lock(true);
    if (button) button.textContent = 'Zapisywanie…';
    host.notice('');
    try {
      const result = await api<{ item: ContentItem }>(selected ? `${path}/${encodeURIComponent(selected.id)}` : path, {
        method: selected ? 'PUT' : 'POST', headers: { 'X-CSRF-Token': host.token() }, body: JSON.stringify({ ...draft, status }),
      });
      items = [result.item, ...items.filter((item) => item.id !== result.item.id)];
      selected = result.item;
      draft = itemFields(result.item);
      baseline = JSON.stringify(draft);
      list();
      editor();
      host.notice(status === 'published' ? 'Treść zapisana i opublikowana.' : 'Szkic zapisany.');
    } catch (error) { host.report(error); if (button && previous) button.textContent = previous; }
    finally { host.lock(false); }
  }

  async function remove() {
    if (host.busy() || !selected || !window.confirm(`Usunąć „${selected.title}”? Tej operacji nie można cofnąć.`)) return;
    host.lock(true);
    const button = root.querySelector<HTMLButtonElement>('#cms-delete')!;
    button.textContent = 'Usuwanie…';
    try {
      await api(`${path}/${encodeURIComponent(selected.id)}`, { method: 'DELETE', headers: { 'X-CSRF-Token': host.token() } });
      items = items.filter((item) => item.id !== selected!.id);
      selected = null;
      draft = null;
      baseline = '';
      list();
      editor();
      host.notice('Treść usunięta.');
    } catch (error) { host.report(error); button.textContent = 'Usuń'; }
    finally { host.lock(false); }
  }

  async function load() {
    host.lock(true);
    host.notice('Wczytywanie treści…');
    try { items = (await api<{ items: ContentItem[] }>(path)).items; list(); host.notice(''); }
    catch (error) { host.report(error, () => { void load(); }); }
    finally { host.lock(false); }
  }

  return { dirty, async mount(container) {
    root = container;
    root.innerHTML = `<div class="admin-topbar"><button type="button" class="admin-primary" id="cms-new">${labels.create}</button></div>
      ${kind === 'videos' ? '<p class="admin-section-note">Ręcznie dodane filmy uzupełniają automatyczną listę z kanału.</p>' : ''}
      <div class="admin-layout"><aside class="admin-sidebar" aria-label="Lista treści"><h2>${labels.heading}</h2><ul id="cms-items"></ul></aside><section id="cms-editor" aria-label="Edytor treści"></section></div>`;
    root.querySelector('#cms-new')!.addEventListener('click', () => { if (!host.busy() && discard()) open(null); });
    editor();
    await load();
  } };
}

export function createSettingsPanel(host: CmsHost): CmsPanel {
  let root: HTMLElement;
  let draft: SiteSettings | null = null;
  let baseline = '';
  const dirty = () => draft !== null && JSON.stringify(draft) !== baseline;

  function sync() {
    if (!draft) return;
    const data = new FormData(root.querySelector<HTMLFormElement>('#cms-settings-form')!);
    draft = { siteName: String(data.get('siteName') ?? ''), email: String(data.get('email') ?? ''), youtubeUrl: String(data.get('youtubeUrl') ?? ''), youtubeChannelId: String(data.get('youtubeChannelId') ?? ''), githubUrl: String(data.get('githubUrl') ?? ''), discordUrl: String(data.get('discordUrl') ?? ''), about: String(data.get('about') ?? '') };
    root.querySelector('#cms-settings-unsaved')!.textContent = dirty() ? 'Niezapisane zmiany' : 'Zmiany zapisane';
  }

  function editor() {
    if (!draft) return;
    root.innerHTML = `<form id="cms-settings-form" class="admin-settings" novalidate>
      <div class="admin-editor-heading"><h2>Ustawienia strony</h2><span id="cms-settings-unsaved" class="admin-unsaved">${dirty() ? 'Niezapisane zmiany' : 'Zmiany zapisane'}</span></div>
      <p class="admin-section-note">Zmień dane strony i kontaktu. Aby usunąć daną informację, wyczyść jej pole i zapisz ustawienia.</p>
      ${input('cms-site-name', 'Nazwa strony', draft.siteName, 'name="siteName" maxlength="60"')}
      ${input('cms-email', 'E-mail do kontaktu', draft.email, 'name="email" type="email" maxlength="254"')}
      ${input('cms-youtube-url', 'Adres kanału YouTube', draft.youtubeUrl, 'name="youtubeUrl" type="url" maxlength="2048"')}
      ${input('cms-youtube-id', 'Identyfikator kanału YouTube', draft.youtubeChannelId, 'name="youtubeChannelId" maxlength="24" pattern="UC[A-Za-z0-9_-]{22}"')}
      <p class="admin-hint">24 znaki, zaczyna się od UC. Umożliwia pobieranie najnowszych filmów z kanału. Możesz zostawić to pole puste.</p>
      ${input('cms-github', 'Adres profilu GitHub', draft.githubUrl, 'name="githubUrl" type="url" maxlength="2048"')}
      ${input('cms-discord', 'Link do Discorda', draft.discordUrl, 'name="discordUrl" type="url" maxlength="2048"')}
      <div class="admin-content-heading"><label for="cms-about">O mnie</label><div class="admin-view-buttons" role="group" aria-label="Widok treści O mnie">
        <button type="button" data-view="edit" aria-pressed="true">Edytor</button><button type="button" data-view="preview" aria-pressed="false">Podgląd</button></div></div>
      <p class="admin-hint" id="cms-about-help">Markdown: ## nagłówek, **pogrubienie**, [tekst](https://adres.pl), - lista. Maks. 30 000 znaków.</p>
      <textarea id="cms-about" class="admin-content" name="about" rows="12" maxlength="30000" aria-describedby="cms-about-help">${escapeHtml(draft.about)}</textarea>
      <div id="cms-about-preview" class="admin-preview" aria-label="Podgląd strony O mnie" hidden></div>
      <div class="admin-editor-actions"><button type="submit" class="admin-primary">Zapisz ustawienia</button></div></form>`;
    const form = root.querySelector<HTMLFormElement>('form')!;
    form.addEventListener('input', sync);
    form.addEventListener('submit', (event) => { event.preventDefault(); void save(); });
    root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.addEventListener('click', () => {
      sync();
      const preview = button.dataset.view === 'preview';
      root.querySelector<HTMLTextAreaElement>('#cms-about')!.hidden = preview;
      const output = root.querySelector<HTMLElement>('#cms-about-preview')!;
      output.hidden = !preview;
      if (preview) output.innerHTML = draft!.about.trim() ? renderMarkdown(draft!.about) : '<p class="admin-hint">Podgląd pojawi się po wpisaniu treści.</p>';
      root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((tab) => tab.setAttribute('aria-pressed', String((tab.dataset.view === 'preview') === preview)));
    }));
  }

  async function save() {
    if (host.busy() || !draft) return;
    sync();
    if (!root.querySelector<HTMLFormElement>('form')!.reportValidity()) return;
    host.lock(true);
    const button = root.querySelector<HTMLButtonElement>('[type="submit"]')!;
    button.textContent = 'Zapisywanie…';
    host.notice('');
    try {
      const result = await api<{ settings: SiteSettings }>('/api/admin/settings', { method: 'PUT', headers: { 'X-CSRF-Token': host.token() }, body: JSON.stringify(draft) });
      draft = settingsFields(result.settings);
      baseline = JSON.stringify(draft);
      editor();
      host.notice('Ustawienia zapisane.');
      window.dispatchEvent(new CustomEvent('cms:settings-saved', { detail: { settings: result.settings } }));
    } catch (error) { host.report(error); button.textContent = 'Zapisz ustawienia'; }
    finally { host.lock(false); }
  }

  async function load() {
    host.lock(true);
    host.notice('Wczytywanie ustawień…');
    try { draft = settingsFields((await api<{ settings: SiteSettings }>('/api/admin/settings')).settings); baseline = JSON.stringify(draft); editor(); host.notice(''); }
    catch (error) { host.report(error, () => { void load(); }); }
    finally { host.lock(false); }
  }

  return { dirty, async mount(container) {
    root = container;
    if (draft) editor();
    else { root.innerHTML = '<p class="admin-empty">Wczytywanie ustawień…</p>'; await load(); }
  } };
}
