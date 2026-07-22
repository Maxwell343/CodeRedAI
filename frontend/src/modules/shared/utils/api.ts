const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/+$/, '');

const HOSPITAL_AUTH_STORAGE_KEY = 'codered-hospital-auth-v2';
const DRIVER_AUTH_STORAGE_KEY = 'codered-driver-auth-v2';
const ADMIN_AUTH_STORAGE_KEY = 'codered-admin-auth-v2';

function resolveApiUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  const normalizedPath = url.startsWith('/') ? url : `/${url}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

function getStoredAuthToken(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const keys = [HOSPITAL_AUTH_STORAGE_KEY, DRIVER_AUTH_STORAGE_KEY, ADMIN_AUTH_STORAGE_KEY];
  for (const key of keys) {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { token?: string };
        if (parsed.token && typeof parsed.token === 'string') {
          return parsed.token;
        }
      } catch {
        // continue
      }
    }
  }

  return null;
}

export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getStoredAuthToken();
  const authHeaders: Record<string, string> = {};

  if (token) {
    authHeaders['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(resolveApiUrl(url), {
    ...init,
    credentials: init?.credentials ?? 'include',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    let message = `Request failed with status ${response.status}`;

    if (contentType.includes('application/json')) {
      const payload = (await response.json()) as { message?: string; detail?: string };
      if (payload.message) {
        message = payload.message;
      } else if (payload.detail) {
        message = payload.detail;
      }
    } else {
      const textPayload = await response.text();
      if (textPayload.trim()) {
        message = textPayload.trim();
      }
    }

    throw new Error(message);
  }

  return (await response.json()) as T;
}
