import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useRewardPoints } from '@/components/reward-points';
import { useI18n } from '@/i18n';
import {
  redeemReward,
  type RewardItemType,
} from '@/lib/rewards';

const PALETTE = {
  bg: '#E9F8F8',
  surface: '#FFFFFF',
  ink: '#16212B',
  muted: '#657179',
  hairline: '#D8E9E7',
  teal: '#2BC5A4',
  navy: '#20252D',
  greenSoft: '#DFF8EF',
  blueSoft: '#E1F3FA',
  redSoft: '#FFE7E3',
};

export default function RewardsScreen() {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const { rewards: progress, rewardsLoading, updateRewards } = useRewardPoints();
  const [redeeming, setRedeeming] = useState<RewardItemType | null>(null);
  const [message, setMessage] = useState('');
  const hasPosterPass = (progress?.inventory.poster_analysis_passes ?? 0) > 0;
  const canRedeem = (progress?.points ?? 0) >= 200;

  const redeem = useCallback(async (itemType: RewardItemType) => {
    setRedeeming(itemType);
    setMessage('');
    try {
      const nextProgress = await redeemReward(itemType);
      updateRewards(nextProgress);
      setMessage(itemType === 'streak_freeze_card' ? t('rewards.cardAdded') : t('rewards.posterUnlocked'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRedeeming(null);
    }
  }, [t, updateRewards]);

  return (
    <View style={styles.app}>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.safeArea} edges={['left', 'right']}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingTop: Math.max(insets.top, 16), paddingBottom: insets.bottom + 30 },
          ]}>
          <View style={styles.header}>
            {/* 返回按钮绝对定位靠左 */}
            <Pressable 
              style={({ pressed }) => [styles.backButton, pressed && styles.pressed]} 
              onPress={() => router.back()}
            >
              <Text style={styles.backButtonText}>{t('common.back')}</Text>
            </Pressable>

            {/* 标题居中 */}
            <View style={styles.headerCopy}>
              <Text style={styles.kicker}>REWARD STORE</Text>
              <Text style={styles.title}>{t('rewards.store')}</Text>
            </View>
          </View>

          <View style={styles.storeIntro}>
            <Text style={styles.storeIntroTitle}>{t('rewards.title')}</Text>
            <Text style={styles.storeIntroText}>{t('rewards.description')}</Text>
          </View>

          {rewardsLoading && !progress ? (
            <View style={styles.loadingCard}>
              <ActivityIndicator color={PALETTE.teal} />
              <Text style={styles.loadingText}>{t('rewards.loading')}</Text>
            </View>
          ) : null}

          {message ? (
            <View style={styles.messageBar}>
              <Text style={styles.messageText}>{message}</Text>
            </View>
          ) : null}

          <View style={styles.storeGrid}>
            <RewardProductCard
              icon="🩹"
              title={t('rewards.streakName')}
              subtitle={t('rewards.streakSubtitle')}
              description={t('rewards.streakDescription')}
              detail={t('rewards.inventoryCount').replace('{count}', `${progress?.inventory.streak_freeze_cards ?? 0}`)}
              canRedeem={canRedeem}
              redeeming={redeeming === 'streak_freeze_card'}
              onRedeem={() => void redeem('streak_freeze_card')}
            />
            <RewardProductCard
              icon="✦"
              title={t('rewards.posterName')}
              subtitle={t('rewards.posterSubtitle')}
              description={t('rewards.posterDescription')}
              detail={hasPosterPass ? t('rewards.passUnlocked') : t('rewards.passLocked')}
              canRedeem={canRedeem}
              redeeming={redeeming === 'poster_analysis'}
              onRedeem={() => void redeem('poster_analysis')}
            />
          </View>

        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function RewardProductCard({
  icon,
  title,
  subtitle,
  description,
  detail,
  canRedeem,
  redeeming,
  onRedeem,
}: {
  icon: string;
  title: string;
  subtitle: string;
  description: string;
  detail: string;
  canRedeem: boolean;
  redeeming: boolean;
  onRedeem: () => void;
}) {
  const { t } = useI18n();
  return (
    <View style={styles.productCard}>
      <View style={styles.productTop}>
        <View style={styles.productIcon}>
          <Text style={styles.productIconText}>{icon}</Text>
        </View>
        <View style={styles.productName}>
          <Text style={styles.productTitle}>{title}</Text>
          <Text style={styles.productSubtitle}>{subtitle}</Text>
        </View>
        <Text style={styles.productCost}>200</Text>
      </View>
      <Text style={styles.productDescription}>{description}</Text>
      <View style={styles.productFooter}>
        <Text style={styles.productDetail}>{detail}</Text>
        <Pressable
          disabled={!canRedeem || redeeming}
          style={({ pressed }) => [
            styles.redeemButton,
            (!canRedeem || redeeming) && styles.buttonDisabled,
            pressed && styles.pressed,
          ]}
          onPress={onRedeem}>
          <Text style={styles.redeemButtonText}>
            {redeeming ? t('rewards.redeeming') : canRedeem ? t('rewards.redeem') : t('rewards.unlock')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: PALETTE.bg },
  safeArea: { flex: 1, backgroundColor: PALETTE.bg },
  scrollContent: { paddingHorizontal: 18, gap: 16 },
  header: {
    width: '100%',
    position: 'relative',    // 开启相对定位，方便按钮基于此容器绝对定位
    justifyContent: 'center', // 让 headerCopy 水平居中
    alignItems: 'center',     // 确保内部文字居中对齐
    minHeight: 44,            // 保证 header 有足够的高度
  },
  headerCopy: {
    alignItems: 'center',     // 文字居中
  },
  backButton: {
    position: 'absolute',     // 绝对定位脱离文档流
    left: 0,                  // 靠最左侧
    zIndex: 10,               // 保证按钮可点击
    minWidth: 58,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.hairline,
  },
  backButtonText: { color: PALETTE.ink, fontSize: 13, fontWeight: '900' },
  kicker: { color: '#13967F', fontSize: 11, fontWeight: '900', letterSpacing: 0, textAlign: 'center' },
  title: { color: PALETTE.ink, fontSize: 24, lineHeight: 30, fontWeight: '900', marginTop: 3, textAlign: 'center' },
  storeIntro: { borderRadius: 8, backgroundColor: PALETTE.navy, padding: 18, gap: 7 },
  storeIntroTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '900' },
  storeIntroText: { color: '#B8D6D2', fontSize: 13, lineHeight: 19 },
  loadingCard: {
    minHeight: 96,
    borderRadius: 8,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.hairline,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  loadingText: { color: PALETTE.muted, fontSize: 13, fontWeight: '700' },
  messageBar: { borderRadius: 8, backgroundColor: PALETTE.greenSoft, padding: 12 },
  messageText: { color: '#126F61', fontSize: 12, fontWeight: '800' },
  storeGrid: { gap: 12 },
  productCard: {
    borderRadius: 8,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.hairline,
    padding: 16,
    gap: 14,
  },
  productTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  productIcon: {
    width: 42,
    height: 42,
    borderRadius: 8,
    backgroundColor: PALETTE.greenSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  productIconText: { fontSize: 23 },
  productName: { flex: 1, minWidth: 0 },
  productTitle: { color: PALETTE.ink, fontSize: 16, fontWeight: '900' },
  productSubtitle: { color: PALETTE.muted, fontSize: 11, fontWeight: '700', marginTop: 2 },
  productCost: { color: PALETTE.teal, fontSize: 18, fontWeight: '900' },
  productDescription: { color: PALETTE.muted, fontSize: 13, lineHeight: 19 },
  productFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  productDetail: { flex: 1, color: PALETTE.muted, fontSize: 11, fontWeight: '700' },
  redeemButton: {
    minHeight: 38,
    borderRadius: 19,
    backgroundColor: PALETTE.teal,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  redeemButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  buttonDisabled: { opacity: 0.48 },
  pressed: { opacity: 0.72 },
});
