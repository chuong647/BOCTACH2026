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
    const { pdfBase64, fileBase64, fileType, fileName } = req.body;

    const base64 = fileBase64 || pdfBase64;
    const mimeType = fileType || (pdfBase64 ? "application/pdf" : undefined);

    if (!base64) {
      return res.status(400).json({ error: "Yêu cầu cung cấp dữ liệu tệp (PDF hoặc hình ảnh) dưới dạng Base64" });
    }

    if (!mimeType) {
      return res.status(400).json({ error: "Yêu cầu cung cấp định dạng tệp (MIME type)" });
    }

    console.log(`Starting extraction for: ${fileName || "unnamed"} (MIME: ${mimeType}, Size: ${Math.round(base64.length / 1024)} KB base64)`);

    const ai = getGeminiClient();

    // Prepare file inline data part
    const filePart = {
      inlineData: {
        mimeType: mimeType,
        data: base64,
      },
    };

    // System instruction and user prompt targeting the extraction guidelines
    const systemInstruction = 
      "Bạn là chuyên gia văn thư lưu trữ, chuyên gia giải mã văn bản lịch sử và hệ thống trích xuất dữ liệu tài liệu văn bản PDF sang dạng bảng danh mục có cấu trúc.\n\n" +
      "CHỈ THỊ QUAN TRỌNG NHẤT (NGUYÊN TẮC BẤT DI BẤT DỊCH):\n" +
      "1. CÁC DÒNG TRONG FILE PDF NHƯ THẾ NÀO THÌ BẮT BUỘC GIỮ NGUYÊN 100% NHƯ THẾ:\n" +
      "   - Từng dòng trong tệp PDF gốc xuất hiện theo thứ tự nào (từ trên xuống dưới, từ trang 1 đến trang cuối cùng) thì trong kết quả trả về PHẢI GIỮ NGUYÊN ĐÚNG VỊ TRÍ Y HỆT NHƯ VẬY.\n" +
      "   - TUYỆT ĐỐI KHÔNG THAY ĐỔI VỊ TRÍ: Không sắp xếp lại (không sort), không đảo lộn trật tự các dòng, không gom nhóm, không phân loại lại.\n" +
      "2. TUYỆT ĐỐI KHÔNG XÓA BẤT KỲ DÒNG NÀO (KHÔNG ĐƯỢC BỎ SÓT HOẶC LỌC BỎ):\n" +
      "   - File PDF gốc có bao nhiêu dòng/văn bản thì trong kết quả trả về phải có bấy nhiêu phần tử, ánh xạ 1-1 chính xác theo từng dòng.\n" +
      "   - KHÔNG XÓA DÒNG TRÙNG LẶP: Dù các dòng trùng số hiệu, trùng ngày tháng hoặc trùng nội dung thì xuất hiện bao nhiêu lần trong file PDF phải tạo bấy nhiêu dòng riêng biệt tại đúng vị trí xuất hiện của nó.\n" +
      "   - KHÔNG XÓA CÁC VĂN BẢN CÓ SỐ HIỆU CHỨA: 'Vinaincon', 'VINAINCON', 'BBNT' (Biên bản nghiệm thu) hoặc bất kỳ ký hiệu nào khác.\n" +
      "   - KHÔNG XÓA DÒNG THIẾU THÔNG TIN: Nếu dòng nào không có số hiệu thì để symbol là \"\", nếu không có ngày tháng thì để date là \"\", nhưng BẮT BUỘC VẪN PHẢI GIỮ DÒNG ĐÓ trong danh sách.\n" +
      "   - TUYỆT ĐỐI KHÔNG GỘP DÒNG: Mỗi dòng trong bảng của tài liệu PDF là một đối tượng độc lập, không gộp 2 dòng thành 1.\n" +
      "3. QUY TẮC GIẢI MÃ VĂN BẢN & TIẾNG VIỆT:\n" +
      "   - Đối với văn bản đánh máy kiểu cũ (máy Olivetti, Hermes) và công điện: thường không có dấu hoặc dùng Telex cổ điển ('as'->'á', 'af'->'à', 'ax'->'ã', 'aj'->'ạ', 'ar'->'ả', 'ee'->'ê', 'oo'->'ô', 'aa'->'â', 'dd'->'đ', 'uw'->'ư', 'ow'->'ơ'). Bạn PHẢI giải mã sang tiếng Việt có dấu chính xác nhất.\n" +
      "   - Tóm tắt trích yếu (summary): Bắt đầu bằng chữ thường (ví dụ: 'về việc...', 'kết quả...'). Tuyệt đối không lặp lại tên loại văn bản (docType) ở đầu trích yếu.\n" +
      "   - Cơ quan ban hành (authority): Viết hoa chữ cái đầu và tên riêng, không viết hoa toàn bộ. Đối với bản kiểm điểm, sơ yếu lý lịch: cơ quan ban hành là tên cá nhân thực hiện.\n" +
      "   - Số hiệu (symbol): Ghi đầy đủ (ví dụ: 12-QĐ/UBKTHU, 12/BB-UBND, 01/BBNT). Không thêm dấu nháy đơn '.\n" +
      "   - Ngày tháng (date): Định dạng dd/mm/yyyy.\n" +
      "   - Số trang bắt đầu (startPage): Trích xuất số bút chì ghi ở góc trên bên phải trang đầu mỗi văn bản (nếu từ 1-9 thì thêm số 0 ở trước: '01', '02'...). Nếu không tìm thấy để trống.\n" +
      "4. QUÉT TOÀN BỘ CÁC TRANG CỦA TỆP: Duyệt qua tất cả các trang từ trang đầu tiên đến trang cuối cùng, không dừng giữa chừng.";

    const prompt = 
      "LƯU Ý CỰC KỲ QUAN TRỌNG TỪ NGƯỜI DÙNG:\n" +
      "- CÁC DÒNG TRONG FILE PDF NHƯ THẾ NÀO, HÃY GIỮ NGUYÊN NHƯ THẾ, KHÔNG THAY ĐỔI VỊ TRÍ, KHÔNG XÓA BẤT KỲ DÒNG NÀO.\n" +
      "- Giữ nguyên 100% thứ tự từng dòng từ trên xuống dưới, từ trang trước sang trang sau.\n" +
      "- Giữ đầy đủ tất cả các dòng: không xóa dòng trùng, không xóa văn bản số hiệu Vinaincon, BBNT, không xóa các dòng thiếu số hiệu hoặc thời gian.\n" +
      "- Bóc tách chuẩn cấu trúc các trường: index, symbol, date, docType, summary, authority, startPage, pageRange, original.";

    // Prioritize candidate Gemini models
    const CANDIDATE_MODELS = [
      "gemini-3.6-flash",
      "gemini-3.8-flash",
      "gemini-3.1-flash-lite",
      "gemini-flash-latest",
    ];

    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    let responseText: string | undefined;
    let lastError: any = null;

    for (const modelName of CANDIDATE_MODELS) {
      try {
        console.log(`Bắt đầu xử lý với mô hình: ${modelName}...`);
        const response = await ai.models.generateContent({
          model: modelName,
          contents: [filePart, { text: prompt }],
          config: {
            temperature: 0,
            systemInstruction: systemInstruction,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              description: "Danh sách từng dòng dữ liệu từ file PDF được giữ nguyên 100% vị trí, thứ tự và không xóa bất kỳ dòng nào.",
              items: {
                type: Type.OBJECT,
                properties: {
                  index: {
                    type: Type.INTEGER,
                    description: "Số thứ tự liên tục tăng dần từ 1 tương ứng với từng dòng theo đúng vị trí trong PDF",
                  },
                  symbol: {
                    type: Type.STRING,
                    description: "Số hiệu: Số và ký hiệu của văn bản/biên bản (ví dụ: '12/BB-UBND', '.../Vinaincon', '01/BBNT', 'BBNT-XD...'). Nếu không có số hiệu thì để chuỗi rỗng '', TUYỆT ĐỐI KHÔNG ĐƯỢC XÓA DÒNG.",
                  },
                  date: {
                    type: Type.STRING,
                    description: "Ngày ban hành: Ngày tháng hoặc thời gian lập/ban hành (định dạng dd/mm/yyyy). Nếu không có, để chuỗi rỗng '', TUYỆT ĐỐI KHÔNG ĐƯỢC XÓA DÒNG.",
                  },
                  docType: {
                    type: Type.STRING,
                    description: "Loại văn bản: Quyết định, Thông báo, Công văn, Biên bản, Biên bản nghiệm thu, Kế hoạch...",
                  },
                  summary: {
                    type: Type.STRING,
                    description: "Trích yếu nội dung: Nội dung của dòng bằng tiếng Việt sạch sẽ, bắt đầu bằng chữ thường, không lặp lại tên loại văn bản",
                  },
                  authority: {
                    type: Type.STRING,
                    description: "Cơ quan ban hành hoặc cá nhân lập văn bản",
                  },
                  startPage: {
                    type: Type.STRING,
                    description: "Số trang bắt đầu bằng bút chì ở góc trên bên phải ('01', '02'...). Nếu không có để chuỗi rỗng ''",
                  },
                  pageRange: {
                    type: Type.STRING,
                    description: "Khoảng trang xuất hiện (ví dụ: '01', '01-02', 'Trang 1')",
                  },
                  original: {
                    type: Type.STRING,
                    description: "Nội dung chữ gốc đầy đủ ban đầu của dòng trong file PDF",
                  },
                },
                required: ["index", "symbol", "date", "docType", "summary", "authority", "startPage", "pageRange", "original"],
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
        console.warn(`Mô hình ${modelName} gặp lỗi:`, errMsg);
        // Switch quickly to next candidate model with a brief backoff
        await delay(500);
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
    if (cleanJson.startsWith("```json")) {
      cleanJson = cleanJson.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    } else if (cleanJson.startsWith("```")) {
      cleanJson = cleanJson.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }

    const parsedData = JSON.parse(cleanJson);
    res.json({
      success: true,
      data: parsedData,
    });
  } catch (error: any) {
    console.error("Lỗi trong quá trình xử lý tệp:", error);
    const errMsg = error?.message || String(error);
    const is503 = errMsg.includes("503") || errMsg.includes("high demand") || errMsg.includes("UNAVAILABLE");
    res.status(500).json({
      error: is503
        ? "Máy chủ Google AI hiện đang quá tải tạm thời (503 High Demand). Vui lòng bấm 'Thử lại' sau ít giây."
        : "Đã xảy ra lỗi khi bóc tách tài liệu",
      details: errMsg,
    });
  }
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
    if (viteMiddleware) {
      return viteMiddleware(req, res, next);
    }
    if (req.path.startsWith("/api/")) {
      return next();
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Refresh", "1");
    res.send("<!DOCTYPE html><html><head><title>Starting...</title></head><body style='font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc;'><div style='text-align:center;'><h2>Đang khởi động ứng dụng...</h2><p style='color:#64748b;font-size:14px;'>Đang tải tài nguyên Vite, trang sẽ tự động tải trong giây lát.</p></div></body></html>");
  });
} else {
  const distPath = path.join(process.cwd(), "dist");
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

