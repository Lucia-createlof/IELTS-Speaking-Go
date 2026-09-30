import AsyncStorage from '@react-native-async-storage/async-storage';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { Platform } from 'react-native';

import { ACCOUNT_API_BASE_URL, GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID } from '@/lib/config';

export type AuthSession = {
  username: string;
  token: string;
  token_type: string;
  logged_in_at: string;
  phone?: string;
  email?: string;
  display_name?: string;
  auth_type?: 'PHONE' | 'TEST_ACCOUNT' | string;
};

type TokenResponse = {
  username?: string;
  access_token?: string;
  token?: string;
  token_type?: string;
  phone?: string;
  email?: string;
  display_name?: string;
  auth_type?: string;
  session?: unknown;
};

type BrowserStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

const AUTH_STORAGE_KEY = 'ielts_mockai_session';
const AUTH_COOKIE_NAME = 'ielts_mockai_session';
const AUTH_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

let memorySession: AuthSession | null = null;

function getStorage() {
  return (globalThis as { localStorage?: BrowserStorage }).localStorage;
}

function getCookieSource() {
  return (globalThis as { document?: { cookie: string } }).document;
}

function readCookie(name: string) {
  const source = getCookieSource();
  if (!source?.cookie) {
    return '';
  }
  const match = source.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

function writeCookie(name: string, value: string, maxAge: number) {
  const source = getCookieSource();
  if (!source) {
    return;
  }
  source.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`;
}

function parseSession(value: string | null | undefined): AuthSession | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<AuthSession>;
    const username = parsed.username ?? parsed.phone;
    if (username && parsed.token && parsed.logged_in_at) {
      return {
        username,
        phone: parsed.phone,
        email: parsed.email,
        display_name: parsed.display_name,
        token: parsed.token,
        token_type: parsed.token_type ?? 'bearer',
        logged_in_at: parsed.logged_in_at,
        auth_type: parsed.auth_type,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeTokenResponse(payload: TokenResponse): AuthSession {
  const source = isRecord(payload.session) ? (payload.session as TokenResponse) : payload;
  const username = typeof source.username === 'string' ? source.username : '';
  const token =
    typeof source.access_token === 'string'
      ? source.access_token
      : typeof source.token === 'string'
        ? source.token
        : '';

  if (!username || !token) {
    throw new Error('登录接口没有返回有效的 username 和 access_token。');
  }

  return {
    username,
    phone: typeof source.phone === 'string' ? source.phone : undefined,
    email: typeof source.email === 'string' ? source.email : undefined,
    display_name: typeof source.display_name === 'string' ? source.display_name : undefined,
    token,
    token_type: source.token_type ?? 'bearer',
    logged_in_at: new Date().toISOString(),
    auth_type: source.auth_type,
  };
}

export function loadStoredAuthSession() {
  const stored = parseSession(getStorage()?.getItem(AUTH_STORAGE_KEY));
  if (stored) {
    memorySession = stored;
    return stored;
  }

  const cookieSession = parseSession(readCookie(AUTH_COOKIE_NAME));
  if (cookieSession) {
    memorySession = cookieSession;
    return cookieSession;
  }

  return memorySession;
}

export async function hydrateStoredAuthSession() {
  const synchronousSession = loadStoredAuthSession();
  if (synchronousSession) {
    return synchronousSession;
  }
  let stored: AuthSession | null = null;
  try {
    stored = parseSession(await AsyncStorage.getItem(AUTH_STORAGE_KEY));
  } catch {
    return null;
  }
  if (stored) {
    memorySession = stored;
  }
  return stored;
}

export function saveStoredAuthSession(session: AuthSession) {
  memorySession = session;
  const encoded = JSON.stringify(session);
  getStorage()?.setItem(AUTH_STORAGE_KEY, encoded);
  void AsyncStorage.setItem(AUTH_STORAGE_KEY, encoded).catch(() => undefined);
  writeCookie(AUTH_COOKIE_NAME, encoded, AUTH_MAX_AGE_SECONDS);
}

export function clearStoredAuthSession() {
  memorySession = null;
  getStorage()?.removeItem(AUTH_STORAGE_KEY);
  void AsyncStorage.removeItem(AUTH_STORAGE_KEY).catch(() => undefined);
  writeCookie(AUTH_COOKIE_NAME, '', 0);
}

export function getStoredAccessToken() {
  return loadStoredAuthSession()?.token ?? '';
}

export function buildAuthHeaders(headers?: HeadersInit) {
  const nextHeaders = new Headers(headers);
  const token = getStoredAccessToken();
  if (token) {
    nextHeaders.set('Authorization', `Bearer ${token}`);
  }
  return nextHeaders;
}

export async function authFetch(
  pathOrUrl: string,
  init: RequestInit = {},
  baseUrl = ACCOUNT_API_BASE_URL,
) {
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${baseUrl}${pathOrUrl}`;
  return fetch(url, {
    ...init,
    headers: buildAuthHeaders(init.headers),
    credentials: init.credentials ?? 'include',
  });
}

async function ensureJsonResponse(response: Response) {
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `请求失败：${response.status}`);
  }
  return response.json();
}

async function readAuthResponse(response: Response): Promise<TokenResponse> {
  const text = await response.text();
  let payload: TokenResponse | { detail?: string } | null = null;

  // 防止将 Nginx 502 HTML 当成 JSON 解析
  if (text.trim().startsWith('<')) {
    throw new Error('服务器暂时不可用（502），请稍后重试');
  }

  try {
    payload = text ? (JSON.parse(text) as TokenResponse | { detail?: string }) : null;
  } catch {
    throw new Error('服务器返回了无法解析的响应，请稍后重试');
  }

  if (!response.ok) {
    const detail =
      payload && 'detail' in payload && typeof payload.detail === 'string'
        ? payload.detail
        : '';
    const statusDetail = `HTTP ${response.status}`;
    throw new Error(detail ? `${detail} (${statusDetail})` : `请求失败 (${statusDetail})`);
  }
  return (payload ?? {}) as TokenResponse;
}

export async function loginWithAliyunPhone(loginToken: string): Promise<AuthSession> {
  const response = await fetch(`${ACCOUNT_API_BASE_URL}/api/auth/aliyun-phone-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ sp_token: loginToken }),
  });
  const session = normalizeTokenResponse(await readAuthResponse(response));
  saveStoredAuthSession(session);
  return session;
}

let googleSignInConfigured = false;

function configureGoogleSignIn() {
  if (Platform.OS === 'web') {
    throw new Error('Google 登录目前仅支持 iOS 和 Android 客户端。');
  }
  if (!GOOGLE_IOS_CLIENT_ID && !GOOGLE_WEB_CLIENT_ID) {
    throw new Error('请先配置 EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID 和 EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID。');
  }
  if (!googleSignInConfigured) {
    GoogleSignin.configure({
      iosClientId: GOOGLE_IOS_CLIENT_ID || undefined,
      webClientId: GOOGLE_WEB_CLIENT_ID || undefined,
      scopes: ['profile', 'email'],
    });
    googleSignInConfigured = true;
  }
}

export async function loginWithGoogle(): Promise<AuthSession> {
  configureGoogleSignIn();
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const result = await GoogleSignin.signIn();
  if (result.type !== 'success') {
    throw new Error('Google 登录已取消。');
  }
  const idToken = result.data.idToken;
  if (!idToken) {
    throw new Error('Google 未返回有效的 ID token，请检查 OAuth 客户端配置。');
  }
  const response = await fetch(`${ACCOUNT_API_BASE_URL}/api/auth/google-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ id_token: idToken }),
  });
  const session = normalizeTokenResponse(await readAuthResponse(response));
  saveStoredAuthSession(session);
  return session;
}

export async function loginWithPassword(username: string, password: string): Promise<AuthSession> {
  const response = await fetch(`${ACCOUNT_API_BASE_URL}/api/auth/legacy-test-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username, password }),
  });
  const session = normalizeTokenResponse(await ensureJsonResponse(response));
  saveStoredAuthSession(session);
  return session;
}

export async function logoutSession() {
  if (Platform.OS !== 'web' && googleSignInConfigured) {
    await GoogleSignin.signOut().catch(() => undefined);
  }
  clearStoredAuthSession();
  await AsyncStorage.removeItem(AUTH_STORAGE_KEY).catch(() => undefined);
}

export async function deleteAccount() {
  const response = await authFetch('/api/auth/account', { method: 'DELETE' });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `请求失败：${response.status}`);
  }
  clearStoredAuthSession();
  await AsyncStorage.removeItem(AUTH_STORAGE_KEY).catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
