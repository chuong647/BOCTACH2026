import { ExtractedDocument } from '../types';
import { PDFDocument } from 'pdf-lib';

const API_LIMIT_BYTES = 30 * 1024 * 1024; // 30MB
const PAGES_PER_CHUNK = 15;

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

const callExtractApi = async (base64Data: string, fileName: string, fileType = 'application/pdf'): Promise<ExtractedDocument[]> => {
  const response = await fetch('/api/extract', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fileBase64: base64Data,
      fileType: fileType,
      fileName: fileName,
    }),
  });

  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || result.details || 'Không thể bóc tách tài liệu này.');
  }

  return (result.data || []).map((doc: any, idx: number) => {
    let startPage = (doc.startPage || '').toString().trim();
    if (startPage && /^\d$/.test(startPage)) {
      startPage = `0${startPage}`;
    }

    let summary = (doc.summary || doc.content || '').trim();
    const docType = (doc.docType || 'Văn bản').trim();
    const docTypeLower = docType.toLowerCase();

    // Xóa tên loại văn bản lặp lại ở đầu trích yếu
    if (summary.toLowerCase().startsWith(docTypeLower)) {
      summary = summary.substring(docTypeLower.length).trim();
    }

    // Viết thường chữ cái đầu tiên của trích yếu
    if (summary.length > 0) {
      summary = summary.charAt(0).toLowerCase() + summary.slice(1);
    }

    return {
      index: doc.index ?? idx + 1,
      symbol: doc.symbol || doc.recordNumber || '',
      date: doc.date || doc.recordTime || '',
      docType: docType,
      summary: summary,
      authority: doc.authority || '',
      startPage: startPage,
      pageRange: doc.pageRange || '',
      original: doc.original || '',
    };
  });
};

export const extractDataFromPdf = async (file: File): Promise<ExtractedDocument[]> => {
  let allResults: ExtractedDocument[] = [];

  try {
    if (file.type === 'application/pdf') {
      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(arrayBuffer);
      const totalPdfPages = pdfDoc.getPageCount();

      if (file.size <= API_LIMIT_BYTES && totalPdfPages <= PAGES_PER_CHUNK) {
        const base64Data = await fileToBase64(file);
        allResults = await callExtractApi(base64Data, file.name, file.type);
      } else {
        // Chunking large PDF
        for (let i = 0; i < totalPdfPages; i += PAGES_PER_CHUNK) {
          const newDoc = await PDFDocument.create();
          const end = Math.min(i + PAGES_PER_CHUNK, totalPdfPages);
          const pagesToCopy = Array.from({ length: end - i }, (_, k) => i + k);
          const copiedPages = await newDoc.copyPages(pdfDoc, pagesToCopy);
          copiedPages.forEach(page => newDoc.addPage(page));
          const pdfBytes = await newDoc.save();
          const base64Chunk = uint8ArrayToBase64(pdfBytes);
          const chunkResults = await callExtractApi(base64Chunk, `${file.name}-part-${Math.floor(i / PAGES_PER_CHUNK) + 1}`, 'application/pdf');
          allResults = [...allResults, ...chunkResults];
        }
      }
    } else {
      const base64Data = await fileToBase64(file);
      allResults = await callExtractApi(base64Data, file.name, file.type);
    }

    // HẬU XỬ LÝ: Tính toán pageRange và định dạng ngày tháng như trong CQ-cu-1
    return allResults.map((doc, index, array) => {
      const startPage = doc.startPage?.toString().trim();
      
      let displayRange = "";
      if (startPage) {
        let endPage: number | null = null;
        
        // Tìm startPage tiếp theo có giá trị để tính endPage
        for (let j = index + 1; j < array.length; j++) {
          const nextStart = array[j].startPage?.toString().trim();
          if (nextStart && !isNaN(Number(nextStart))) {
            endPage = Number(nextStart) - 1;
            break;
          }
        }

        // Logic: Số trang bắt đầu-Số trang kết thúc
        displayRange = `'${startPage}`;
        if (endPage !== null && endPage > Number(startPage)) {
          const endPageStr = endPage < 10 ? `0${endPage}` : `${endPage}`;
          displayRange = `'${startPage}-${endPageStr}`;
        }
      }

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
        date: formattedDate || doc.date,
        pageRange: displayRange || doc.pageRange || (startPage ? `'${startPage}` : '')
      };
    });
  } catch (error: any) {
    throw new Error(error.message || "Lỗi xử lý PDF.");
  }
};
