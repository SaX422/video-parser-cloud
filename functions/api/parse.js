/* functions/api/parse.js —— GET /api/parse?url=<分享链接>
 * 作用：在边缘节点代请求第三方解析接口（浏览器不做跨域请求），
 *       把结果统一成 { ok, video, images[], title, cover, platform, ... } 返回。
 *
 * 示例：
 *   /api/parse?url=https%3A%2F%2Fv.douyin.com%2Fxxxxx%2F
 */
import { parseLink, jsonResponse, preflight } from '../_lib/core.js';

export async function onRequestGet(context) {
  const { request } = context;
  const u = new URL(request.url);
  const target = u.searchParams.get('url') || '';
  const result = await parseLink(target);
  return jsonResponse(result);
}

export async function onRequestOptions() {
  return preflight();
}

export async function onRequest(context) {
  return onRequestGet(context);
}
