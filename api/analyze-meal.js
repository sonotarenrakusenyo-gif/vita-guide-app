const GEMINI_MODEL_FALLBACKS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-flash-8b",
];

function emptyAnalysis(mealComment) {
  return {
    menu: ["判定中"],
    calories_kcal: 0,
    protein_g: 0,
    fat_g: 0,
    carbs_g: 0,
    vitamins: {
      A_ug_RAE: 0, B1_mg: 0, B2_mg: 0, B6_mg: 0, B12_ug: 0,
      C_mg: 0, D_ug: 0, E_mg: 0, folate_ug: 0, niacin_mg: 0
    },
    minerals: {
      calcium_mg: 0, iron_mg: 0, zinc_mg: 0, magnesium_mg: 0, potassium_mg: 0
    },
    vitamin_insights: [],
    mineral_insights: [],
    improvement_tips: [],
    lacking_nutrients: [],
    recommended_foods: [],
    substitute_suggestions: [],
    confidence_score: 0,
    reminder_message: "",
    goal_advice: "",
    meal_comment: mealComment || "AI出力の整形に失敗したため、再解析をおすすめします。"
  };
}

function toNumberOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeAnalysis(input) {
  const base = emptyAnalysis("");
  const src = input && typeof input === "object" ? input : {};
  const menu = Array.isArray(src.menu) && src.menu.length > 0 ? src.menu.map((x) => String(x)) : base.menu;

  const vitamins = { ...base.vitamins };
  Object.keys(vitamins).forEach((k) => {
    vitamins[k] = toNumberOrZero(src?.vitamins?.[k]);
  });

  const minerals = { ...base.minerals };
  Object.keys(minerals).forEach((k) => {
    minerals[k] = toNumberOrZero(src?.minerals?.[k]);
  });

  const normalized = {
    menu,
    calories_kcal: toNumberOrZero(src.calories_kcal),
    protein_g: toNumberOrZero(src.protein_g),
    fat_g: toNumberOrZero(src.fat_g),
    carbs_g: toNumberOrZero(src.carbs_g),
    vitamins,
    minerals,
    vitamin_insights: Array.isArray(src.vitamin_insights) ? src.vitamin_insights : [],
    mineral_insights: Array.isArray(src.mineral_insights) ? src.mineral_insights : [],
    improvement_tips: Array.isArray(src.improvement_tips) ? src.improvement_tips.map((x) => String(x)) : [],
    lacking_nutrients: Array.isArray(src.lacking_nutrients) ? src.lacking_nutrients.map((x) => String(x)) : [],
    recommended_foods: Array.isArray(src.recommended_foods) ? src.recommended_foods.map((x) => String(x)) : [],
    substitute_suggestions: Array.isArray(src.substitute_suggestions) ? src.substitute_suggestions.map((x) => String(x)) : [],
    confidence_score: Math.max(0, Math.min(100, toNumberOrZero(src.confidence_score))),
    reminder_message: typeof src.reminder_message === "string" ? src.reminder_message : "",
    goal_advice: typeof src.goal_advice === "string" ? src.goal_advice : "",
    meal_comment: typeof src.meal_comment === "string" ? src.meal_comment : ""
  };
  return normalized;
}

function micronutrientsAllZero(a) {
  const vSum = Object.values(a.vitamins || {}).reduce((s, n) => s + toNumberOrZero(n), 0);
  const mSum = Object.values(a.minerals || {}).reduce((s, n) => s + toNumberOrZero(n), 0);
  return vSum <= 0 && mSum <= 0;
}

function parseGeminiJson(text) {
  let t = String(text || "").trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(t);
  if (fence) t = fence[1].trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

  // 余計な前置き/後置き文があってもJSONオブジェクト本体を抽出する
  const extractObject = (src) => {
    let start = -1;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === "}") {
        if (depth > 0) depth--;
        if (depth === 0 && start >= 0) return src.slice(start, i + 1);
      }
    }
    return src;
  };

  const candidates = [];
  candidates.push(t);
  candidates.push(extractObject(t));
  candidates.push(extractObject(t).replace(/,\s*([}\]])/g, "$1"));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // next
    }
  }
  throw new Error("JSON_PARSE_FAILED");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function repairJsonWithGemini(apiKey, brokenText) {
  const repairModel = "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${repairModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const repairPrompt = [
    "次のテキストを、内容を変えずに有効なJSONオブジェクト1つへ修復してください。",
    "出力はJSONのみ。説明文、Markdown、コードブロックは禁止。",
    "末尾カンマ、クォート欠落、改行崩れを補正してください。",
    "",
    brokenText
  ].join("\n");

  const body = JSON.stringify({
    contents: [{ parts: [{ text: repairPrompt }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2048,
      responseMimeType: "application/json"
    }
  });

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
  if (!r.ok) return null;
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) return null;
  try {
    return parseGeminiJson(raw);
  } catch {
    return null;
  }
}

async function enrichMicronutrients(apiKey, analysis) {
  const model = "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = `以下の食事情報から、ビタミン・ミネラルだけを推定してJSONで返してください。説明文禁止。

食事情報:
${JSON.stringify({
  menu: analysis.menu,
  calories_kcal: analysis.calories_kcal,
  protein_g: analysis.protein_g,
  fat_g: analysis.fat_g,
  carbs_g: analysis.carbs_g
}, null, 2)}

JSON:
{
  "vitamins": {"A_ug_RAE": number,"B1_mg": number,"B2_mg": number,"B6_mg": number,"B12_ug": number,"C_mg": number,"D_ug": number,"E_mg": number,"folate_ug": number,"niacin_mg": number},
  "minerals": {"calcium_mg": number,"iron_mg": number,"zinc_mg": number,"magnesium_mg": number,"potassium_mg": number},
  "vitamin_insights": [{"key":"C_mg","status":"不足|適量|過多の可能性","note":"短い解説","food_sources":["食材1"]}],
  "mineral_insights": [{"key":"iron_mg","status":"不足|適量|過多の可能性","note":"短い解説","food_sources":["食材1"]}],
  "lacking_nutrients": ["不足しやすい栄養素名"],
  "recommended_foods": ["補える食材名"],
  "substitute_suggestions": ["置き換え提案（例: 唐揚げ→焼き魚）"],
  "improvement_tips": ["次の食事での改善提案を短く"]
  "confidence_score": number, 
  "reminder_message": "短い通知文"
}`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1200,
      responseMimeType: "application/json"
    }
  });
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  if (!r.ok) return null;
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) return null;
  try {
    return normalizeAnalysis(parseGeminiJson(raw));
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "サーバー環境変数 GEMINI_API_KEY が未設定です" });
  }

  const { base64Image, mimeType, prompt } = req.body || {};
  if (!base64Image || !mimeType || !prompt) {
    return res.status(400).json({ error: "リクエストが不正です" });
  }

  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64Image } }
      ]
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
      responseMimeType: "application/json"
    }
  });

  const maxAttemptsPerModel = 4;
  let last404Body = "";
  let lastOverloadBody = "";

  try {
    for (const model of GEMINI_MODEL_FALLBACKS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

      for (let attempt = 0; attempt < maxAttemptsPerModel; attempt++) {
        if (attempt > 0) {
          const waitMs = Math.min(12000, 2000 * Math.pow(2, attempt - 1));
          await sleep(waitMs);
        }

        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body
        });
        const text = await r.text();

        if (r.ok) {
          let data;
          try {
            data = JSON.parse(text);
          } catch (e) {
            console.error("Gemini API response JSON.parse failed", { message: e?.message, textSnippet: text?.slice(0, 400) });
            return res.status(502).json({ error: "Gemini APIの応答形式が不正です（レスポンスJSONの解析失敗）" });
          }
          const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!raw) {
            return res.status(502).json({ error: "Gemini応答が空です" });
          }
          let analysis;
          try {
            analysis = parseGeminiJson(raw);
          } catch (e) {
            console.error("Gemini content JSON.parse failed", { message: e?.message, rawSnippet: String(raw).slice(0, 1200) });
            const repaired = await repairJsonWithGemini(apiKey, String(raw));
            if (repaired) {
              console.info("Gemini JSON repair succeeded");
              analysis = repaired;
            } else {
              console.error("Gemini JSON repair failed; returning safe fallback object");
              return res.status(200).json({
                analysis: emptyAnalysis("解析結果のJSONが不正だったため暫定表示です。もう一度お試しください。")
              });
            }
          }
          let normalized = normalizeAnalysis(analysis);
          if (micronutrientsAllZero(normalized)) {
            const enriched = await enrichMicronutrients(apiKey, normalized);
            if (enriched) {
              // 補完側は微量栄養素のみ反映し、PFCやカロリーを上書きしない
              normalized = {
                ...normalized,
                vitamins: enriched.vitamins || normalized.vitamins,
                minerals: enriched.minerals || normalized.minerals,
                vitamin_insights: Array.isArray(enriched.vitamin_insights) ? enriched.vitamin_insights : normalized.vitamin_insights,
                mineral_insights: Array.isArray(enriched.mineral_insights) ? enriched.mineral_insights : normalized.mineral_insights,
              };
            }
          }
          return res.status(200).json({ analysis: normalized });
        }

        if (r.status === 404) {
          last404Body = text;
          break;
        }

        if (r.status === 503 || r.status === 429) {
          lastOverloadBody = text;
          if (attempt === maxAttemptsPerModel - 1) break;
          continue;
        }

        return res.status(r.status).json({ error: `Gemini API: ${r.status} ${text}` });
      }
    }

    if (lastOverloadBody) {
      return res.status(503).json({
        error: "Gemini API が混雑中（503）か利用枠に達しています（429）。数分後に再試行してください。"
      });
    }

    return res.status(404).json({
      error: "利用可能なGeminiモデルが見つかりません。Vercel環境変数とモデル設定を確認してください。"
    });
  } catch (e) {
    console.error("analyze-meal handler error", e);
    return res.status(500).json({ error: e?.message || "サーバーエラー" });
  }
}
