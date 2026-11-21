export const DEFAULT_WEIXIN_API_BASE_URL = "https://ilinkai.weixin.qq.com";

export interface WeixinConfig {
  dotcraft: {
    wsUrl: string;
    token?: string;
  };
  weixin: {
    apiBaseUrl: string;
    pollIntervalMs?: number;
    pollTimeoutMs?: number;
    approvalTimeoutMs?: number;
    botType?: string;
  };
}
