import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TourGuideZone, type TourGuideZoneProps, type TooltipProps } from 'rn-tourguide';

import { useI18n } from '@/i18n';
import { ONBOARDING_STEPS } from '@/lib/onboarding';

const palette = {
  ink: '#16212B',
  muted: '#657179',
  teal: '#2BC5A4',
  tealDark: '#117C6D',
  navy: '#20252D',
  greenSoft: '#DFF8EF',
  hairline: '#D8E9E7',
};

export function OnboardingTooltip({
  currentStep,
  handleNext,
  handlePrev,
  handleStop,
  isFirstStep,
  isLastStep,
}: TooltipProps) {
  const { t } = useI18n();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const step = ONBOARDING_STEPS[(currentStep.order ?? 1) - 1] ?? ONBOARDING_STEPS[0];
  const compact = screenWidth < 360 || screenHeight < 640;
  const horizontalInset = screenWidth < 360 ? 12 : 16;
  const cardWidth = Math.min(390, Math.max(0, screenWidth - horizontalInset * 2));
  const maxCardHeight = Math.max(128, screenHeight - insets.top - insets.bottom - 28);

  const handleNextPress = () => {
    if (isLastStep) {
      handleStop?.();
      return;
    }
    handleNext?.();
  };

  return (
    <View
      style={[
        styles.card,
        {
          width: cardWidth,
          maxHeight: maxCardHeight,
          padding: compact ? 14 : 18,
          gap: compact ? 8 : 12,
        },
      ]}>
      <ScrollView
        bounces={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.cardContent}>
        <View style={styles.progressRow}>
          <Text style={styles.progress}>
            {currentStep.order} / {ONBOARDING_STEPS.length}
          </Text>
          <Pressable style={({ pressed }) => [styles.skip, pressed && styles.pressed]} onPress={handleStop}>
            <Text style={styles.skipText}>{t('onboarding.skip')}</Text>
          </Pressable>
        </View>

        <Text style={[styles.title, compact && styles.titleCompact]}>{t(step.titleKey)}</Text>

        <View style={styles.footer}>
          <View style={styles.dots}>
            {ONBOARDING_STEPS.map((item, index) => (
              <View
                key={`${item.target}-${index}`}
                style={[styles.dot, index + 1 === currentStep.order && styles.dotActive]}
              />
            ))}
          </View>

          {!isFirstStep ? (
            <Pressable style={({ pressed }) => [styles.previous, pressed && styles.pressed]} onPress={handlePrev}>
              <Text style={styles.previousText}>{t('onboarding.previous')}</Text>
            </Pressable>
          ) : null}

          <Pressable style={({ pressed }) => [styles.next, pressed && styles.pressed]} onPress={handleNextPress}>
            <Text style={styles.nextText}>{isLastStep ? t('onboarding.finish') : t('onboarding.next')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

export function AdaptiveTourGuideZone(props: TourGuideZoneProps) {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const compact = screenWidth < 360 || screenHeight < 640;
  const tooltipBottomOffset = Math.max(props.tooltipBottomOffset ?? 0, compact ? 8 : 24);

  return <TourGuideZone {...props} tooltipBottomOffset={tooltipBottomOffset} />;
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    alignSelf: 'center',
    overflow: 'hidden',
    elevation: 9999,
    shadowColor: '#071B22',
    shadowOpacity: 0.3,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 14 },
    zIndex: 9999,
  },
  cardContent: { flexGrow: 1, justifyContent: 'center' },
  progressRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  progress: { color: palette.tealDark, fontSize: 12, fontWeight: '900' },
  skip: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 4 },
  skipText: { color: palette.muted, fontSize: 10, fontWeight: '800' },
  emoji: { fontSize: 35, lineHeight: 56, textAlign: 'center' },
  title: { color: palette.ink, fontSize: 20, lineHeight: 27, fontWeight: '900', textAlign: 'center', flexShrink: 1 },
  titleCompact: { fontSize: 18, lineHeight: 24 },
  target: {
    borderRadius: 8,
    backgroundColor: palette.greenSoft,
    borderLeftWidth: 4,
    borderLeftColor: palette.teal,
    padding: 12,
    gap: 4,
  },
  targetLabel: { color: palette.tealDark, fontSize: 10, fontWeight: '900' },
  targetValue: { color: palette.ink, fontSize: 14, fontWeight: '800' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  dots: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: palette.hairline },
  dotActive: { width: 20, backgroundColor: palette.teal },
  previous: {
    minHeight: 42,
    borderRadius: 21,
    paddingHorizontal: 12,
    backgroundColor: '#F0F6F5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previousText: { color: palette.tealDark, fontSize: 12, fontWeight: '900' },
  next: {
    minHeight: 42,
    borderRadius: 21,
    paddingHorizontal: 18,
    backgroundColor: palette.navy,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nextText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  pressed: { opacity: 0.72 },
});
