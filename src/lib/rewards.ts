import { authFetch } from '@/lib/auth';
import { ACCOUNT_API_BASE_URL } from '@/lib/config';

export type RewardActivityType = 'mock_test' | 'part_practice';
export type RewardItemType = 'streak_freeze_card' | 'poster_analysis';

export type RewardInventory = {
  streak_freeze_cards: number;
  poster_analysis_passes: number;
};

export type RecoveryOffer = {
  missed_date: string;
  streak_days: number;
};

export type RewardsProgress = {
  points: number;
  streak_days: number;
  last_checkin_date: string | null;
  checkin_dates: string[];
  inventory: RewardInventory;
  has_seen_onboarding: boolean;
  recovery_offer?: RecoveryOffer | null;
};

const EMPTY_PROGRESS: RewardsProgress = {
  points: 0,
  streak_days: 0,
  last_checkin_date: null,
  checkin_dates: [],
  inventory: {
    streak_freeze_cards: 0,
    poster_analysis_passes: 0,
  },
  has_seen_onboarding: false,
  recovery_offer: null,
};

export function getClientDate() {
  return toDateKey(new Date());
}

export async function fetchRewardsProgress(clientDate = getClientDate()): Promise<RewardsProgress> {
  const endpoint = `/api/rewards/progress?client_date=${encodeURIComponent(clientDate)}`;
  const response = await requestReward(endpoint);
  await ensureRewardResponse(response, endpoint);
  return normalizeProgress(await readRewardJson(response, endpoint));
}

export async function completeRewardActivity(
  activityType: RewardActivityType,
  sourceId: string,
  clientDate = getClientDate(),
) {
  const endpoint = '/api/rewards/complete';
  const response = await requestReward(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      activity_type: activityType,
      source_id: sourceId,
      client_date: clientDate,
    }),
  });
  await ensureRewardResponse(response, endpoint);
  return normalizeProgress(await readRewardJson(response, endpoint));
}

export async function markOnboardingSeen() {
  const endpoint = '/api/rewards/onboarding/seen';
  const response = await requestReward(endpoint, {
    method: 'POST',
  });
  await ensureRewardResponse(response, endpoint);
  return normalizeProgress(await readRewardJson(response, endpoint));
}

export async function redeemReward(itemType: RewardItemType) {
  const endpoint = '/api/rewards/redeem';
  const response = await requestReward(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item_type: itemType }),
  });
  await ensureRewardResponse(response, endpoint);
  return normalizeProgress(await readRewardJson(response, endpoint));
}

export async function useStreakFreezeCard() {
  const endpoint = '/api/rewards/recovery/use';
  const response = await requestReward(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_date: getClientDate() }),
  });
  await ensureRewardResponse(response, endpoint);
  return normalizeProgress(await readRewardJson(response, endpoint));
}

export async function dismissRecoveryOffer() {
  const endpoint = '/api/rewards/recovery/dismiss';
  const response = await requestReward(endpoint, {
    method: 'POST',
  });
  await ensureRewardResponse(response, endpoint);
  return normalizeProgress(await readRewardJson(response, endpoint));
}

async function requestReward(endpoint: string, init: RequestInit = {}) {
  if (!ACCOUNT_API_BASE_URL) {
    throw new Error(
      '积分服务未配置：EXPO_PUBLIC_ACCOUNT_API_BASE_URL 为空。修改 .env 后请重启 Expo。',
    );
  }

  try {
    return await authFetch(endpoint, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `无法连接积分服务 ${ACCOUNT_API_BASE_URL}${endpoint}。请检查 DNS、HTTPS 证书、服务器、防火墙或浏览器 CORS。${detail ? ` (${detail})` : ''}`,
    );
  }
}

async function ensureRewardResponse(response: Response, endpoint: string) {
  if (response.ok) {
    return;
  }

  const raw = await response.text();
  let detail = raw;
  try {
    const payload = JSON.parse(raw) as { detail?: unknown };
    if (typeof payload.detail === 'string' && payload.detail) {
      detail = payload.detail;
    }
  } catch {
    // Keep the raw response when the server did not return JSON.
  }

  if (response.status === 404) {
    throw new Error(
      `积分服务路由不存在：${ACCOUNT_API_BASE_URL}${endpoint} 返回 404。请确认域名反向代理到 Login_SQL，并且没有漏掉 /api 前缀。`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `积分服务已连接，但登录凭证无效或已过期（HTTP ${response.status}）。请退出后重新登录。`,
    );
  }
  if (response.status >= 500) {
    throw new Error(
      `积分服务端异常（HTTP ${response.status}）。请检查 Login_SQL、数据库和 Nginx 日志。${detail ? ` ${detail}` : ''}`,
    );
  }
  throw new Error(detail || `积分请求失败：${response.status}`);
}

async function readRewardJson(response: Response, endpoint: string) {
  try {
    return await response.json();
  } catch {
    throw new Error(
      `积分服务返回的不是有效 JSON：${ACCOUNT_API_BASE_URL}${endpoint}。请检查反向代理是否把请求转到了前端页面。`,
    );
  }
}

function normalizeProgress(value: unknown): RewardsProgress {
  if (!value || typeof value !== 'object') {
    return EMPTY_PROGRESS;
  }

  const record = value as Record<string, unknown>;
  const inventory = record.inventory && typeof record.inventory === 'object'
    ? record.inventory as Record<string, unknown>
    : {};

  return {
    points: numberValue(record.points),
    streak_days: numberValue(record.streak_days),
    last_checkin_date: typeof record.last_checkin_date === 'string' ? record.last_checkin_date : null,
    checkin_dates: Array.isArray(record.checkin_dates)
      ? record.checkin_dates.filter((item): item is string => typeof item === 'string')
      : [],
    inventory: {
      streak_freeze_cards: numberValue(inventory.streak_freeze_cards),
      poster_analysis_passes: numberValue(inventory.poster_analysis_passes),
    },
    has_seen_onboarding: Boolean(record.has_seen_onboarding),
    recovery_offer:
      record.recovery_offer && typeof record.recovery_offer === 'object'
        ? {
            missed_date: stringValue((record.recovery_offer as Record<string, unknown>).missed_date),
            streak_days: numberValue((record.recovery_offer as Record<string, unknown>).streak_days),
          }
        : null,
  };
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}
