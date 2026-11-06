/* functions/api/proxy.js —— GET /api/proxy?url=<媒体地址>
 * 作用：流式转发视频/图片，透传 Range 使其可拖动进度条，
 *       同时把 http 媒体升级为同源 https，避免浏览器混合内容拦截。
 * 安全：只放行 functions/_lib/core.js 中 ALLOWED_HOST_SUFFIX 的 CDN 域名。
 */
import { proxyMedia, preflight } from '../_lib/core.js';

export async function onRequestGet(context) {
  return proxyMedia(context.request);
}

export async function onRequestOptions() {
  return preflight();
}

export async function onRequest(context) {
  return onRequestGet(context);
}
