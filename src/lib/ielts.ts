import { ACCOUNT_API_BASE_URL, API_BASE_URL } from '@/lib/config';
import { authFetch } from '@/lib/auth';

export { API_BASE_URL } from '@/lib/config';

export type PartKey = 'part1' | 'part2' | 'part3';

export type QuestionCard = {
  id: string;
  part: PartKey;
  title: string;
  questionText: string;
  prompts: string[];
  sourceIndex: number;
  questionIndex?: number;
  category?: string;
  related_topic?: string;
  relatedTopic?: string;
};

export type MockItem = QuestionCard & {
  mockPartLabel: 'Part 1' | 'Part 2' | 'Part 3';
};

export type PracticeHistoryRecord = {
  id: string;
  created_at: string;
  mode: string;
  part?: string;
  topic?: string;
  question_text?: string;
  audio_url?: string;
  audioUrl?: string;
  audio_path?: string;
  audioPath?: string;
  file_url?: string;
  fileUrl?: string;
  recording_uri?: string;
  recordingUri?: string;
  report?: Record<string, unknown>;
  analysis?: Record<string, unknown>;
};

export function stripQuestionNumber(text: string) {
  return text.replace(/^\s*(?:question\s*)?\d+[\).\u3001:：-]\s*/i, '').trim();
}

export function displayQuestion(text: string) {
  return stripQuestionNumber(text);
}

function ensureJsonResponse(response: Response) {
  if (!response.ok) {
    throw new Error(`请求失败：${response.status}`);
  }
  return response.json();
}

export async function fetchPartQuestions(part: PartKey): Promise<QuestionCard[]> {
  const response = await fetch(`${API_BASE_URL}/api/questions/${part}`, {
    credentials: 'include',
  });
  const raw = await ensureJsonResponse(response);
  return parsePartQuestions(part, raw);
}

export async function loadMockQuestions(): Promise<MockItem[]> {
  const [part1, part2, part3] = await Promise.all([
    fetchPartQuestions('part1'),
    fetchPartQuestions('part2'),
    fetchPartQuestions('part3'),
  ]);

  const part1Items = part1.slice(0, 4).map((item) => ({ ...item, mockPartLabel: 'Part 1' as const }));
  const selectedPart2 = part2[0];
  const part2Items = selectedPart2
    ? [{ ...selectedPart2, mockPartLabel: 'Part 2' as const }]
    : [];
  const relatedPart3 = selectedPart2
    ? part3.filter((item) => item.title === selectedPart2.title)
    : [];
  const part3Source = relatedPart3.length > 0 ? relatedPart3 : part3;
  const part3Items = part3Source
    .slice(0, 4)
    .map((item) => ({ ...item, mockPartLabel: 'Part 3' as const }));

  return [...part1Items, ...part2Items, ...part3Items];
}

export function questionPayload(items: MockItem[]) {
  return items
    .map((item) => {
      const base = `${item.mockPartLabel}: ${stripQuestionNumber(item.questionText)}`;
      if (item.prompts.length === 0) {
        return base;
      }
      return `${base}\nYou should say:\n${item.prompts.map((prompt) => `- ${prompt}`).join('\n')}`;
    })
    .join('\n\n');
}

export async function submitPartPracticeAudio(
  uri: string,
  options: { questionText: string; part: PartKey; topic: string },
  onAnalysisSuccess?: (payload: Record<string, unknown>) => void,
) {
  const questionText = stripQuestionNumber(options.questionText);
  const audioBlob = await readAudioBlob(uri);
  const analysisPayload = await uploadAudioBlob('/api/analyze-part', audioBlob, {
    question_text: questionText,
    part: options.part,
    topic: options.topic,
  }, 'file');
  onAnalysisSuccess?.(analysisPayload as Record<string, unknown>);
  const analysis = optionalRecord(analysisPayload.analysis) ?? analysisPayload;
  const scoreDetail = {
    mode: 'part_practice',
    practice_type: 'speaking',
    part: options.part,
    topic: options.topic,
    question_text: questionText,
    analysis,
  };
  const record = await savePracticeRecord(audioBlob, scoreDetail);
  return {
    record,
    analysis: {
      ...analysis,
      ...scoreDetail,
      audio_url: record.audio_url ?? record.audio_path ?? analysisPayload.audio_url,
      history_record: analysisPayload.history_record,
      record_id: record.id,
    },
  };
}

export async function submitPracticeRecordBlob(
  audioBlob: Blob,
  options: { questionText: string; part: PartKey; topic: string; scoreDetail?: Record<string, unknown> },
) {
  const questionText = stripQuestionNumber(options.questionText);
  const scoreDetail = {
    mode: 'part_practice',
    practice_type: 'speaking',
    part: options.part,
    topic: options.topic,
    question_text: questionText,
    analysis: options.scoreDetail ?? {
      status: 'stored',
      submitted_at: new Date().toISOString(),
    },
  };
  const payload = await uploadAudioBlob('/api/practice/records', audioBlob, {
    practice_type: 'speaking',
    score_detail: JSON.stringify(scoreDetail),
  }, 'audio', ACCOUNT_API_BASE_URL);
  return payload.record;
}

export async function submitMockTestAudio(
  uri: string,
  items: MockItem[],
  onAnalysisSuccess?: (payload: Record<string, unknown>) => void,
) {
  const questionText = questionPayload(items);
  const audioBlob = await readAudioBlob(uri);
  const reportPayload = await uploadAudioBlob('/api/process-audio', audioBlob, {
    question_text: questionText,
    enable_retrieve: 'true',
    part: 'full_test',
    topic: 'IELTS Mock Test',
  }, 'file');
  onAnalysisSuccess?.(reportPayload as Record<string, unknown>);
  const report = optionalRecord(reportPayload.report) ?? reportPayload;
  const scoreDetail = {
    mode: 'mock_test',
    practice_type: 'speaking',
    part: 'full_test',
    topic: 'IELTS Mock Test',
    question_text: questionText,
    report,
  };
  const record = await savePracticeRecord(audioBlob, scoreDetail);
  return {
    record,
    report: {
      ...report,
      ...scoreDetail,
      audio_url: record.audio_url ?? record.audio_path ?? reportPayload.audio_url,
      history_record: reportPayload.history_record,
      record_id: record.id,
    },
  };
}

export async function fetchPracticeHistory(): Promise<PracticeHistoryRecord[]> {
  const response = await authFetch('/api/practice/records', {}, ACCOUNT_API_BASE_URL);
  const payload = await ensureJsonResponse(response);
  return normalizePracticeHistory(payload);
}

export function formatDuration(durationMillis: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMillis / 1000));
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function parsePartQuestions(part: PartKey, raw: unknown): QuestionCard[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  if (part === 'part1') {
    return raw.flatMap((item, sourceIndex) => {
      const group = asRecord(item);
      const questions = arrayOfStrings(group.questions);
      const title = stringValue(group.category, 'Part 1');
      return questions.map((questionText, questionIndex) => ({
        id: `part1-${sourceIndex}-${questionIndex}`,
        part,
        title,
        questionText,
        prompts: [],
        sourceIndex,
        questionIndex,
        category: title,
      }));
    });
  }

  if (part === 'part2') {
    return raw.map((item, sourceIndex) => {
      const group = asRecord(item);
      const topic = stringValue(group.topic, 'Part 2 Topic');
      return {
        id: `part2-${sourceIndex}`,
        part,
        title: topic,
        questionText: topic,
        prompts: arrayOfStrings(group.prompts),
        sourceIndex,
      };
    });
  }

  return raw.flatMap((item, sourceIndex) => {
    const group = asRecord(item);
    const questions = arrayOfStrings(group.questions);
    const title = stringValue(group.related_topic, 'Part 3');
    return questions.map((questionText, questionIndex) => ({
      id: `part3-${sourceIndex}-${questionIndex}`,
      part,
      title,
      questionText,
      prompts: [],
      sourceIndex,
      questionIndex,
      related_topic: title,
      relatedTopic: title,
    }));
  });
}

export async function uploadAudioBlob(
  endpoint: string,
  audioBlob: Blob,
  fields: Record<string, string>,
  fileFieldName = 'audio',
  baseUrl = API_BASE_URL,
) {
  const formData = new FormData();
  formData.append(fileFieldName, audioBlob, `ielts-recording-${Date.now()}.m4a`);
  Object.entries(fields).forEach(([key, value]) => {
    formData.append(key, value);
  });

  const response = await authFetch(endpoint, {
    method: 'POST',
    body: formData,
  }, baseUrl);

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `上传失败：${response.status}`);
  }

  return response.json();
}

async function readAudioBlob(uri: string) {
  const audioResponse = await fetch(uri);

  if (!audioResponse.ok) {
    throw new Error('无法读取音频文件');
  }

  return audioResponse.blob();
}

async function savePracticeRecord(audioBlob: Blob, scoreDetail: Record<string, unknown>) {
  try {
    const payload = await uploadAudioBlob('/api/practice/records', audioBlob, {
      practice_type: 'speaking',
      score_detail: JSON.stringify(scoreDetail),
    }, 'audio', ACCOUNT_API_BASE_URL);
    return asRecord(payload.record);
  } catch (error) {
    return {
      history_save_error: getErrorMessage(error),
    };
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizePracticeHistory(payload: unknown): PracticeHistoryRecord[] {
  const record = asRecord(payload);
  const source = Array.isArray(record.records)
    ? record.records
    : Array.isArray(record.history)
      ? record.history
      : Array.isArray(payload)
        ? payload
        : [];

  return source.map((item) => {
    const row = asRecord(item);
    const scoreDetail = optionalRecord(row.score_detail) ?? {};
    const analysis = optionalRecord(row.analysis) ?? optionalRecord(scoreDetail.analysis) ?? scoreDetail;
    return {
      id: stringValue(row.id, `${Date.now()}`),
      created_at: stringValue(row.created_at, ''),
      mode: stringValue(row.mode ?? row.practice_type ?? scoreDetail.mode, 'part_practice'),
      part: stringValue(row.part ?? scoreDetail.part, ''),
      topic: stringValue(row.topic ?? scoreDetail.topic, ''),
      question_text: stringValue(row.question_text ?? scoreDetail.question_text, ''),
      audio_url: stringValue(row.audio_url ?? row.audio_path, ''),
      audio_path: stringValue(row.audio_path, ''),
      analysis,
      report: optionalRecord(row.report) ?? optionalRecord(scoreDetail.report) ?? undefined,
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringValue(value: unknown, fallback: string) {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${value}`;
  }
  return fallback;
}
