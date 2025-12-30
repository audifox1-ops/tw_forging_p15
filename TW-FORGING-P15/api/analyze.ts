export const config = {
  runtime: 'edge', 
};

// 파일 크기 제한 4MB
const MAX_FILE_SIZE = 4 * 1024 * 1024; 

const getCorsHeaders = (origin: string | null) => {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
};

export default async function handler(req: Request) {
  const origin = req.headers.get('Origin');
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: corsHeaders });
  }

  try {
    // Vercel 환경 변수에서 키 가져오기
    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
      throw new Error('GEMINI_API_KEY가 Vercel 환경변수에 설정되지 않았습니다.');
    }

    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return new Response(JSON.stringify({ error: '파일이 없습니다.' }), { status: 400, headers: corsHeaders });
    }

    if (file.size > MAX_FILE_SIZE) {
      return new Response(JSON.stringify({ error: '파일 크기 초과 (4MB 이하만 가능)' }), { status: 413, headers: corsHeaders });
    }

    // --- AI 프롬프트 ---
    const systemPrompt = `
    당신은 생산기술부 '견적 검토 AI'입니다. 
    제공된 데이터(엑셀/이미지)에서 **활성 시트(Active Sheet)**의 값을 분석하세요.

    **[분석 규칙]**
    1. **형상(Shape):** 파일명/헤더(OD,ID,L,W,T)를 보고 판단 (SQUARE, SHAFT, RING, SHELL, DISC, 화공기).
    2. **데이터 추출:**
       - **제품 치수:** 행 앞쪽의 숫자 3개.
       - **단조 치수:** 행 뒤쪽의 숫자 3개.
       - **여유치:** 명시된 값이 없으면 (단조 - 제품)으로 계산.
    3. **Ingot & 회수율:**
       - **회수율:** '회수율', 'Yield' (0.xx 또는 xx%). 없으면 0.68.
       - **Ingot:** 코드(101C 등)가 없으면 (단조중량/회수율)로 계산된 타입 추천.

    **[출력 형식 (JSON)]**
    {
      "items": [
        {
          "rowId": "#1", 
          "productName": "SQUARE",
          "material": "SA266",
          "inputSpec": { "width": 600, "length": 600, "thickness": 300 },
          "outputSpec": { "width": 600, "length": 850, "thickness": 300 },
          "allowanceSpec": { "length": 250 }, 
          "weight": 1201,
          "ingotType": "101C",
          "recoveryRate": 0.68,
          "note": "자동 분석 결과"
        }
      ]
    }
    `;

    // 데이터 전처리
    const isCsvOrText = file.type.includes('csv') || file.type.startsWith('text/') || file.name.endsWith('.csv');
    let parts = [{ text: systemPrompt }];

    if (isCsvOrText) {
      const text = await file.text();
      parts.push({ text: `\n[DATA START]\n파일명:${file.name}\n${text}\n[DATA END]` });
    } else {
      const arrayBuffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(arrayBuffer);
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      parts.push({ inline_data: { mime_type: file.type || 'application/pdf', data: base64 } });
    }

    // Google API 호출
    const googleRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: parts }] })
    });

    if (!googleRes.ok) {
      const err = await googleRes.text();
      throw new Error(`Google API Error: ${err}`);
    }

    const aiData = await googleRes.json();
    let textResult = aiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
    
    // JSON 정리
    textResult = textResult.replace(/```json/g, '').replace(/```/g, '').trim();
    const jsonResult = JSON.parse(textResult);
    const items = jsonResult.items || (Array.isArray(jsonResult) ? jsonResult : []);

    return new Response(JSON.stringify({ success: true, data: { items } }), { headers: corsHeaders });

  } catch (error: any) {
    console.error(error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
}
