export interface Post {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  category: string;
  status: 'draft' | 'published';
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export type ContentKind = 'projects' | 'tools' | 'videos';

export interface ContentItem {
  id: string;
  kind: ContentKind;
  title: string;
  description: string;
  image: string;
  url: string;
  category: string;
  status: 'draft' | 'published';
  createdAt: string;
  updatedAt: string;
}

export interface SiteSettings {
  siteName: string;
  email: string;
  youtubeUrl: string;
  youtubeChannelId: string;
  githubUrl: string;
  discordUrl: string;
  about: string;
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = options.method?.toUpperCase() ?? 'GET';
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  const mutates = !['GET', 'HEAD'].includes(method);
  if (mutates) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      credentials: 'same-origin',
      body: mutates ? (options.body ?? '{}') : options.body,
    });
  } catch {
    throw new ApiError('Nie udało się połączyć z serwerem. Spróbuj ponownie za chwilę.', 0);
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new ApiError('Serwer zwrócił nieprawidłową odpowiedź. Spróbuj ponownie.', response.status);
  }
  if (!response.ok) {
    const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
      ? result.error
      : 'Nie udało się wykonać tej operacji.';
    throw new ApiError(message, response.status);
  }
  return result as T;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
