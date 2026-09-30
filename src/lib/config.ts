import Constants from 'expo-constants';

const explicitApiUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
const explicitAccountApiUrl = process.env.EXPO_PUBLIC_ACCOUNT_API_BASE_URL;
export const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim() || '';
export const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim() || '';

function normalizeBaseUrl(value: string | undefined) {
  return value?.trim().replace(/\/+$/, '') || undefined;
}

function getExpoHost() {
  const constants = Constants as typeof Constants & {
    manifest?: { debuggerHost?: string };
    manifest2?: { extra?: { expoGo?: { debuggerHost?: string } } };
  };

  const hostUri =
    Constants.expoConfig?.hostUri ??
    constants.manifest?.debuggerHost ??
    constants.manifest2?.extra?.expoGo?.debuggerHost;

  return hostUri?.split(':')[0];
}

const devHost = getExpoHost();

export const API_BASE_URL =
  normalizeBaseUrl(explicitApiUrl) ??
  (devHost ? `http://${devHost}:8000` : '');

// Login_SQL owns auth, history, rewards, and inventory. Keep it configurable
// because the analysis service and the account service can be deployed apart.
export const ACCOUNT_API_BASE_URL =
  normalizeBaseUrl(explicitAccountApiUrl) ?? API_BASE_URL;

export const API_BASE_URL_SOURCE = explicitApiUrl
  ? 'EXPO_PUBLIC_API_BASE_URL'
  : devHost
    ? 'Expo development host fallback'
    : 'missing';

export const ACCOUNT_API_BASE_URL_SOURCE = explicitAccountApiUrl
  ? 'EXPO_PUBLIC_ACCOUNT_API_BASE_URL'
  : explicitApiUrl
    ? 'EXPO_PUBLIC_API_BASE_URL fallback'
    : devHost
      ? 'Expo development host fallback'
      : 'missing';

export function getRuntimeApiConfig() {
  return {
    apiBaseUrl: API_BASE_URL,
    apiBaseUrlSource: API_BASE_URL_SOURCE,
    accountApiBaseUrl: ACCOUNT_API_BASE_URL,
    accountApiBaseUrlSource: ACCOUNT_API_BASE_URL_SOURCE,
    accountApiExplicitlyConfigured: Boolean(normalizeBaseUrl(explicitAccountApiUrl)),
  };
}

if (!API_BASE_URL) {
  throw new Error(
    'API_BASE_URL is not configured. Please set EXPO_PUBLIC_API_BASE_URL.'
  );
}
