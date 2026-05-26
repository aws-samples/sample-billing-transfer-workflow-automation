import { useContext } from 'react';
import { RuntimeConfigContext } from '../components/RuntimeConfig';
import { useAuth } from 'react-oidc-context';

/**
 * Returns an authenticated fetch function and the API base URL.
 */
export function useApiFetch() {
  const runtimeConfig = useContext(RuntimeConfigContext);
  const auth = useAuth();

  const apiBase =
    import.meta.env.MODE === 'serve-local'
      ? 'http://localhost:8000'
      : (runtimeConfig?.apis?.BillingApi ?? '').replace(/\/$/, '');

  const apiFetch = (path: string, init?: RequestInit) => {
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string>),
    };
    const token = auth?.user?.id_token;
    if (token) {
      headers['Authorization'] = token;
    }
    if (init?.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    // Include selected account for cross-account operations
    const accountId = localStorage.getItem('billing-portal-selected-account');
    if (accountId) {
      headers['X-Account-Id'] = accountId;
    }
    return fetch(`${apiBase}${path}`, { ...init, headers });
  };

  return { apiBase, apiFetch };
}
