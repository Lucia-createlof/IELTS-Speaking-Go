import LottieView from 'lottie-react-native';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import coinsAnimation from '@/assets/coins.json';
import { loadStoredAuthSession } from '@/lib/auth';
import { fetchRewardsProgress, type RewardsProgress } from '@/lib/rewards';

type RewardPointsContextValue = {
  rewards: RewardsProgress | null;
  rewardsLoading: boolean;
  updateRewards: (nextRewards: RewardsProgress | null) => void;
  refreshRewards: () => Promise<RewardsProgress | null>;
  triggerRewardAnimation: (points?: number) => void;
  registerPointsTarget: (target: View | null) => void;
};

type RewardAnimation = {
  id: number;
  points: number;
};

type FlyingCoinItem = {
  id: string;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  curveX: number;
  curveY: number;
  size: number;
  duration: number;
  delay: number;
  rotateStart: number;
  rotateEnd: number;
};

const RewardPointsContext = createContext<RewardPointsContextValue | null>(null);

export function RewardPointsProvider({ children }: { children: ReactNode }) {
  const [rewards, setRewards] = useState<RewardsProgress | null>(null);
  const [rewardsLoading, setRewardsLoading] = useState(false);
  const [rewardAnimation, setRewardAnimation] = useState<RewardAnimation | null>(null);
  const pointsTargetRef = useRef<View | null>(null);

  const updateRewards = useCallback((nextRewards: RewardsProgress | null) => {
    setRewards(nextRewards);
  }, []);

  const refreshRewards = useCallback(async () => {
    if (!loadStoredAuthSession()) {
      updateRewards(null);
      return null;
    }

    setRewardsLoading(true);
    try {
      const nextRewards = await fetchRewardsProgress();
      updateRewards(nextRewards);
      return nextRewards;
    } finally {
      setRewardsLoading(false);
    }
  }, [updateRewards]);

  useEffect(() => {
    if (!loadStoredAuthSession()) {
      return;
    }

    const timer = setTimeout(() => {
      void refreshRewards().catch(() => {
        setRewardsLoading(false);
      });
    }, 0);

    return () => clearTimeout(timer);
  }, [refreshRewards]);

  const triggerRewardAnimation = useCallback((points = 10) => {
    setRewardAnimation({
      id: Date.now() + Math.random(),
      points: Math.max(1, points),
    });
  }, []);

  const registerPointsTarget = useCallback((target: View | null) => {
    pointsTargetRef.current = target;
  }, []);

  const contextValue: RewardPointsContextValue = {
    rewards,
    rewardsLoading,
    updateRewards,
    refreshRewards,
    triggerRewardAnimation,
    registerPointsTarget,
  };

  return (
    <RewardPointsContext.Provider value={contextValue}>
      <View style={styles.root}>
        <View style={styles.stack}>{children}</View>
        <CoinRewardBurst trigger={rewardAnimation} targetRef={pointsTargetRef} />
      </View>
    </RewardPointsContext.Provider>
  );
}

export function useRewardPoints() {
  const value = useContext(RewardPointsContext);
  if (!value) {
    throw new Error('useRewardPoints must be used inside RewardPointsProvider');
  }
  return value;
}

export function PointsHeader() {
  const { registerPointsTarget, rewards, rewardsLoading } = useRewardPoints();
  const targetRef = useRef<View | null>(null);

  useEffect(() => {
    registerPointsTarget(targetRef.current);
    return () => {
      registerPointsTarget(null);
    };
  }, [registerPointsTarget]);

  return (
    <View pointerEvents="none" style={styles.pointsHeaderRow}>
      <View ref={targetRef} collapsable={false} style={styles.pointsBadge}>
        <Text style={styles.pointsText}>💰{rewardsLoading ? '—' : rewards?.points ?? 0}</Text>
      </View>
    </View>
  );
}

function CoinRewardBurst({
  trigger,
  targetRef,
}: {
  trigger: RewardAnimation | null;
  targetRef: RefObject<View | null>;
}) {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [coins, setCoins] = useState<FlyingCoinItem[]>([]);
  const burstIdRef = useRef(0);

  const clearCoin = useCallback((coinId: string) => {
    setCoins((current) => current.filter((coin) => coin.id !== coinId));
  }, []);

  const launchBurst = useCallback(
    (points: number) => {
      const spawnCoins = (targetX: number, targetY: number) => {
        const count = Math.min(6, Math.max(3, Math.ceil(points / 10)));
        const burstId = burstIdRef.current++;
        const baseX = screenWidth / 2;
        const baseY = screenHeight / 2;
        const nextCoins = Array.from({ length: count }, (_, index) => {
          const spread = 32 + index * 8;
          const lift = 92 + index * 12;
          return {
            id: `coin-${burstId}-${index}`,
            startX: baseX + randomBetween(-16, 16),
            startY: baseY + randomBetween(-16, 16),
            targetX: targetX + randomBetween(-12, 12),
            targetY: targetY + randomBetween(-10, 10),
            curveX: randomBetween(-spread, spread),
            curveY: randomBetween(lift * 0.72, lift),
            size: randomBetween(54, 72),
            duration: 1400,
            delay: index * 90,
            rotateStart: randomBetween(-18, 18),
            rotateEnd: randomBetween(180, 300),
          } satisfies FlyingCoinItem;
        });
        setCoins(nextCoins);
      };

      targetRef.current?.measureInWindow((x, y, width, height) => {
        spawnCoins(x + width / 2, y + height / 2);
      });
    },
    [screenHeight, screenWidth, targetRef],
  );

  useEffect(() => {
    if (!trigger) {
      return;
    }

    const frameId = requestAnimationFrame(() => launchBurst(trigger.points));
    return () => cancelAnimationFrame(frameId);
  }, [launchBurst, trigger]);

  return (
    <View pointerEvents="none" style={styles.coinLayer}>
      {coins.map((coin) => (
        <FlyingCoin key={coin.id} coin={coin} onComplete={clearCoin} />
      ))}
    </View>
  );
}

function FlyingCoin({
  coin,
  onComplete,
}: {
  coin: FlyingCoinItem;
  onComplete: (coinId: string) => void;
}) {
  const progress = useSharedValue(0);
  const [active, setActive] = useState(coin.delay <= 0);

  useEffect(() => {
    if (coin.delay <= 0) {
      return;
    }

    const timer = setTimeout(() => setActive(true), coin.delay);
    return () => clearTimeout(timer);
  }, [coin.delay]);

  useEffect(() => {
    if (!active) {
      return;
    }

    progress.value = withTiming(
      1,
      {
        duration: coin.duration,
        easing: Easing.out(Easing.cubic),
      },
      (finished) => {
        if (finished) {
          runOnJS(onComplete)(coin.id);
        }
      },
    );
  }, [active, coin.duration, coin.id, onComplete, progress]);

  const animatedStyle = useAnimatedStyle(() => {
    const t = progress.value;
    const arc = Math.sin(Math.PI * t);
    const x = coin.startX + (coin.targetX - coin.startX) * t + arc * coin.curveX - coin.size / 2;
    const y = coin.startY + (coin.targetY - coin.startY) * t - arc * coin.curveY - coin.size / 2;
    const scale = t < 0.16 ? 0.45 + (t / 0.16) * 0.55 : t > 0.84 ? 1 - ((t - 0.84) / 0.16) * 0.32 : 1;
    const opacity = t < 0.08 ? t / 0.08 : t > 0.88 ? Math.max(0, 1 - (t - 0.88) / 0.12) : 1;
    const rotate = coin.rotateStart + (coin.rotateEnd - coin.rotateStart) * t;

    return {
      opacity,
      transform: [
        { translateX: x },
        { translateY: y },
        { scale },
        { rotate: `${rotate}deg` },
      ],
    };
  }, [
    coin.curveX,
    coin.curveY,
    coin.rotateEnd,
    coin.rotateStart,
    coin.size,
    coin.startX,
    coin.startY,
    coin.targetX,
    coin.targetY,
    progress,
  ]);

  if (!active) {
    return null;
  }

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.flyingCoin, { width: coin.size, height: coin.size }, animatedStyle]}>
      <LottieView
        source={coinsAnimation}
        autoPlay
        loop={false}
        speed={1.4}
        resizeMode="cover"
        style={StyleSheet.absoluteFill}
        webStyle={{ width: '100%', height: '100%' }}
      />
    </Animated.View>
  );
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  stack: { flex: 1 },
  pointsHeaderRow: {
    alignItems: 'flex-start',
    marginBottom: 4,
  },
  pointsBadge: {
    alignSelf: 'flex-start',
    minHeight: 35,
    borderRadius: 19,
    backgroundColor: '#dbece9',
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  pointsText: { color: '#042c2a', fontSize: 13, fontWeight: '900' },
  coinLayer: {
    ...StyleSheet.absoluteFill,
    zIndex: 70,
    elevation: 70,
  },
  flyingCoin: { position: 'absolute', left: 0, top: 0 },
});
