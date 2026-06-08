import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

const configuredApiBaseUrl = ((import.meta as any).env?.VITE_API_BASE_URL || '')
  .toString()
  .trim()
  .replace(/\/+$/, '');
const isGitHubPages = typeof window !== 'undefined' && window.location.hostname === 'yethish2010.github.io';
const defaultGitHubPagesApiBaseUrl = 'https://mbu-planning.vercel.app';
const apiBaseUrl = configuredApiBaseUrl || (isGitHubPages ? defaultGitHubPagesApiBaseUrl : '');

if (typeof window !== 'undefined') {
  const nativeFetch = window.fetch.bind(window);

  const buildApiFetchTarget = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      return {
        rewrittenInput: (apiBaseUrl ? `${apiBaseUrl}${input}` : input) as RequestInfo | URL,
        rewrittenInit: { ...init, credentials: init?.credentials ?? 'include' },
      };
    }

    if (input instanceof Request) {
      const currentOrigin = window.location.origin;
      if (input.url.startsWith(`${currentOrigin}/api/`)) {
        if (apiBaseUrl) {
          const rewrittenUrl = `${apiBaseUrl}${input.url.slice(currentOrigin.length)}`;
          return {
            rewrittenInput: new Request(rewrittenUrl, input) as RequestInfo | URL,
            rewrittenInit: { ...init, credentials: init?.credentials ?? input.credentials ?? 'include' },
          };
        }
        return {
          rewrittenInput: input,
          rewrittenInit: { ...init, credentials: init?.credentials ?? input.credentials ?? 'include' },
        };
      }
    }

    return null;
  };

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const apiTarget = buildApiFetchTarget(input, init);
    if (apiTarget) {
      return nativeFetch(apiTarget.rewrittenInput, apiTarget.rewrittenInit);
    }
    return nativeFetch(input, init);
  };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
