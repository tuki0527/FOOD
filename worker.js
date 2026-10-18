/**
 * Cloudflare Worker for AI Weekly Meal Planner (AI 個人化每週料理規劃)
 * Secure proxy to Google Gemini API
 * 
 * Features:
 * - CORS preflight and request handling
 * - Method & Payload validation (<10KB)
 * - Safe API Key reading from Cloudflare Worker Secrets (env.GEMINI_API_KEY)
 * - Timeout guard (15s) with AbortController
 * - System prompts enforcing recipe ID validation and pure JSON responses
 * - Error isolation preventing sensitive credential leaks
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    // 1. Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // 2. Enforce POST method
    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed. Only POST is accepted.' }),
        { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // 3. Payload size limit (protect against abuse)
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > 15000) {
      return new Response(
        JSON.stringify({ error: 'Payload too large. Maximum size is 15KB.' }),
        { status: 413, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // 4. Verify API Key is provisioned
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: 'Cloudflare Worker 尚未設定 GEMINI_API_KEY Secret。請先於 Cloudflare 後台綁定 API 金鑰。',
          code: 'MISSING_API_KEY',
        }),
        { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // 5. Parse and validate JSON input
    let requestData;
    try {
      requestData = await request.json();
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON payload.' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    const { action, preferences, availableRecipes, dates, currentDishId, targetDate } = requestData;

    if (!action || !['generate_week', 'replace_day'].includes(action)) {
      return new Response(
        JSON.stringify({ error: 'Invalid action. Must be generate_week or replace_day.' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // 6. Build the specialized prompt for Gemini
    let systemInstruction = `你是一位專業的個人化營養與每週料理規劃師。
重要規則：
1. 你必須【只能】從給定的料理清單中挑選 recipeId，絕對不可自行捏造不存在的料理或食材 ID！
2. 絕對不可推薦包含使用者忌口或過敏原 (allergens) 的料理。
3. 兼顧蛋白質來源多樣性（雞肉、豬肉、海鮮、豆腐、蛋類）與食材共用原則，降低採買成本。
4. 嚴格輸出合法的 JSON，不得包含任何 Markdown 代碼塊（例如不要包在 \`\`\`json 內），直接輸出純 JSON 格式。`;

    let userPrompt = '';

    if (action === 'generate_week') {
      userPrompt = `請為以下偏好規劃 7 天晚餐（固定一人份）：
- 使用者飲食目標：${preferences?.dietGoal || '均衡飲食'}
- 喜愛食材：${(preferences?.likedIngredients || []).join(', ') || '無特別指定'}
- 討厭食材：${(preferences?.dislikedIngredients || []).join(', ') || '無'}
- 過敏與絕對排除：${(preferences?.allergens || []).join(', ') || '無'}
- 偏好類型：${preferences?.cuisineStyle || '家常台式/日式定食'}
- 週預算目標：NT$ ${preferences?.budget || 1000}
- 需要排定的日期（週一至週日）：${(dates || []).join(', ')}

候選有效料理清單（包含 ID、名稱、主要食材、分類）：
${JSON.stringify(availableRecipes, null, 1)}

請嚴格輸出符合以下結構的純 JSON 格式：
{
  "mode": "ai",
  "days": [
    {
      "date": "YYYY-MM-DD",
      "recipeId": "rec_xxx",
      "reason": "具體說明推薦原因與食材共用優勢（20字以內繁體中文）"
    }
  ]
}`;
    } else if (action === 'replace_day') {
      userPrompt = `使用者想要替換 ${targetDate} 的晚餐料理（原料理 ID: ${currentDishId}）。
- 使用者飲食目標：${preferences?.dietGoal || '均衡飲食'}
- 過敏與絕對排除：${(preferences?.allergens || []).join(', ') || '無'}
- 偏好料理類型：${preferences?.cuisineStyle || '無'}

候選料理清單：
${JSON.stringify(availableRecipes, null, 1)}

請挑選 2 到 3 道最適合的替代料理，直接輸出純 JSON 格式：
{
  "mode": "ai",
  "candidates": [
    {
      "recipeId": "rec_xxx",
      "reason": "替換優勢說明，例如低卡清爽或共用現有食材（20字以內繁體中文）"
    }
  ]
}`;
    }

    // 7. Request to Google Gemini API with 15s timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

      const geminiPayload = {
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemInstruction}\n\n${userPrompt}` }],
          },
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1500,
          responseMimeType: 'application/json',
        },
      };

      const geminiResponse = await fetch(geminiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiPayload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!geminiResponse.ok) {
        const errorText = await geminiResponse.text();
        return new Response(
          JSON.stringify({
            error: 'Google Gemini API 回應錯誤',
            status: geminiResponse.status,
            details: errorText.substring(0, 300),
          }),
          { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
      }

      const geminiResult = await geminiResponse.json();
      const rawText = geminiResult.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

      // Clean markdown fences if any
      const cleanedText = rawText.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
      const parsedData = JSON.parse(cleanedText);

      return new Response(JSON.stringify(parsedData), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const isTimeout = err.name === 'AbortError';
      return new Response(
        JSON.stringify({
          error: isTimeout ? '請求 Gemini API 超時（超過 15 秒）' : 'Worker 代理請求失敗',
          message: err.message,
        }),
        { status: isTimeout ? 504 : 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }
  },
};
