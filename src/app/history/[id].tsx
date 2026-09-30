import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
} from 'expo-audio';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '@/i18n';

import {
  displayQuestion,
  fetchPracticeHistory,
  formatDate,
  formatDuration,
  type PracticeHistoryRecord,
} from '@/lib/ielts';
import { ACCOUNT_API_BASE_URL } from '@/lib/config';

type ReportType = 'report' | 'analysis';
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

export default function HistoryDetailScreen() {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const historyId = Array.isArray(params.id) ? params.id[0] : params.id;
  const [item, setItem] = useState<PracticeHistoryRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadRecord() {
      if (!historyId) {
        setLoading(false);
        setErrorMessage(t('history.missingId'));
        return;
      }

      setLoading(true);
      setErrorMessage(null);
      try {
        const records = await fetchPracticeHistory();
        const nextItem = records.find((record) => record.id === historyId) ?? null;
        if (isMounted) {
          setItem(nextItem);
          if (!nextItem) {
            setErrorMessage(t('history.notFound'));
          }
        }
      } catch (error) {
        if (isMounted) {
          setErrorMessage(getErrorMessage(error));
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    void loadRecord();
    return () => {
      isMounted = false;
    };
  }, [historyId, t]);

  const reportData = useMemo<Record<string, unknown> | null>(() => {
    if (!item) {
      return null;
    }
    const payload = item.report ?? item.analysis;
    const record = asRecord(payload) ?? (payload ? { analysis: payload } : {});
    return {
      ...record,
      recording_uri: item.recording_uri ?? record.recording_uri,
      recordingUri: item.recordingUri ?? record.recordingUri,
      audio_url: item.audio_url ?? record.audio_url,
      audioUrl: item.audioUrl ?? record.audioUrl,
      audio_path: item.audio_path ?? record.audio_path,
      audioPath: item.audioPath ?? record.audioPath,
      file_url: item.file_url ?? record.file_url,
      fileUrl: item.fileUrl ?? record.fileUrl,
    };
  }, [item]);

  const reportType: ReportType = item?.mode === 'mock_test' ? 'report' : 'analysis';
  const audioUri = item && reportData ? extractAudioUri(item, reportData, asRecord(reportData.analysis)) : '';

  return (
    <View style={styles.app}>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.safeArea} edges={['left', 'right']}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingTop: Math.max(insets.top, 16), paddingBottom: insets.bottom + 28 },
          ]}>
          <View style={styles.detailHeader}>
            <Pressable style={({ pressed }) => [styles.backButton, pressed && styles.pressed]} onPress={() => router.back()}>
              <Text style={styles.backButtonText}>{t('common.back')}</Text>
            </Pressable>
            <View style={styles.detailHeaderText}>
              <Text style={styles.kicker}>{t('history.title')}</Text>
              <Text style={styles.detailTitle}>{item?.topic || item?.part || ''}</Text>
            </View>
          </View>

          {loading ? (
            <View style={styles.loadingCard}>
              <ActivityIndicator color={palette.teal} />
              <Text style={styles.loadingText}>{t('history.loading')}</Text>
            </View>
          ) : null}

          {errorMessage ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorTitle}>{t('common.notice')}</Text>
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : null}

          {item ? (
            <View style={styles.summaryPanel}>
              <View style={styles.historyTop}>
                <View style={[styles.historyMode, item.mode === 'mock_test' ? styles.historyModeMock : styles.historyModePractice]}>
                  <Text style={styles.historyModeText}>{item.mode === 'mock_test' ? 'Mock' : 'Practice'}</Text>
                </View>
                <Text style={styles.historyDate}>{formatDate(item.created_at)}</Text>
              </View>
              {item.question_text ? (
                <Text style={styles.historyQuestion}>
                  {displayQuestion(item.question_text)}
                </Text>
              ) : null}
            </View>
          ) : null}

          {reportData ? (
            <ReportCard
              title={item?.mode === 'mock_test' ? t('history.mockReport') : t('history.practiceReport')}
              data={reportData}
              type={reportType}
              showMissingAudio={!audioUri}
            />
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function ReportCard({
  title,
  data,
  type,
  showMissingAudio = false,
}: {
  title: string;
  data: Record<string, unknown>;
  type: ReportType;
  showMissingAudio?: boolean;
}) {
  return (
    <View style={styles.reportPanel}>
      <Text style={styles.reportTitle}>{title}</Text>
      <ReportContent data={data} type={type} showMissingAudio={showMissingAudio} />
    </View>
  );
}

function ReportContent({
  data,
  type,
  showMissingAudio,
}: {
  data: Record<string, unknown>;
  type: ReportType;
  showMissingAudio: boolean;
}) {
  const { t } = useI18n();
  const analysisRecord = asRecord(data.analysis);
  const pauseAnalysis = asRecord(data.pause_analysis);
  const audioUri = extractAudioUri(data, analysisRecord);
  const transcriptionRecord = firstRecord([data, analysisRecord], ['transcription', 'transcript_result']);
  const fluencyFeatures = firstRecord([data, analysisRecord, pauseAnalysis], ['fluency_features_6d']);
  const speakingRate =
    typeof fluencyFeatures?.speaking_rate_wpm === 'number'
      ? fluencyFeatures.speaking_rate_wpm
      : undefined;
  const pauseCountFromFeatures = fluencyFeatures
    ? Number(fluencyFeatures.mid_pause_100_200 ?? 0) +
      Number(fluencyFeatures.mid_pause_200_500 ?? 0) +
      Number(fluencyFeatures.mid_pause_gt_500 ?? 0) +
      Number(fluencyFeatures.filler_pause_100_250 ?? 0) +
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
    ['pause_sentence_advice', 'pauseSentenceAdvice', 'pause_advice', 'pauseAdvice', 'pause_sentence_feedback'],
  );
  const deepseekAnalysis = firstRecord([data, analysisRecord, pauseAnalysis], ['deepseek_detailed_analysis']);
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
          <ScoreTile label="Pronunciation" value={textValue(firstKnownValue([subScores, data, analysisRecord], ['fluency_and_coherence', 'pronunciation_score']), 'N/A')} />
          <ScoreTile label="Fluency" value={textValue(firstKnownValue([subScores, data, analysisRecord], ['fluency_and_coherence', 'fluency']), 'N/A')} />
          <ScoreTile label="Lexical" value={textValue(firstKnownValue([subScores, data, analysisRecord], ['lexical_resource', 'lexical']), 'N/A')} />
          <ScoreTile label="Grammar" value={textValue(firstKnownValue([subScores, data, analysisRecord], ['grammatical_range_accuracy', 'grammar']), 'N/A')} />
          <ScoreTile label="Overall" value={textValue(firstKnownValue([data, analysisRecord], ['overall_band', 'overallBand', 'band_score', 'score']), 'N/A')} highlight />
        </View>
      ) : null}

      {type === 'analysis' || hasFluencyMetrics ? (
        <View style={styles.scoreGrid}>
          <ScoreTile label="Words/min" value={textValue(speakingRate, 'N/A')} highlight />
          <ScoreTile label="Pauses" value={textValue(pauseCountValue, '0')} />
          <ScoreTile label="Sentences" value={Array.isArray(sentences) ? `${sentences.length}` : '0'} />
        </View>
      ) : null}

      {audioUri ? (
        <RecordingPlayback uri={audioUri} />
      ) : showMissingAudio ? (
        <View style={styles.reportSection}>
          <Text style={styles.reportSectionTitle}>{t('history.recordingPlayback')}</Text>
          <Text style={styles.reportBody}>{t('history.missingAudio')}</Text>
        </View>
      ) : null}

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
          <Text style={styles.playButtonText}>{status.playing ? t('history.pause') : t('history.play')}</Text>
        </Pressable>
      </View>
      {playbackError ? <Text style={styles.audioPlaybackError}>{playbackError}</Text> : null}
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
  return value !== undefined && value !== null && value !== '';
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
  return error instanceof Error ? error.message : String(error);
}

const palette = {
  bg: '#E9F8F8',
  surface: 'rgba(255,255,255,0.88)',
  surfaceStrong: '#FFFFFF',
  ink: '#16212B',
  muted: '#657179',
  hairline: '#D8E9E7',
  teal: '#2BC5A4',
  tealDark: '#13967F',
  navy: '#20252D',
  greenSoft: '#DFF8EF',
  blueSoft: '#E1F3FA',
  redSoft: '#FFE7E3',
};

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: palette.bg },
  safeArea: { flex: 1, backgroundColor: palette.bg },
  scrollContent: { paddingHorizontal: 18, gap: 16 },
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
  kicker: { color: palette.tealDark, fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  detailTitle: { color: palette.ink, fontSize: 22, fontWeight: '900', lineHeight: 28, marginTop: 2 },
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
  errorBanner: {
    borderRadius: 8,
    backgroundColor: palette.redSoft,
    borderColor: '#FFB8AE',
    borderWidth: 1,
    padding: 14,
  },
  errorTitle: { color: '#9C2F27', fontSize: 13, fontWeight: '800' },
  errorText: { color: '#9C2F27', fontSize: 13, lineHeight: 19, marginTop: 4 },
  summaryPanel: {
    borderRadius: 8,
    backgroundColor: palette.surface,
    padding: 16,
    borderWidth: 1,
    borderColor: palette.hairline,
    gap: 10,
  },
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
  historyQuestion: { color: palette.ink, fontSize: 14, lineHeight: 21 },
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
  pressed: { opacity: 0.78 },
});
