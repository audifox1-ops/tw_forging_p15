// Vercel Edge Runtime 설정 (가볍고 빠름)
export const config = {
  runtime: 'edge',
};

// --- Configuration ---
// 배포된 Vercel 도메인이나 로컬 호스트를 허용
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  // 실제 배포 후 Vercel 도메인 추가 필요 (예: https://my-project.vercel.app)
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// --- Types ---
interface Dimension {
  od?: number;
  id?: number;
  length?: number;
  width?: number;
  thickness?: number;
}

// --- CORS Helper ---
const getCorsHeaders = (origin: string | null) => {
  // 간단하게 모든 Origin 허용하거나, 위 리스트 기반으로 필터링 가능
  // 여기서는 편의상 요청 온 Origin을 그대로 반사 (실무에선 보안 주의)
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
};

export default async function handler(req: Request) {
  const origin = req.headers.get('Origin');
  const corsHeaders = getCorsHeaders(origin);

  // Handle CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Only POST allowed
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    console.log('Processing document analysis request...');

    // Vercel 환경 변수에서 API Key 가져오기
    const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY is not configured in Vercel Settings');
    }

    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (file.size > MAX_FILE_SIZE) {
      return new Response(JSON.stringify({ error: 'File too large (Max 10MB)' }), {
        status: 413,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 파일 타입 확인
    const isCsvOrText =
      file.type.includes('csv') ||
      file.type.startsWith('text/') ||
      file.name.toLowerCase().endsWith('.csv');

    let messagesContent;

    // ✨ 핵심: 원본의 강력한 프롬프트 로직 유지
    const systemPrompt = `
    당신은 제조업 생산기술부의 '견적 검토 및 물량 산출 AI'입니다. 
    업로드된 파일(${file.name})은 특정 시트(Sheet)의 내용을 담은 CSV 파일입니다.
    이 파일은 **'선택된 시트'의 값만을 포함**하고 있으므로, 파일 내의 유효한 데이터 행을 찾아 분석하세요.

    **[분석 미션]**
    1. **형상(Shape) 확정:** 파일명에 있는 키워드(SQUARE, SHAFT, SHELL, RING, DISC, 화공기)를 최우선으로 하여 형상을 결정하세요.
    2. **데이터 행 식별:** 첫 번째 컬럼이 '#', 숫자(1, 2...), 또는 코드(P001)로 시작하는 행만 분석하세요. (헤더 행 무시)
    3. **데이터 패턴 매핑 (Numeric Cluster Mapping):**
       CSV 변환 과정에서 빈 컬럼(,,)이 많습니다. 헤더 위치 대신 **숫자가 뭉쳐있는 패턴**을 찾으세요.
       - **Cluster 1 (제품 치수):** 행의 앞부분에 나타나는 **3개의 연속된 숫자**.
       - **Cluster 2 (단조 치수):** 행의 중간/뒷부분에 나타나는 **3개의 연속된 숫자**. (값은 Cluster 1보다 크거나 같음)
       - **Cluster 3 (여유치):** 만약 제품 치수와 단조 치수 사이에 숫자가 있다면 여유치입니다. 없으면 **(단조 - 제품)**으로 계산하세요.

    **[형상별 치수 순서 가이드]**
    - **SQUARE / BLOCK:** [L(길이), W(폭), T(두께)] 또는 [W, L, T]
    - **ROUND (SHAFT/SHELL/RING):** [OD(외경), ID(내경), L(길이)]
    
    **[INGOT 및 회수율 분석]**
    - **회수율(Yield):** 0.xx 또는 xx% 형태의 데이터. (없으면 기본값 0.68)
    - **Ingot Type:** 숫자 3자리+알파벳(예: 101C, 566F, 168F).
    - **Ingot 선정 로직:** 1. 문서에 Ingot Type이 있으면 추출.
      2. 없으면, \`계산된 필요 중량 = 단조 중량 / 회수율\`을 구하고, 이를 비고(note)에 기록.

    **[응답 형식 (JSON Only)]**
    반드시 아래 JSON 포맷으로만 응답하세요.
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

    if (isCsvOrText) {
      console.log('Processing as Text/CSV file');
      const textContent = await file.text();
      messagesContent = [
        { type: 'text', text: systemPrompt },
        {
          type: 'text',
          text: `\n\n[CSV DATA CONTENT START]\n${textContent}\n[CSV DATA CONTENT END]`,
        },
      ];
    } else {
      console.log('Processing as Image/PDF file');
      const arrayBuffer = await file.arrayBuffer();
      // Edge Runtime에서 Buffer 사용 (Node 호환)
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      const mimeType = file.type || 'application/pdf';
      messagesContent = [
        { type: 'text', text: systemPrompt },
        {
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${base64}` },
        },
      ];
    }

    // Call Gemini API
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'user',
            content: messagesContent,
          },
        ],
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      console.error('AI service error:', response.status);
      throw new Error(`AI Service Error: ${response.status}`);
    }

    const aiResult = await response.json();
    const content = aiResult.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from AI');
    }

    // Parse JSON Response
    let extractedData;
    try {
      let jsonStr = content;
      const jsonMatch = content.match(/