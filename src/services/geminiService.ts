import { ExtractedDocument } from '../types';
import { PDFDocument } from 'pdf-lib';

const API_LIMIT_BYTES = 4 * 1024 * 1024; // 4MB ngưỡng an toàn cho proxy Nginx & Cloud Run
const PAGES_PER_CHUNK = 3; // 3 trang mỗi phân đoạn PDF: phản hồi nhanh, không timeout 60s và không vượt payload limit
const IMAGES_PER_CHUNK = 2; // 2 ảnh mỗi lượt gửi: đảm bảo dung lượng nhẹ

const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Lỗi khi đọc file."));
  });
};

// Tối ưu hóa ảnh tải lên để tránh lỗi 413 Payload Too Large
const optimizeImageForAi = async (file: File): Promise<{ mimeType: string; data: string }> => {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) {
      fileToBase64(file).then(base64 => resolve({ mimeType: file.type || 'image/jpeg', data: base64 }));
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const maxDim = 2048;
      let width = img.width;
      let height = img.height;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
        const base64 = dataUrl.split(',')[1];
        resolve({ mimeType: 'image/jpeg', data: base64 });
        return;
      }
      fileToBase64(file).then(base64 => resolve({ mimeType: file.type || 'image/jpeg', data: base64 }));
    };
    img.onerror = () => {
      fileToBase64(file).then(base64 => resolve({ mimeType: file.type || 'image/jpeg', data: base64 }));
    };
    img.src = url;
  });
};

interface ContentPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

interface ExtractOptions {
  parts: ContentPart[];
  fileName?: string;
  pageStart?: number;
  pageEnd?: number;
  totalPages?: number;
  isPdf?: boolean;
}

const callExtractApi = async (options: ExtractOptions, retries = 2): Promise<ExtractedDocument[]> => {
  try {
    const response = await fetch('/api/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(options),
    });

    const contentType = response.headers.get('content-type') || '';
    let result: any = null;
    let rawText = '';

    if (contentType.includes('application/json')) {
      try {
        result = await response.json();
      } catch (jsonErr) {
        console.warn("Lỗi phân tích JSON phản hồi:", jsonErr);
      }
    } else {
      rawText = await response.text();
    }

    if (!response.ok) {
      let errText = result?.error || result?.details;
      if (!errText) {
        if (response.status === 413 || rawText.includes('413') || rawText.toLowerCase().includes('payload too large') || rawText.toLowerCase().includes('entity too large')) {
          errText = 'Dung lượng phân đoạn tệp vượt quá giới hạn (413 Payload Too Large). Hệ thống sẽ tự động phân tách nhỏ hơn.';
        } else if (response.status === 504 || rawText.includes('504') || rawText.toLowerCase().includes('gateway timeout')) {
          errText = 'Quá thời gian chờ xử lý từ AI (504 Gateway Timeout). Đang tự động gửi lại...';
        } else if (response.status === 502 || rawText.includes('502') || rawText.toLowerCase().includes('bad gateway')) {
          errText = 'Máy chủ phản hồi gián đoạn (502 Bad Gateway). Đang tự động thử lại...';
        } else if (response.status === 503 || rawText.includes('503') || rawText.toLowerCase().includes('high demand') || rawText.toLowerCase().includes('unavailable')) {
          errText = 'Máy chủ Google AI hiện đang quá tải tạm thời (503 High Demand). Đang tự động thử lại sau ít giây...';
        } else if (rawText.includes('Đang khởi động ứng dụng')) {
          errText = 'Máy chủ đang khởi tạo tài nguyên. Đang tự động thử lại...';
        } else {
          errText = `Máy chủ phản hồi mã lỗi ${response.status}.`;
        }
      }

      if (retries > 0) {
        console.warn(`Máy chủ phản hồi lỗi (${response.status}), tự động thử lại sau 2.5 giây (${retries} lượt còn lại)...`);
        await new Promise(res => setTimeout(res, 2500));
        return callExtractApi(options, retries - 1);
      }
      throw new Error(errText);
    }

    // Xử lý khi response.ok (200 OK)
    if (result && result.success === false) {
      const errText = result.error || result.details || 'Không thể bóc tách tài liệu.';
      if (retries > 0 && (errText.includes('503') || errText.includes('quá tải') || errText.includes('high demand'))) {
        await new Promise(res => setTimeout(res, 2500));
        return callExtractApi(options, retries - 1);
      }
      throw new Error(errText);
    }

    // Trích xuất mảng tài liệu từ nhiều định dạng phản hồi có thể có
    let rawData: ExtractedDocument[] = [];
    if (Array.isArray(result)) {
      rawData = result;
    } else if (result && Array.isArray(result.data)) {
      rawData = result.data;
    } else if (result && Array.isArray(result.documents)) {
      rawData = result.documents;
    } else if (result && Array.isArray(result.results)) {
      rawData = result.results;
    } else if (result && typeof result === 'object') {
      if (result.docType || result.summary) {
        rawData = [result as ExtractedDocument];
      }
    }

    // Hậu xử lý dữ liệu
    rawData.forEach(doc => {
      if (doc.startPage && /^\d$/.test(doc.startPage.toString().trim())) {
        doc.startPage = `0${doc.startPage.toString().trim()}`;
      }
              
      if (doc.docType && doc.summary) {
        let summary = doc.summary.trim();
        const docTypeLower = doc.docType.toLowerCase().trim();
                  
        if (summary.toLowerCase().startsWith(docTypeLower)) {
          summary = summary.substring(docTypeLower.length).trim();
        }
                  
        if (summary.length > 0) {
          summary = summary.charAt(0).toLowerCase() + summary.slice(1);
        }
                  
        doc.summary = summary;
      }
    });

    return rawData;
  } catch (err: any) {
    if (retries > 0 && (err?.message?.includes('503') || err?.message?.includes('high demand') || err?.message?.includes('quá tải'))) {
      console.warn(`Lỗi tạm thời khi gọi API, tự động thử lại sau 2 giây (${retries} lượt còn lại)...`);
      await new Promise(res => setTimeout(res, 2000));
      return callExtractApi(options, retries - 1);
    }
    throw err;
  }
};

const cleanPencilString = (val?: string): string => {
  if (!val) return '';
  return val.toString().trim().replace(/['"`]/g, '');
};

const formatPencilNumber = (str: string): string => {
  const trimmed = str.trim();
  if (!trimmed) return '';

  // If it's a range e.g. "01-02", "1-2", "01 - 02", "1–2"
  if (trimmed.includes('-') || trimmed.includes('–')) {
    const parts = trimmed.split(/[-–]/).map(p => p.trim());
    if (parts.length === 2) {
      const p1 = parseInt(parts[0], 10);
      const p2 = parseInt(parts[1], 10);
      const s1 = !isNaN(p1) ? (p1 < 10 ? `0${p1}` : `${p1}`) : parts[0];
      const s2 = !isNaN(p2) ? (p2 < 10 ? `0${p2}` : `${p2}`) : parts[1];
      return `${s1}-${s2}`;
    }
    return trimmed;
  }

  // Single number
  const num = parseInt(trimmed, 10);
  if (!isNaN(num)) {
    return num < 10 ? `0${num}` : `${num}`;
  }
  return trimmed;
};

const formatAndCalculateRanges = (allResults: ExtractedDocument[]): ExtractedDocument[] => {
  return allResults.map((doc, index, array) => {
    let rawStart = cleanPencilString(doc.startPage);
    let rawRange = cleanPencilString(doc.pageRange);

    // If rawStart itself contains a range (e.g. "01-02") and rawRange was empty
    if ((rawStart.includes('-') || rawStart.includes('–')) && !rawRange) {
      rawRange = rawStart;
      rawStart = rawStart.split(/[-–]/)[0].trim();
    }

    // Format startPage
    let formattedStart = '';
    if (rawStart) {
      formattedStart = formatPencilNumber(rawStart);
    } else {
      // Fallback only if no pencil page was detected on document
      formattedStart = (index + 1) < 10 ? `0${index + 1}` : `${index + 1}`;
    }
    doc.startPage = formattedStart;

    // Determine pageRange
    let finalRange = '';
    if (rawRange && rawRange !== '-') {
      finalRange = formatPencilNumber(rawRange);
    } else {
      // Check if next document has a startPage to calculate range
      const nextDoc = array[index + 1];
      const startNum = parseInt(formattedStart, 10);
      if (nextDoc && nextDoc.startPage) {
        const nextStartRaw = cleanPencilString(nextDoc.startPage).split(/[-–]/)[0].trim();
        const nextStartNum = parseInt(nextStartRaw, 10);
        if (!isNaN(startNum) && !isNaN(nextStartNum) && nextStartNum > startNum + 1) {
          const endNum = nextStartNum - 1;
          const endStr = endNum < 10 ? `0${endNum}` : `${endNum}`;
          finalRange = `${formattedStart}-${endStr}`;
        }
      }
      
      // Default: the page range is the pencil page itself
      if (!finalRange) {
        finalRange = formattedStart;
      }
    }

    // Prefix single quote for Excel text formatting
    const displayRange = finalRange.startsWith("'") ? finalRange : `'${finalRange}`;

    let formattedDate = doc.date ? (doc.date.startsWith("'") ? doc.date.substring(1) : doc.date) : "";
    if (formattedDate) {
      const parts = formattedDate.split('/');
      if (parts.length === 3) {
        let [day, month, year] = parts;
        const monthNum = parseInt(month, 10);
        if (!isNaN(monthNum)) {
          if (monthNum >= 1 && monthNum <= 3) {
            month = monthNum.toString().padStart(2, '0');
          } else if (monthNum >= 4 && monthNum <= 9) {
            month = monthNum.toString();
          }
          formattedDate = `${day}/${month}/${year}`;
        }
      }
      formattedDate = `'${formattedDate}`;
    }

    return {
      ...doc,
      date: formattedDate,
      startPage: formattedStart,
      pageRange: displayRange,
    };
  });
};

export const extractDataFromFiles = async (files: File[]): Promise<ExtractedDocument[]> => {
  let allResults: ExtractedDocument[] = [];

  const pdfFiles = files.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  const imageFiles = files.filter(f => f.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|tiff)$/i.test(f.name));

  // 1. Xử lý các tệp PDF
  for (const pdfFile of pdfFiles) {
    const arrayBuffer = await pdfFile.arrayBuffer();
    const pdfDoc = await PDFDocument.load(arrayBuffer);
    const totalPdfPages = pdfDoc.getPageCount();

    if (pdfFile.size <= API_LIMIT_BYTES && totalPdfPages <= PAGES_PER_CHUNK) {
      const base64Data = await fileToBase64(pdfFile);
      const pdfResults = await callExtractApi({
        parts: [{ inlineData: { mimeType: "application/pdf", data: base64Data } }],
        fileName: pdfFile.name,
        pageStart: 1,
        pageEnd: totalPdfPages,
        totalPages: totalPdfPages,
        isPdf: true,
      });
      allResults.push(...pdfResults);
    } else {
      for (let i = 0; i < totalPdfPages; i += PAGES_PER_CHUNK) {
        const newDoc = await PDFDocument.create();
        const end = Math.min(i + PAGES_PER_CHUNK, totalPdfPages);
        const pagesToCopy = Array.from({ length: end - i }, (_, k) => i + k);
        const copiedPages = await newDoc.copyPages(pdfDoc, pagesToCopy);
        copiedPages.forEach(page => newDoc.addPage(page));
        const pdfBytes = await newDoc.save();
        const base64Chunk = uint8ArrayToBase64(pdfBytes);
        const chunkResults = await callExtractApi({
          parts: [{ inlineData: { mimeType: "application/pdf", data: base64Chunk } }],
          fileName: `${pdfFile.name} (trang ${i + 1}-${end}/${totalPdfPages})`,
          pageStart: i + 1,
          pageEnd: end,
          totalPages: totalPdfPages,
          isPdf: true,
        });
        allResults.push(...chunkResults);
      }
    }
  }

  // 2. Xử lý các tệp ảnh (Hình ảnh đính kèm / nhiều ảnh)
  if (imageFiles.length > 0) {
    for (let i = 0; i < imageFiles.length; i += IMAGES_PER_CHUNK) {
      const chunk = imageFiles.slice(i, i + IMAGES_PER_CHUNK);
      const imageParts: ContentPart[] = [];
      for (const imgFile of chunk) {
        const opt = await optimizeImageForAi(imgFile);
        imageParts.push({ inlineData: opt });
      }
      if (imageParts.length > 0) {
        const imgResults = await callExtractApi({
          parts: imageParts,
          fileName: `Ảnh (${i + 1}-${i + chunk.length}/${imageFiles.length})`,
          pageStart: i + 1,
          pageEnd: i + chunk.length,
          totalPages: imageFiles.length,
          isPdf: false,
        });
        allResults.push(...imgResults);
      }
    }
  }

  return formatAndCalculateRanges(allResults);
};

export const extractDataFromPdf = async (file: File): Promise<ExtractedDocument[]> => {
  return extractDataFromFiles([file]);
};
