export const config = {
  runtime: 'edge', // Vercel Edge Function
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// CORS 설정
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
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    // 1. Vercel 환경 변수에서 구글 API 키 가져오기
    // Vercel 대시보드 -> Settings -> Environment Variables에 'GEMINI_API_KEY'로 등록해야 함
    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
      throw new Error('GEMINI_API_KEY is not configured in Vercel Settings');
    }

    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 2. 프롬프트 작성 (AI에게 내리는 지시사항)
    const systemPrompt = `
    당신은 제조업 생산기술부의 '견적 검토 및 물량 산출 AI'입니다. 
    제공된 데이터는 엑셀/CSV 파일 내용이거나 이미지입니다.
    이 데이터에서 **'선택된 시트'의 값**을 분석하여 형상, 치수, 여유치, Ingot 정보를 추출하세요.

    **[분석 미션]**
    1. **형상(Shape):** 파일명이나 데이터 헤더(W, T, OD, ID)를 보고 결정 (SQUARE, SHAFT, RING, SHELL, DISC).
    2. **데이터 행 식별:** #, 숫자, 코드로 시작하는 유효 행만 분석 (헤더 제외).
    3. **패턴 인식:**
       - **제품 치수:** 행 앞쪽의 연속된 숫자 3개.
       - **단조 치수:** 행 중간/뒤쪽의 연속된 숫자 3개 (제품보다 큼).
       - **여유치:** 없으면 (단조 - 제품)으로 자동 계산.
    4. **Ingot & 회수율 (중요):**
       - **회수율(Yield/Recovery):** '회수율', '수율', 'Yield', 'Recovery' 등의 헤더 아래에 있는 값을 찾으세요.
         - 값의 형식은 **0.xx (소수점)** 또는 **xx% (백분율)** 입니다. (예: 0.68, 72%)
         - 회수율은 보통 Ingot Type이나 중량 데이터 근처에 위치합니다.
         - 만약 값이 없거나 유효한 범위(0.5 ~ 1.0)를 벗어난 경우, **기본값 0.68**을 적용하고 비고에 '기본 회수율 적용'이라고 적으세요.
       - **Ingot Type:** 숫자 3자리+알파벳(예: 101C) 코드를 찾으세요. 없으면 (중량 / 회수율) 계산하여 비고에 기록.

    **[응답 형식 (JSON Only)]**
    반드시 아래 JSON 포맷만 출력하세요. 마크다운(```json) 쓰지 마세요.
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
          "calculatedIngotWeight": 1766.17,
          "note": "여유치 자동 계산됨."
        }
      ]
    }
    `;

    // 3. Google Gemini API 요청 생성
    const isCsvOrText = file.type.includes('csv') || file.type.startsWith('text/') || file.name.toLowerCase().endsWith('.csv');
    
    let parts = [];
    parts.push({ text: systemPrompt }); // 시스템 지시사항 먼저 추가

    if (isCsvOrText) {
      const textContent = await file.text();
      parts.push({ text: `\n\n[FILE DATA START]\n파일명: ${file.name}\n${textContent}\n[FILE DATA END]` });
    } else {
      const arrayBuffer = await file.arrayBuffer();
      // Google API용 Base64 (Standard)
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      const mimeType = file.type || 'application/pdf';
      parts.push({
        inline_data: {
          mime_type: mimeType,
          data: base64
        }
      });
    }

    // Google Gemini API 호출
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: parts }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Gemini API Error:', errText);
      throw new Error(`Google API Error: ${response.status}`);
    }

    const aiResult = await response.json();
    let content = aiResult.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!content) {
      throw new Error('AI 응답이 비어있습니다.');
    }

    // JSON 파싱 (마크다운 제거)
    content = content.replace(/```json/g, '').replace(/```/g, '').trim();
    const extractedData = JSON.parse(content);

    // items 배열이 없는 경우 처리
    const items = extractedData.items || (Array.isArray(extractedData) ? extractedData : []);

    return new Response(
      JSON.stringify({
        success: true,
        data: { items },
        fileName: file.name,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Server Error:', error);
    return new Response(
      JSON.stringify({ error: error.message || '서버 처리 중 오류 발생' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}
