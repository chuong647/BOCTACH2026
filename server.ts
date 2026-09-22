import express from "express";
import http from "http";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const app = express();
const PORT = 3000;

// Set request size limit to 50MB to handle large PDF base64 payloads
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Express body-parser error handler to ensure all body parsing errors return JSON, never HTML
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err) {
    console.error("Express body-parser error:", err.message);
    return res.status(err.status || 400).json({
      success: false,
      error: err.type === "entity.too.large" || err.status === 413
        ? "Dung lượng dữ liệu tệp vượt quá giới hạn máy chủ (413 Payload Too Large)."
        : "Dữ liệu gửi lên không đúng định dạng.",
      details: err.message,
    });
  }
  next();
});

// Helper to initialize Gemini SDK lazily
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not defined in environment variables. Please check Settings > Secrets.");
  }
  return new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// API endpoint to health-check (instant response for dev server probes)
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// API endpoint to parse PDF or Image
app.post("/api/extract", async (req, res) => {
  try {
    const { parts, pdfBase64, fileBase64, fileType, fileName, pageStart, pageEnd, totalPages, isPdf } = req.body;

    let contentParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];

    if (Array.isArray(parts) && parts.length > 0) {
      contentParts = parts.map((p: any) => ({
        inlineData: {
          mimeType: p.inlineData?.mimeType || p.mimeType || "application/pdf",
          data: p.inlineData?.data || p.data || "",
        },
      }));
    } else {
      const base64 = fileBase64 || pdfBase64;
      const mimeType = fileType || (pdfBase64 ? "application/pdf" : undefined);

      if (!base64) {
        return res.status(400).json({ error: "Yêu cầu cung cấp dữ liệu tệp (PDF hoặc hình ảnh) dưới dạng Base64" });
      }

      if (!mimeType) {
        return res.status(400).json({ error: "Yêu cầu cung cấp định dạng tệp (MIME type)" });
      }

      contentParts = [{
        inlineData: {
          mimeType: mimeType,
          data: base64,
        },
      }];
    }

    const pageCount = (pageEnd && pageStart) ? (pageEnd - pageStart + 1) : (totalPages || undefined);
    console.log(`Bắt đầu trích xuất tài liệu: ${fileName || "batch/chunk"} (${contentParts.length} phần tử dữ liệu, ${pageCount ? pageCount + " trang" : "nhiều trang"})`);

    const ai = getGeminiClient();

    // System instruction tuân thủ nghiêm ngặt chuẩn TP01, nguyên tắc 1 trang = 1 trích yếu, số bút chì góc phải & TUYỆT ĐỐI KHÔNG DỊCH TIẾNG PHÁP
    const systemInstruction = 
      "Bạn là chuyên gia văn thư lưu trữ và chuyên gia giải mã văn bản lịch sử, văn bản hành chính Đông Dương, văn bản thời kỳ Pháp thuộc và Việt Nam cận đại. Nhiệm vụ của bạn là bóc tách TOÀN BỘ các văn bản có trong tệp/hình ảnh được cung cấp.\n\n" +
      "⭐⭐⭐ NGUYÊN TẮC CỐT LÕI BẤT KHẢ XÂM PHẠM TỪ NGƯỜI DÙNG ⭐⭐⭐\n\n" +
      "1. ⭐ TUYỆT ĐỐI KHÔNG DỊCH ĐỐI VỚI NHỮNG VĂN BẢN TIẾNG PHÁP (GIỮ NGUYÊN 100% TIẾNG PHÁP GỐC) ⭐:\n" +
      "   - NẾU VĂN BẢN LÀ TIẾNG PHÁP: TẤT CẢ CÁC TRƯỜNG DỮ LIỆU (docType, summary, authority, symbol) BẮT BUỘC PHẢI 100% GIỮ NGUYÊN BẰNG TIẾNG PHÁP. TUYỆT ĐỐI KHÔNG ĐƯỢC DỊCH SANG TIẾNG VIỆT HAY BẤT KỲ NGÔN NGỮ NÀO KHÁC.\n" +
      "   - Loại văn bản (docType): Phải là tiếng Pháp nguyên bản (Ví dụ: Arrêté, Décision, Circulaire, Rapport, Lettre, Télégramme, Procès-verbal, Bordereau, Ordre de service, Demande, Avis, Notification, Certificat, Extrait, Contrat...). TUYỆT ĐỐI CẤM dịch thành 'Nghị định', 'Quyết định', 'Thông tư', 'Báo cáo', 'Thư', 'Công văn', 'Biên bản'...\n" +
      "   - Trích yếu (summary): Phải tóm tắt trích yếu hoàn toàn 100% BẰNG TIẾNG PHÁP (Ví dụ: 'portant nomination de...', 'au sujet de...', 'relatif à...', 'sur la réorganisation de...', 'accordant un congé à...', 'concernant...'). TUYỆT ĐỐI CẤM dịch sang tiếng Việt (như 'về việc bổ nhiệm...', 'về việc...', 'liên quan đến...'). Bắt đầu trích yếu bằng chữ thường trong tiếng Pháp. Tuyệt đối không lặp lại tên loại văn bản ở đầu trích yếu.\n" +
      "   - Cơ quan ban hành (authority): Phải giữ nguyên 100% tên tiếng Pháp (Ví dụ: Gouverneur Général de l'Indochine, Résident Supérieur au Tonkin, Résident Supérieur en Annam, Gouverneur de la Cochinchine, Province de Hà Đông, Mairie de Hanoi, Direction des Affaires Politiques...). TUYỆT ĐỐI CẤM dịch thành 'Toàn quyền Đông Dương', 'Thống sứ Bắc Kỳ', 'Khâm sứ Trung Kỳ', 'Thống đốc Nam Kỳ', 'Tỉnh...', 'Tòa thị chính'...\n" +
      "   - Trích xuất chính xác từng ký tự, chữ viết hoa, chữ viết thường và đầy đủ các dấu trọng âm tiếng Pháp (é, è, ê, à, â, ç, î, ô, ù, û...).\n\n" +
      "2. ⭐ MỖI TRANG VĂN BẢN TRONG TỆP PDF LÀ MỘT TRÍCH YẾU NỘI DUNG RIÊNG BIỆT (TỶ LỆ CHÍNH XÁC 1 TRANG = 1 TRÍCH YẾU / 1 DÒNG DỮ LIỆU) ⭐:\n" +
      "   - Cứ mỗi một trang văn bản trong tệp PDF tương ứng với ĐÚNG MỘT dòng dữ liệu / MỘT trích yếu nội dung độc lập trong kết quả JSON.\n" +
      "   - TUYỆT ĐỐI KHÔNG GỘP NHIỀU TRANG THÀNH 1 DÒNG: Dù các trang có chung một số hiệu quyết định, chung một chủ đề, cùng một loại văn bản hay có nội dung liên tiếp nhau, bạn VẪN BẮT BUỘC PHẢI TÁCH THÀNH CÁC DÒNG RIÊNG BIỆT CHO TỪNG TRANG.\n" +
      "   - TUYỆT ĐỐI KHÔNG BỎ QUA BẤT KỲ TRANG NÀO: Tệp có bao nhiêu trang thì kết quả JSON trả về phải có bấy nhiêu phần tử, theo đúng thứ tự lần lượt từ trang đầu tiên đến trang cuối cùng của tệp.\n\n" +
      "3. ⭐ CHÍNH XÁC SỐ TRANG VÀ KHOẢNG TRANG BÚT CHÌ GÓC PHẢI PHÍA TRÊN MỖI TRANG ⭐:\n" +
      "   - VỊ TRÍ QUAN SÁT: Quan sát kỹ VÙNG GÓC TRÊN BÊN PHẢI (Top-Right Corner / mép trên bên phải) của mỗi trang văn bản. Đây là vị trí cán bộ văn thư lưu trữ ghi SỐ TRANG BẰNG BÚT CHÌ (số viết tay chì, nét chì mờ hoặc rõ, hoặc con dấu lưu trữ).\n" +
      "   - BẮT BUỘC TRÍCH XUẤT CHÍNH XÁC SỐ BÚT CHÌ ĐÓ:\n" +
      "     + Trường 'startPage': Đọc chính xác số bút chì viết ở góc trên bên phải của trang. Định dạng chuẩn: nếu số từ 1 đến 9 phải thêm số 0 ở trước (Ví dụ: '01', '02', '03'..., '10', '15', '104'...). Tuyệt đối không để trống nếu trang có số bút chì.\n" +
      "     + Trường 'pageRange': Đọc chính xác khoảng trang bút chì ở góc trên bên phải. Nếu góc phải ghi khoảng trang bút chì (Ví dụ: '01-02', '1-2', '03-04', '15-18'...) thì 'pageRange' phải là chính xác khoảng đó (định dạng '01-02', '03-04', '15-18'...). Nếu góc phải chỉ ghi số bút chì đơn (Ví dụ: '01', '02'...) thì 'pageRange' chính là số bút chì đó (Ví dụ: '01', '02'...). Nếu văn bản kéo dài nhiều trang liên tiếp từ trang bút chì X đến Y thì ghi 'X-Y' (Ví dụ: '01-02').\n" +
      "   - NGUYÊN TẮC ƯU TIÊN: Luôn luôn ưu tiên số bút chì thực tế viết tay ở góc trên bên phải trang tài liệu hơn số thứ tự trang PDF thuần túy. Chỉ dùng số thứ tự trang nếu trang đó hoàn toàn không có dấu vết số bút chì.\n\n" +
      "QUY TẮC BỔ TRỢ CHO VĂN BẢN TIẾNG VIỆT:\n" +
      "1. VĂN BẢN ĐÁNH MÁY KIỂU CŨ (MÁY OLIVETTI, HERMES) VÀ CÔNG ĐIỆN BẰNG TIẾNG VIỆT:\n" +
      "   - Các văn bản này thường không có dấu hoặc sử dụng quy ước Telex cổ điển (Ví dụ: 'as' -> 'á', 'af' -> 'à', 'ax' -> 'ã', 'aj' -> 'ạ', 'ar' -> 'ả', 'ee' -> 'ê', 'oo' -> 'ô', 'aa' -> 'â', 'dd' -> 'đ', 'uw' -> 'ư', 'ow' -> 'ơ').\n" +
      "   - Bạn PHẢI dịch thuật, giải mã và chuyển đổi các ký tự Telex sang tiếng Việt có dấu một cách CHÍNH XÁC NHẤT.\n" +
      "   - Đảm bảo nội dung trích xuất hoàn toàn là tiếng Việt chuẩn, tự nhiên, không còn các ký tự Telex thừa hay lỗi font.\n" +
      "   - Nếu văn bản tiếng Việt hoàn toàn không có dấu (không dùng Telex), bạn phải dựa vào ngữ cảnh để thêm dấu tiếng Việt một cách chính xác nhất.\n\n" +
      "2. TÓM TẮT TRÍCH YẾU (Summary) CHO VĂN BẢN TIẾNG VIỆT:\n" +
      "   - Phải tóm tắt rõ ràng, ngắn gọn nhưng PHẢI ĐẦY ĐỦ NỘI DUNG cốt lõi.\n" +
      "   - TUYỆT ĐỐI KHÔNG lặp lại tên loại văn bản (docType) trong phần trích yếu.\n" +
      "   - Bắt đầu trích yếu bằng chữ thường (Ví dụ: \"về việc...\", \"kết quả...\"). CHỈ viết hoa nếu là tên riêng hoặc địa danh.\n\n" +
      "3. Cơ quan ban hành (authority) CHO VĂN BẢN TIẾNG VIỆT:\n" +
      "   - KHÔNG viết in hoa tất cả các chữ cái (trừ các từ viết tắt).\n" +
      "   - CHỈ viết hoa chữ cái đầu tiên và các từ là tên riêng.\n" +
      "   - Đối với BẢN TỰ KIỂM ĐIỂM, SƠ YẾU LÝ LỊCH...: Cơ quan ban hành chính là Tên cá nhân thực hiện văn bản.\n\n" +
      "4. Số hiệu: Ghi đầy đủ (Ví dụ: 12-QĐ/UBKTHU hoặc N° 1245). KHÔNG THÊM dấu nháy đơn '.\n\n" +
      "5. Ngày tháng: Định dạng dd/mm/yyyy. Nếu trang đó không có ngày tháng riêng, để trống.";

    let prompt = "Phân tích và trích xuất danh sách văn bản sang JSON theo đúng schema và hướng dẫn hệ thống.\n\n" +
      "⭐⭐⭐ MỆNH LỆNH CỐT LÕI TỐI CAO TỪ NGƯỜI DÙNG: TUYỆT ĐỐI KHÔNG DỊCH ĐỐI VỚI NHỮNG VĂN BẢN TIẾNG PHÁP ⭐⭐⭐\n" +
      "1. VĂN BẢN TIẾNG PHÁP -> GIỮ NGUYÊN 100% BẰNG TIẾNG PHÁP:\n" +
      "   - TUYỆT ĐỐI CẤM DỊCH SANG TIẾNG VIỆT trong bất kỳ trường hợp nào.\n" +
      "   - 'docType': Bắt buộc giữ nguyên tiếng Pháp (Arrêté, Décision, Circulaire, Rapport, Lettre, Télégramme, Procès-verbal, Bordereau...). TUYỆT ĐỐI KHÔNG dịch thành 'Nghị định', 'Quyết định', 'Báo cáo', 'Thư', 'Công văn'...\n" +
      "   - 'summary': Bắt buộc 100% tóm tắt trích yếu bằng tiếng Pháp (portant..., au sujet de..., relatif à...). TUYỆT ĐỐI KHÔNG dịch thành 'về việc...', 'liên quan đến...'.\n" +
      "   - 'authority': Bắt buộc 100% giữ nguyên tên tiếng Pháp (Gouverneur Général, Résident Supérieur, Province de..., Mairie de...). TUYỆT ĐỐI KHÔNG dịch thành 'Toàn quyền...', 'Thống sứ...', 'Khâm sứ...'...\n" +
      "   - 'symbol': Giữ nguyên ký hiệu gốc tiếng Pháp (N°...).\n" +
      "2. MỖI TRANG VĂN BẢN TRONG FILE PDF LÀ MỘT TRÍCH YẾU NỘI DUNG RIÊNG BIỆT (1 TRANG = 1 DÒNG TRÍCH YẾU):\n" +
      "   - Tuyệt đối không gộp trang. Hãy duyệt từng trang một từ đầu đến cuối và trích xuất đúng 1 dòng cho mỗi trang.\n" +
      "3. CHÍNH XÁC SỐ TRANG VÀ KHOẢNG TRANG BÚT CHÌ GÓC PHẢI PHÍA TRÊN MỖI TRANG:\n" +
      "   - Phải đọc đúng số viết tay bằng bút chì ở góc trên bên phải của từng trang ('startPage').\n" +
      "   - Phải đọc đúng khoảng trang bút chì ở góc trên bên phải ('pageRange', ví dụ '01', '01-02', '05-06'...). Thêm số 0 phía trước nếu số từ 1 đến 9.";

    if (pageStart && pageEnd) {
      const count = pageEnd - pageStart + 1;
      prompt += `\n- Phân đoạn này gồm chính xác ${count} trang (từ trang ${pageStart} đến trang ${pageEnd}). BẮT BUỘC kết quả trả về phải có đúng ${count} phần tử JSON tương ứng lần lượt với ${count} trang này.`;
    } else if (totalPages) {
      prompt += `\n- Tệp này gồm chính xác ${totalPages} trang. BẮT BUỘC kết quả trả về phải có đúng ${totalPages} phần tử JSON tương ứng lần lượt với từng trang.`;
    }

    // Prioritize high-availability candidate Gemini models
    const CANDIDATE_MODELS = [
      "gemini-3.1-flash-lite",
      "gemini-flash-latest",
      "gemini-3.6-flash",
      "gemini-3.8-flash",
    ];

    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    let responseText: string | undefined;
    let lastError: any = null;

    for (const modelName of CANDIDATE_MODELS) {
      // Try up to 2 attempts per model if temporary 503/429 occurs
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`Bắt đầu xử lý với mô hình: ${modelName} (lần thử ${attempt})...`);
          const response = await ai.models.generateContent({
            model: modelName,
            contents: [
              ...contentParts,
              { text: prompt },
            ],
            config: {
              temperature: 0,
              systemInstruction: systemInstruction,
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.ARRAY,
                description: "Danh sách văn bản bóc tách chuẩn cấu trúc",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    docType: {
                      type: Type.STRING,
                      description: "Loại văn bản. NẾU LÀ TIẾNG PHÁP: BẮT BUỘC 100% GIỮ NGUYÊN TIẾNG PHÁP (Arrêté, Décision, Circulaire, Rapport, Lettre, Télégramme, Procès-verbal...), TUYỆT ĐỐI CẤM DỊCH SANG TIẾNG VIỆT.",
                    },
                    symbol: {
                      type: Type.STRING,
                      description: "Số ký hiệu văn bản (Ví dụ: N° 123, 12-QĐ/UB...). Nếu không có để trống.",
                    },
                    date: {
                      type: Type.STRING,
                      description: "Ngày tháng ban hành theo định dạng dd/mm/yyyy. Nếu không có để trống.",
                    },
                    summary: {
                      type: Type.STRING,
                      description: "Tóm tắt trích yếu nội dung. NẾU LÀ TIẾNG PHÁP: BẮT BUỘC 100% TÓM TẮT BẰNG TIẾNG PHÁP (portant..., au sujet de..., relatif à...), TUYỆT ĐỐI CẤM DỊCH SANG TIẾNG VIỆT. Bắt đầu bằng chữ thường. Tuyệt đối không lặp lại tên loại văn bản ở đầu.",
                    },
                    authority: {
                      type: Type.STRING,
                      description: "Cơ quan ban hành hoặc người thực hiện. NẾU LÀ TIẾNG PHÁP: BẮT BUỘC 100% GIỮ NGUYÊN TÊN TIẾNG PHÁP (Gouverneur Général, Résident Supérieur, Province de...), TUYỆT ĐỐI CẤM DỊCH SANG TIẾNG VIỆT.",
                    },
                    startPage: {
                      type: Type.STRING,
                      description: "Số trang bút chì ghi ở góc trên bên phải của trang (định dạng '01', '02', '15'...).",
                    },
                    pageRange: {
                      type: Type.STRING,
                      description: "Khoảng trang bút chì ghi ở góc trên bên phải (Ví dụ: '01', '01-02', '05-06'...).",
                    },
                  },
                  required: ["docType", "symbol", "date", "summary", "authority", "startPage", "pageRange"],
                },
              },
            },
          });

          if (response && response.text) {
            responseText = response.text;
            console.log(`Bóc tách thành công bằng mô hình: ${modelName}`);
            break;
          }
        } catch (err: any) {
          lastError = err;
          const errMsg = err?.message || String(err);
          const isTemporary = errMsg.includes("503") || errMsg.includes("high demand") || errMsg.includes("UNAVAILABLE") || errMsg.includes("429");
          
          if (isTemporary && attempt < 2) {
            console.log(`Mô hình ${modelName} đang bận tạm thời, chờ 1.5s và thử lại...`);
            await delay(1500);
            continue;
          }
          // Chuyển sang mô hình dự phòng tiếp theo
          break;
        }
      }

      if (responseText) {
        break;
      }
    }

    if (!responseText) {
      const errMsg = lastError?.message || String(lastError);
      const is503 = errMsg.includes("503") || errMsg.includes("high demand") || errMsg.includes("UNAVAILABLE");
      const userMessage = is503
        ? "Máy chủ Google AI hiện đang quá tải tạm thời (503 High Demand). Vui lòng bấm 'Thử lại' sau ít giây."
        : "Đã xảy ra lỗi khi bóc tách tài liệu từ AI.";
      
      return res.status(503).json({
        error: userMessage,
        details: errMsg,
      });
    }

    let cleanJson = responseText.trim();
    const codeBlockMatch = cleanJson.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      cleanJson = codeBlockMatch[1].trim();
    } else {
      const firstBracket = cleanJson.indexOf('[');
      const firstBrace = cleanJson.indexOf('{');
      if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
        const lastBracket = cleanJson.lastIndexOf(']');
        if (lastBracket !== -1) {
          cleanJson = cleanJson.substring(firstBracket, lastBracket + 1);
        }
      } else if (firstBrace !== -1) {
        const lastBrace = cleanJson.lastIndexOf('}');
        if (lastBrace !== -1) {
          cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);
        }
      }
    }

    let parsedData: any;
    try {
      parsedData = JSON.parse(cleanJson);
    } catch (parseErr) {
      // Thử loại bỏ dấu phẩy thừa trước ngoặc đóng (trailing commas)
      const sanitized = cleanJson.replace(/,\s*([}\]])/g, "$1");
      try {
        parsedData = JSON.parse(sanitized);
      } catch (retryErr) {
        console.error("Lỗi parse JSON từ Gemini:", parseErr, "Raw output:", responseText.slice(0, 300));
        return res.status(500).json({
          success: false,
          error: "Không thể phân tích dữ liệu JSON trả về từ mô hình AI.",
          details: String(parseErr),
        });
      }
    }

    const documents = Array.isArray(parsedData) ? parsedData : (parsedData ? [parsedData] : []);
    res.json({
      success: true,
      data: documents,
    });
  } catch (error: any) {
    console.error("Lỗi trong quá trình xử lý tệp:", error);
    const errMsg = error?.message || String(error);
    const is503 = errMsg.includes("503") || errMsg.includes("high demand") || errMsg.includes("UNAVAILABLE");
    res.status(is503 ? 503 : 500).json({
      success: false,
      error: is503
        ? "Máy chủ Google AI hiện đang quá tải tạm thời (503 High Demand). Vui lòng bấm 'Thử lại' sau ít giây."
        : "Đã xảy ra lỗi khi bóc tách tài liệu",
      details: errMsg,
    });
  }
});

// Explicit API catch-all to guarantee NO /api request ever falls through or returns HTML
app.all("/api/*", (req, res) => {
  res.status(404).json({
    success: false,
    error: `Đường dẫn API '${req.method} ${req.originalUrl}' không tồn tại.`,
  });
});

// Create HTTP server instance
const server = http.createServer(app);

// Start listening immediately on PORT 3000 to ensure fast health check response
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});

// Attach Vite middleware in development or serve static files in production
let viteMiddleware: any = null;

if (process.env.NODE_ENV !== "production") {
  createViteServer({
    server: {
      middlewareMode: true,
      hmr: {
        server,
      },
    },
    appType: "spa",
  })
    .then((vite) => {
      viteMiddleware = vite.middlewares;
      console.log("Vite dev middleware attached successfully.");
    })
    .catch((err) => {
      console.error("Failed to initialize Vite dev server:", err);
    });

  // Delegate non-API requests to Vite
  app.use((req, res, next) => {
    // Absolutely protect API routes from Vite fallback
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({
        success: false,
        error: `API route '${req.path}' not found.`,
      });
    }

    if (viteMiddleware) {
      return viteMiddleware(req, res, next);
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Refresh", "1");
    res.send("<!DOCTYPE html><html><head><title>Starting...</title></head><body style='font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc;'><div style='text-align:center;'><h2>Đang khởi động ứng dụng...</h2><p style='color:#64748b;font-size:14px;'>Đang tải tài nguyên Vite, trang sẽ tự động tải trong giây lát.</p></div></body></html>");
  });
} else {
  const distPath = path.join(process.cwd(), "dist");
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ success: false, error: "API endpoint not found" });
    }
    res.sendFile(path.join(distPath, "index.html"));
  });
}

// Global server error handling middleware - always returns JSON for /api routes
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Lỗi máy chủ không xử lý:", err);
  if (res.headersSent) {
    return next(err);
  }
  if (req.path.startsWith("/api/")) {
    return res.status(err.status || 500).json({
      success: false,
      error: err.message || "Lỗi máy chủ nội bộ",
      details: String(err),
    });
  }
  res.status(500).send("Internal Server Error");
});

