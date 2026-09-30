export type OnboardingTab = 'mock' | 'practice' | 'profile';

export const ONBOARDING_STEPS = [
  { emoji: '👆', titleKey: 'onboarding.step1', target: '开始模拟测试按钮', tab: 'mock' as const },
  { emoji: '👇', titleKey: 'onboarding.step2', target: '分块练习图标', tab: 'practice' as const },
  { emoji: '👉', titleKey: 'onboarding.step3', target: '分块练习卡片', tab: 'practice' as const },
  { emoji: '👇', titleKey: 'onboarding.step4', target: '我的图标', tab: 'profile' as const },
  { emoji: '👆', titleKey: 'onboarding.step5', target: '日历面板区域', tab: 'profile' as const },
  { emoji: '👇', titleKey: 'onboarding.step6', target: '历史记录区域', tab: 'profile' as const },
  { emoji: '👆', titleKey: 'onboarding.step7', target: '日历面板区域', tab: 'profile' as const },
] as const;
