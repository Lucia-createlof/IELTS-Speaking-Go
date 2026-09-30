import { requireOptionalNativeModule } from 'expo-modules-core';
import { NativeModules, Platform } from 'react-native';

type AliyunNumberAuthNativeModule = {
  checkEnvAvailable?: () => Promise<unknown>;
  accelerateLoginPage?: (timeout?: number) => Promise<unknown>;
  getLoginToken?: () => Promise<unknown>;
  getVerifyToken?: (secretInfo?: string) => Promise<unknown>;
  login?: () => Promise<unknown>;
  quitLoginPage?: () => Promise<boolean>;
  setLogEnabled?: (enabled: boolean) => Promise<boolean>;
  getSDKVersion?: () => Promise<{ version: string }>;
};

type AliyunNumberAuthResult = {
  code?: string | number;
  _code?: string | number;
  resultCode?: string | number;
  msg?: string;
  _msg?: string;
  message?: string;
  errorMsg?: string;
  token?: string;
  _token?: string;
  accessToken?: string;
  access_token?: string;
};

type NativeErrorLike = {
  code?: string | number;
  message?: unknown;
  userInfo?: { message?: unknown };
  nativeError?: { message?: unknown };
  error?: { message?: unknown };
};

const GET_LOGIN_TOKEN_SUCCESS_CODE = '600000';
const START_AUTH_PAGE_SUCCESS_CODE = '600001';
const CHECK_ENV_SUCCESS_CODE = '600024';

let activeLoginFlow: Promise<string> | null = null;

function getNativeModule() {
  return (
    requireOptionalNativeModule<AliyunNumberAuthNativeModule>('AliyunNumberAuth') ||
    (NativeModules.AliyunNumberAuth as AliyunNumberAuthNativeModule | undefined)
  );
}

function getNativeModuleNames() {
  return Object.keys(NativeModules).filter((name) => {
    const normalizedName = name.toLowerCase();
    return normalizedName.includes('aliyun') || normalizedName.includes('numberauth');
  });
}

function getResultMessage(result: AliyunNumberAuthResult) {
  return result.msg || result._msg || result.message || result.errorMsg || '';
}

function getNativeErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === 'object') {
    const candidate = error as NativeErrorLike;
    const nestedMessage =
      candidate.message ??
      candidate.userInfo?.message ??
      candidate.nativeError?.message ??
      candidate.error?.message;
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

function normalizeNativeError(error: unknown, fallback: string) {
  const normalized = new Error(getNativeErrorMessage(error) || fallback);
  if (error && typeof error === 'object' && 'code' in error) {
    normalized.name = String((error as NativeErrorLike).code ?? 'AliyunNumberAuthError');
  }
  return normalized;
}

function parseNativeResult(rawResult: unknown) {
  if (rawResult && typeof rawResult === 'object') {
    return rawResult as AliyunNumberAuthResult;
  }

  const trimmedResult = typeof rawResult === 'string' ? rawResult.trim() : '';
  if (!trimmedResult) {
    throw new Error('原生模块返回为空');
  }

  // 如果不是 JSON，直接当作 token 返回
  if (!trimmedResult.startsWith('{')) {
    return { token: trimmedResult };
  }

  try {
    return JSON.parse(trimmedResult) as AliyunNumberAuthResult;
  } catch {
    throw new Error('原生模块返回了无法解析的结果');
  }
}

function extractLoginToken(rawResult: unknown) {
  const result = parseNativeResult(rawResult);
  const codeValue = result.code ?? result._code ?? result.resultCode;
  const code = codeValue === undefined ? '' : String(codeValue);
  const token =
    result.token ||
    result._token ||
    result.accessToken ||
    result.access_token ||
    '';

  if (code === START_AUTH_PAGE_SUCCESS_CODE || code === CHECK_ENV_SUCCESS_CODE) {
    throw new Error(getResultMessage(result) || '尚未获取到运营商 Token');
  }

  if (code && code !== GET_LOGIN_TOKEN_SUCCESS_CODE) {
    throw new Error(getResultMessage(result) || code || '获取运营商 Token 失败');
  }

  if (!token.trim()) {
    throw new Error('手机号验证失败，获取到的返回凭证为空');
  }

  return token.trim();
}

async function runAliyunLoginFlow() {
  const nativeModule = getNativeModule();
  console.log('[AliyunNumberAuth] Native module snapshot:', nativeModule);
  console.log('[AliyunNumberAuth] Native module candidates:', getNativeModuleNames());

  if (!nativeModule?.login) {
    throw new Error(
      Platform.OS === 'ios'
        ? '当前 iOS development build 未包含新版号码认证模块。请重新构建并安装应用后再试。'
        : '当前客户端号码认证原生模块未正确安装。请重新构建 development build 后再试。'
    );
  }

  const tokenResult = await nativeModule.login();

  console.log('[AliyunNumberAuth] Native login resolved');
  console.log('[AliyunNumberAuth] Result type:', typeof tokenResult);
  console.log(
    '[AliyunNumberAuth] Result length:',
    typeof tokenResult === 'string' ? tokenResult.length : -1
  );

  const accessToken = extractLoginToken(tokenResult);

  console.log(
    `[AliyunNumberAuth] ${Platform.OS} access token extracted successfully, length:`,
    accessToken.length
  );

  return accessToken;
}

/**
 * 预取号/加速弹起授权页
 * 建议在进入登录界面 (useEffect) 时调用，以减少唤起授权页的等待时间
 * @param timeout 超时时间（秒），默认 3.0s
 */
export async function accelerateAliyunLoginPage(timeout: number = 3.0): Promise<boolean> {
  const nativeModule = getNativeModule();
  if (!nativeModule?.accelerateLoginPage) {
    console.warn('[AliyunNumberAuth] 原生模块不支持 accelerateLoginPage 方法');
    return false;
  }

  try {
    console.log(`[AliyunNumberAuth] 开始预取号加速，设置超时为 ${timeout} 秒...`);
    const res = await nativeModule.accelerateLoginPage(timeout);
    console.log('[AliyunNumberAuth] 预取号加速成功:', res);
    return true;
  } catch (error: any) {
    console.warn('[AliyunNumberAuth] 预取号加速失败:', error?.message || error);
    return false;
  }
}

/**
 * 切换 Native 控制台日志开关
 */
export async function setAliyunLogEnabled(enabled: boolean): Promise<boolean> {
  const nativeModule = getNativeModule();
  if (!nativeModule?.setLogEnabled) return false;
  try {
    return await nativeModule.setLogEnabled(enabled);
  } catch {
    return false;
  }
}

/**
 * 获取 SDK 当前版本号
 */
export async function getAliyunSDKVersion(): Promise<string> {
  const nativeModule = getNativeModule();
  if (!nativeModule?.getSDKVersion) return '';
  try {
    const res = await nativeModule.getSDKVersion();
    return res.version || '';
  } catch {
    return '';
  }
}

/**
 * 拉起授权页并获取一键登录 Token
 */
export async function getAliyunLoginToken(): Promise<string> {
  if (!activeLoginFlow) {
    activeLoginFlow = Promise.race([
      runAliyunLoginFlow(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('E_PHONE_TIMEOUT')), 30000)
      )
    ]).finally(() => {
      activeLoginFlow = null;
    });
  }

  try {
    return await activeLoginFlow;
  } catch (error: unknown) {
    console.error('[AliyunNumberAuth] Login token flow error:', error);

    // 验证失败、超时或取消时，主动关闭阿里云授权页。
    try {
      const nativeModule = getNativeModule();
      if (nativeModule?.quitLoginPage) {
        await nativeModule.quitLoginPage();
      }
    } catch (quitError) {
      // 忽略退出页面时的异常（例如授权页本就未成功拉起）。
      console.warn('[AliyunNumberAuth] Failed to quit login page:', quitError);
    }

    throw normalizeNativeError(error, '手机号验证失败，请稍后重试');
  }
}
