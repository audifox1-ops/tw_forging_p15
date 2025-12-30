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

    // 2. 프롬프트 작성 (AI에게 내리는 지시사항) - 강력한 분석 로직 적용
    const systemPrompt = `
    당신은 제조업 생산기술부의 '견적 검토 및 물량 산출 AI'입니다. 
    제공된 데이터는 엑셀/CSV 파일 내용이거나 이미지입니다.
    이 데이터에서 **'선택된 시트'의 값**을 분석하여 형상, 치수, 여유치, Ingot 정보를 추출하세요.

    **[분석 미션 1: 형상(Shape) 판단]**
    파일명과 데이터 헤더를 최우선으로 분석하세요.
    - **SQUARE / BLOCK:** 파일명에 'SQUARE', 'BLOCK' 포함 또는 헤더에 'W(폭)', 'T(두께)' 존재.
    - **SHAFT:** 파일명에 'SHAFT', 'ROUND' 포함 또는 길이(L)가 외경(OD)보다 월등히 김.
    - **RING / SHELL:** 파일명에 'RING', 'SHELL' 포함. (내경 ID 존재)
    - **DISC:** 파일명에 'DISC' 포함. (내경 ID가 없거나 0)
    - **화공기:** 파일명에 '화공기', 'TUBE SHEET' 포함.

    **[분석 미션 2: 데이터 추출]**
    데이터 행(Row)은 '#', 숫자(1,2...), 코드(P001)로 시작합니다. 헤더는 제외하세요.
    
    1. **치수 (Dimensions):**
       - **제품 치수 (Input):** 행 앞쪽에 위치한 연속된 숫자 3개.
       - **단조 치수 (Output):** 행 중간/뒤쪽에 위치한 연속된 숫자 3개 (제품 치수보다 큼).
    
    2. **여유치 (Allowance):**
       - 문서에 '여유치' 값이 명시되어 있으면 추출하세요.
       - **값이 없거나 0이면:** (단조 치수 - 제품 치수)를 계산하여 '전체 여유치'로 적용하세요.

    3. **Ingot & 회수율 (핵심):**
       - **회수율(Yield/Recovery):** '회수율', '수율', 'Yield', 'Recovery' 헤더 아래 값을 찾으세요.
         - 값의 형식은 **0.xx (소수점)** 또는 **xx% (백분율)** 입니다. (예: 0.68, 72%)
         - 유효 범위(0.5 ~ 0.99)가 아니거나 값이 없으면 **기본값 0.68**을 적용하세요.
       - **Ingot Type:** 숫자 3자리+알파벳(예: 101C, 566F, 168F) 코드를 찾으세요.
       - **검증:** (단조 중량 / 회수율) = 필요 Ingot 중량. 이 중량을 만족하는 Ingot Type인지 확인하세요.

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
          "note": "여유치 250mm 자동 계산됨. 회수율 68% 적용."
        }
      ]
    }
    `;

    // 3. Google Gemini API 요청 생성
    const isCsvOrText = file.type.includes('csv') || file.type.startsWith('text/') || file.name.toLowerCase().endsWith('.csv');
    
    let parts = [];
    parts.push({ text: systemPrompt }); 

    if (isCsvOrText) {
      const textContent = await file.text();
      parts.push({ text: `\n\n[FILE DATA START]\n파일명: ${file.name}\n${textContent}\n[FILE DATA END]` });
    } else {
      const arrayBuffer = await file.arrayBuffer();
      
      // Edge Runtime 호환 Base64 변환 (Buffer 대신 표준 API 사용)
      let binary = '';
      const bytes = new Uint8Array(arrayBuffer);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);
      
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

    // JSON 파싱 (마크다운 제거 및 유효성 검사)
    content = content.replace(/```json/g, '').replace(/```/g, '').trim();
    const extractedData = JSON.parse(content);

    // items 배열 처리
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
