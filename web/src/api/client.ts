const BASE = '/admin';

async function apiFetch(path: string, token: string, options?: RequestInit): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export const api = {
  getCapabilities: (token: string) => apiFetch('/capabilities', token),
  deleteCapability: (token: string, id: string) =>
    apiFetch(`/capabilities/${id}`, token, { method: 'DELETE' }),
  getPolicies: (token: string) => apiFetch('/policies', token),
  getCosts: (token: string, windowHours = 24) =>
    apiFetch(`/costs?windowHours=${windowHours}`, token),
  getAudit: (token: string, limit = 50, offset = 0) =>
    apiFetch(`/audit?limit=${limit}&offset=${offset}`, token),
  getHealth: (): Promise<unknown> => fetch('/health').then((r) => r.json()),
};
