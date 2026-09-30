import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { TourGuideProvider } from 'rn-tourguide';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { OnboardingTooltip } from '@/components/onboarding-tooltip';
import { RewardPointsProvider } from '@/components/reward-points';
import { I18nProvider, useI18n } from '@/i18n';
import { configureRevenueCat } from '@/lib/revenuecat';

SplashScreen.preventAutoHideAsync();

export default function TabLayout() {
  const colorScheme = useColorScheme();

  useEffect(() => {
    configureRevenueCat();
  }, []);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <I18nProvider>
        <AppNavigation />
      </I18nProvider>
    </ThemeProvider>
  );
}

function AppNavigation() {
  const { t } = useI18n();

  return (
    <TourGuideProvider
      tooltipComponent={OnboardingTooltip}
      labels={{
        skip: t('onboarding.skip'),
        previous: t('onboarding.previous'),
        next: t('onboarding.next'),
        finish: t('onboarding.finish'),
      }}
      backdropColor="rgba(7, 27, 34, 0.72)"
      verticalOffset={30}
      androidStatusBarVisible={false}
      borderRadius={8}
      maskOffset={6}
      preventOutsideInteraction={true}>
      <RewardPointsProvider>
        <Stack screenOptions={{ headerShown: false }} />
      </RewardPointsProvider>
      <AnimatedSplashOverlay />
    </TourGuideProvider>
  );
}
