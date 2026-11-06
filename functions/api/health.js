/* functions/api/health.js —— GET /api/health
 * 作用：前端 init() 用它自检，判断「接口是否同源可用」；顺便列出解析源与平台。
 * 部署后访问 https://<你的域名>/api/health 应立即返回 JSON。
 */
import { healthPayload, jsonResponse, preflight } from '../_lib/core.js';

export async function onRequestGet() {
  return jsonResponse(healthPayload());
}

export async function onRequestOptions() {
  return preflight();
}

/* 兜底：非 GET 请求也返回统一 JSON，避免页面拿到 HTML 报错 */
export async function onRequest(context) {
  return onRequestGet(context);
}
