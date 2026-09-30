import {
  ACCOUNT_API_BASE_URL,
  getRuntimeApiConfig,
} from '@/lib/config';

export type AccountCheckKind =
  | 'configuration'
  | 'reachable'
  | 'auth-required'
  | 'route-not-found'
  | 'server-error'
  | 'network-error';

export type AccountApiCheck = {
  name: string;
  url: string;
  status: number | null;
  ok: boolean;
  kind: AccountCheckKind;
  detail: string;
  durationMs: number;
};

export type AccountApiDiagnostics = {
  config: ReturnType<typeof getRuntimeApiConfig>;
  checks: AccountApiCheck[];
};

export async function diagnoseAccountApi(
  baseUrl = ACCOUNT_API_BASE_URL,
  token = '',
): Promise<AccountApiDiagnostics> {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  const config = getRuntimeApiConfig();

  if (!normalizedBaseUrl) {
    return {
      config,
      checks: [
        {
          name: 'base URL',
          url: '',
          status: null,
          ok: false,
          kind: 'configuration',
          detail: 'ACCOUNT_API_BASE_URL is empty. Set EXPO_PUBLIC_ACCOUNT_API_BASE_URL and restart Expo.',
          durationMs: 0,
        },
      ],
    };
  }

  const health = await checkEndpoint('health', `${normalizedBaseUrl}/health`);
  const rewards = await checkEndpoint(
    'rewards route',
    `${normalizedBaseUrl}/api/rewards/progress?client_date=${encodeURIComponent(getClientDate())}`,
    token,
  );

  return { config, checks: [health, rewards] };
}

async function checkEndpoint(name: string, url: string, token = ''): Promise<AccountApiCheck> {
  const startedAt = Date.now();
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const response = await fetch(url, { headers, credentials: 'include' });
    const durationMs = Date.now() - startedAt;

    if (response.status === 404) {
      return {
        name,
        url,
        status: response.status,
        ok: false,
        kind: 'route-not-found',
        detail: 'The host responded, but this route was not found. Check the reverse proxy and API prefix.',
        durationMs,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        name,
        url,
        status: response.status,
        ok: name === 'rewards route',
        kind: 'auth-required',
        detail: 'The service is reachable. This protected route requires a valid Bearer token.',
        durationMs,
      };
    }

    if (response.status >= 500) {
      return {
        name,
        url,
        status: response.status,
        ok: false,
        kind: 'server-error',
        detail: 'The server or reverse proxy returned a 5xx response. Check Login_SQL and Nginx logs.',
        durationMs,
      };
    }

    return {
      name,
      url,
      status: response.status,
      ok: response.ok,
      kind: 'reachable',
      detail: response.ok ? 'Endpoint responded successfully.' : `Unexpected HTTP status ${response.status}.`,
      durationMs,
    };
  } catch (error) {
    return {
      name,
      url,
      status: null,
      ok: false,
      kind: 'network-error',
      detail: getNetworkErrorDetail(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

function getNetworkErrorDetail(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return `The request did not receive an HTTP response. Check DNS, TLS, firewall, server availability, or browser CORS. (${detail})`;
}

function getClientDate() {
  const date = new Date();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
