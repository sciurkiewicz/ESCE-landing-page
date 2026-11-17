// Wartości zapasowe. Treści i ustawienia edytuje się w panelu /adminpanel.
export interface Video {
  id: string; // identyfikator z adresu youtube.com/watch?v=...
  title: string;
  category: string;
  duration?: string;
}

export interface Project {
  title: string;
  description: string;
  tags: string[];
  url: string;
  image: string;
  status: string;
}

export interface Tool {
  title: string;
  description: string;
  image?: string;
  url?: string;
  category?: string;
}

export const site = {
  name: 'ESCE',
  youtubeUrl: '',
  email: '',
  githubUrl: '',
  discordUrl: '',
  tagline: '',
  about: '',
  videos: [] as Video[],
  projects: [] as Project[],
  tools: [] as Tool[],
};

// Pozwala bezpiecznie używać adresów z konfiguracji w atrybutach href/src.
export function safeUrl(value: string, options: { email?: boolean; local?: boolean } = {}): string {
  if (options.email) return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) ? `mailto:${value}` : '';
  if (options.local && /^\/(?!\/)/.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}
