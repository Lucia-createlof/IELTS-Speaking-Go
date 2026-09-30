import { Platform } from 'react-native';
import Purchases, { LOG_LEVEL, type CustomerInfo } from 'react-native-purchases';
import RevenueCatUI, { PAYWALL_RESULT } from 'react-native-purchases-ui';

const DEFAULT_API_KEY = 'sk_wGJsUJWKRznsYVWfRLNHweFlJqMvR';

const iosApiKey = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY ?? DEFAULT_API_KEY;
const androidApiKey = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY ?? DEFAULT_API_KEY;

export const REVENUECAT_ENTITLEMENT_ID = process.env.EXPO_PUBLIC_REVENUECAT_ENTITLEMENT_ID?.trim() ?? '';

let configuredPlatform: typeof Platform.OS | null = null;

export function configureRevenueCat(): boolean {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return false;
  }

  if (configuredPlatform === Platform.OS) {
    return true;
  }

  const apiKey = Platform.OS === 'ios' ? iosApiKey : androidApiKey;
  if (!apiKey) {
    return false;
  }

  void Purchases.setLogLevel(LOG_LEVEL.VERBOSE).catch(() => undefined);
  Purchases.configure({ apiKey });
  configuredPlatform = Platform.OS;
  return true;
}

export async function getRevenueCatCustomerInfo(): Promise<CustomerInfo | null> {
  if (!configureRevenueCat()) {
    return null;
  }

  try {
    return await Purchases.getCustomerInfo();
  } catch {
    return null;
  }
}

export async function hasActiveEntitlement(
  entitlementId = REVENUECAT_ENTITLEMENT_ID,
): Promise<boolean> {
  if (!entitlementId) {
    return false;
  }

  const customerInfo = await getRevenueCatCustomerInfo();
  return customerInfo?.entitlements.active[entitlementId] !== undefined;
}

export async function presentPaywall(): Promise<boolean> {
  if (!configureRevenueCat()) {
    return false;
  }

  try {
    const paywallResult = await RevenueCatUI.presentPaywall();
    return paywallResult === PAYWALL_RESULT.PURCHASED || paywallResult === PAYWALL_RESULT.RESTORED;
  } catch {
    return false;
  }
}
