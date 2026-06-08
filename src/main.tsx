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

const STATIC_SESSION_STORAGE_KEY = 'smart-campus-static-session';
const STATIC_DB_STORAGE_KEY = 'smart-campus-static-db-v1';
const STATIC_DB_COUNTER_STORAGE_KEY = 'smart-campus-static-db-counter-v1';
const STATIC_PASSWORD_STORAGE_KEY = 'smart-campus-static-password';
const staticAdminUser = {
  id: 1,
  email: 'admin@smartcampus.ai',
  role: 'Master Admin',
  name: 'Master Admin',
  department: 'Administration',
  designation: 'System Administrator',
  responsibilities: '',
  access_limits: '',
  access_paths: '',
  force_password_change: false,
};

const createJsonResponse = (payload: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  });

const STATIC_CRUD_TABLES = new Set([
  'users',
  'campuses',
  'buildings',
  'blocks',
  'floors',
  'rooms',
  'schools',
  'departments',
  'department_allocations',
  'equipment',
  'schedules',
  'bookings',
  'maintenance',
]);

const getStoredStaticPassword = () => {
  if (typeof window === 'undefined') return 'admin123';

  try {
    return window.localStorage.getItem(STATIC_PASSWORD_STORAGE_KEY) || 'admin123';
  } catch {
    return 'admin123';
  }
};

const persistStaticPassword = (password: string) => {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(STATIC_PASSWORD_STORAGE_KEY, password);
  } catch {
    // Ignore storage errors in static demo mode.
  }
};

const normalizeStaticSession = (user: any) => {
  if (!user || typeof user !== 'object') return null;

  if (
    user.email === staticAdminUser.email &&
    user.name === staticAdminUser.name &&
    user.role === 'Administrator'
  ) {
    return {
      ...user,
      role: 'Master Admin',
    };
  }

  return user;
};

const getStoredStaticSession = () => {
  if (typeof window === 'undefined') return null;

  try {
    const rawValue = window.localStorage.getItem(STATIC_SESSION_STORAGE_KEY);
    const parsedValue = rawValue ? JSON.parse(rawValue) : null;
    const normalizedValue = normalizeStaticSession(parsedValue);
    if (normalizedValue && JSON.stringify(normalizedValue) !== JSON.stringify(parsedValue)) {
      window.localStorage.setItem(STATIC_SESSION_STORAGE_KEY, JSON.stringify(normalizedValue));
    }
    return normalizedValue;
  } catch {
    return null;
  }
};

const persistStaticSession = (user: typeof staticAdminUser | null) => {
  if (typeof window === 'undefined') return;

  try {
    if (user) {
      window.localStorage.setItem(STATIC_SESSION_STORAGE_KEY, JSON.stringify(user));
    } else {
      window.localStorage.removeItem(STATIC_SESSION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors in static demo mode.
  }
};

const getStoredStaticDb = () => {
  if (typeof window === 'undefined') return {};

  try {
    const rawValue = window.localStorage.getItem(STATIC_DB_STORAGE_KEY);
    const parsedValue = rawValue ? JSON.parse(rawValue) : {};
    return parsedValue && typeof parsedValue === 'object' ? parsedValue : {};
  } catch {
    return {};
  }
};

const persistStaticDb = (dbState: Record<string, any[]>) => {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(STATIC_DB_STORAGE_KEY, JSON.stringify(dbState));
  } catch {
    // Ignore storage errors in static demo mode.
  }
};

const getNextStaticId = () => {
  if (typeof window === 'undefined') return Date.now();

  try {
    const rawValue = window.localStorage.getItem(STATIC_DB_COUNTER_STORAGE_KEY);
    const nextValue = (rawValue ? Number(rawValue) : 1) || 1;
    window.localStorage.setItem(STATIC_DB_COUNTER_STORAGE_KEY, String(nextValue + 1));
    return nextValue;
  } catch {
    return Date.now();
  }
};

const getStaticCrudMatch = (pathname: string) => {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'api') return null;

  const tableName = segments[1];
  if (!tableName || !STATIC_CRUD_TABLES.has(tableName)) return null;

  return {
    tableName,
    idSegment: segments[2] || '',
  };
};

const getRequestMethod = (input: RequestInfo | URL, init?: RequestInit) =>
  (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

const getRequestPath = (input: RequestInfo | URL) => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return `${input.pathname}${input.search}`;

  const requestUrl = new URL(input.url);
  return `${requestUrl.pathname}${requestUrl.search}`;
};

const readRequestJsonBody = async (input: RequestInfo | URL, init?: RequestInit) => {
  try {
    if (init?.body && typeof init.body === 'string') {
      return JSON.parse(init.body);
    }

    if (input instanceof Request) {
      return JSON.parse(await input.clone().text());
    }
  } catch {
    return null;
  }

  return null;
};

const handleStaticApiRequest = async (input: RequestInfo | URL, init?: RequestInit) => {
  const method = getRequestMethod(input, init);
  const path = getRequestPath(input);
  const pathname = path.split('?')[0];
  const isAuthenticated = !!getStoredStaticSession();

  if (pathname === '/api/auth/login' && method === 'POST') {
    const requestBody = await readRequestJsonBody(input, init);
    const email = requestBody?.email?.toString().trim().toLowerCase();
    const password = requestBody?.password?.toString();

    if (email === staticAdminUser.email && password === getStoredStaticPassword()) {
      persistStaticSession(staticAdminUser);
      return createJsonResponse({ user: staticAdminUser });
    }

    return createJsonResponse({ error: 'Invalid credentials' }, { status: 401 });
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = getStoredStaticSession();
    return user
      ? createJsonResponse({ user })
      : createJsonResponse({ error: 'Not logged in' }, { status: 401 });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    persistStaticSession(null);
    return createJsonResponse({ success: true });
  }

  if (pathname === '/api/auth/change-password' && method === 'POST') {
    const user = getStoredStaticSession();
    if (!user) {
      return createJsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    const requestBody = await readRequestJsonBody(input, init);
    const password = requestBody?.password?.toString() || '';
    if (password.length < 8) {
      return createJsonResponse({ error: 'Password must be at least 8 characters.' }, { status: 400 });
    }

    const updatedUser = {
      ...user,
      force_password_change: false,
    };
    persistStaticPassword(password);
    persistStaticSession(updatedUser);

    return createJsonResponse({ user: updatedUser });
  }

  if (pathname.startsWith('/api/') && !isAuthenticated) {
    return createJsonResponse({ error: 'Unauthorized' }, { status: 401 });
  }

  if (pathname === '/api/dashboard/stats' && method === 'GET') {
    return createJsonResponse({
      totalBuildings: 0,
      availableNow: 0,
      scheduledRooms: 0,
      equipmentIssues: 0,
      pendingBookings: 0,
      recentAlerts: [],
    });
  }

  if (pathname === '/api/analytics/utilization-trends' && method === 'GET') {
    return createJsonResponse([]);
  }

  if (pathname === '/api/reports/utilization' && method === 'GET') {
    return createJsonResponse({
      schoolReports: [],
      deptReports: [],
      roomReports: [],
      overallUtilization: 0,
    });
  }

  if (pathname === '/api/notifications' && method === 'GET') {
    return createJsonResponse([]);
  }

  if (pathname === '/api/notifications/read-all' && method === 'POST') {
    return createJsonResponse({ success: true });
  }

  const crudMatch = getStaticCrudMatch(pathname);
  if (crudMatch) {
    const dbState = getStoredStaticDb();
    const currentRows = Array.isArray(dbState[crudMatch.tableName]) ? dbState[crudMatch.tableName] : [];

    if (method === 'GET' && !crudMatch.idSegment) {
      return createJsonResponse(currentRows);
    }

    if (method === 'POST' && !crudMatch.idSegment) {
      const requestBody = await readRequestJsonBody(input, init);
      const createdRow = {
        id: getNextStaticId(),
        ...(requestBody || {}),
      };
      dbState[crudMatch.tableName] = [...currentRows, createdRow];
      persistStaticDb(dbState);
      return createJsonResponse(createdRow);
    }

    if (method === 'PUT' && crudMatch.idSegment) {
      const requestBody = await readRequestJsonBody(input, init);
      const targetId = crudMatch.idSegment.toString();
      let didUpdate = false;

      dbState[crudMatch.tableName] = currentRows.map((row: any) => {
        if (row?.id?.toString() !== targetId) return row;
        didUpdate = true;
        return { ...row, ...(requestBody || {}) };
      });

      if (!didUpdate) {
        return createJsonResponse({ error: 'Record not found' }, { status: 404 });
      }

      persistStaticDb(dbState);
      return createJsonResponse({ success: true });
    }

    if (method === 'DELETE' && crudMatch.idSegment === 'reset') {
      dbState[crudMatch.tableName] = [];
      persistStaticDb(dbState);
      return createJsonResponse({ success: true });
    }

    if (method === 'DELETE' && crudMatch.idSegment) {
      const targetId = crudMatch.idSegment.toString();
      dbState[crudMatch.tableName] = currentRows.filter((row: any) => row?.id?.toString() !== targetId);
      persistStaticDb(dbState);
      return createJsonResponse({ success: true });
    }
  }

  if (pathname.startsWith('/api/')) {
    return method === 'GET'
      ? createJsonResponse([])
      : createJsonResponse({ success: true });
  }

  return null;
};

if (typeof window !== 'undefined') {
  const nativeFetch = window.fetch.bind(window);

  const fetchApiWithFallback = async (
    input: RequestInfo | URL,
    init?: RequestInit,
    rewrittenInput?: RequestInfo | URL,
    rewrittenInit?: RequestInit,
  ) => {
    try {
      const response = await nativeFetch(rewrittenInput ?? input, rewrittenInit ?? init);
      if (response.status !== 404 && response.status < 500) return response;

      const requestPath = getRequestPath(input);
      if (requestPath.startsWith('/api/')) {
        const mockResponse = await handleStaticApiRequest(input, init);
        if (mockResponse) return mockResponse;
      }

      return response;
    } catch (error) {
      const requestPath = getRequestPath(input);
      if (requestPath.startsWith('/api/')) {
        const mockResponse = await handleStaticApiRequest(input, init);
        if (mockResponse) return mockResponse;
      }

      throw error;
    }
  };

  const buildApiFetchTarget = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      if (apiBaseUrl) {
        return {
          rewrittenInput: `${apiBaseUrl}${input}` as RequestInfo | URL,
          rewrittenInit: {
            ...init,
            credentials: init?.credentials ?? 'include',
          },
        };
      }

      return {
        rewrittenInput: input,
        rewrittenInit: {
          ...init,
          credentials: init?.credentials ?? 'include',
        },
      };
    }

    if (input instanceof Request) {
      const currentOrigin = window.location.origin;
      if (input.url.startsWith(`${currentOrigin}/api/`)) {
        if (apiBaseUrl) {
          const rewrittenUrl = `${apiBaseUrl}${input.url.slice(currentOrigin.length)}`;
          const rewrittenRequest = new Request(rewrittenUrl, input);
          return {
            rewrittenInput: rewrittenRequest as RequestInfo | URL,
            rewrittenInit: {
              ...init,
              credentials: init?.credentials ?? input.credentials ?? 'include',
            },
          };
        }

        return {
          rewrittenInput: input,
          rewrittenInit: {
            ...init,
            credentials: init?.credentials ?? input.credentials ?? 'include',
          },
        };
      }
    }

    return null;
  };

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const apiTarget = buildApiFetchTarget(input, init);
    if (apiTarget) {
      return fetchApiWithFallback(input, init, apiTarget.rewrittenInput, apiTarget.rewrittenInit);
    }

    return nativeFetch(input, init);
  };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
