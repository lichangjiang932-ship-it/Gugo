import { getAuthToken } from '../accountClient.js'
import { parseProxyResponse } from './modelHttp.js'

export async function callModelThroughProxy({ messages, modelName, agentId, fetchImpl = fetch }) {
  const response = await fetchImpl('/api/model/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: JSON.stringify({ messages, modelName, agentId }),
  })
  const data = await parseProxyResponse(response)
  if (!data?.reply) throw new Error('\u6a21\u578b\u8fd4\u56de\u4e3a\u7a7a\u3002')
  return { reply: data.reply }
}

/**
 * \u2605 #8: \u5f02\u6b65\u751f\u6210\u4f1a\u8bdd\u6807\u9898 \u2014 \u7528\u9996\u53e5\u5582\u6a21\u578b 8 \u5b57\u5185\u603b\u7ed3\u3002
 * \u5931\u8d25/\u7a7a\u8fd4\u56de\u65f6\u8fd4\u56de null,\u8ba9\u8c03\u7528\u65b9 fallback \u5230\u622a\u65ad\u3002
 * \u4e0d\u8ba1\u5165\u7528\u6237\u53d1\u8d77\u7684\u5de5\u5177\u8c03\u7528\u7edf\u8ba1\uff08\u672c\u671f\u524d\u7aef\u53ea\u8d1f\u8d23\u8c03\u7528\uff09\u3002
 */
export async function summarizeSessionTitle({ firstUserContent, modelName, fetchImpl = fetch, signal }) {
  const text = String(firstUserContent || '').trim()
  if (!text) return null
  // \u5185\u5bb9\u5df2\u7ecf\u5f88\u77ed\u5c31\u4e0d\u7528 AI \u4e86
  if (text.length <= 12) return text
  try {
    const response = await fetchImpl('/api/model/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getAuthToken()}`,
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: '\u4f60\u662f\u4f1a\u8bdd\u6807\u9898\u751f\u6210\u5668\u3002\u8bfb\u5b8c\u7528\u6237\u9996\u53e5\u540e,\u7528 8 \u4e2a\u6c49\u5b57\u4ee5\u5185\u603b\u7ed3\u4e3b\u9898,\u53ea\u8fd4\u56de\u6807\u9898\u6587\u672c,\u4e0d\u8981\u5f15\u53f7\u3001\u4e0d\u8981\u53e5\u53f7\u3001\u4e0d\u8981\u89e3\u91ca\u3002',
          },
          { role: 'user', content: text.slice(0, 600) },
        ],
        modelName,
      purpose: 'title', // \u7ed9\u540e\u7aef\u4e00\u4e2a\u6807\u8bb0\uff0c\u4fbf\u4e8e\u533a\u5206\u6807\u9898\u6458\u8981\u4e0e\u666e\u901a\u5bf9\u8bdd
      }),
      signal,
    })
    if (!response.ok) return null
    const data = await response.json()
    const reply = String(data?.reply || '').trim()
    if (!reply) return null
    // \u6e05\u7406\u5e38\u89c1\u566a\u58f0
    const cleaned = reply
      .replace(/^["\u300e\u300c\u3010]+|["\u300f\u300d\u3011]+$/g, '')
      .replace(/[\u3002\uff01\uff1f.!?]+$/u, '')
      .trim()
    if (!cleaned) return null
    // \u9650\u957f \u2014 8 \u5b57 / 16 \u5b57\u7b26\u515c\u5e95
    return cleaned.length > 16 ? cleaned.slice(0, 16) : cleaned
  } catch {
    return null
  }
}

/* \u2500\u2500 \u6d41\u5f0f\u8f93\u51fa\uff08SSE\uff09\u2500\u2500 */
/**
 * \u6ce8\u610f:\u65e7\u7248 yield \u5b57\u7b26\u4e32(text delta);\u65b0\u7248 yield event \u5bf9\u8c61 { type, ... },
 * \u8ba9\u4e0a\u5c42\u80fd\u533a\u5206\u6587\u672c\u589e\u91cf\u548c\u5de5\u5177\u8c03\u7528\u3002
 *   { type: 'text', delta: string }
 *   { type: 'tool_calls', toolCalls: [{id,name,arguments}], finishReason }
 */
/**
 * \u6d41\u88ab\u622a\u65ad \u2014\u2014 \u8fde\u63a5\u65ad\u4e86\u4f46\u4ece\u6ca1\u6536\u5230 done \u5e27\u3002
 *
 * \u2605 \u5fc5\u987b\u548c\u300c\u6b63\u5e38\u7ed3\u675f\u300d\u533a\u5206\u5f00\u3002\u539f\u6765 `if (done) break` \u8ba9\u4e24\u8005\u5b8c\u5168\u4e00\u6837,
 * \u4e8e\u662f\u672c\u5730\u6a21\u578b\u8dd1\u4e00\u534a\u5d29\u4e86,\u524d\u7aef\u8868\u73b0\u6210\u300c\u6a21\u578b\u6b63\u5e38\u56de\u7b54\u5b8c\u4e86,\u53ea\u662f\u8bdd\u8bf4\u4e86\u4e00\u534a\u300d:
 * \u6ca1\u6709\u9519\u8bef\u3001\u6ca1\u6709\u63d0\u793a\u3001\u6ca1\u6709\u91cd\u8bd5\u5165\u53e3,\u7528\u6237\u53ea\u80fd\u81ea\u5df1\u53d1\u73b0\u4e0d\u5bf9\u52b2\u3002
 */

