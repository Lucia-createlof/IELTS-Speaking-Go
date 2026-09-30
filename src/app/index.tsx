import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { router, type Href } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle
} from 'react-native';
import FlipCard from 'react-native-flip-card';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTourGuideController } from 'rn-tourguide';

import { AdaptiveTourGuideZone } from '@/components/onboarding-tooltip';
import { PointsHeader, useRewardPoints } from '@/components/reward-points';
import { accelerateAliyunLoginPage, getAliyunLoginToken } from '@/lib/aliyunNumberAuth';
import {
  deleteAccount,
  hydrateStoredAuthSession,
  loadStoredAuthSession,
  loginWithAliyunPhone,
  loginWithGoogle,
  loginWithPassword,
  logoutSession,
  saveStoredAuthSession,
  type AuthSession,
} from '@/lib/auth';
import { ACCOUNT_API_BASE_URL } from '@/lib/config';
import {
  API_BASE_URL,
  displayQuestion,
  fetchPartQuestions,
  fetchPracticeHistory,
  formatDuration,
  stripQuestionNumber,
  submitMockTestAudio,
  submitPartPracticeAudio,
  type MockItem,
  type PartKey,
  type PracticeHistoryRecord,
  type QuestionCard,
} from '@/lib/ielts';
import { ONBOARDING_STEPS } from '@/lib/onboarding';
import {
  completeRewardActivity,
  dismissRecoveryOffer,
  markOnboardingSeen,
  useStreakFreezeCard as redeemStreakFreezeCard,
  type RewardActivityType,
  type RewardsProgress,
} from '@/lib/rewards';
import { localeNames, supportedLocales, useI18n, type AppLocale, type TranslationKey } from '@/i18n';

type MainTab = 'mock' | 'practice' | 'profile';
type PracticeStatus = 'idle' | 'recording' | 'paused' | 'ready' | 'processing' | 'complete';
type MockStatus = 'idle' | 'recording' | 'prep' | 'ready' | 'processing' | 'complete';
type QuestionBank = Record<PartKey, QuestionCard[]>;
type GrammarErrorRow = {
  sentenceIndex: string;
  sentence: string;
  errorType: string;
  error: string;
  correction: string;
  explanation: string;
};
type ImprovementAdviceRow = {
  originalSentence: string;
  improvedSentence: string;
  examinerAdvice: string;
};
type BackendProgressProfile = 'mock' | 'practice' | 'inline';
type BackendProgressStage = {
  from: number;
  to: number;
  durationMs: number;
};

type PracticeSession = {
  part: PartKey;
  seed: QuestionCard;
  questions: QuestionCard[];
  currentIndex: number;
};

const PARTS: PartKey[] = ['part1', 'part2', 'part3'];
const PREP_SECONDS = 60;
const PART2_ANSWER_SECONDS = 120;
const PROCESSING_COMPLETE_VISIBLE_MS = 360;
const PROGRESS_CREEP_LIMIT = 99;
const BACKEND_PROGRESS_PROFILES: Record<BackendProgressProfile, BackendProgressStage[]> = {
  practice: [
    { from: 0, to: 20, durationMs: 9000 },
    { from: 20, to: 32, durationMs: 2500 },
    { from: 32, to: 50, durationMs: 9000 },
    { from: 50, to: 70, durationMs: 8500 },
    { from: 70, to: 96, durationMs: 5000 },
  ],
  mock: [
    { from: 0, to: 20, durationMs: 12000 },
    { from: 20, to: 50, durationMs: 17000 },
    { from: 50, to: 70, durationMs: 10000 },
    { from: 70, to: 96, durationMs: 9000 },
  ],
  inline: [
    { from: 0, to: 85, durationMs: 1800 },
    { from: 85, to: 96, durationMs: 2200 },
  ],
};

const EMPTY_BANK: QuestionBank = {
  part1: [],
  part2: [],
  part3: [],
};

const TAB_ITEMS: { key: MainTab; caption: string; mark: string }[] = [
  { key: 'mock', caption: 'Mock', mark: '📃' },
  { key: 'practice', caption: 'Practice', mark: '🎯' },
  { key: 'profile', caption: 'History', mark: '🗂' },
];

const PART_LABELS: Record<PartKey, string> = {
  part1: 'Part 1',
  part2: 'Part 2',
  part3: 'Part 3',
};

const TOPIC_PRACTICE_PARTS = new Set<PartKey>(['part1', 'part3']);

const FALLBACK_MOCK_ITEMS: MockItem[] = [
  {
    id: 'fallback-p1-1',
    part: 'part1',
    title: 'Hometown',
    questionText: '1. Tell me about your hometown.',
    prompts: [],
    sourceIndex: 0,
    questionIndex: 0,
    mockPartLabel: 'Part 1',
  },
  {
    id: 'fallback-p1-2',
    part: 'part1',
    title: 'Hometown',
    questionText: '2. What do you like most about it?',
    prompts: [],
    sourceIndex: 0,
    questionIndex: 1,
    mockPartLabel: 'Part 1',
  },
  {
    id: 'fallback-p2-1',
    part: 'part2',
    title: 'A memorable place',
    questionText: 'Describe a memorable place you have visited',
    prompts: ['Where it is', 'When you went there', 'Who you went with', 'And explain why it was memorable'],
    sourceIndex: 0,
    mockPartLabel: 'Part 2',
  },
  {
    id: 'fallback-p3-1',
    part: 'part3',
    title: 'Travel',
    questionText: '1. Why do people like visiting new places?',
    prompts: [],
    sourceIndex: 0,
    questionIndex: 0,
    mockPartLabel: 'Part 3',
  },
];

export default function HomeScreen() {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 250);
  const ttsPlayer = useAudioPlayer(null, { keepAudioSessionActive: true, updateInterval: 250 });
  const ttsStatus = useAudioPlayerStatus(ttsPlayer);
  const { canStart, start, eventEmitter } = useTourGuideController();

  const [authSession, setAuthSession] = useState<AuthSession | null>(() => loadStoredAuthSession());
  const [authHydrated, setAuthHydrated] = useState(false);
  const [activeTab, setActiveTab] = useState<MainTab>('mock');
  const {
    rewards,
    rewardsLoading,
    refreshRewards,
    triggerRewardAnimation,
    updateRewards,
  } = useRewardPoints();
  const [questionBank, setQuestionBank] = useState<QuestionBank>(EMPTY_BANK);
  const [questionsLoading, setQuestionsLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [history, setHistory] = useState<PracticeHistoryRecord[]>([]);
  const [selectedPracticePart, setSelectedPracticePart] = useState<PartKey>('part1');
  const [practiceSession, setPracticeSession] = useState<PracticeSession | null>(null);
  const [practiceStatus, setPracticeStatus] = useState<PracticeStatus>('idle');
  const [practiceAnalysis, setPracticeAnalysis] = useState<Record<string, unknown> | null>(null);
  const [practiceProcessingCompleteSignal, setPracticeProcessingCompleteSignal] = useState(0);
  const [mockItems, setMockItems] = useState<MockItem[]>([]);
  const [mockIndex, setMockIndex] = useState(0);
  const [mockStatus, setMockStatus] = useState<MockStatus>('idle');
  const [mockReport, setMockReport] = useState<Record<string, unknown> | null>(null);
  const [mockProcessingCompleteSignal, setMockProcessingCompleteSignal] = useState(0);
  const [prepSeconds, setPrepSeconds] = useState(PREP_SECONDS);
  const [part2Seconds, setPart2Seconds] = useState(PART2_ANSWER_SECONDS);
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [lastDurationMillis, setLastDurationMillis] = useState(0);
  const [isReadingQuestion, setIsReadingQuestion] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const lastProcessedRewardsRef = useRef<string | null>(null);

  const resumeMockAfterPrepCueRef = useRef(false);
  const prepCueFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onboardingStartedRef = useRef(false);
  const mainScrollRef = useRef<ScrollView | null>(null);
  const mockStartButtonYRef = useRef(0);
  const historySectionYRef = useRef(0);

  useEffect(() => {
    let active = true;
    void hydrateStoredAuthSession().then((session) => {
      if (active) {
        setAuthSession(session);
        setAuthHydrated(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const activeMockItem = mockItems[mockIndex] ?? null;
  const activePracticeQuestion = practiceSession?.questions[practiceSession.currentIndex] ?? null;
  const isMockPart2Answering = mockStatus === 'recording' && activeMockItem?.mockPartLabel === 'Part 2';
  const isRecorderActive =
    practiceStatus === 'recording' ||
    practiceStatus === 'paused' ||
    mockStatus === 'recording' ||
    mockStatus === 'prep';



  const mockPartCounts = useMemo(() => {
    const part1Categories = new Set<string>();
    const part3Topics = new Set<string>();
    const counts: Record<string, number> = {};

    mockItems.forEach((item) => {
      const label = item.mockPartLabel;

      if (label === 'Part 1') {
        const category = item.category ?? item.title;
        if (category) {
          part1Categories.add(category);
        }
        return;
      }

      if (label === 'Part 3') {
        const topic = item.related_topic ?? item.relatedTopic ?? item.title;
        if (topic) {
          part3Topics.add(topic);
        }
        return;
      }

      counts[label] = (counts[label] ?? 0) + 1;
    });

    counts['Part 1'] = part1Categories.size;
    counts['Part 3'] = part3Topics.size;

    return counts;
  }, [mockItems]);

  const answeredPracticeQuestions = useMemo(() => {
    if (!practiceSession) {
      return [];
    }
    return practiceSession.questions.slice(0, practiceSession.currentIndex + 1);
  }, [practiceSession]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const records = await fetchPracticeHistory();
      setHistory(records);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadRewards = useCallback(async () => {
    if (!authSession) {
      updateRewards(null);
      return;
    }
    try {
      await refreshRewards();
    } catch (error) {
      setErrorMessage(`${t('errors.rewardService')}: ${getErrorMessage(error)}`);
    }
  }, [authSession, refreshRewards, t, updateRewards]);

  const syncRewardActivity = useCallback(async (activityType: RewardActivityType, sourceId: string) => {
    try {
      const previousPoints = rewards?.points;
      const nextRewards = await completeRewardActivity(activityType, sourceId);
      updateRewards(nextRewards);
      const earnedPoints =
        previousPoints === undefined
          ? 10
          : Math.max(1, nextRewards.points - previousPoints);
      triggerRewardAnimation(earnedPoints);
      return nextRewards;
    } catch {
      // Reward syncing is secondary to saving the completed practice result.
    }
  }, [rewards, triggerRewardAnimation, updateRewards]);


// 2. 指引启动逻辑（无死循环、支持多账号）
  useEffect(() => {
    // 如果没有 rewards 数据、或者当前账号已经看过指引、或者 canStart 未就绪，直接拦截
    if (!rewards || rewards.has_seen_onboarding || !canStart) {
      return;
    }

    // 将整个 rewards 对象序列化为唯一的字符串标识
    const currentIdentifier = JSON.stringify(rewards);

    // 关键防重锁：如果是同一个 rewards 数据，说明是同一个账号在重复渲染，拦截防死循环
    if (lastProcessedRewardsRef.current === currentIdentifier) {
      return;
    }

    // 记录当前标识，锁住重复触发
    lastProcessedRewardsRef.current = currentIdentifier;

    mainScrollRef.current?.scrollTo({
      y: Math.max(0, mockStartButtonYRef.current - 160),
      animated: false,
    });

    const timer = requestAnimationFrame(() => {
      start();
    });

    return () => cancelAnimationFrame(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canStart, rewards]);


  const loadQuestions = useCallback(async () => {
    setQuestionsLoading(true);
    setErrorMessage(null);
    try {
      const [part1, part2, part3] = await Promise.all([
        fetchPartQuestions('part1'),
        fetchPartQuestions('part2'),
        fetchPartQuestions('part3'),
      ]);
      const nextBank = { part1, part2, part3 };
      setQuestionBank(nextBank);
      setMockItems(buildMockItems(nextBank));
    } catch (error) {
      setErrorMessage(`${t('errors.questionLoad')}: ${getErrorMessage(error)}`);
      setMockItems(FALLBACK_MOCK_ITEMS);
    } finally {
      setQuestionsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!authSession) {
      updateRewards(null);
      return;
    }
    void loadQuestions();
    void loadHistory();
    void loadRewards();
  }, [authSession, loadHistory, loadQuestions, loadRewards]);

  useEffect(() => {
    if (!eventEmitter) {
      return;
    }

    const handleStepChange = (step?: { order?: number }) => {
      // 包裹在 requestAnimationFrame 中，避开 TourGuideProvider 的渲染周期，解决 setState 报错
      requestAnimationFrame(() => {
        const nextStep = step?.order ? ONBOARDING_STEPS[step.order - 1] : undefined;
        if (!nextStep) {
          return;
        }

        setActiveTab(nextStep.tab);

        const scrollY =
          nextStep.target === '历史记录区域' ? Math.max(0, historySectionYRef.current - 24) : 0;
        mainScrollRef.current?.scrollTo({ y: scrollY, animated: false });
      });
    };

    eventEmitter.on('stepChange', handleStepChange);
    return () => eventEmitter.off('stepChange', handleStepChange);
  }, [eventEmitter]);

  useEffect(() => {
    if (!eventEmitter) {
      return;
    }

    const handleStop = () => {
      void markOnboardingSeen()
        .then((nextRewards) => updateRewards(nextRewards))
        .catch(() => {
          // Stopping the guide still leaves the app usable if the reward API is unavailable.
        });
    };

    eventEmitter.on('stop', handleStop);
    return () => eventEmitter.off('stop', handleStop);
  }, [eventEmitter, updateRewards]);

  useEffect(() => {
    if (authSession && activeTab === 'profile') {
      void loadHistory();
    }
  }, [activeTab, authSession, loadHistory]);

  const resumeMockAfterPrep = useCallback(async () => {
    try {
      setPart2Seconds(PART2_ANSWER_SECONDS);
      recorder.record();
      setMockStatus('recording');
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  }, [recorder]);

  useEffect(() => {
    if (!ttsStatus.didJustFinish) {
      return;
    }
    setIsReadingQuestion(false);
    if (resumeMockAfterPrepCueRef.current) {
      resumeMockAfterPrepCueRef.current = false;
      if (prepCueFallbackRef.current) {
        clearTimeout(prepCueFallbackRef.current);
        prepCueFallbackRef.current = null;
      }
      void resumeMockAfterPrep();
    }
  }, [resumeMockAfterPrep, ttsStatus.didJustFinish]);

  useEffect(
    () => () => {
      if (prepCueFallbackRef.current) {
        clearTimeout(prepCueFallbackRef.current);
      }
    },
    [],
  );

  const finishPrepRef = useRef(false);
  useEffect(() => {
    if (mockStatus !== 'prep') {
      finishPrepRef.current = false;
      return;
    }
    if (prepSeconds <= 0) {
      if (!finishPrepRef.current) {
        finishPrepRef.current = true;
        resumeMockAfterPrepCueRef.current = true;
        setIsReadingQuestion(true);
        try {
          ttsPlayer.replace(`${API_BASE_URL}/api/tts?text=${encodeURIComponent('Now please start speaking.')}`);
          ttsPlayer.play();
          prepCueFallbackRef.current = setTimeout(() => {
            if (resumeMockAfterPrepCueRef.current) {
              resumeMockAfterPrepCueRef.current = false;
              void resumeMockAfterPrep();
            }
          }, 3500);
        } catch (error) {
          resumeMockAfterPrepCueRef.current = false;
          setIsReadingQuestion(false);
          setErrorMessage(getErrorMessage(error));
          void resumeMockAfterPrep();
        }
      }
      return;
    }
    const timer = setTimeout(() => {
      setPrepSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [mockStatus, prepSeconds, resumeMockAfterPrep, ttsPlayer]);

  useEffect(() => {
    if (!isMockPart2Answering || part2Seconds <= 0) {
      return;
    }
    const timer = setTimeout(() => {
      setPart2Seconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [isMockPart2Answering, part2Seconds]);

  const playQuestionAudio = useCallback(
    async (text: string) => {
      const spokenText = stripQuestionNumber(text);
      if (!spokenText) {
        return;
      }
      setIsReadingQuestion(true);
      try {
        ttsPlayer.replace(`${API_BASE_URL}/api/tts?text=${encodeURIComponent(spokenText)}`);
        ttsPlayer.play();
      } catch (error) {
        setIsReadingQuestion(false);
        setErrorMessage(getErrorMessage(error));
      }
    },
    [ttsPlayer],
  );

  const requestMic = useCallback(async () => {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      throw new Error(t('errors.micPermission'));
    }
    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: 'doNotMix',
    });
  }, [t]);

  const startRecorder = useCallback(async () => {
    await requestMic();
    setRecordingUri(null);
    setLastDurationMillis(0);
    await recorder.prepareToRecordAsync();
    recorder.record();
  }, [recorder, requestMic]);

  const stopRecorder = useCallback(async () => {
    setLastDurationMillis(recorder.getStatus().durationMillis);
    await recorder.stop();
    const uri = recorder.uri ?? recorder.getStatus().url;
    if (!uri) {
      throw new Error(t('errors.noRecording'));
    }
    setRecordingUri(uri);
    return uri;
  }, [recorder, t]);

  const discardRecorder = useCallback(async () => {
    resumeMockAfterPrepCueRef.current = false;
    if (prepCueFallbackRef.current) {
      clearTimeout(prepCueFallbackRef.current);
      prepCueFallbackRef.current = null;
    }
    try {
      const state = recorder.getStatus();
      if (state.canRecord || state.isRecording) {
        await recorder.stop();
      }
    } catch {
      // Ignore cleanup errors while resetting UI state.
    }
    setRecordingUri(null);
    setLastDurationMillis(0);
  }, [recorder]);

  const switchTab = useCallback(
    (tab: MainTab) => {
      if (tab === activeTab) {
        return;
      }
      if (isRecorderActive) {
        Alert.alert(t('settings.recordingTitle'), t('navigation.switchMessage'), [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('navigation.continueSwitch'),
            style: 'destructive',
            onPress: () => {
              void discardRecorder();
              setPracticeStatus('idle');
              setMockStatus('idle');
              setActiveTab(tab);
            },
          },
        ]);
        return;
      }
      setActiveTab(tab);
    },
    [activeTab, discardRecorder, isRecorderActive, t],
  );

  const openPracticeCard = useCallback(
    (card: QuestionCard) => {
      if (isRecorderActive) {
        Alert.alert(t('settings.recordingTitle'), t('navigation.finishFirst'));
        return;
      }
      const partQuestions = questionBank[card.part];
      const sessionQuestions =
        TOPIC_PRACTICE_PARTS.has(card.part)
          ? partQuestions.filter((item) => item.sourceIndex === card.sourceIndex)
          : [card];

      setPracticeSession({
        part: card.part,
        seed: card,
        questions: sessionQuestions.length > 0 ? sessionQuestions : [card],
        currentIndex: 0,
      });
      setPracticeStatus('idle');
      setPracticeAnalysis(null);
      setRecordingUri(null);
      setLastDurationMillis(0);
      void playQuestionAudio(card.questionText);
    },
    [isRecorderActive, playQuestionAudio, questionBank, t],
  );

  const closePracticeSession = useCallback(() => {
    if (isRecorderActive) {
      Alert.alert(t('settings.recordingTitle'), t('navigation.exitMessage'), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('navigation.exit'),
          style: 'destructive',
          onPress: () => {
            void discardRecorder();
            setPracticeSession(null);
            setPracticeStatus('idle');
            setPracticeAnalysis(null);
          },
        },
      ]);
      return;
    }
    setPracticeSession(null);
    setPracticeStatus('idle');
    setPracticeAnalysis(null);
    setRecordingUri(null);
  }, [discardRecorder, isRecorderActive, t]);

  const startPractice = useCallback(async () => {
    if (!activePracticeQuestion) {
      return;
    }
    setErrorMessage(null);
    setPracticeAnalysis(null);
    try {
      await playQuestionAudio(activePracticeQuestion.questionText);
      await startRecorder();
      setPracticeStatus('recording');
    } catch (error) {
      setPracticeStatus('idle');
      setErrorMessage(getErrorMessage(error));
    }
  }, [activePracticeQuestion, playQuestionAudio, startRecorder]);

  const nextPracticeQuestion = useCallback(async () => {
    if (!practiceSession || !TOPIC_PRACTICE_PARTS.has(practiceSession.part)) {
      return;
    }

    const nextIndex = practiceSession.currentIndex + 1;
    const nextQuestion = practiceSession.questions[nextIndex];

    try {
      if (!nextQuestion) {
        const uri = await stopRecorder();
        setRecordingUri(uri);
        setPracticeStatus('ready');
        return;
      }
      setPracticeSession({ ...practiceSession, currentIndex: nextIndex });
      void playQuestionAudio(nextQuestion.questionText);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  }, [playQuestionAudio, practiceSession, stopRecorder]);

  const pausePractice = useCallback(() => {
    try {
      recorder.pause();
      setPracticeStatus('paused');
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  }, [recorder]);

  const resumePractice = useCallback(() => {
    try {
      recorder.record();
      setPracticeStatus('recording');
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  }, [recorder]);

  const stopPractice = useCallback(async () => {
    try {
      const uri = await stopRecorder();
      setRecordingUri(uri);
      setPracticeStatus('ready');
    } catch (error) {
      setPracticeStatus('idle');
      setErrorMessage(getErrorMessage(error));
    }
  }, [stopRecorder]);

  const restartPractice = useCallback(async () => {
    await discardRecorder();
    setPracticeStatus('idle');
    setPracticeAnalysis(null);
  }, [discardRecorder]);

  const submitPractice = useCallback(async () => {
    if (!practiceSession || !recordingUri) {
      return;
    }
    setPracticeProcessingCompleteSignal(0);
    setPracticeStatus('processing');
    setErrorMessage(null);
    let rewardSourceId: string | null = null;
    try {
      const payload = await submitPartPracticeAudio(recordingUri, {
        part: practiceSession.part,
        topic: practiceSession.seed.title,
        questionText: buildPracticePayload(answeredPracticeQuestions),
      }, (analysisPayload) => {
        rewardSourceId = getRewardSourceId(analysisPayload, 'part_practice');
      });
      setPracticeAnalysis(prev => ({
        ...(prev ?? {}),
        ...(asRecord(payload.analysis) ?? payload),
        recording_uri: recordingUri,
      }));
      setPracticeProcessingCompleteSignal(Date.now());
      await waitForVisibleProgressCompletion();
      setPracticeStatus('complete');
      if (rewardSourceId) {
        void syncRewardActivity('part_practice', rewardSourceId);
      }
      void loadHistory();
    } catch (error) {
      setPracticeStatus('ready');
      setErrorMessage(`${t('errors.analysisFailed')}: ${getErrorMessage(error)}`);
    }
  }, [answeredPracticeQuestions, loadHistory, practiceSession, recordingUri, syncRewardActivity, t]);

  const startMockTest = useCallback(async () => {
    const nextMockItems = buildMockItems(questionBank);
    if (nextMockItems.length === 0) {
      Alert.alert(t('navigation.questionsNotReadyTitle'), t('navigation.questionsNotReadyMessage'));
      return;
    }
    setErrorMessage(null);
    setMockReport(null);
    setMockItems(nextMockItems);
    setMockIndex(0);
    setPrepSeconds(PREP_SECONDS);
    setPart2Seconds(PART2_ANSWER_SECONDS);
    try {
      await playQuestionAudio(nextMockItems[0].questionText);
      await startRecorder();
      setMockStatus('recording');
    } catch (error) {
      setMockStatus('idle');
      setErrorMessage(getErrorMessage(error));
    }
  }, [playQuestionAudio, questionBank, startRecorder, t]);

  const resetMockTest = useCallback(async () => {
    await discardRecorder();
    setMockIndex(0);
    setMockStatus('idle');
    setMockReport(null);
    setPrepSeconds(PREP_SECONDS);
    setPart2Seconds(PART2_ANSWER_SECONDS);
  }, [discardRecorder]);

  const moveMockForward = useCallback(async () => {
    if (!activeMockItem) {
      return;
    }
    const nextIndex = mockIndex + 1;
    if (nextIndex >= mockItems.length) {
      try {
        const uri = await stopRecorder();
        setRecordingUri(uri);
        setPart2Seconds(PART2_ANSWER_SECONDS);
        setMockStatus('ready');
      } catch (error) {
        setMockStatus('recording');
        setErrorMessage(getErrorMessage(error));
      }
      return;
    }

    const nextItem = mockItems[nextIndex];
    const enteringPart2 =
      nextItem.mockPartLabel === 'Part 2' && activeMockItem.mockPartLabel !== 'Part 2';

    setMockIndex(nextIndex);
    if (nextItem.mockPartLabel !== 'Part 2') {
      setPart2Seconds(PART2_ANSWER_SECONDS);
    }
    void playQuestionAudio(nextItem.questionText);

    if (enteringPart2) {
      try {
        recorder.pause();
        setPrepSeconds(PREP_SECONDS);
        setPart2Seconds(PART2_ANSWER_SECONDS);
        setMockStatus('prep');
      } catch (error) {
        setErrorMessage(getErrorMessage(error));
      }
    }
  }, [activeMockItem, mockIndex, mockItems, playQuestionAudio, recorder, stopRecorder]);

  const submitMock = useCallback(async () => {
    if (!recordingUri || mockItems.length === 0) {
      return;
    }
    setMockProcessingCompleteSignal(0);
    setMockStatus('processing');
    setErrorMessage(null);
    let rewardSourceId: string | null = null;
    try {
      const payload = await submitMockTestAudio(recordingUri, mockItems, (analysisPayload) => {
        rewardSourceId = getRewardSourceId(analysisPayload, 'mock_test');
      });
      setMockReport(prev => ({
        ...(prev ?? {}),
        ...(asRecord(payload.report) ?? payload),
        recording_uri: recordingUri,
      }));
      setMockProcessingCompleteSignal(Date.now());
      await waitForVisibleProgressCompletion();
      setMockStatus('complete');
      if (rewardSourceId) {
        void syncRewardActivity('mock_test', rewardSourceId);
      }
      void loadHistory();
    } catch (error) {
      setMockStatus('ready');
      setErrorMessage(`${t('errors.submitFailed')}: ${getErrorMessage(error)}`);
    }
  }, [loadHistory, mockItems, recordingUri, syncRewardActivity, t]);

  const handleLogin = useCallback((session: AuthSession) => {
    saveStoredAuthSession(session);
    setAuthSession(session);
    setActiveTab('mock');
    setErrorMessage(null);
  }, []);

  const handleLogout = useCallback(() => {
    if (isRecorderActive) {
      Alert.alert(t('settings.recordingTitle'), t('settings.logoutRecordingMessage'), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.discardAndLogout'),
          style: 'destructive',
          onPress: () => {
            void discardRecorder();
            void logoutSession();
            setAuthSession(null);
            updateRewards(null);
            setActiveTab('mock');
          },
        },
      ]);
      return;
    }
    void logoutSession();
    setAuthSession(null);
    updateRewards(null);
    setActiveTab('mock');
  }, [discardRecorder, isRecorderActive, t, updateRewards]);

  const handleDeleteAccount = useCallback(async () => {
    if (isRecorderActive) {
      await discardRecorder();
    }
    await deleteAccount();
    setAuthSession(null);
    updateRewards(null);
    setHistory([]);
    setActiveTab('mock');
  }, [discardRecorder, isRecorderActive, updateRewards]);

  if (!authHydrated) {
    return (
      <View style={[styles.app, styles.centeredScreen]}>
        <ActivityIndicator color={palette.teal} />
        <Text style={styles.loadingText}>{t('common.loading')}</Text>
      </View>
    );
  }

  if (!authSession) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <View style={styles.app}>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.safeArea} edges={['left', 'right']}>
        <ScrollView
          ref={mainScrollRef}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingTop: Math.max(insets.top, 16), paddingBottom: insets.bottom + 108 },
          ]}
          refreshControl={
            activeTab === 'profile' ? (
              <RefreshControl refreshing={historyLoading} onRefresh={loadHistory} tintColor={palette.teal} />
            ) : undefined
          }>
            <View>
              <Text style={styles.appName}></Text>
            </View>
          {errorMessage ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorTitle}>{t('common.notice')}</Text>
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : null}

          <View
            style={[styles.tabScreen, activeTab === 'mock' ? styles.tabScreenActive : styles.tabScreenInactive]}
            pointerEvents={activeTab === 'mock' ? 'auto' : 'none'}>
            <MockTestView
              activeItem={activeMockItem}
              index={mockIndex}
              itemCount={mockItems.length}
              loading={questionsLoading}
              isActive={activeTab === 'mock'}
              mockPartCounts={mockPartCounts}
              onGuideStartLayout={(event) => {
                mockStartButtonYRef.current = event.nativeEvent.layout.y;
              }}
              part2Seconds={part2Seconds}
              prepSeconds={prepSeconds}
              processingCompleteSignal={mockProcessingCompleteSignal}
              report={mockReport}
              recorderDuration={recorderState.durationMillis || lastDurationMillis}
              status={mockStatus}
              isReadingQuestion={isReadingQuestion}
              onReadQuestion={() => activeMockItem && void playQuestionAudio(activeMockItem.questionText)}
              onStart={() => void startMockTest()}
              onNext={() => void moveMockForward()}
              onFinishPrep={() => void resumeMockAfterPrep()}
              onSubmit={() => void submitMock()}
              onReset={() => void resetMockTest()}
            />
          </View>

          <View
            style={[styles.tabScreen, activeTab === 'practice' ? styles.tabScreenActive : styles.tabScreenInactive]}
            pointerEvents={activeTab === 'practice' ? 'auto' : 'none'}>
            <PracticeView
              activeQuestion={activePracticeQuestion}
              analysis={practiceAnalysis}
              currentIndex={practiceSession?.currentIndex ?? 0}
              isReadingQuestion={isReadingQuestion}
              loading={questionsLoading}
              isActive={activeTab === 'practice'}
              onBack={closePracticeSession}
              onNextQuestion={() => void nextPracticeQuestion()}
              onOpenCard={openPracticeCard}
              onPause={pausePractice}
              onReadQuestion={() =>
                activePracticeQuestion && void playQuestionAudio(activePracticeQuestion.questionText)
              }
              onRestart={() => void restartPractice()}
              onResume={resumePractice}
              onStart={() => void startPractice()}
              onStop={() => void stopPractice()}
              onSubmit={() => void submitPractice()}
              processingCompleteSignal={practiceProcessingCompleteSignal}
              questionBank={questionBank}
              recorderDuration={recorderState.durationMillis || lastDurationMillis}
              selectedPart={selectedPracticePart}
              session={practiceSession}
              setSelectedPart={setSelectedPracticePart}
              status={practiceStatus}
              totalInSession={practiceSession?.questions.length ?? 0}
            />
          </View>

          <View
            style={[styles.tabScreen, activeTab === 'profile' ? styles.tabScreenActive : styles.tabScreenInactive]}
            pointerEvents={activeTab === 'profile' ? 'auto' : 'none'}>
            <ProfileView
              isActive={activeTab === 'profile'}
              history={history}
              loading={historyLoading}
              rewards={rewards}
              rewardsLoading={rewardsLoading}
              onHistoryLayout={(event) => {
                historySectionYRef.current = event.nativeEvent.layout.y;
              }}
              onOpenRewards={() => router.push('/rewards' as Href)}
              onDismissRecovery={async () => {
                try {
                  const nextRewards = await dismissRecoveryOffer();
                  updateRewards(nextRewards);
                } catch (error) {
                  setErrorMessage(getErrorMessage(error));
                }
              }}
              onUseStreakCard={async () => {
                try {
                  const nextRewards = await redeemStreakFreezeCard();
                  updateRewards(nextRewards);
                } catch (error) {
                  setErrorMessage(getErrorMessage(error));
                }
              }}
              onRefresh={() => void loadHistory()}
              onLogout={handleLogout}
              onDeleteAccount={handleDeleteAccount}
              username={authSession.username}
            />
          </View>
        </ScrollView>
        <BottomGuide activeTab={activeTab} bottomInset={insets.bottom} onChange={switchTab} />
      </SafeAreaView>
    </View>
  );
}

function LoginScreen({ onLogin }: { onLogin: (session: AuthSession) => void }) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<'google' | 'phone' | 'legacy'>('google');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [statusText, setStatusText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const isGoogleMode = mode === 'google';
  const isLegacyMode = mode === 'legacy';
  const canLegacyLogin = isLegacyMode && username.trim().length >= 3 && password.length > 0 && !submitting;

  useEffect(() => {
    if (mode !== 'phone') {
      return;
    }

    void accelerateAliyunLoginPage();
  }, [mode]);

  const switchMode = useCallback(
    (nextMode: 'google' | 'phone' | 'legacy') => {
      if (submitting || nextMode === mode) {
        return;
      }
      setMode(nextMode);
      setUsername('');
      setPassword('');
      setStatusText('');
    },
    [mode, submitting],
  );

  const submitPhoneLogin = useCallback(async () => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setStatusText(t('login.checking'));
    try {
      const loginToken = await getAliyunLoginToken();
      setStatusText(t('login.verifying'));
      const session = await loginWithAliyunPhone(loginToken);
      onLogin(session);
    } catch (error) {
      setStatusText(getLocalizedLoginError(error, 'phone', t));
    } finally {
      setSubmitting(false);
    }
  }, [onLogin, submitting, t]);

  const submitGoogleLogin = useCallback(async () => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setStatusText(t('login.googleChecking'));
    try {
      const session = await loginWithGoogle();
      onLogin(session);
    } catch (error) {
      setStatusText(getLocalizedLoginError(error, 'google', t));
    } finally {
      setSubmitting(false);
    }
  }, [onLogin, submitting, t]);

  const submitLegacyLogin = useCallback(async () => {
    if (!isLegacyMode) {
      return;
    }
    const normalizedUsername = username.trim();
    if (normalizedUsername.length < 3 || !password) {
      setStatusText(t('login.enterCredentials'));
      return;
    }
    setSubmitting(true);
    setStatusText('');
    try {
      const session = await loginWithPassword(normalizedUsername, password);
      onLogin(session);
    } catch (error) {
      setStatusText(getLocalizedLoginError(error, 'legacy', t));
    } finally {
      setSubmitting(false);
    }
  }, [isLegacyMode, onLogin, password, t, username]);

  return (
    <View style={styles.app}>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.safeArea} edges={['left', 'right']}>
        <KeyboardAvoidingView
          style={styles.keyboardAvoider}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}>
          <ScrollView
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={[
              styles.loginContent,
              { paddingTop: Math.max(insets.top, 28), paddingBottom: insets.bottom + 96 },
            ]}>
            <View style={styles.loginPanel}>
              <Text style={styles.kicker}>{t('login.welcome')}</Text>
              <Text style={styles.loginTitle}>
                {isGoogleMode ? t('login.googleTitle') : isLegacyMode ? t('login.legacyTitle') : t('login.phoneTitle')}
              </Text>
              <Text style={styles.loginSubtitle}>
                {isGoogleMode
                  ? t('login.googleSubtitle')
                  : isLegacyMode
                  ? t('login.legacySubtitle')
                  : t('login.phoneSubtitle')}
              </Text>

              <View style={styles.authModeTabs}>
                <Pressable
                  disabled={submitting}
                  style={({ pressed }) => [
                    styles.authModeTab,
                    mode === 'phone' && styles.authModeTabActive,
                    submitting && styles.buttonDisabled,
                    pressed && styles.pressed,
                  ]}
                  onPress={() => switchMode('phone')}>
                  <Text numberOfLines={1} style={[styles.authModeTabText, mode === 'phone' && styles.authModeTabTextActive]}>
                    {t('login.phoneTab')}
                  </Text>
                </Pressable>
                <Pressable
                  disabled={submitting}
                  style={({ pressed }) => [
                    styles.authModeTab,
                    isGoogleMode && styles.authModeTabActive,
                    submitting && styles.buttonDisabled,
                    pressed && styles.pressed,
                  ]}
                  onPress={() => switchMode('google')}>
                  <Text numberOfLines={1} style={[styles.authModeTabText, isGoogleMode && styles.authModeTabTextActive]}>
                    {t('login.googleTab')}
                  </Text>
                </Pressable>
                <Pressable
                  disabled={submitting}
                  style={({ pressed }) => [
                    styles.authModeTab,
                    isLegacyMode && styles.authModeTabActive,
                    submitting && styles.buttonDisabled,
                    pressed && styles.pressed,
                  ]}
                  onPress={() => switchMode('legacy')}>
                  <Text numberOfLines={1} style={[styles.authModeTabText, isLegacyMode && styles.authModeTabTextActive]}>
                    {t('login.legacyTab')}
                  </Text>
                </Pressable>
              </View>

              {isGoogleMode ? (
                <View style={styles.googleLoginHint}>
                  <Text style={styles.googleLoginIcon}>G</Text>
                  <Text style={styles.phoneLoginHintText}>{t('login.googleHint')}</Text>
                </View>
              ) : isLegacyMode ? (
                <>
                  <View style={styles.loginField}>
                    <Text style={styles.loginLabel}>{t('login.username')}</Text>
                    <TextInput
                      value={username}
                      onChangeText={setUsername}
                      autoCapitalize="none"
                      autoCorrect={false}
                      textContentType="username"
                      placeholder={t('login.usernamePlaceholder')}
                      placeholderTextColor={palette.muted}
                      style={styles.loginInput}
                    />
                  </View>
                  <View style={styles.loginField}>
                    <Text style={styles.loginLabel}>{t('login.password')}</Text>
                    <TextInput
                      value={password}
                      onChangeText={setPassword}
                      secureTextEntry
                      textContentType="password"
                      placeholder={t('login.passwordPlaceholder')}
                      placeholderTextColor={palette.muted}
                      style={styles.loginInput}
                    />
                  </View>
                </>
              ) : 
            null}

              {statusText ? <Text style={styles.loginStatus}>{statusText}</Text> : null}

              <Pressable
                disabled={isLegacyMode ? !canLegacyLogin : submitting}
                style={({ pressed }) => [
                  styles.primaryButton,
                  styles.authActionButton,
                  (isLegacyMode ? !canLegacyLogin : submitting) && styles.buttonDisabled,
                  pressed && styles.pressed,
                ]}
                onPress={isGoogleMode ? submitGoogleLogin : isLegacyMode ? submitLegacyLogin : submitPhoneLogin}>
                <Text style={styles.primaryButtonText}>
                  {submitting
                    ? t('login.processing')
                    : isGoogleMode
                      ? t('login.googleSignIn')
                      : isLegacyMode
                        ? t('login.signIn')
                        : t('login.phoneTitle')}
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}


function MockTestView(props: {
  activeItem: MockItem | null;
  index: number;
  itemCount: number;
  loading: boolean;
  isActive: boolean;
  mockPartCounts: Record<string, number>;
  onGuideStartLayout: (event: LayoutChangeEvent) => void;
  part2Seconds: number;
  prepSeconds: number;
  processingCompleteSignal: number;
  recorderDuration: number;
  report: Record<string, unknown> | null;
  status: MockStatus;
  isReadingQuestion: boolean;
  onFinishPrep: () => void;
  onNext: () => void;
  onReadQuestion: () => void;
  onReset: () => void;
  onStart: () => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  const isActive = props.status === 'recording' || props.status === 'prep';
  const done = props.status === 'ready' || props.status === 'complete' || props.status === 'processing';
  const progress = props.itemCount > 0 ? (props.index + (done ? 1 : 0)) / props.itemCount : 0;
  const isPart2Item = props.activeItem?.mockPartLabel === 'Part 2';
  const isPart2Answering = props.status === 'recording' && isPart2Item;
  const autoFlipQuestionCard =
    isPart2Item && (props.status === 'prep' || props.status === 'recording')
      ? true
      : props.activeItem?.mockPartLabel === 'Part 3'
        ? false
        : undefined;

  return (
    <View style={styles.screenStack}>
      {props.isActive ? <PointsHeader /> : null}
      <View style={styles.mockHero}>
        <View style={styles.mockHeroTop}>
          <View>
            <Text style={styles.kicker}>{t('mock.kicker')}</Text>
            <Text style={styles.mockTitle}>{t('mock.title')}</Text>
          </View>
          <View style={[styles.statePill, isActive && styles.statePillLive]}>
            <View style={[styles.stateDot, isActive && styles.stateDotLive]} />
            <Text style={[styles.statePillText, isActive && styles.statePillTextLive]}>
              {mockStatusLabel(props.status, t)}
            </Text>
          </View>
        </View>

        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${Math.min(100, progress * 100)}%` }]} />
        </View>

        <View style={styles.mockStats}>
          <Metric label={t('mock.question')} value={props.itemCount ? `${Math.min(props.index + 1, props.itemCount)}/${props.itemCount}` : '--'} />
          <Metric label={t('mock.recorded')} value={formatDuration(props.recorderDuration)} />
        </View>
      </View>

      <View style={styles.partStrip}>
        {['Part 1', 'Part 2', 'Part 3'].map((part) => {
          const active = props.activeItem?.mockPartLabel === part;
          return (
            <View key={part} style={[styles.partChip, active && styles.partChipActive]}>
              <Text style={[styles.partChipTitle, active && styles.partChipTitleActive]}>{part}</Text>
              <Text style={[styles.partChipCaption, active && styles.partChipCaptionActive]}>
                {props.mockPartCounts[part] ?? 0} {part === 'Part 1' ? t('mock.questions') : part === 'Part 3' ? t('mock.topic') : t('mock.card')}
              </Text>
            </View>
          );
        })}
      </View>

      {props.loading ? (
        <LoadingCard text={t('mock.loadingQuestions')} />
      ) : props.activeItem ? (
        <QuestionPanel
          key={`${props.activeItem.id}:${autoFlipQuestionCard ?? 'manual'}`}
          item={props.activeItem}
          label={props.activeItem.mockPartLabel}
          autoFlipTo={autoFlipQuestionCard}
          isReadingQuestion={props.isReadingQuestion}
          onReadQuestion={props.onReadQuestion}
        />
      ) : (
        <LoadingCard text={t('mock.noQuestions')} />
      )}

      {props.status === 'prep' ? (
        <View style={styles.prepPanel}>
          <Text style={styles.prepTimer}>{formatClock(props.prepSeconds)}</Text>
          <Text style={styles.prepTitle}>{t('mock.prepTitle')}</Text>
          <Text style={styles.prepText}>{t('mock.prepText')}</Text>
          <Pressable style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]} onPress={props.onFinishPrep}>
            <Text style={styles.primaryButtonText}>{t('mock.startAnswer')}</Text>
          </Pressable>
        </View>
      ) : null}

      {isPart2Answering ? (
        <View style={styles.part2TimerPanel}>
          <Text style={styles.prepTimer}>{formatClock(props.part2Seconds)}</Text>
          <Text style={styles.prepTitle}>{props.part2Seconds === 0 ? "TIME'S UP!!" : t('mock.part2Timer')}</Text>
          <Text style={styles.prepText}>{t('mock.part2Text')}</Text>
        </View>
      ) : null}

      {props.status === 'idle' ? (
        <AdaptiveTourGuideZone
          zone={1}
          text={t('mock.startTour')}
          shape="rectangle"
          borderRadius={8}
          maskOffset={5}>
          <View collapsable={false} onLayout={props.onGuideStartLayout}>
            <Pressable
              style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
              onPress={props.onStart}>
              <Text style={styles.primaryButtonText}>{t('mock.start')}</Text>
            </Pressable>
          </View>
        </AdaptiveTourGuideZone>
      ) : null}

      {props.status === 'recording' ? (
        <>
          <View style={styles.controlRow}>
            <Pressable style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]} onPress={props.onReset}>
              <Text style={styles.secondaryButtonText}>{t('mock.abandon')}</Text>
            </Pressable>
            <Pressable style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]} onPress={props.onNext}>
              <Text style={styles.primaryButtonText}>
                {props.index + 1 >= props.itemCount ? t('mock.finishAll') : t('mock.next')}
              </Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {props.status === 'ready' ? (
        <>
          <Text style={styles.controlHint}>{t('mock.allPartsDone')}</Text>
          <View style={styles.controlRow}>
            <Pressable style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]} onPress={props.onReset}>
              <Text style={styles.secondaryButtonText}>{t('mock.reset')}</Text>
            </Pressable>
            <Pressable style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]} onPress={props.onSubmit}>
              <Text style={styles.primaryButtonText}>{t('mock.submit')}</Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {props.status === 'processing' ? (
        <LoadingInline
          text={t('mock.processing')}
          profile="mock"
          completeSignal={props.processingCompleteSignal}
        />
      ) : null}

      {props.report ? <ReportCard title={t('mock.report')} data={props.report} type="report" /> : null}

      {props.status === 'complete' ? (
        <View style={styles.controlRow}>
          <Pressable style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]} onPress={props.onReset}>
            <Text style={styles.secondaryButtonText}>{t('mock.newSet')}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function PracticeView(props: {
  activeQuestion: QuestionCard | null;
  analysis: Record<string, unknown> | null;
  currentIndex: number;
  isReadingQuestion: boolean;
  loading: boolean;
  isActive: boolean;
  onBack: () => void;
  onNextQuestion: () => void;
  onOpenCard: (card: QuestionCard) => void;
  onPause: () => void;
  onReadQuestion: () => void;
  onRestart: () => void;
  onResume: () => void;
  onStart: () => void;
  onStop: () => void;
  onSubmit: () => void;
  processingCompleteSignal: number;
  questionBank: QuestionBank;
  recorderDuration: number;
  selectedPart: PartKey;
  session: PracticeSession | null;
  setSelectedPart: (part: PartKey) => void;
  status: PracticeStatus;
  totalInSession: number;
}) {
  const { t } = useI18n();

const handleCardPress = useCallback(
    (_cardKey: string, card: QuestionCard) => {
      props.onOpenCard(card);
    },
    [props.onOpenCard],
  );


  if (props.session) {
    const isTopicSession = TOPIC_PRACTICE_PARTS.has(props.session.part);
    return (
      <View style={styles.screenStack}>
        {props.isActive ? <PointsHeader /> : null}
        <View style={styles.detailHeader}>
          <Pressable style={({ pressed }) => [styles.backButton, pressed && styles.pressed]} onPress={props.onBack}>
            <Text style={styles.backButtonText}>{t('common.back')}</Text>
          </Pressable>
          <View style={styles.detailHeaderText}>
            <Text style={styles.kicker}>{props.session.seed.title}</Text>
            <Text style={styles.detailTitle}>{props.session.seed.title}</Text>
          </View>
        </View>

        {props.activeQuestion ? (
          <QuestionPanel
            item={props.activeQuestion}
            label={
              isTopicSession
                ? `${PART_LABELS[props.session.part]} ${props.currentIndex + 1}/${props.totalInSession}`
                : PART_LABELS[props.session.part]
            }
            isReadingQuestion={props.isReadingQuestion}
            onReadQuestion={props.onReadQuestion}
          />
        ) : null}

        <View style={styles.controlPanel}>
          <View style={styles.practiceMeter}>
            <Metric label={t('common.status')} value={practiceStatusLabel(props.status, t)} />
            <Metric label={t('mock.recorded')} value={formatDuration(props.recorderDuration)} />
          </View>

          {props.status === 'idle' ? (
            <Pressable style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]} onPress={props.onStart}>
              <Text style={styles.primaryButtonText}>{t('practice.startRecording')}</Text>
            </Pressable>
          ) : null}

          {props.status === 'recording' ? (
            <>
              {isTopicSession ? (
                <Text style={styles.controlHint}></Text>
              ) : null}
              <View style={styles.controlRow}>
                <Pressable
                  style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                  onPress={isTopicSession ? props.onNextQuestion : props.onPause}>
                  <Text style={styles.secondaryButtonText}>
                    {isTopicSession ? t('practice.next') : t('practice.pause')}
                  </Text>
                </Pressable>
                <Pressable style={({ pressed }) => [styles.dangerButton, pressed && styles.pressed]} onPress={props.onStop}>
                  <Text style={styles.dangerButtonText}>{t('practice.endRecording')}</Text>
                </Pressable>
              </View>
            </>
          ) : null}

          {props.status === 'paused' ? (
            <View style={styles.controlColumn}>
              <Pressable style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]} onPress={props.onResume}>
                <Text style={styles.primaryButtonText}>{t('practice.resume')}</Text>
              </Pressable>
              <Pressable style={({ pressed }) => [styles.dangerButton, pressed && styles.pressed]} onPress={props.onStop}>
                <Text style={styles.dangerButtonText}>{t('practice.finishPrepare')}</Text>
              </Pressable>
            </View>
          ) : null}

          {props.status === 'ready' ? (
            <>
              <Text style={styles.controlHint}>{t('practice.recordingGenerated')}</Text>
              <View style={styles.controlRow}>
                <Pressable style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]} onPress={props.onRestart}>
                  <Text style={styles.secondaryButtonText}>{t('practice.rerecord')}</Text>
                </Pressable>
                <Pressable style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]} onPress={props.onSubmit}>
                  <Text style={styles.primaryButtonText}>{t('practice.submitAnalysis')}</Text>
                </Pressable>
              </View>
            </>
          ) : null}

          {props.status === 'processing' ? (
            <LoadingInline
              text={t('practice.processing')}
              profile="practice"
              completeSignal={props.processingCompleteSignal}
            />
          ) : null}

        </View>

        {props.analysis ? <ReportCard title={t('practice.analysis')} data={props.analysis} type="analysis" /> : null}

          {props.status === 'complete' ? (
            <View style={styles.controlRow}>
              <Pressable style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]} onPress={props.onRestart}>
                <Text style={styles.secondaryButtonText}>{t('practice.rerecord')}</Text>
              </Pressable>
            </View>
          ) : null}

      </View>



    );
  }

  const cards = props.questionBank[props.selectedPart];
  const topicGroups = TOPIC_PRACTICE_PARTS.has(props.selectedPart) ? groupTopicCards(cards) : [];

  return (
    <View style={styles.screenStack}>
      {props.isActive ? <PointsHeader /> : null}
      <View style={styles.sectionPanel}>
        <Text style={styles.kicker}>{t('practice.kicker')}</Text>
        <Text style={styles.sectionTitle}>{t('practice.title')}</Text>
        <Text style={styles.sectionText}>{t('practice.selectPart')}</Text>
        <View style={styles.segmented}>
          {PARTS.map((part) => {
            const active = props.selectedPart === part;
            return (
              <Pressable
                key={part}
                style={({ pressed }) => [styles.segmentButton, active && styles.segmentButtonActive, pressed && styles.pressed]}
                onPress={() => props.setSelectedPart(part)}>
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{PART_LABELS[part]}</Text>
                <Text style={[styles.segmentCount, active && styles.segmentTextActive]}>
                  {TOPIC_PRACTICE_PARTS.has(part) ? groupTopicCards(props.questionBank[part]).length : props.questionBank[part].length}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <AdaptiveTourGuideZone
        zone={3}
        text={t('practice.tour')}
        shape="rectangle"
        borderRadius={8}
        maskOffset={5}>
        {props.loading ? (
          <View>
            <LoadingCard text={t('practice.loadingCards')} />
          </View>
        ) : TOPIC_PRACTICE_PARTS.has(props.selectedPart) && topicGroups.length > 0 ? (
          <View style={styles.cardGrid}>
            {topicGroups.map((group) => (
              <Pressable
                key={group.key}
                style={({ pressed }) => [
                  styles.questionCard,
                  pressed && styles.questionCardPressed,
                ]}
                onPress={() => handleCardPress(group.key, group.questions[0])}>
                <View style={styles.cardHeaderRow}>
                  <Text style={styles.cardPart}>{group.title}</Text>

                </View>
                <Text style={styles.cardQuestion} numberOfLines={6}>
                  {group.questions.map((question) => displayQuestion(question.questionText)).join('\n')}
                </Text>
                <Text style={styles.cardPromptCount}>{group.questions.length} {t('mock.questions')} · {t('practice.clickStart')}</Text>
              </Pressable>
            ))}
          </View>
        ) : cards.length === 0 ? (
          <View style={styles.emptyPanel}>
            <Text style={styles.emptyTitle}>{t('practice.noCards')}</Text>
            <Text style={styles.emptyText}>{t('practice.noCardsText')}</Text>
          </View>
        ) : (
          <View style={styles.cardGrid}>
            {cards.map((card) => (
              <Pressable
                key={card.id}
                style={({ pressed }) => [
                  styles.questionCard,
                  pressed && styles.questionCardPressed,
                ]}
                onPress={() => handleCardPress(card.id, card)}>
                <View style={styles.cardHeaderRow}>
                  <Text style={styles.cardPart}>{card.title}</Text>

                </View>
                <Text style={styles.cardQuestion} numberOfLines={5}>
                  {displayQuestion(card.questionText)}
                </Text>
                {card.prompts.length > 0 ? (
                  <View style={styles.cardPromptList}>
                    {card.prompts.map((prompt) => (
                      <Text key={prompt} style={styles.cardPromptText}>
                        {prompt}
                      </Text>
                    ))}
                  </View>
                ) : null}
                <Text style={styles.cardPromptCount}>{t('practice.clickStart')}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </AdaptiveTourGuideZone>
    </View>
  );
}

function ProfileView({
  isActive,
  history,
  loading,
  rewards,
  rewardsLoading,
  onOpenRewards,
  onDismissRecovery,
  onUseStreakCard,
  onLogout,
  onDeleteAccount,
  onRefresh,
  onHistoryLayout,
  username,
}: {
  isActive: boolean;
  history: PracticeHistoryRecord[];
  loading: boolean;
  rewards: RewardsProgress | null;
  rewardsLoading: boolean;
  onOpenRewards: () => void;
  onDismissRecovery: () => Promise<void>;
  onUseStreakCard: () => Promise<void>;
  onLogout: () => void;
  onDeleteAccount: () => Promise<void>;
  onRefresh: () => void;
  onHistoryLayout: (event: LayoutChangeEvent) => void;
  username: string;
}) {
  const { t } = useI18n();
  const mockCount = history.filter((item) => item.mode === 'mock_test').length;
  const practiceCount = history.filter((item) => item.mode === 'part_practice').length;
  const [toastText, setToastText] = useState('');
  const [calendarVisible, setCalendarVisible] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [languageVisible, setLanguageVisible] = useState(false);
  const [aboutVisible, setAboutVisible] = useState(false);
  const [recoveryPromptVisible, setRecoveryPromptVisible] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setToastText(message);
    toastTimerRef.current = setTimeout(() => setToastText(''), 1800);
  }, []);


  const formatUsername = (username: string) => {
    if (!username) return '';

    const str = String(username).trim();

    // 如果是标准 11 位手机号
    if (/^1\d{10}$/.test(str)) {
      return str.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
    }

    // 如果是其他长度的大于 7 位的账号，同样脱敏中间部分
    if (str.length > 7) {
      const head = str.slice(0, 3);
      const tail = str.slice(-4);
      const mask = '*'.repeat(Math.max(4, str.length - 7));
      return `${head}${mask}${tail}`;
    }

    // 短账号（小于等于7位），遮挡中间部分字符
    if (str.length > 2) {
      const head = str.slice(0, 1);
      const tail = str.slice(-1);
      const mask = '*'.repeat(str.length - 2);
      return `${head}${mask}${tail}`;
    }

    return str;
  };

  const copyUsername = useCallback(async () => {
    if (!username) {
      return;
    }
    try {
      await copyTextToClipboard(username);
      showToast(t('profile.accountCopied'));
    } catch {
      showToast(t('profile.copyFailed'));
    }
  }, [showToast, t, username]);

  useEffect(() => {
    if (!isActive || !rewards?.recovery_offer || recoveryPromptVisible) {
      return;
    }
    setRecoveryPromptVisible(true);
    Alert.alert(
      t('profile.recoveryTitle'),
      t('profile.recoveryMessage').replace('{days}', `${rewards.recovery_offer.streak_days}`),
      [
        {
          text: t('profile.recoveryDismiss'),
          style: 'cancel',
          onPress: () => {
            setRecoveryPromptVisible(false);
            void onDismissRecovery();
          },
        },
        {
          text: t('profile.recoveryUse'),
          onPress: () => {
            setRecoveryPromptVisible(false);
            void onUseStreakCard();
          },
        },
      ],
    );
  }, [isActive, onDismissRecovery, onUseStreakCard, recoveryPromptVisible, rewards?.recovery_offer, t]);

  return (
  <View style={styles.screenStack}>
    <View style={styles.profilePanel}>
      <View style={styles.profileHeaderRow}>
        <View style={styles.profileAccountRow}>
          <Image
            source={require('../../assets/images/profiles.jpg')}
            style={styles.profileAvatar}
            accessibilityLabel={t('tabs.profile')}
          />
          {/* 这里会呈现脱敏后的账号（如：138****1234） */}
          <Text style={styles.profilePhone} numberOfLines={1}>
            {formatUsername(username)}
          </Text>
          <Pressable
            disabled={!username}
            style={({ pressed }) => [
              styles.profileCopyButton,
              !username && styles.buttonDisabled,
              pressed && styles.pressed,
            ]}
            onPress={copyUsername} // 复制功能建议依然复制原始的 username
            accessibilityLabel={t('profile.copyAccount')}>
            <SymbolView
              name={{ ios: 'doc.on.doc', android: 'content_copy', web: 'content_copy' }}
              size={16}
              weight="bold"
              tintColor={palette.teal}
            />
          </Pressable>
          </View>
          <View style={styles.profileActions}>
            <Pressable
              style={({ pressed }) => [styles.profileIconButton, pressed && styles.pressed]}
              onPress={onRefresh}
              accessibilityLabel={t('common.refresh')}>
              <SymbolView
                name={{ ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' }}
                size={17}
                weight="bold"
                tintColor={palette.teal}
              />
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.profileIconButton, pressed && styles.pressed]}
              onPress={() => setMenuVisible(true)}
              accessibilityLabel={t('settings.open')}>
              <SymbolView
                name={{ ios: 'ellipsis', android: 'more_horiz', web: 'more_horiz' }}
                size={18}
                weight="bold"
                tintColor={palette.ink}
              />
            </Pressable>
          </View>
        </View>
        <View style={styles.profileStats}>
          <Metric label={t('profile.mockTests')} value={`${mockCount}`} variant="profile" />
          <Metric label={t('profile.partPractice')} value={`${practiceCount}`} variant="profile" />
          <Metric label={t('profile.total')} value={`${history.length}`} variant="profile" />
        </View>
        {toastText ? (
          <View style={styles.profileToast} pointerEvents="none">
            <Text style={styles.profileToastText}>{toastText}</Text>
          </View>
        ) : null}
      </View>

      <CheckinPointsPanel
        progress={rewards}
        loading={rewardsLoading}
        onOpenCalendar={() => setCalendarVisible(true)}
        onOpenRewards={onOpenRewards}
      />

      <AdaptiveTourGuideZone
        zone={6}
        text={t('onboarding.step6')}
        shape="rectangle"
        borderRadius={8}
        maskOffset={5}>
        <View style={styles.recentSection} onLayout={onHistoryLayout}>
          <Text style={styles.recentTitle}>{t('profile.recent')}</Text>
          {loading ? <LoadingCard text={t('profile.loadingHistory')} /> : null}

          {!loading && history.length === 0 ? (
            <View style={styles.emptyPanel}>
              <Text style={styles.emptyTitle}>{t('profile.emptyTitle')}</Text>
              <Text style={styles.emptyText}>{t('profile.emptyText')}</Text>
            </View>
          ) : null}

          {history.map((item) => (
            <HistoryCard key={item.id} item={item} />
          ))}
        </View>
      </AdaptiveTourGuideZone>

      <MonthlyCalendarModal
        visible={calendarVisible}
        progress={rewards}
        onClose={() => setCalendarVisible(false)}
        onOpenRewards={onOpenRewards}
      />

      <ProfileMenuModal
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        onAbout={() => {
          setMenuVisible(false);
          setAboutVisible(true);
        }}
        onLanguage={() => {
          setMenuVisible(false);
          setLanguageVisible(true);
        }}
        onLogout={() => {
          setMenuVisible(false);
          onLogout();
        }}
        onDeleteAccount={onDeleteAccount}
      />
      <DisplayLanguageModal visible={languageVisible} onClose={() => setLanguageVisible(false)} />
      <AboutModal visible={aboutVisible} onClose={() => setAboutVisible(false)} />
    </View>
  );
}

function ProfileMenuModal({
  visible,
  onClose,
  onAbout,
  onLanguage,
  onLogout,
  onDeleteAccount,
}: {
  visible: boolean;
  onClose: () => void;
  onAbout: () => void;
  onLanguage: () => void;
  onLogout: () => void;
  onDeleteAccount: () => Promise<void>;
}) {
  const { locale, t } = useI18n();
  const [deleting, setDeleting] = useState(false);

  const confirmDeleteAccount = useCallback(() => {
    Alert.alert(t('settings.deleteTitle'), t('settings.deleteMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('settings.confirmDelete'),
        style: 'destructive',
        onPress: () => {
          setDeleting(true);
          void onDeleteAccount()
            .catch(() => Alert.alert(t('common.notice'), t('settings.deleteFailed')))
            .finally(() => setDeleting(false));
        },
      },
    ]);
  }, [onDeleteAccount, t]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.profileMenuCard}>
          <View style={styles.profileMenuHeader}>
            <Text style={styles.profileMenuTitle}>{t('settings.title')}</Text>
            <Pressable
              style={({ pressed }) => [styles.modalIconButton, pressed && styles.pressed]}
              onPress={onClose}
              accessibilityLabel={t('common.close')}>
              <SymbolView
                name={{ ios: 'xmark', android: 'close', web: 'close' }}
                size={16}
                weight="bold"
                tintColor={palette.ink}
              />
            </Pressable>
          </View>
          <Pressable
            style={({ pressed }) => [styles.profileMenuRow, pressed && styles.pressed]}
            onPress={onLanguage}>
            <SymbolView
              name={{ ios: 'globe', android: 'language', web: 'language' }}
              size={18}
              weight="bold"
              tintColor={palette.teal}
            />
            <Text style={styles.profileMenuRowText}>{t('settings.displayLanguage')}</Text>
            <Text style={styles.profileMenuValue}>{localeNames[locale]}</Text>
            <SymbolView
              name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
              size={15}
              weight="bold"
              tintColor={palette.muted}
            />
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.profileMenuRow, pressed && styles.pressed]}
            onPress={onAbout}>
            <SymbolView
              name={{ ios: 'info.circle', android: 'info', web: 'info' }}
              size={18}
              weight="bold"
              tintColor={palette.teal}
            />
            <Text style={styles.profileMenuRowText}>{t('common.about')}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.profileMenuRow, styles.profileMenuDanger, pressed && styles.pressed]}
            onPress={onLogout}>
            <SymbolView
              name={{ ios: 'rectangle.portrait.and.arrow.right', android: 'logout', web: 'logout' }}
              size={18}
              weight="bold"
              tintColor={palette.coral}
            />
            <Text style={styles.profileMenuDangerText}>{t('settings.logout')}</Text>
          </Pressable>
          <Pressable
            disabled={deleting}
            style={({ pressed }) => [
              styles.profileMenuRow,
              styles.profileMenuDelete,
              deleting && styles.buttonDisabled,
              pressed && styles.pressed,
            ]}
            onPress={confirmDeleteAccount}>
            <SymbolView
              name={{ ios: 'person.crop.circle.badge.xmark', android: 'person_remove', web: 'person_remove' }}
              size={18}
              weight="bold"
              tintColor="#9C2F27"
            />
            <Text style={styles.profileMenuDeleteText}>
              {deleting ? t('settings.deleting') : t('settings.deleteAccount')}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function DisplayLanguageModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { locale, setLocale, t } = useI18n();

  const chooseLocale = useCallback(
    async (nextLocale: AppLocale) => {
      await setLocale(nextLocale);
      onClose();
    },
    [onClose, setLocale],
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.profileMenuCard}>
          <View style={styles.profileMenuHeader}>
            <Text style={styles.profileMenuTitle}>{t('settings.selectLanguage')}</Text>
            <Pressable
              style={({ pressed }) => [styles.modalIconButton, pressed && styles.pressed]}
              onPress={onClose}
              accessibilityLabel={t('common.close')}>
              <SymbolView
                name={{ ios: 'xmark', android: 'close', web: 'close' }}
                size={16}
                weight="bold"
                tintColor={palette.ink}
              />
            </Pressable>
          </View>
          <Text style={styles.languageHint}>{t('settings.languageHint')}</Text>
          {supportedLocales.map((item) => {
            const active = locale === item;
            return (
              <Pressable
                key={item}
                style={({ pressed }) => [
                  styles.profileMenuRow,
                  active && styles.languageRowActive,
                  pressed && styles.pressed,
                ]}
                onPress={() => void chooseLocale(item)}>
                <Text style={[styles.profileMenuRowText, active && styles.languageOptionTextActive]}>
                  {localeNames[item]}
                </Text>
                {active ? (
                  <SymbolView
                    name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }}
                    size={18}
                    weight="bold"
                    tintColor="#FFFFFF"
                  />
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </View>
    </Modal>
  );
}

function AboutModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.aboutCard}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{t('settings.aboutTitle')}</Text>
            <Pressable
              style={({ pressed }) => [styles.modalIconButton, pressed && styles.pressed]}
              onPress={onClose}
              accessibilityLabel={t('settings.closeAbout')}>
              <SymbolView
                name={{ ios: 'xmark', android: 'close', web: 'close' }}
                size={16}
                weight="bold"
                tintColor={palette.ink}
              />
            </Pressable>
          </View>
          <Text style={styles.aboutLabel}>{t('common.webAddress')}</Text>
          <Pressable
            style={({ pressed }) => [styles.aboutLinkButton, pressed && styles.pressed]}
            onPress={() => void Linking.openURL('https://speakinggo.com')}
            accessibilityRole="link">
            <Text style={styles.aboutLink}>speakinggo.com</Text>
            <SymbolView
              name={{ ios: 'arrow.up.right', android: 'open_in_new', web: 'open_in_new' }}
              size={15}
              weight="bold"
              tintColor={palette.teal}
            />
          </Pressable>
          <Text style={styles.aboutLabel}>Contact</Text>
          <Text style={styles.aboutLabel}>liuzhn6@outlook.com</Text>
          <Pressable style={({ pressed }) => [styles.aboutCloseButton, pressed && styles.pressed]} onPress={onClose}>
            <Text style={styles.aboutCloseText}>{t('common.close')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function CheckinPointsPanel({
  progress,
  loading,
  onOpenCalendar,
  onOpenRewards,
}: {
  progress: RewardsProgress | null;
  loading: boolean;
  onOpenCalendar: () => void;
  onOpenRewards: () => void;
}) {
  const { locale, t } = useI18n();
  const checkedDates = new Set(progress?.checkin_dates ?? []);
  const recentDays = getRecentDateKeys(7);

  return (
    <View style={styles.rewardSection}>
      <View style={styles.rewardSectionHeader}>
        <Text style={styles.rewardSectionTitle}>{t('common.rewards')}</Text>
        <Pressable
          style={({ pressed }) => [styles.rewardStoreButton, pressed && styles.pressed]}
          onPress={onOpenRewards}
          accessibilityLabel={t('common.openStore')}>
          <Text style={styles.rewardStoreButtonText}>{t('common.store')}</Text>
        </Pressable>
      </View>

      <AdaptiveTourGuideZone
        zone={5}
        text={t('onboarding.step5')}
        shape="rectangle"
        borderRadius={8}
        maskOffset={5}>
        <Pressable
          style={({ pressed }) => [styles.weekCalendarPanel, pressed && styles.pressed]}
          onPress={onOpenCalendar}
          accessibilityLabel={t('common.viewCalendar')}>
          <AdaptiveTourGuideZone
            zone={7}
            text={t('onboarding.step7')}
            shape="rectangle"
            borderRadius={8}
            maskOffset={5}>
            <View style={styles.weekCalendarRow}>
              {recentDays.map((dateKey) => {
                const isToday = dateKey === getClientDateKey();
                const checked = checkedDates.has(dateKey);
                return (
                  <View key={dateKey} style={styles.dayCell}>
                    <Text style={styles.dayCellLabel}>{formatWeekday(dateKey, locale)}</Text>
                    <View
                      style={[
                        styles.dayCellMark,
                        checked && styles.dayCellMarkChecked,
                        isToday && !checked && styles.dayCellMarkToday,
                      ]}>
                      <Text style={[styles.dayCellMarkText, checked && styles.dayCellMarkTextChecked]}>
                        {checked ? '✓' : dateKey.slice(-2)}
                      </Text>
                    </View>
                    {isToday ? <Text style={styles.dayCellToday}>{t('common.today')}</Text> : <Text style={styles.dayCellToday}> </Text>}
                  </View>
                );
              })}
            </View>
          </AdaptiveTourGuideZone>
        </Pressable>
      </AdaptiveTourGuideZone>

      <View style={styles.pointsPanel}>
        <View style={styles.pointsCopy}>
          <Text style={styles.pointsValue}>💰 {loading ? '—' : progress?.points ?? 0} {t('profile.points')}</Text>
        </View>
        <View style={styles.pointsDivider} />
        <View style={styles.streakBadge}>
          <Text style={styles.streakLine}>
            🔥 {t('profile.streak').replace('{days}', `${progress?.streak_days ?? 0}`)}
          </Text>
        </View>
      </View>
    </View>
  );
}

function MonthlyCalendarModal({
  visible,
  progress,
  onClose,
  onOpenRewards,
}: {
  visible: boolean;
  progress: RewardsProgress | null;
  onClose: () => void;
  onOpenRewards: () => void;
}) {
  const { locale, t } = useI18n();
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const firstWeekday = monthStart.getDay();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const checkedDates = new Set(progress?.checkin_dates ?? []);
  const cells: Array<number | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];

  while (cells.length % 7 !== 0) {
    cells.push(null);
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.calendarModalCard}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.kicker}>FULL CALENDAR</Text>
              <Text style={styles.modalTitle}>
                {today.toLocaleDateString(toIntlLocale(locale), { year: 'numeric', month: 'long' })}
              </Text>
            </View>
            <Pressable style={({ pressed }) => [styles.modalCloseButton, pressed && styles.pressed]} onPress={onClose}>
              <Text style={styles.modalCloseText}>{t('common.close')}</Text>
            </Pressable>
          </View>

          <View style={styles.monthWeekdayRow}>
            {getWeekdayLabels(locale).map((label) => (
              <Text key={label} style={styles.monthWeekday}>
                {label}
              </Text>
            ))}
          </View>
          <View style={styles.monthGrid}>
            {cells.map((day, index) => {
              const dateKey = day ? toDateKey(new Date(today.getFullYear(), today.getMonth(), day)) : '';
              const checked = Boolean(dateKey && checkedDates.has(dateKey));
              const isToday = day === today.getDate();
              return (
                <View key={`${dateKey}-${index}`} style={styles.monthCell}>
                  {day ? (
                    <View style={[styles.monthDay, checked && styles.monthDayChecked, isToday && styles.monthDayToday]}>
                      <Text style={[styles.monthDayText, checked && styles.monthDayTextChecked]}>{day}</Text>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>

          <View style={styles.calendarLegend}>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, styles.legendDotChecked]} />
              <Text style={styles.legendText}>{t('common.checkedIn')}</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, styles.legendDotToday]} />
              <Text style={styles.legendText}>{t('common.today')}</Text>
            </View>
          </View>

          <Pressable style={({ pressed }) => [styles.modalStoreButton, pressed && styles.pressed]} onPress={onOpenRewards}>
            <Text style={styles.modalStoreButtonText}>{t('common.goStore')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function QuestionPanel({
  item,
  label,
  autoFlipTo,
  isReadingQuestion,
  onReadQuestion,
}: {
  item: QuestionCard;
  label: string;
  autoFlipTo?: boolean;
  isReadingQuestion: boolean;
  onReadQuestion: () => void;
}) {
  const { t } = useI18n();
  const [isFlipped, setIsFlipped] = useState(autoFlipTo ?? false);

  return (
    <View style={styles.questionPanel}>
      <View style={styles.questionPanelHeader}>
        <View>
          <Text style={styles.kicker}>{label}</Text>
        </View>
        <Pressable
          disabled={isReadingQuestion}
          style={({ pressed }) => [
            styles.readButton,
            isReadingQuestion && styles.buttonDisabled,
            pressed && styles.pressed,
          ]}
          onPress={onReadQuestion}>
          <Text style={styles.readButtonText}>
            {isReadingQuestion ? t('question.reading') : t('question.read')}
          </Text>
        </Pressable>
      </View>

      <Pressable onPress={() => setIsFlipped(!isFlipped)}>
          <FlipCard
            flipHorizontal={true}
            flip={isFlipped}
            clickable={false}
            style={styles.cardContainer}
          >
          {/* 正面 */}
          <View style={styles.questionPanel}>
            <Text style={styles.Notes}>{t('question.flip')}</Text>
          </View>

          {/* 背面 */}
          <View style={styles.questionPanel}>
            <Text style={styles.questionText}>{displayQuestion(item.questionText)}</Text>
            {item.prompts.length > 0 ? (
              item.prompts.map((prompt) => (
                <Text key={prompt} style={styles.promptText}>
                  {prompt}
                </Text>
              ))
            ) : null}
          </View>
        </FlipCard>
      </Pressable>
    </View>
  );
}

function BottomGuide({
  activeTab,
  bottomInset,
  onChange,
}: {
  activeTab: MainTab;
  bottomInset: number;
  onChange: (tab: MainTab) => void;
}) {
  const { t } = useI18n();
  return (
    <View style={[styles.bottomBarWrap, { paddingBottom: Math.max(bottomInset, 12) }]}>
      <View style={styles.bottomBar}>
        {TAB_ITEMS.map((tab) => {
          const active = tab.key === activeTab;

          // 1. 抽离纯按钮节点
          const item = (
            <Pressable
              style={({ pressed }) => [
                styles.bottomItem,
                active && styles.bottomItemActive,
                pressed && styles.pressed,
              ]}
              onPress={() => onChange(tab.key)}>
              <View style={[styles.bottomMark, active && styles.bottomMarkActive]}>
                <Text style={[styles.bottomMarkText, active && styles.bottomMarkTextActive]}>
                  {tab.mark}
                </Text>
              </View>
              <Text style={[styles.bottomLabel, active && styles.bottomLabelActive]}>
                {tab.key === 'mock' ? t('tabs.mock') : tab.key === 'practice' ? t('tabs.practice') : t('tabs.profile')}
              </Text>
              <Text style={[styles.bottomCaption, active && styles.bottomCaptionActive]}>
                {tab.key === 'profile' ? t('tabs.profileCaption') : tab.caption}
              </Text>
            </Pressable>
          );

          const zoneConfig =
            tab.key === 'practice'
              ? { zone: 2, text: t('onboarding.step2') }
              : tab.key === 'profile'
              ? { zone: 4, text: t('onboarding.step4') }
              : null;

          if (!zoneConfig) {
            return (
              <View key={tab.key} style={styles.bottomGuideZone}>
                {item}
              </View>
            );
          }

          return (
            <AdaptiveTourGuideZone
              key={tab.key}
              zone={zoneConfig.zone}
              text={zoneConfig.text}
              shape="rectangle"
              borderRadius={8}
              maskOffset={5}
              style={styles.bottomGuideZone}>
              {item}
            </AdaptiveTourGuideZone>
          );
        })}
      </View>
    </View>
  );
}

function ReportCard({
  title,
  data,
  type,
}: {
  title: string;
  data: Record<string, unknown>;
  type: 'report' | 'analysis';
}) {
  return (
    <View style={styles.reportPanel}>
      <Text style={styles.reportTitle}>{title}</Text>
      <ReportContent data={data} type={type} />
    </View>
  );
}

function ReportContent({
  data,
  type,
}: {
  data: Record<string, unknown>;
  type: 'report' | 'analysis';
}) {
  const { t } = useI18n();

  const analysisRecord = asRecord(data.analysis);
  const pauseAnalysis = asRecord(data.pause_analysis);
  const audioUri = extractAudioUri(data, analysisRecord);

  const transcriptionRecord = firstRecord(
    [data, analysisRecord],
    ['transcription', 'transcript_result']
  );


  const fluencyFeatures = firstRecord(
    [
      data,
      analysisRecord,
      pauseAnalysis
    ],
    [
      'fluency_features_6d'
    ]
  );


  const speakingRate =
    typeof fluencyFeatures?.speaking_rate_wpm === 'number'
      ? fluencyFeatures.speaking_rate_wpm
      : undefined;


  const pauseCountFromFeatures =
    fluencyFeatures
      ? Number(fluencyFeatures.mid_pause_100_200 ?? 0)
        +
        Number(fluencyFeatures.mid_pause_200_500 ?? 0)
        +
        Number(fluencyFeatures.mid_pause_gt_500 ?? 0)
        +
        Number(fluencyFeatures.filler_pause_100_250 ?? 0)
        +
        Number(fluencyFeatures.filler_pause_gt_250 ?? 0)
      : undefined;
  const pauseCountValue =
    pauseCountFromFeatures ??
    firstKnownValue([data, analysisRecord, pauseAnalysis], [
      'detected_pause_count',
      'pause_count',
      'pauseCount',
      'total_pauses',
      'pauseCountValue',
    ]);

  const subScores = firstRecord([data, analysisRecord], ['sub_scores', 'subScores', 'scores']);
  const transcript = firstText([data, analysisRecord, transcriptionRecord], [
    'full_transcript',
    'transcript',
    'Transcript',
    'text',
  ]);

  const pauseSentenceAdvice = firstKnownValue(
    [data, analysisRecord, pauseAnalysis],
    ['pause_sentence_advice', 'pauseSentenceAdvice', 'pause_advice', 'pauseAdvice', 'pause_sentence_feedback']
  );


  const deepseekAnalysis = firstRecord(
  [
    data,
    analysisRecord,
    pauseAnalysis
  ],
  [
    'deepseek_detailed_analysis'
  ]
);
  const lexicalResource = asRecord(deepseekAnalysis?.lexical_resource);
  const grammarAccuracy = asRecord(deepseekAnalysis?.grammatical_range_accuracy);
  const grammarErrors = collectGrammarErrors([data, analysisRecord, pauseAnalysis, deepseekAnalysis, grammarAccuracy]);


 const analysisText = [
  lexicalResource?.analysis
    ? `Lexical Resource:\n${lexicalResource.analysis}`
    : '',

  grammarAccuracy?.analysis
   ? `Grammatical Range & Accuracy:\n${grammarAccuracy.analysis}`
   : '',
]
.filter(Boolean)
.join('\n\n');

  const sentences = firstKnownValue([data, analysisRecord], ['sentences']);
  const hasFluencyMetrics =
    speakingRate !== undefined || pauseCountValue !== undefined || Array.isArray(sentences);

  return (
    <>
      {type === 'report' ? (
        <View style={styles.scoreGrid}>
          <ScoreTile
            label="Pronunciation"
            value={textValue(firstKnownValue([subScores, data, analysisRecord], ['fluency_and_coherence', 'pronunciation_score']), 'N/A')}
          />
          <ScoreTile
            label="Fluency"
            value={textValue(firstKnownValue([subScores, data, analysisRecord], ['fluency_and_coherence', 'fluency']), 'N/A')}
          />
          <ScoreTile
            label="Lexical"
            value={textValue(firstKnownValue([subScores, data, analysisRecord], ['lexical_resource', 'lexical']), 'N/A')}
          />
          <ScoreTile
            label="Grammar"
            value={textValue(firstKnownValue([subScores, data, analysisRecord], ['grammatical_range_accuracy', 'grammar']), 'N/A')}
          />
          <ScoreTile
            label="Overall"
            value={textValue(firstKnownValue([data, analysisRecord], ['overall_band', 'overallBand', 'band_score', 'score']), 'N/A')}
            highlight
          />
        </View>
      ) : null}

      {type === 'analysis' || hasFluencyMetrics ? (
        <View style={styles.scoreGrid}>
          <ScoreTile label="Words/min" value={textValue(speakingRate, 'N/A')} highlight />
          <ScoreTile label="Pauses" value={textValue(pauseCountValue, '0')} />
          <ScoreTile label="Sentences" value={Array.isArray(sentences) ? `${sentences.length}` : '0'} />
        </View>
      ) : null}

      {audioUri ? <RecordingPlayback uri={audioUri} /> : null}

      {analysisText ? (
        <View style={styles.reportSection}>
          <Text style={styles.reportSectionTitle}>{t('history.analysis')}</Text>
          <Text style={styles.reportBody}>{analysisText}</Text>
        </View>
      ) : null}

      {grammarErrors.length > 0 ? <GrammarErrorTable items={grammarErrors} /> : null}

      {transcript ? (
        <View style={styles.reportSection}>
          <Text style={styles.reportSectionTitle}>{t('history.transcript')}</Text>
          <Text style={styles.reportBody}>{transcript}</Text>
        </View>
      ) : null}

      {hasRecordContent(speakingRate) ? (
        <View style={styles.reportSection}>
          <Text style={styles.reportSectionTitle}>{t('history.speakingRate')}</Text>
          <Text style={styles.reportBody}>{compactJson(speakingRate)}</Text>
        </View>
      ) : null}

      {hasRecordContent(pauseCountValue) ? (
        <View style={styles.reportSection}>
          <Text style={styles.reportSectionTitle}>{t('history.pauseCount')}</Text>
          <Text style={styles.reportBody}>{compactJson(pauseCountValue)}</Text>
        </View>
      ) : null}

      {hasRecordContent(pauseSentenceAdvice) ? <ImprovementAdviceList value={pauseSentenceAdvice} /> : null}

      {textValue(firstKnownValue([data, analysisRecord], ['error'])) ? (
        <View style={styles.reportSection}>
          <Text style={styles.reportSectionTitle}>{t('history.error')}</Text>
          <Text style={styles.reportBody}>{textValue(firstKnownValue([data, analysisRecord], ['error']))}</Text>
        </View>
      ) : null}
</>
  );
}

function HistoryCard({ item }: { item: PracticeHistoryRecord }) {
  const { t } = useI18n();
  const payload = item.report ?? item.analysis;
  const record = asRecord(payload) ?? (payload ? { analysis: payload } : {});
  const analysisRecord = asRecord(record.analysis);
  const subScores = firstRecord([record, analysisRecord], ['sub_scores', 'subScores', 'scores']);
  const overall = textValue(firstKnownValue([record, analysisRecord], ['overall_band', 'overallBand', 'band_score', 'score']));
  const transcript = firstText([record, analysisRecord], ['full_transcript']);
  const pauseCount = textValue(
    firstKnownValue([record, analysisRecord], ['detected_pause_count', 'pause_count', 'pauseCount', 'total_pauses']),
  );

  return (
    <View style={styles.historyCard}>
      <Pressable
        style={({ pressed }) => [styles.historyCardBody, pressed && styles.historyCardPressed]}
        onPress={() => router.push(`/history/${encodeURIComponent(item.id)}` as Href)}>
        <View style={styles.historyTop}>
          <View
            style={[
              styles.historyMode,
              item.mode === 'mock_test' ? styles.historyModeMock : styles.historyModePractice,
            ]}>
            <Text style={styles.historyModeText}>{item.mode === 'mock_test' ? t('tabs.mock') : t('tabs.practice')}</Text>
          </View>
          <Text style={styles.historyDate}>{formatHistoryDate(item.created_at)}</Text>
        </View>
        <Text style={styles.historyTitle}>{item.topic || item.part || 'Untitled practice'}</Text>
        {item.question_text ? (
          <Text style={styles.historyQuestion} numberOfLines={3}>
            {formatHistoryQuestion(item)}
          </Text>
        ) : null}
      </Pressable>
      <View style={styles.historyFooter}>
        <View style={styles.historyMetaRow}>
          {overall ? <Text style={styles.historyMeta}>{overall}</Text> : null}
          {pauseCount ? <Text style={styles.historyMeta}>{t('history.pauseCount')} {pauseCount}</Text> : null}
        </View>
        <Pressable
          style={({ pressed }) => [styles.historyDetailsButton, pressed && styles.pressed]}
          onPress={() => router.push(`/history/${encodeURIComponent(item.id)}` as Href)}
          accessibilityLabel={t('history.viewDetails')}>
          <Text style={styles.historyDetailsText}>{t('history.viewDetails')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Metric({
  label,
  value,
  variant = 'default',
}: {
  label: string;
  value: string;
  variant?: 'default' | 'profile';
}) {
  return (
    <View style={[styles.metric, variant === 'profile' && styles.profileMetric]}>
      <Text style={[styles.metricLabel, variant === 'profile' && styles.profileMetricLabel]}>{label}</Text>
      <Text style={[styles.metricValue, variant === 'profile' && styles.profileMetricValue]}>{value}</Text>
    </View>
  );
}

function ScoreTile({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <View style={[styles.scoreTile, highlight && styles.scoreTileHighlight]}>
      <Text style={[styles.scoreLabel, highlight && styles.scoreLabelHighlight]}>{label}</Text>
      <Text style={[styles.scoreValue, highlight && styles.scoreValueHighlight]}>{value}</Text>
    </View>
  );
}

function GrammarErrorTable({ items }: { items: GrammarErrorRow[] }) {
  const { t } = useI18n();
  return (
    <View style={styles.reportSection}>
      <Text style={styles.reportSectionTitle}>{t('history.grammarErrors')}</Text>
      <View style={styles.grammarTable}>
        {items.map((item, index) => (
          <View key={`${item.sentenceIndex}-${index}`} style={styles.grammarCard}>
            <KeyValueStackItem label="Sentence" value={item.sentence || 'N/A'} valueStyle={styles.grammarSentence} />
            <KeyValueStackItem label="Correction" value={item.correction || 'N/A'} valueStyle={styles.grammarCorrection} />
            <KeyValueStackItem
              label="Explanation"
              value={[item.error, item.explanation].filter(Boolean).join('\n') || 'N/A'}
              valueStyle={styles.grammarMeta}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

function ImprovementAdviceList({ value }: { value: unknown }) {
  const { t } = useI18n();
  const items = collectImprovementAdvice(value);

  if (items.length === 0) {
    return null;
  }

  return (
    <View style={styles.reportSection}>
      <Text style={styles.reportSectionTitle}>{t('history.sentencesWithPauses')}</Text>
      <View style={styles.grammarTable}>
        {items.map((item, index) => (
          <View key={`${item.originalSentence}-${index}`} style={styles.grammarCard}>
            <KeyValueStackItem
              label="Original"
              value={item.originalSentence || 'N/A'}
              valueStyle={styles.grammarSentence}
            />
            <KeyValueStackItem
              label="Improved"
              value={item.improvedSentence || 'N/A'}
              valueStyle={styles.grammarCorrection}
            />
            <KeyValueStackItem
              label="Examiner Advice"
              value={item.examinerAdvice || 'N/A'}
              valueStyle={styles.grammarMeta}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

function KeyValueStackItem({
  label,
  value,
  valueStyle,
}: {
  label: string;
  value: string;
  valueStyle?: StyleProp<TextStyle>;
}) {
  return (
    <View style={styles.grammarStackItem}>
      <Text style={styles.grammarStackLabel}>{label}</Text>
      <Text style={[styles.grammarStackValue, valueStyle]}>{value}</Text>
    </View>
  );
}

function LoadingCard({ text }: { text: string }) {
  return (
    <View style={styles.loadingCard}>
      <ActivityIndicator color={palette.teal} />
      <Text style={styles.loadingText}>{text}</Text>
    </View>
  );
}

function LoadingInline({
  text,
  profile = 'inline',
  completeSignal = 0,
}: {
  text: string;
  profile?: BackendProgressProfile;
  completeSignal?: number;
}) {
  const { t } = useI18n();
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let frameId: number | null = null;

    if (completeSignal) {
      frameId = requestAnimationFrame(() => setProgress(100));
      return () => {
        if (frameId !== null) {
          cancelAnimationFrame(frameId);
        }
      };
    }

    const startedAt = Date.now();

    const tick = () => {
      setProgress(getInterpolatedBackendProgress(BACKEND_PROGRESS_PROFILES[profile], Date.now() - startedAt));
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [completeSignal, profile]);

  const roundedProgress = Math.max(0, Math.min(100, Math.round(progress)));

  return (
    <View
      style={styles.loadingInline}
      accessibilityLabel={text}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: roundedProgress }}>
      <View style={styles.loadingInlineHeader}>
        <Text style={styles.loadingInlinePercent}>{roundedProgress}%</Text>
        <Text style={styles.loadingInlineText}>{t('common.analyzing')}</Text>
      </View>
      <View style={styles.loadingProgressTrack}>
        <View style={[styles.loadingProgressFill, { width: `${roundedProgress}%` }]} />
      </View>
    </View>
  );
}

function waitForVisibleProgressCompletion() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, PROCESSING_COMPLETE_VISIBLE_MS);
  });
}

function getInterpolatedBackendProgress(stages: BackendProgressStage[], elapsedMs: number) {
  if (stages.length === 0) {
    return 0;
  }

  let elapsedBeforeStage = 0;
  for (const stage of stages) {
    const stageElapsed = elapsedMs - elapsedBeforeStage;
    if (stageElapsed <= stage.durationMs) {
      const ratio = Math.max(0, Math.min(1, stageElapsed / stage.durationMs));
      const easedRatio = 1 - Math.pow(1 - ratio, 3);
      return stage.from + (stage.to - stage.from) * easedRatio;
    }
    elapsedBeforeStage += stage.durationMs;
  }

  const finalStage = stages[stages.length - 1];
  const overrunMs = Math.max(0, elapsedMs - elapsedBeforeStage);
  const creep = (PROGRESS_CREEP_LIMIT - finalStage.to) * (1 - Math.exp(-overrunMs / 18000));
  return Math.min(PROGRESS_CREEP_LIMIT, finalStage.to + creep);
}

function RecordingPlayback({ uri }: { uri: string }) {
  const { t } = useI18n();
  const player = useAudioPlayer(null, { keepAudioSessionActive: false, updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const [loadedUri, setLoadedUri] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  useEffect(
    () => () => {
      try {
        player.pause();
      } catch {
        // Ignore playback cleanup errors.
      }
    },
    [player],
  );

  const togglePlayback = useCallback(async () => {
    setPlaybackError(null);
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: 'doNotMix',
      });
      if (status.playing) {
        player.pause();
        return;
      }
      if (loadedUri !== uri) {
        player.replace(uri);
        setLoadedUri(uri);
      }
      if (status.didJustFinish) {
        await player.seekTo(0);
      }
      player.play();
    } catch (error) {
      setPlaybackError(getErrorMessage(error));
    }
  }, [loadedUri, player, status.didJustFinish, status.playing, uri]);

  const currentMillis = Number.isFinite(status.currentTime) ? status.currentTime * 1000 : 0;
  const durationMillis = Number.isFinite(status.duration) ? status.duration * 1000 : 0;

  return (
    <View style={styles.audioPlayback}>
      <View style={styles.audioPlaybackHeader}>
        <View>
          <Text style={styles.reportSectionTitle}>{t('history.recordingPlayback')}</Text>
          <Text style={styles.audioPlaybackTime}>
            {formatDuration(currentMillis)}{durationMillis > 0 ? ` / ${formatDuration(durationMillis)}` : ''}
          </Text>
        </View>
        <Pressable style={({ pressed }) => [styles.playButton, pressed && styles.pressed]} onPress={togglePlayback}>
          <Text style={styles.playButtonText}>{status.playing ? t('common.pause') : t('common.play')}</Text>
        </Pressable>
      </View>
      {playbackError ? <Text style={styles.audioPlaybackError}>{playbackError}</Text> : null}
    </View>
  );
}

function buildMockItems(bank: QuestionBank): MockItem[] {
  const part1Items = sampleItems(bank.part1, 4).map((item) => ({ ...item, mockPartLabel: 'Part 1' as const }));
  const selectedPart2 = sampleOne(bank.part2);
  const part2Items = selectedPart2 ? [{ ...selectedPart2, mockPartLabel: 'Part 2' as const }] : [];
  const relatedPart3 = selectedPart2
    ? bank.part3.filter((item) => item.sourceIndex === selectedPart2.sourceIndex)
    : [];
  const fallbackPart3 = selectedPart2
    ? bank.part3.filter((item) => item.title === selectedPart2.title)
    : [];
  const part3Source = relatedPart3.length > 0 ? relatedPart3 : fallbackPart3.length > 0 ? fallbackPart3 : bank.part3;
  const part3Items = sampleItems(part3Source, 4).map((item) => ({ ...item, mockPartLabel: 'Part 3' as const }));
  const items = [...part1Items, ...part2Items, ...part3Items];
  return items.length > 0 ? items : FALLBACK_MOCK_ITEMS;
}

function sampleOne<T>(items: T[]) {
  if (items.length === 0) {
    return undefined;
  }
  return items[Math.floor(Math.random() * items.length)];
}

function sampleItems<T>(items: T[], count: number) {
  return [...items].sort(() => Math.random() - 0.5).slice(0, count);
}

function buildPracticePayload(questions: QuestionCard[]) {
  return questions
    .map((question) => {
      const base = `${PART_LABELS[question.part]}: ${stripQuestionNumber(question.questionText)}`;
      if (question.prompts.length === 0) {
        return base;
      }
      return `${base}\nYou should say:\n${question.prompts.map((prompt) => `- ${prompt}`).join('\n')}`;
    })
    .join('\n\n');
}

function groupTopicCards(cards: QuestionCard[]) {
  const groups = new Map<number, { key: string; title: string; questions: QuestionCard[] }>();
  cards.forEach((card) => {
    const existing = groups.get(card.sourceIndex);
    if (existing) {
      existing.questions.push(card);
      return;
    }
    groups.set(card.sourceIndex, {
      key: `${card.part}-topic-${card.sourceIndex}`,
      title: card.title,
      questions: [card],
    });
  });
  return [...groups.values()];
}

function mockStatusLabel(status: MockStatus, t: (key: TranslationKey) => string) {
  switch (status) {
    case 'recording':
      return t('common.recording');
    case 'prep':
      return t('common.preparing');
    case 'ready':
      return t('common.ready');
    case 'processing':
      return t('common.processing');
    case 'complete':
      return t('common.complete');
    default:
      return t('common.standby');
  }
}

function practiceStatusLabel(status: PracticeStatus, t: (key: TranslationKey) => string) {
  switch (status) {
    case 'recording':
      return t('common.recording');
    case 'paused':
      return t('common.paused');
    case 'ready':
      return t('common.ready');
    case 'processing':
      return t('common.analyzingStatus');
    case 'complete':
      return t('common.complete');
    default:
      return t('common.standby');
  }
}

function formatClock(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function formatUsername(username: string) {
  return username || '未登录';
}

function formatHistoryDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value || '—';
  }
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

function formatHistoryQuestion(item: PracticeHistoryRecord) {
  const question = displayQuestion(item.question_text ?? '');
  if (!item.part) {
    return question;
  }
  const part = item.part
    .replace(/^part/i, 'Part ')
    .replace(/^full_test$/i, 'Mock Test');
  return `${part}: ${question}`;
}

function getRewardSourceId(payload: Record<string, unknown>, activityType: RewardActivityType) {
  const record = asRecord(payload.record);
  const analysis = asRecord(payload.analysis);
  const report = asRecord(payload.report);
  return textValue(
    firstKnownValueDeep([record, analysis, report, payload], ['id', 'record_id', 'recordId']),
    `${activityType}-${Date.now()}`,
  );
}

function getRecentDateKeys(count: number) {
  const today = new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (count - index - 1));
    return toDateKey(date);
  });
}

function getClientDateKey() {
  return toDateKey(new Date());
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatWeekday(dateKey: string, locale: AppLocale) {
  const date = new Date(`${dateKey}T12:00:00`);
  return new Intl.DateTimeFormat(toIntlLocale(locale), { weekday: 'short' }).format(date);
}

function getWeekdayLabels(locale: AppLocale) {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(2026, 8, 20 + index);
    return new Intl.DateTimeFormat(toIntlLocale(locale), { weekday: 'short' }).format(date);
  });
}

function toIntlLocale(locale: AppLocale) {
  return locale === 'zh' ? 'zh-CN' : locale;
}

async function copyTextToClipboard(text: string) {
  const clipboard = (globalThis as {
    navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } };
  }).navigator?.clipboard;

  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }

  Clipboard.setString(text);
}

function collectImprovementAdvice(value: unknown) {
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }

  const record = asRecord(source);
  const items = Array.isArray(source)
    ? source
    : Array.isArray(record?.pause_sentence_feedback)
      ? record.pause_sentence_feedback
      : Array.isArray(record?.feedback)
        ? record.feedback
        : [];

  return items
    .map((item): ImprovementAdviceRow | null => {
      const itemRecord = asRecord(item);
      if (!itemRecord) {
        return null;
      }

      const originalSentence = textValue(
        firstKnownValue([itemRecord], ['original_sentence', 'originalSentence', 'sentence', 'sentence_text']),
      );
      const improvedSentence = textValue(
        firstKnownValue([itemRecord], ['improved_sentence', 'improvedSentence', 'correction', 'corrected_sentence']),
      );
      const examinerAdvice = textValue(
        firstKnownValue([itemRecord], ['examiner_advice', 'examinerAdvice', 'advice', 'explanation']),
      );

      if (!originalSentence && !improvedSentence && !examinerAdvice) {
        return null;
      }

      return { originalSentence, improvedSentence, examinerAdvice };
    })
    .filter((item): item is ImprovementAdviceRow => item !== null);
}

function collectGrammarErrors(records: (Record<string, unknown> | null)[]) {
  const rows: GrammarErrorRow[] = [];
  const seen = new Set<string>();

  const appendItems = (value: unknown) => {
    const direct = Array.isArray(value) ? value : null;
    const nested = asRecord(value);
    const items =
      direct ??
      (Array.isArray(nested?.grammar_errors)
        ? nested?.grammar_errors
        : Array.isArray(nested?.grammarErrors)
          ? nested?.grammarErrors
          : Array.isArray(nested?.grammar_error_table)
            ? nested?.grammar_error_table
            : Array.isArray(nested?.error_examples)
              ? nested?.error_examples
              : null);

    if (!items) {
      return;
    }

    items.forEach((item, index) => {
      const row = normalizeGrammarError(item, index);
      if (!row) {
        return;
      }
      const dedupeKey = `${row.sentence}|${row.error}|${row.correction}`;
      if (seen.has(dedupeKey)) {
        return;
      }
      seen.add(dedupeKey);
      rows.push(row);
    });
  };

  records.forEach((record) => {
    if (!record) {
      return;
    }
    appendItems(record.grammar_errors);
    appendItems(record.grammarErrors);
    appendItems(record.grammar_error_report);
    appendItems(record.grammarErrorReport);
    appendItems(record.grammar_error_table);
    appendItems(record.error_examples);
    appendItems(record.errorExamples);
  });

  return rows;
}

function normalizeGrammarError(value: unknown, fallbackIndex: number): GrammarErrorRow | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const sentence = textValue(
    firstKnownValue([record], ['original_sentence', 'originalSentence', 'sentence', 'sentence_text', 'text']),
  );
  const error = textValue(
    firstKnownValue([record], ['grammar_error', 'grammarError', 'error', 'issue']),
  );
  const correction = textValue(
    firstKnownValue([record], ['correction', 'corrected_sentence', 'correctedSentence', 'improved_sentence', 'improvedSentence']),
  );
  const explanation = textValue(firstKnownValue([record], ['explanation', 'analysis', 'reason']));

  if (!sentence && !error && !correction) {
    return null;
  }

  return {
    sentenceIndex: textValue(firstKnownValue([record], ['sentence_index', 'sentenceIndex', 'index']), `${fallbackIndex + 1}`),
    sentence,
    errorType: textValue(firstKnownValue([record], ['error_type', 'errorType', 'type'])),
    error,
    correction,
    explanation,
  };
}

function extractAudioUri(...records: (Record<string, unknown> | null)[]) {
  const audioKeys = [
    'recording_uri',
    'recordingUri',
    'audio_url',
    'audioUrl',
    'audio_path',
    'audioPath',
    'file_url',
    'fileUrl',
  ];
  const value = firstKnownValue(records, audioKeys) ?? firstKnownValueDeep(records, audioKeys);
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }
  const uri = value.trim();
  if (/^(?:https?:|file:|content:|blob:)/i.test(uri)) {
    return uri;
  }
  return `${ACCOUNT_API_BASE_URL}${uri.startsWith('/') ? '' : '/'}${uri}`;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === 'object') {
    const candidate = error as {
      message?: unknown;
      detail?: unknown;
      error?: { message?: unknown } | unknown;
      nativeError?: { message?: unknown };
    };
    const nestedMessage =
      candidate.message ??
      candidate.detail ??
      candidate.nativeError?.message ??
      (candidate.error && typeof candidate.error === 'object'
        ? (candidate.error as { message?: unknown }).message
        : candidate.error);
    if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
      return nestedMessage.trim();
    }
  }
  const stringified = String(error ?? '').trim();
  if (stringified && stringified !== '[object Object]') {
    return stringified;
  }
  return '';
}

function getLocalizedLoginError(
  error: unknown,
  mode: 'phone' | 'google' | 'legacy',
  t: (key: TranslationKey) => string,
) {
  const message = getErrorMessage(error);
  const normalized = message.toLowerCase();

  if (mode === 'phone') {
    if (
      normalized.includes('蜂窝') ||
      normalized.includes('网络使用权限') ||
      normalized.includes('network permission') ||
      normalized.includes('cellular') ||
      normalized.includes('当前设备不支持') ||
      normalized.includes('not available') ||
      normalized.includes('运营商')
    ) {
      return t('login.phoneUnavailable');
    }
    if (normalized.includes('超时') || normalized.includes('timeout')) {
      return t('login.phoneTimeout');
    }
    if (normalized.includes('取消') || normalized.includes('cancel')) {
      return t('login.loginCancelled');
    }
    if (normalized.includes('原生模块') || normalized.includes('development build') || normalized.includes('native module')) {
      return t('login.nativeModuleUnavailable');
    }
    if (normalized.includes('网络') || normalized.includes('network')) {
      return t('login.networkFailed');
    }
    return t('login.phoneFailed');
  }

  if (mode === 'google') {
    if (normalized.includes('取消') || normalized.includes('cancel')) {
      return t('login.googleCancelled');
    }
    if (normalized.includes('配置') || normalized.includes('config') || normalized.includes('client id')) {
      return t('login.googleConfig');
    }
    if (normalized.includes('网络') || normalized.includes('network')) {
      return t('login.networkFailed');
    }
    if (/\bhttp\s+404\b/.test(normalized) || normalized.includes('接口不存在')) {
      return `${t('login.googleFailed')} ${message}`;
    }
    if (/\bhttp\s+[45]\d{2}\b/.test(normalized) && message) {
      return `${t('login.googleFailed')} ${message}`;
    }
    return t('login.googleFailed');
  }

  if (normalized.includes('502') || normalized.includes('服务器暂时不可用') || normalized.includes('server')) {
    return t('login.serverUnavailable');
  }
  if (normalized.includes('无法解析') || normalized.includes('invalid response')) {
    return t('login.accountResponseInvalid');
  }
  if (normalized.includes('网络') || normalized.includes('network')) {
    return t('login.networkFailed');
  }
  return t('login.credentialsFailed');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstRecord(records: (Record<string, unknown> | null)[], keys: string[]) {
  const value = firstKnownValue(records, keys);
  return asRecord(value);
}

function firstKnownValue(records: (Record<string, unknown> | null)[], keys: string[]) {
  for (const record of records) {
    if (!record) {
      continue;
    }
    for (const key of keys) {
      const value = record[key];
      if (value !== undefined && value !== null && value !== '') {
        return value;
      }
    }
  }
  return undefined;
}

function firstKnownValueDeep(values: unknown[], keys: string[], depth = 0): unknown {
  if (depth > 4) {
    return undefined;
  }
  for (const value of values) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    if (Array.isArray(value)) {
      const nestedArrayValue = firstKnownValueDeep(value, keys, depth + 1);
      if (nestedArrayValue !== undefined) {
        return nestedArrayValue;
      }
      continue;
    }
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      const knownValue = record[key];
      if (knownValue !== undefined && knownValue !== null && knownValue !== '') {
        return knownValue;
      }
    }
    const nestedValue = firstKnownValueDeep(Object.values(record), keys, depth + 1);
    if (nestedValue !== undefined) {
      return nestedValue;
    }
  }
  return undefined;
}

function firstText(records: (Record<string, unknown> | null)[], keys: string[]) {
  const value = firstKnownValue(records, keys);
  return textValue(value);
}

function hasRecordContent(value: unknown) {
  return (
    value !== undefined &&
    value !== null &&
    value !== ''
  );
}

function textValue(value: unknown, fallback = '') {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? `${value}` : value.toFixed(2);
  }
  if (typeof value === 'string') {
    return value;
  }
  return fallback || compactJson(value);
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const palette = {
  bg: '#E9F8F8',
  surface: 'rgba(255,255,255,0.88)',
  surfaceStrong: '#FFFFFF',
  ink: '#16212B',
  muted: '#657179',
  hairline: '#D8E9E7',
  teal: '#004F50',
  tealDark: '#13967F',
  navy: '#20252D',
  coral: '#3a9ae4',
  amber: '#E3A636',
  greenSoft: '#DFF8EF',
  blueSoft: '#E1F3FA',
  redSoft: '#FFE7E3',
};

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: palette.bg },
  centeredScreen: { alignItems: 'center', justifyContent: 'center', gap: 12 },
  safeArea: { flex: 1, backgroundColor: palette.bg },
  scrollContent: { paddingHorizontal: 18, gap: 16 },
  tabScreen: { width: '100%' },
  tabScreenActive: { position: 'relative' },
  tabScreenInactive: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    opacity: 0,
  },
  keyboardAvoider: { flex: 1 },
  loginContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  loginPanel: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: palette.hairline,
    padding: 20,
    gap: 16,
  },
  loginTitle: { color: palette.ink, fontSize: 26, fontWeight: '900', lineHeight: 32 },
  loginSubtitle: { color: palette.muted, fontSize: 13, lineHeight: 20 },
  authModeTabs: {
    flexDirection: 'row',
    borderRadius: 8,
    backgroundColor: '#F7FBFA',
    borderWidth: 1,
    borderColor: palette.hairline,
    padding: 4,
    gap: 4,
  },
  authModeTab: {
    flex: 1,
    flexBasis: 0,
    height: 48,
    minWidth: 0,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  authModeTabActive: { backgroundColor: palette.teal },
  authModeTabText: { color: palette.muted, fontSize: 14, fontWeight: '900', textAlign: 'center', flexShrink: 1 },
  authModeTabTextActive: { color: '#FFFFFF' },
  loginField: { gap: 7 },
  loginLabel: { color: palette.ink, fontSize: 13, fontWeight: '900' },
  generatedAccountRow: { flexDirection: 'row', alignItems: 'stretch', gap: 10 },
  generatedAccountField: { flex: 1 },
  generatedAccountInput: {
    backgroundColor: '#EEF7F5',
    color: palette.teal,
  },
  generateAccountButton: {
    minWidth: 92,
    minHeight: 50,
    borderRadius: 8,
    backgroundColor: '#198484',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
  },
  generateAccountText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  loginInput: {
    minHeight: 50,
    borderRadius: 8,
    backgroundColor: '#F7FBFA',
    borderWidth: 1,
    borderColor: '#DCEBE9',
    paddingHorizontal: 14,
    color: palette.ink,
    fontSize: 16,
    fontWeight: '700',
  },
  codeRow: { flexDirection: 'row', gap: 10, alignItems: 'stretch' },
  codeInput: { flex: 1 },
  authButtonRow: { flexDirection: 'row', gap: 10, alignItems: 'stretch' },
  authActionButton: { flex: 1, paddingHorizontal: 12 },
  phoneLoginHint: {
    minHeight: 86,
    borderRadius: 8,
    backgroundColor: '#EEF7F5',
    borderWidth: 1,
    borderColor: '#DCEBE9',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 18,
  },
  phoneLoginHintText: { color: palette.tealDark, fontSize: 13, lineHeight: 20, fontWeight: '800', textAlign: 'center' },
  googleLoginHint: {
    minHeight: 86,
    borderRadius: 8,
    backgroundColor: '#F7F7F7',
    borderWidth: 1,
    borderColor: '#DADCE0',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 18,
  },
  googleLoginIcon: { color: '#4285F4', fontSize: 24, fontWeight: '900' },
  codeButton: {
    minWidth: 82,
    borderRadius: 8,
    backgroundColor: '#4fadad',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  codeButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  loginStatus: { color: palette.coral, fontSize: 13, lineHeight: 19, fontWeight: '800', textAlign: 'center' },
  loginSubmitButton: { flex: 0 },
  header: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  headerCopy: { flex: 1, minWidth: 0 },
  appName: {
    color: palette.ink,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 0,
    flexShrink: 1,
    alignSelf: 'flex-start',
  },
  headerSubtitle: {
    color: palette.muted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
    maxWidth: 270,
    flexShrink: 1,
  },
  apiBadge: {
    backgroundColor: '#4fadad',
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexShrink: 0,
  },
  apiBadgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '800' },
  errorBanner: {
    borderRadius: 8,
    backgroundColor: palette.redSoft,
    borderColor: '#FFB8AE',
    borderWidth: 1,
    padding: 14,
  },
  errorTitle: { color: '#9C2F27', fontSize: 13, fontWeight: '800' },
  errorText: { color: '#9C2F27', fontSize: 13, lineHeight: 19, marginTop: 4 },
  screenStack: { gap: 16 },
  mockHero: {
    borderRadius: 8,
    padding: 18,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.75)',
    elevation: 4,
    shadowColor: '#609D9B',
    shadowOpacity: 0.16,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
  },
  mockHeroTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 14,
    flexWrap: 'wrap',
  },
  kicker: { color: palette.tealDark, fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  mockTitle: {
    color: palette.ink,
    fontSize: 24,
    fontWeight: '900',
    lineHeight: 24,
    letterSpacing: 0,
    marginTop: 4,
  },
  statePill: {
    minWidth: 100,
    maxWidth: '100%',
    borderRadius: 18,
    backgroundColor: palette.blueSoft,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
  },
  statePillLive: { backgroundColor: palette.redSoft },
  stateDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: palette.teal },
  stateDotLive: { backgroundColor: palette.coral },
  statePillText: { color: palette.tealDark, fontSize: 11, fontWeight: '800', flexShrink: 1 },
  statePillTextLive: { color: '#AA342E' },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: '#E7F0EF',
    marginTop: 20,
  },
  progressFill: { height: '100%', borderRadius: 4, backgroundColor: palette.teal },
  mockStats: { flexDirection: 'row', gap: 10, marginTop: 14 },
  metric: {
    flex: 1,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderWidth: 1,
    borderColor: palette.hairline,
    paddingVertical: 11,
    paddingHorizontal: 10,
    minHeight: 58,
    justifyContent: 'center',
  },
  metricLabel: { color: palette.muted, fontSize: 11, fontWeight: '700' },
  metricValue: { color: palette.ink, fontSize: 17, fontWeight: '900', marginTop: 4 },
  partStrip: { flexDirection: 'row', gap: 8 },
  partChip: {
    flex: 1,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.64)',
    borderWidth: 1,
    borderColor: palette.hairline,
    padding: 12,
  },
  partChipActive: { backgroundColor: '#004F50', borderColor: '#003737' },
  partChipTitle: { color: palette.ink, fontSize: 13, fontWeight: '900' },
  partChipTitleActive: { color: '#FFFFFF' },
  partChipCaption: { color: palette.muted, fontSize: 11, fontWeight: '700', marginTop: 3 },
  partChipCaptionActive: { color: '#BDE8E3' },
  questionPanel: {
    borderRadius: 8,
    backgroundColor: palette.surfaceStrong,
    padding: 18,
    borderWidth: 1,
    borderColor: palette.hairline,
    elevation: 3,
    shadowColor: '#b5cfce',
    shadowOpacity: 0.13,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
  },
  questionPanelHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  questionTopic: { color: palette.ink, fontSize: 16, fontWeight: '800', marginTop: 4, maxWidth: 220 },
  readButton: {
    minHeight: 38,
    borderRadius: 19,
    backgroundColor: palette.blueSoft,
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  readButtonText: { color: '#0e3c49', fontSize: 12, fontWeight: '800' },
  buttonDisabled: { opacity: 0.55 },
  questionText: {
    color: palette.ink,
    fontSize: 18,
    lineHeight: 20,
    fontWeight: '800',
    letterSpacing: 0,
    marginTop: 16,
  },
  Notes: {
    textAlign: 'center',
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '800',
    color: '#003737',
    letterSpacing: 0,
    alignSelf: 'center', // 确保在 Flex 容器中水平居中
  },
  cardContainer: {
    width: '100%',
    marginVertical: 10,
  },
  // 实体卡片控制背景、内边距和圆角
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    minHeight: 180, // 给定固定或最小高度，防止翻转时因两面高度不一致导致抖动
    justifyContent: 'center',
    alignItems: 'center',
  },
  promptBox: {
    marginTop: 18,
    borderRadius: 8,
    backgroundColor: palette.greenSoft,
    borderLeftWidth: 4,
    borderLeftColor: palette.teal,
    padding: 14,
    gap: 8,
  },
  promptTitle: { color: palette.tealDark, fontSize: 13, fontWeight: '900' },
  promptText: { color: palette.ink, fontSize: 15, lineHeight: 21, fontWeight: '600' },
  prepPanel: {
    borderRadius: 8,
    backgroundColor: '#4fadad',
    padding: 20,
    alignItems: 'center',
    gap: 10,
  },
  part2TimerPanel: {
    borderRadius: 8,
    backgroundColor: '#198484',
    padding: 20,
    alignItems: 'center',
    gap: 10,
  },
  prepTimer: { color: '#FFFFFF', fontSize: 42, lineHeight: 48, fontWeight: '900', letterSpacing: 0 },
  prepTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: '900' },
  prepText: { color: '#C8F0EA', fontSize: 13, lineHeight: 19, textAlign: 'center' },
  controlPanel: {
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.78)',
    borderWidth: 1,
    borderColor: palette.hairline,
    padding: 16,
    gap: 12,
  },
  controlHint: { color: palette.muted, fontSize: 11, lineHeight: 19, textAlign: 'center' , marginBottom: 10,},
  controlRow: { flexDirection: 'row', gap: 10 },
  controlColumn: { gap: 10 },
  primaryButton: {
    minHeight: 50,
    borderRadius: 25,
    backgroundColor: '#198484',
    borderColor: '#004F50',
    paddingHorizontal: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '900' },
  secondaryButton: {
    flex: 1,
    minHeight: 50,
    borderRadius: 25,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: palette.hairline,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { color: palette.ink, fontSize: 15, fontWeight: '900' },
  dangerButton: {
    flex: 1,
    minHeight: 50,
    borderRadius: 25,
    backgroundColor: palette.coral,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '900' },
  practiceMeter: { flexDirection: 'row', gap: 10 },
  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  backButton: {
    minWidth: 58,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: palette.hairline,
  },
  backButtonText: { color: palette.ink, fontSize: 13, fontWeight: '900' },
  detailHeaderText: { flex: 1 },
  detailTitle: { color: palette.ink, fontSize: 20, fontWeight: '900', lineHeight: 25, marginTop: 2 },
  sectionPanel: {
    borderRadius: 8,
    backgroundColor: palette.surface,
    padding: 18,
    borderWidth: 1,
    borderColor: palette.hairline,
  },
  sectionTitle: { color: palette.ink, fontSize: 24, fontWeight: '900', lineHeight: 30, marginTop: 4 },
  sectionText: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 8 },
  segmented: { flexDirection: 'row', gap: 8, marginTop: 16 },
  segmentButton: {
    flex: 1,
    minHeight: 56,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: palette.hairline,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  segmentButtonActive: { backgroundColor: palette.teal, borderColor: palette.teal },
  segmentText: { color: palette.ink, fontSize: 13, fontWeight: '900' },
  segmentTextActive: { color: '#FFFFFF' },
  segmentCount: { color: palette.muted, fontSize: 11, fontWeight: '800', marginTop: 3 },
  cardGrid: { gap: 12 },
  topicCarousel: { gap: 12, paddingRight: 18 },
  topicCard: {
    width: 280,
    borderRadius: 8,
    backgroundColor: palette.surfaceStrong,
    borderWidth: 1,
    borderColor: palette.hairline,
    padding: 16,
    minHeight: 250,
    elevation: 2,
    shadowColor: '#719998',
    shadowOpacity: 0.11,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  questionCard: {
    borderRadius: 8,
    backgroundColor: palette.surfaceStrong,
    borderWidth: 1,
    borderColor: palette.hairline,
    padding: 16,
    minHeight: 154,
    elevation: 2,
    shadowColor: '#719998',
    shadowOpacity: 0.11,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  questionCardHidden: {
    backgroundColor: '#4fadad',
    borderColor: '#4fadad',
  },
  questionCardPressed: { opacity: 0.76, transform: [{ scale: 0.995 }] },
  cardHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardPart: { color: palette.tealDark, fontSize: 11, fontWeight: '900', textTransform: 'uppercase' },
  cardIndex: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: palette.blueSoft,
    color: '#1D7F9A',
    fontSize: 12,
    fontWeight: '900',
    textAlign: 'center',
    lineHeight: 28,
  },
  cardTitle: { color: palette.ink, fontSize: 18, lineHeight: 23, fontWeight: '900', marginTop: 10 },
  cardQuestion: { color: palette.muted, fontSize: 14, lineHeight: 20, marginTop: 8 },
  cardFlipFace: {
    flex: 1,
    minHeight: 92,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
  cardFlipTitle: { color: '#FFFFFF', fontSize: 18, lineHeight: 24, fontWeight: '900', textAlign: 'center' },
  cardPromptList: {
    marginTop: 10,
    gap: 6,
  },
  cardPromptText: { color: palette.ink, fontSize: 13, lineHeight: 19, fontWeight: '700' },
  cardPromptCount: { color: palette.amber, fontSize: 12, fontWeight: '900', marginTop: 12 },
  reportPanel: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: palette.hairline,
    padding: 16,
    gap: 14,
  },
  reportTitle: { color: palette.ink, fontSize: 21, fontWeight: '900' },
  scoreGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  scoreTile: { minWidth: '47%', flexGrow: 1, borderRadius: 8, backgroundColor: palette.blueSoft, padding: 13 },
  scoreTileHighlight: { backgroundColor: palette.navy },
  scoreLabel: { color: '#246D86', fontSize: 11, fontWeight: '900' },
  scoreLabelHighlight: { color: '#BAF2E9' },
  scoreValue: { color: palette.ink, fontSize: 22, fontWeight: '900', marginTop: 4 },
  scoreValueHighlight: { color: '#FFFFFF' },
  reportSection: {
    borderRadius: 8,
    backgroundColor: '#F7FBFA',
    padding: 13,
    borderWidth: 1,
    borderColor: '#E5F0EF',
  },
  reportSectionTitle: {
    color: palette.tealDark,
    fontSize: 12,
    fontWeight: '900',
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  reportBody: { color: palette.ink, fontSize: 13, lineHeight: 20 },
  grammarTable: {
    gap: 10,
  },
  grammarCard: {
    width: '100%',
    borderWidth: 1,
    borderColor: '#DDEBEA',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 12,
    gap: 10,
  },
  grammarCardTitle: {
    color: '#246D86',
    fontSize: 11,
    fontWeight: '900',
    textAlign: 'left',
  },
  grammarStackItem: {
    width: '100%',
    gap: 4,
  },
  grammarStackLabel: {
    color: '#246D86',
    fontSize: 10,
    fontWeight: '900',
    textAlign: 'left',
    textTransform: 'uppercase',
  },
  grammarStackValue: {
    width: '100%',
    textAlign: 'left',
  },
  grammarSentence: { color: palette.ink, fontSize: 12, lineHeight: 18, fontWeight: '800', textAlign: 'left' },
  grammarCorrection: { color: palette.tealDark, fontSize: 12, lineHeight: 18, fontWeight: '800', textAlign: 'left' },
  grammarMeta: { color: palette.muted, fontSize: 11, lineHeight: 16, marginTop: 0, textAlign: 'left' },
  audioPlayback: {
    borderRadius: 8,
    backgroundColor: '#F7FBFA',
    padding: 13,
    borderWidth: 1,
    borderColor: '#E5F0EF',
    gap: 8,
  },
  audioPlaybackHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  audioPlaybackTime: { color: palette.muted, fontSize: 12, fontWeight: '800' },
  audioPlaybackError: { color: '#9C2F27', fontSize: 12, lineHeight: 18 },
  playButton: {
    minWidth: 72,
    minHeight: 38,
    borderRadius: 19,
    backgroundColor: '#4fadad',
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  profilePanel: {
    position: 'relative',
    gap: 18,
  },
  profileHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  profileAccountRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  profileAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    flexShrink: 0,
  },
  profilePhone: { flex: 1, color: palette.muted, fontSize: 13, fontWeight: '800' },
  profileCopyButton: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#F7FBFA',
    borderWidth: 1,
    borderColor: palette.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileActions: {
    flexDirection: 'row',
    flexShrink: 0,
    gap: 8,
  },
  profileIconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: palette.hairline,
  },
  profileStats: {
    flexDirection: 'row',
    gap: 8,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: palette.hairline,
    paddingVertical: 14,
    paddingHorizontal: 8,
  },
  profileMetric: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRightWidth: 1,
    borderRadius: 0,
    borderColor: palette.hairline,
    paddingVertical: 0,
    paddingHorizontal: 8,
    minHeight: 48,
    alignItems: 'center',
  },
  profileMetricLabel: { fontSize: 11, color: palette.muted },
  profileMetricValue: { fontSize: 20, marginTop: 5 },
  profileToast: {
    position: 'absolute',
    left: 18,
    right: 18,
    bottom: 16,
    minHeight: 38,
    borderRadius: 8,
    backgroundColor: 'rgba(22,33,43,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  profileToastText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  refreshButton: {
    position: 'absolute',
    right: 16,
    top: 16,
    height: 36,
    borderRadius: 18,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#4fadad',
  },
  refreshButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  recentSection: { gap: 12 },
  recentTitle: { color: palette.ink, fontSize: 18, fontWeight: '900' },
  emptyPanel: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: palette.hairline,
    padding: 18,
  },
  emptyTitle: { color: palette.ink, fontSize: 18, fontWeight: '900' },
  emptyText: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 6 },
  historyCard: {
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: palette.hairline,
    overflow: 'hidden',
  },
  historyCardBody: { padding: 15, gap: 9 },
  historyCardPressed: { opacity: 0.82 },
  historyTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  historyMode: { borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  historyModeMock: { backgroundColor: palette.blueSoft },
  historyModePractice: { backgroundColor: palette.greenSoft },
  historyModeText: { color: palette.tealDark, fontSize: 11, fontWeight: '900' },
  historyDate: {
    color: palette.muted,
    fontSize: 11,
    fontWeight: '700',
    flexShrink: 1,
    textAlign: 'right',
  },
  historyTitle: { color: palette.ink, fontSize: 17, fontWeight: '900', lineHeight: 22 },
  historyQuestion: { color: palette.muted, fontSize: 13, lineHeight: 19 },
  historyFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: palette.hairline,
    paddingHorizontal: 15,
    paddingVertical: 11,
  },
  historyMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  historyMeta: {
    color: '#246D86',
    backgroundColor: palette.blueSoft,
    borderRadius: 13,
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 5,
    fontSize: 11,
    fontWeight: '800',
  },
  historyDetailsButton: {
    minHeight: 30,
    borderRadius: 15,
    backgroundColor: palette.navy,
    paddingHorizontal: 11,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  historyDetailsText: { color: '#FFFFFF', fontSize: 11, fontWeight: '900' },
  historyDetail: {
    borderTopWidth: 1,
    borderTopColor: palette.hairline,
    paddingTop: 12,
    gap: 12,
  },
  historyDetailTitle: { color: palette.ink, fontSize: 14, fontWeight: '900' },
  loadingCard: {
    minHeight: 120,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: palette.hairline,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: { color: palette.muted, fontSize: 13, fontWeight: '700' },
  loadingInline: {
    minHeight: 58,
    justifyContent: 'center',
    gap: 9,
    width: '100%',
  },
  loadingInlineHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
  loadingInlinePercent: { color: palette.tealDark, fontSize: 12, fontWeight: '900' },
  loadingInlineText: { color: palette.tealDark, fontSize: 12, fontWeight: '900' },
  loadingProgressTrack: {
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: '#DDEBEA',
  },
  loadingProgressFill: { height: '100%', borderRadius: 4, backgroundColor: palette.teal },
  rewardSection: {
    gap: 12,
    marginTop: 4,
  },
  rewardSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  rewardSectionTitle: { color: palette.ink, fontSize: 18, lineHeight: 24, fontWeight: '900' },
  rewardStoreButton: {
    minHeight: 36,
    borderRadius: 18,
    backgroundColor: palette.navy,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  rewardStoreButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
  weekCalendarPanel: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: palette.hairline,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  weekCalendarHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  weekCalendarTitle: { color: palette.ink, fontSize: 14, fontWeight: '900' },
  weekCalendarHint: { color: palette.tealDark, fontSize: 11, fontWeight: '800' },
  weekCalendarRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 4 },
  dayCell: { flex: 1, alignItems: 'center', minWidth: 0 },
  dayCellLabel: { color: palette.muted, fontSize: 10, fontWeight: '800' },
  dayCellMark: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#F1F7F6',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 6,
  },
  dayCellMarkChecked: { backgroundColor: palette.teal },
  dayCellMarkToday: { borderWidth: 2, borderColor: palette.teal },
  dayCellMarkText: { color: palette.muted, fontSize: 11, fontWeight: '900' },
  dayCellMarkTextChecked: { color: '#FFFFFF' },
  dayCellToday: { color: palette.tealDark, fontSize: 9, fontWeight: '900', height: 13, marginTop: 3 },
  pointsPanel: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: palette.hairline,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  pointsCopy: { flex: 1, minWidth: 0 },
  pointsValue: { color: palette.ink, fontSize: 14, fontWeight: '900' },
  pointsDivider: { width: 1, height: 28, backgroundColor: palette.hairline, marginHorizontal: 14 },
  streakBadge: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-start',
  },
  streakLine: { color: palette.ink, fontSize: 14, fontWeight: '900' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(10, 27, 31, 0.58)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 18,
  },
  profileMenuCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 16,
    gap: 8,
    elevation: 12,
    shadowColor: '#071B22',
    shadowOpacity: 0.22,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
  },
  profileMenuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  profileMenuTitle: { color: palette.ink, fontSize: 18, fontWeight: '900' },
  languageSection: { gap: 8, paddingVertical: 8 },
  languageTitle: { color: palette.ink, fontSize: 14, fontWeight: '900' },
  languageHint: { color: palette.muted, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  languageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  languageOption: {
    minHeight: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: palette.hairline,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  languageOptionActive: { backgroundColor: palette.teal, borderColor: palette.teal },
  languageOptionText: { color: palette.ink, fontSize: 12, fontWeight: '800' },
  languageOptionTextActive: { color: '#FFFFFF' },
  languageRowActive: { backgroundColor: palette.teal },
  modalIconButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F0F6F5',
  },
  profileMenuRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 6,
    paddingHorizontal: 12,
  },
  profileMenuRowText: { color: palette.ink, fontSize: 14, fontWeight: '800' },
  profileMenuValue: { flex: 1, color: palette.muted, fontSize: 12, fontWeight: '700', textAlign: 'right' },
  profileMenuDanger: { backgroundColor: palette.redSoft },
  profileMenuDangerText: { color: '#9C2F27', fontSize: 14, fontWeight: '800' },
  profileMenuDelete: { borderWidth: 1, borderColor: '#E7B4AF' },
  profileMenuDeleteText: { color: '#9C2F27', fontSize: 14, fontWeight: '900' },
  aboutCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 18,
    gap: 12,
    elevation: 12,
    shadowColor: '#071B22',
    shadowOpacity: 0.22,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
  },
  aboutText: { color: palette.ink, fontSize: 15, fontWeight: '800' },
  aboutLabel: { color: palette.muted, fontSize: 11, fontWeight: '800' },
  aboutLinkButton: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 6,
    backgroundColor: palette.greenSoft,
    paddingHorizontal: 12,
  },
  aboutLink: { color: palette.teal, fontSize: 14, fontWeight: '900' },
  aboutCloseButton: {
    minHeight: 42,
    borderRadius: 21,
    backgroundColor: palette.navy,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aboutCloseText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  calendarModalCard: {
    width: '100%',
    maxWidth: 460,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    padding: 18,
    gap: 16,
    elevation: 12,
    shadowColor: '#071B22',
    shadowOpacity: 0.22,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
  },
  modalHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  modalTitle: { color: palette.ink, fontSize: 22, fontWeight: '900', marginTop: 3 },
  modalCloseButton: {
    minHeight: 34,
    borderRadius: 17,
    paddingHorizontal: 12,
    backgroundColor: '#F0F6F5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCloseText: { color: palette.tealDark, fontSize: 11, fontWeight: '900' },
  monthWeekdayRow: { flexDirection: 'row', justifyContent: 'space-between' },
  monthWeekday: { flex: 1, color: palette.muted, fontSize: 11, fontWeight: '900', textAlign: 'center' },
  monthGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 10 },
  monthCell: { width: '14.2857%', alignItems: 'center', minHeight: 34 },
  monthDay: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthDayChecked: { backgroundColor: palette.teal },
  monthDayToday: { borderWidth: 2, borderColor: palette.teal },
  monthDayText: { color: palette.ink, fontSize: 11, fontWeight: '800' },
  monthDayTextChecked: { color: '#FFFFFF' },
  calendarLegend: { flexDirection: 'row', gap: 16, alignItems: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 9, height: 9, borderRadius: 5 },
  legendDotChecked: { backgroundColor: palette.teal },
  legendDotToday: { borderWidth: 2, borderColor: palette.teal },
  legendText: { color: palette.muted, fontSize: 11, fontWeight: '700' },
  modalStoreButton: {
    minHeight: 46,
    borderRadius: 23,
    backgroundColor: palette.teal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalStoreButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '900' },
  bottomBarWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 10,
    backgroundColor: 'rgba(233,248,248,0.94)',
  },
  bottomBar: {
    minHeight: 74,
    borderRadius: 30,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: palette.hairline,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    gap: 6,
    elevation: 8,
    shadowColor: '#719998',
    shadowOpacity: 0.18,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
  },
  bottomItem: {
    flex: 1,
    minHeight: 58,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  bottomGuideZone: { flex: 1 },
  bottomItemActive: { backgroundColor: '#4fadad' },
  bottomMark: {
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    paddingHorizontal: 5,
    backgroundColor: palette.blueSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomMarkActive: { backgroundColor: palette.teal },
  bottomMarkText: { color: '#1D7F9A', fontSize: 10, fontWeight: '900' },
  bottomMarkTextActive: { color: '#FFFFFF' },
  bottomLabel: { color: palette.ink, fontSize: 12, fontWeight: '900', marginTop: 4 },
  bottomLabelActive: { color: '#FFFFFF' },
  bottomCaption: { color: palette.muted, fontSize: 10, fontWeight: '700', marginTop: 1 },
  bottomCaptionActive: { color: '#BDE8E3' },
  pressed: { opacity: 0.72 },
});
