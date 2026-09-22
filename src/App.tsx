
import React, { useState, useRef, useEffect } from 'react';
import { extractDataFromFiles } from './services/geminiService';
import { DataTable } from './components/DataTable';
import { BannerCarousel } from './components/BannerCarousel';
import { exportToExcel } from './utils/excelExport';
import { ExtractedDocument, ProcessingStatus, ExcelExportConfig, ThemeConfig, HistoryItem } from './types';
import { 
  FileUp, FileSpreadsheet, Loader2, AlertCircle, Check, Copy, Settings, X, 
  UploadCloud, History, Trash2, Cpu, Palette, Monitor, FileText, Image as ImageIcon,
  Images, Plus, Sparkles, Globe, CheckCircle2, Layers, Hash
} from 'lucide-react';

const THEMES: ThemeConfig[] = [
  { id: 'blue', name: 'Xanh dương', primary: 'blue', gray: 'slate' },
  { id: 'emerald', name: 'Thiên nhiên', primary: 'emerald', gray: 'zinc' },
  { id: 'violet', name: 'Sáng tạo', primary: 'violet', gray: 'slate' },
  { id: 'rose', name: 'Nổi bật', primary: 'rose', gray: 'stone' },
  { id: 'amber', name: 'Mặc định', primary: 'amber', gray: 'neutral' },
];

const PRESET_BG_COLORS = [
  { name: 'Sương mai', value: '#F8FAFC' },
  { name: 'Bạc hà', value: '#F0FDF4' },
  { name: 'Bầu trời', value: '#F0F9FF' },
  { name: 'Oải hương', value: '#F5F3FF' },
  { name: 'Cát trắng', value: '#FAFAF9' },
  { name: 'Hồng phấn', value: '#FFF1F2' },
  { name: 'Cam đào', value: '#FFF7ED' },
  { name: 'Mặc định', value: '#F5FFFA' },
];

const DEFAULT_BG_COLOR = '#F5FFFA';

const App: React.FC = () => {
  const [files, setFiles] = useState<File[]>([]);
  const [extractedData, setExtractedData] = useState<ExtractedDocument[]>([]);
  const [status, setStatus] = useState<ProcessingStatus>(ProcessingStatus.IDLE);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [progress, setProgress] = useState<number>(0);
  const [copySuccess, setCopySuccess] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [showNotification, setShowNotification] = useState<{message: string, type: 'success' | 'info' | 'error'} | null>(null);
  
  const [showConfigPanel, setShowConfigPanel] = useState<boolean>(false);
  const [showHistory, setShowHistory] = useState<boolean>(false);
  
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    const saved = localStorage.getItem('app_history');
    return saved ? JSON.parse(saved) : [];
  });

  const [backgroundColor, setBackgroundColor] = useState<string>(() => localStorage.getItem('app_bg_color') || DEFAULT_BG_COLOR);
  const [currentTheme, setCurrentTheme] = useState<ThemeConfig>(() => {
    const savedThemeId = localStorage.getItem('app_theme_id');
    if (savedThemeId) {
      const found = THEMES.find(t => t.id === savedThemeId);
      if (found) return found;
    }
    return THEMES[0];
  });

  const [excelConfig] = useState<ExcelExportConfig>({ fontName: 'Times New Roman', fontSize: 14, wrapText: true, allBorders: true });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addFileInputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const configPanelRef = useRef<HTMLDivElement>(null);
  
  const p = currentTheme.primary;
  const g = currentTheme.gray;

  useEffect(() => { localStorage.setItem('app_history', JSON.stringify(history)); }, [history]);
  useEffect(() => { localStorage.setItem('app_bg_color', backgroundColor); }, [backgroundColor]);
  useEffect(() => { localStorage.setItem('app_theme_id', currentTheme.id); }, [currentTheme]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (configPanelRef.current && !configPanelRef.current.contains(event.target as Node)) {
        setShowConfigPanel(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    let interval: any;
    if (status === ProcessingStatus.PROCESSING) {
      setProgress(0);
      interval = setInterval(() => {
        setProgress(prev => {
          const totalSize = files.reduce((acc, f) => acc + f.size, 0);
          if (totalSize > 20 * 1024 * 1024) {
             return prev >= 95 ? 95 : prev + 0.15;
          }
          return prev >= 98 ? 98 : prev + (prev > 80 ? 0.3 : 1.5);
        });
      }, 500);
    } else if (status === ProcessingStatus.SUCCESS) {
      setProgress(100);
      notify("Bóc tách thành công!", "success");
      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 500);
    }
    return () => clearInterval(interval);
  }, [status, files]);

  const notify = (message: string, type: 'success' | 'info' | 'error' = 'info') => {
    setShowNotification({ message, type });
    setTimeout(() => setShowNotification(null), 4000);
  };

  const handleExtractFiles = async (targetFiles: File[]) => {
    if (targetFiles.length === 0) return;
    setFiles(targetFiles);
    setStatus(ProcessingStatus.PROCESSING);
    setErrorMessage('');
    setExtractedData([]);
    
    try {
      const data = await extractDataFromFiles(targetFiles);
      setExtractedData(data);
      setStatus(ProcessingStatus.SUCCESS);
      
      const fileNameSummary = targetFiles.length === 1 
        ? targetFiles[0].name 
        : `${targetFiles.length} tệp (${targetFiles[0].name}...)`;

      const newHistoryItem: HistoryItem = {
        id: Date.now().toString(),
        timestamp: Date.now(),
        fileName: fileNameSummary,
        data: data
      };
      setHistory(prev => [newHistoryItem, ...prev]);
    } catch (err: any) {
      console.error(err);
      setStatus(ProcessingStatus.ERROR);
      const msg = err.message || "Đã xảy ra lỗi trong quá trình xử lý.";
      setErrorMessage(msg);
      notify(msg, "error");
    }
  };

  const isAcceptedFile = (f: File) => {
    return f.type === 'application/pdf' || f.type.startsWith('image/') || /\.(pdf|png|jpe?g|webp|bmp|tiff)$/i.test(f.name);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []) as File[];
    const valid = selected.filter(isAcceptedFile);
    
    if (valid.length > 0) {
      handleExtractFiles(valid);
    } else if (selected.length > 0) {
      notify("Hệ thống chỉ hỗ trợ định dạng PDF hoặc hình ảnh (PNG, JPG, WEBP...).", "error");
    }
  };

  const handleAppendFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []) as File[];
    const valid = selected.filter(isAcceptedFile);
    if (valid.length > 0) {
      const combined = [...files, ...valid];
      handleExtractFiles(combined);
    }
  };

  const handleRemoveFile = (index: number) => {
    const updated = files.filter((_, i) => i !== index);
    if (updated.length === 0) {
      setFiles([]);
      setStatus(ProcessingStatus.IDLE);
      setExtractedData([]);
    } else {
      handleExtractFiles(updated);
    }
  };

  const handleExport = () => {
    if (extractedData.length === 0) return;
    const baseName = files.length > 0 ? files[0].name.split('.')[0] : 'trich_xuat';
    exportToExcel(extractedData, `ket_qua_${baseName}`, excelConfig);
    notify("Đã xuất file Excel thành công", "success");
  };

  const handleCopy = async () => {
    if (extractedData.length === 0) return;
    const rows = extractedData.map(d => 
      `${d.symbol}\t${d.date}\t${d.docType} ${d.summary}\t${d.authority}\t${d.pageRange}`
    ).join('\n');
    
    try {
      await navigator.clipboard.writeText(rows);
      setCopySuccess(true);
      notify("Đã sao chép vào bộ nhớ tạm", "success");
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      notify("Lỗi khi sao chép", "error");
    }
  };

  const handleDeleteHistory = (id: string) => {
    setHistory(history.filter(h => h.id !== id));
    notify("Đã xóa bản ghi lịch sử", "info");
  };

  const handleLoadHistory = (item: HistoryItem) => {
    setExtractedData(item.data);
    setStatus(ProcessingStatus.SUCCESS);
    setFiles([new File([], item.fileName)]);
    setShowHistory(false);
    notify(`Đã tải lại kết quả: ${item.fileName}`, "success");
  };

  const imageCount = files.filter(f => f.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|tiff)$/i.test(f.name)).length;
  const pdfCount = files.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')).length;

  return (
    <div 
      className="min-h-screen transition-all duration-700 ease-in-out pb-20"
      style={{ backgroundColor }}
    >
      <nav className="bg-white/80 backdrop-blur-lg sticky top-0 z-40 border-b border-slate-200/50 shadow-sm">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`p-2.5 bg-${p}-500 text-white rounded-2xl shadow-lg shadow-${p}-500/20`}>
              <Cpu size={24} />
            </div>
            <div className="flex flex-col">
              <span className={`text-xl font-black text-${g}-900 tracking-tight leading-none`}>TRÍCH XUẤT TÀI LIỆU CHÍNH QUYỀN</span>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Hệ thống trích xuất văn bản v2.2 • Hỗ trợ PDF & Nhiều ảnh</span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={() => setShowHistory(true)}
              className="group flex items-center gap-2 px-5 py-2.5 rounded-2xl font-bold text-slate-600 hover:bg-white hover:shadow-md transition-all active:scale-95"
            >
              <History size={18} className="group-hover:rotate-[-30deg] transition-transform" /> 
              <span className="hidden sm:inline">Lịch sử</span>
            </button>
            <div className="w-px h-6 bg-slate-200 hidden sm:block"></div>
            <button 
              onClick={() => setShowConfigPanel(!showConfigPanel)}
              className={`p-2.5 rounded-2xl transition-all active:scale-90 relative ${showConfigPanel ? `bg-${p}-100 text-${p}-600` : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
            >
              <Settings size={22} className={showConfigPanel ? 'animate-spin-slow' : ''} />
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-6 py-10">
        <div className="space-y-12 animate-in fade-in duration-700">
          <BannerCarousel theme={currentTheme} />

          <div className="space-y-12">
            <div className="bg-white rounded-[3rem] shadow-2xl shadow-slate-200/50 border border-slate-100 p-8 sm:p-14 overflow-hidden relative group">
              <div className={`absolute top-0 right-0 p-12 opacity-[0.03] pointer-events-none text-${p}-500 transition-transform duration-1000 group-hover:scale-110`}>
                <UploadCloud size={400} strokeWidth={1} />
              </div>
              
              <div className="relative z-10">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-10">
                  <div className="flex items-center gap-5">
                    <div className={`p-5 bg-${p}-50 text-${p}-500 rounded-[2rem] shadow-inner`}>
                      <UploadCloud size={32} />
                    </div>
                    <div>
                      <h3 className="text-3xl font-black text-slate-900 leading-tight">Trung tâm bóc tách</h3>
                      <p className="text-slate-500 font-medium text-lg">Phân tích văn bản PDF & Đính kèm nhiều hình ảnh</p>
                    </div>
                  </div>

                  {/* Feature indicators for French, Telex, 1 Page = 1 Summary & Pencil Page Numbers */}
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="inline-flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-800 font-bold text-xs rounded-full border border-blue-200 shadow-sm">
                      <Globe size={14} className="text-blue-600" />
                      Tuyệt đối không dịch văn bản tiếng Pháp (100% nguyên bản)
                    </span>
                    <span className="inline-flex items-center gap-2 px-4 py-2 bg-amber-50 text-amber-800 font-bold text-xs rounded-full border border-amber-200 shadow-sm">
                      <FileText size={14} className="text-amber-600" />
                      Mỗi trang PDF = 1 trích yếu nội dung
                    </span>
                    <span className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-50 text-indigo-800 font-bold text-xs rounded-full border border-indigo-200 shadow-sm">
                      <Hash size={14} className="text-indigo-600" />
                      Chính xác số & khoảng trang bút chì góc phải trên
                    </span>
                    <span className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-50 text-emerald-700 font-bold text-xs rounded-full border border-emerald-100 shadow-sm">
                      <Sparkles size={14} className="text-emerald-600" />
                      Giải mã Telex & Thêm dấu tiếng Việt
                    </span>
                  </div>
                </div>

                <div 
                  className={`relative border-2 border-dashed rounded-[3rem] p-8 sm:p-16 transition-all cursor-pointer group/upload flex flex-col items-center justify-center ${
                    isDragging ? `border-${p}-500 bg-${p}-50/50 scale-[1.01] shadow-2xl` : `border-slate-200 hover:border-${p}-300 hover:bg-slate-50/20`
                  } ${status === ProcessingStatus.PROCESSING ? 'pointer-events-none opacity-60' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                    const droppedFiles = Array.from(e.dataTransfer.files || []) as File[];
                    const valid = droppedFiles.filter(isAcceptedFile);
                    if (valid.length > 0) handleExtractFiles(valid);
                  }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input 
                    type="file" 
                    ref={fileInputRef} 
                    className="hidden" 
                    accept=".pdf,image/*" 
                    multiple 
                    onChange={handleFileUpload} 
                  />
                  
                  <div className={`w-28 h-28 bg-${p}-50 text-${p}-500 rounded-full flex items-center justify-center mb-8 group-hover/upload:scale-110 transition-transform duration-700 shadow-xl shadow-${p}-500/10`}>
                    {status === ProcessingStatus.PROCESSING ? (
                      <Loader2 className="animate-spin" size={48} />
                    ) : (
                      <Images size={48} />
                    )}
                  </div>

                  <div className="text-center max-w-xl">
                    <p className="text-2xl font-black text-slate-800 mb-3">
                      Kéo thả hoặc chọn tệp PDF / Nhiều hình ảnh
                    </p>
                    <p className="text-slate-400 font-medium text-base leading-relaxed">
                      Hỗ trợ đính kèm nhiều ảnh trang tài liệu cùng lúc (JPG, PNG, WEBP) hoặc file PDF. AI tự động trích xuất các thông tin số hiệu, ngày tháng, trích yếu và cơ quan ban hành.
                    </p>
                  </div>

                  {status === ProcessingStatus.PROCESSING && (
                    <div className="mt-12 w-full max-w-xl">
                      <div className="flex justify-between items-end mb-4">
                        <div className="flex flex-col">
                          <span className={`text-xs font-black text-${p}-600 uppercase tracking-[0.2em] mb-1`}>
                            Đang xử lý dữ liệu qua Gemini AI
                          </span>
                          <span className="text-slate-500 font-bold text-sm">
                            Đang phân tích {files.length} tệp... Vui lòng chờ trong giây lát
                          </span>
                        </div>
                        <span className={`text-3xl font-black text-${p}-600 tabular-nums`}>{Math.round(progress)}%</span>
                      </div>
                      <div className="h-4 w-full bg-slate-100 rounded-full overflow-hidden shadow-inner p-1">
                        <div 
                          className={`h-full bg-${p}-500 rounded-full transition-all duration-300 ease-out shadow-lg shadow-${p}-500/30`}
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Staged / Uploaded Files List */}
                {files.length > 0 && (
                  <div className="mt-8 p-6 bg-slate-50/80 rounded-3xl border border-slate-200/80 animate-in fade-in duration-300">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <Layers size={20} className={`text-${p}-600`} />
                        <span className="font-black text-slate-800 text-sm">
                          Các tệp đang chọn ({files.length}):
                        </span>
                        {pdfCount > 0 && (
                          <span className="px-3 py-1 bg-red-100 text-red-700 font-bold text-xs rounded-full">
                            {pdfCount} PDF
                          </span>
                        )}
                        {imageCount > 0 && (
                          <span className="px-3 py-1 bg-blue-100 text-blue-700 font-bold text-xs rounded-full">
                            {imageCount} hình ảnh
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            addFileInputRef.current?.click();
                          }}
                          className={`flex items-center gap-1.5 px-4 py-2 bg-white text-${p}-600 border border-${p}-200 rounded-xl font-bold text-xs shadow-sm hover:bg-${p}-50 transition-all`}
                        >
                          <Plus size={16} /> Thêm ảnh / PDF
                        </button>
                        <input 
                          type="file" 
                          ref={addFileInputRef} 
                          className="hidden" 
                          accept=".pdf,image/*" 
                          multiple 
                          onChange={handleAppendFiles} 
                        />
                        
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setFiles([]);
                            setStatus(ProcessingStatus.IDLE);
                            setExtractedData([]);
                          }}
                          className="text-xs font-bold text-slate-400 hover:text-rose-600 px-3 py-2 rounded-xl transition-colors"
                        >
                          Xóa tất cả
                        </button>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2.5 max-h-48 overflow-y-auto p-1 custom-scrollbar">
                      {files.map((fileItem, idx) => {
                        const isImg = fileItem.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|tiff)$/i.test(fileItem.name);
                        return (
                          <div 
                            key={idx}
                            className="flex items-center gap-2.5 px-3.5 py-2 bg-white rounded-2xl border border-slate-200 shadow-sm text-xs font-medium text-slate-700 max-w-xs group"
                          >
                            {isImg ? (
                              <ImageIcon size={16} className="text-blue-500 shrink-0" />
                            ) : (
                              <FileText size={16} className="text-red-500 shrink-0" />
                            )}
                            <span className="truncate max-w-[150px]" title={fileItem.name}>
                              {fileItem.name}
                            </span>
                            <span className="text-[10px] text-slate-400 shrink-0">
                              ({(fileItem.size / (1024 * 1024)).toFixed(1)} MB)
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRemoveFile(idx);
                              }}
                              className="text-slate-300 hover:text-rose-500 ml-1 p-0.5 rounded-full transition-colors"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

              </div>
            </div>

            <div ref={resultsRef} className="space-y-12">
              {status === ProcessingStatus.ERROR && (
                <div className="bg-rose-50 rounded-[3rem] border border-rose-100 p-12 text-center animate-in zoom-in duration-500 relative overflow-hidden">
                  <div className="relative z-10">
                      <div className="w-20 h-20 bg-rose-100 text-rose-500 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner">
                        <AlertCircle size={40} />
                      </div>
                      <h4 className="text-2xl font-black text-rose-900">Có lỗi xảy ra</h4>
                      <p className="text-rose-600 mt-3 text-lg font-medium max-w-md mx-auto">{errorMessage}</p>
                      <button 
                        onClick={() => files.length > 0 && handleExtractFiles(files)}
                        className="mt-8 px-10 py-4 bg-rose-500 text-white rounded-2xl font-black shadow-xl shadow-rose-500/20 hover:bg-rose-600 transition-all active:scale-95"
                      >
                        Thử lại ngay
                      </button>
                  </div>
                </div>
              )}

              {(status === ProcessingStatus.SUCCESS || extractedData.length > 0) && (
                <div className="space-y-10 animate-in fade-in slide-in-from-bottom-10 duration-1000">
                  <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-8 px-4">
                    <div className="flex items-center gap-5">
                      <div className={`p-4 bg-${p}-100 text-${p}-600 rounded-[1.5rem]`}>
                        <Monitor size={28} />
                      </div>
                      <div>
                        <h3 className="text-3xl font-black text-slate-900 tracking-tight">Kết quả bóc tách</h3>
                        <p className="text-slate-500 font-bold mt-1 uppercase text-xs tracking-widest flex items-center gap-2">
                          <span>Tìm thấy {extractedData.length} văn bản</span>
                          <span className="text-slate-300">•</span>
                          <span className="text-blue-600 font-medium normal-case">Đã giữ nguyên văn bản tiếng Pháp (không dịch)</span>
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 w-full lg:w-auto">
                      <button
                        onClick={handleCopy}
                        className={`flex-1 lg:flex-none flex items-center justify-center gap-3 px-8 py-4 rounded-[1.5rem] font-black transition-all shadow-xl active:scale-95 ${
                          copySuccess 
                            ? 'bg-green-500 text-white shadow-green-500/20' 
                            : `bg-white text-${p}-600 border border-${p}-100 hover:bg-${p}-50 shadow-slate-200/50`
                        }`}
                      >
                        {copySuccess ? <Check size={20} strokeWidth={3} /> : <Copy size={20} />}
                        {copySuccess ? 'Đã sao chép' : 'Sao chép bảng'}
                      </button>
                      <button
                        onClick={handleExport}
                        className="flex-1 lg:flex-none flex items-center justify-center gap-3 px-8 py-4 bg-emerald-500 text-white rounded-[1.5rem] font-black shadow-xl shadow-emerald-500/20 hover:bg-emerald-600 hover:-translate-y-1 transition-all active:scale-95"
                      >
                        <FileSpreadsheet size={20} /> Xuất Excel
                      </button>
                    </div>
                  </div>
                  <DataTable data={extractedData} theme={currentTheme} />
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      <div className={`fixed inset-y-0 right-0 w-80 bg-white/95 backdrop-blur-2xl shadow-2xl z-[55] transform transition-transform duration-500 ease-out border-l border-slate-100 ${showConfigPanel ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="h-full flex flex-col p-8">
          <div className="flex items-center justify-between mb-10">
            <div className="flex items-center gap-3">
              <div className={`p-2 bg-${p}-100 text-${p}-600 rounded-xl`}>
                <Palette size={20} />
              </div>
              <h4 className="text-xl font-black text-slate-900 tracking-tight">Giao diện</h4>
            </div>
            <button onClick={() => setShowConfigPanel(false)} className="p-2 hover:bg-slate-100 rounded-full transition-colors"><X size={20} /></button>
          </div>

          <div className="flex-1 space-y-10 overflow-y-auto pr-2 custom-scrollbar">
            <section>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-5">Chủ đề màu sắc</p>
              <div className="grid grid-cols-5 gap-3">
                {THEMES.map(t => (
                  <button key={t.id} onClick={() => setCurrentTheme(t)} className={`aspect-square rounded-2xl border-2 transition-all ${currentTheme.id === t.id ? 'border-slate-900 ring-4 ring-slate-100' : 'border-transparent shadow-sm'}`} style={{ backgroundColor: t.primary === 'blue' ? '#3B82F6' : t.primary === 'emerald' ? '#10B981' : t.primary === 'violet' ? '#8B5CF6' : t.primary === 'rose' ? '#F43F5E' : '#F59E0B' }} />
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>

      {showHistory && (
        <div className="fixed inset-0 z-[60] flex justify-end">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" onClick={() => setShowHistory(false)} />
          <div className="relative w-full max-w-md bg-white h-full shadow-2xl p-8 animate-in slide-in-from-right duration-500">
            <div className="flex items-center justify-between mb-10">
              <div className="flex items-center gap-3"><History size={20} /><h3 className="text-2xl font-black">Lịch sử</h3></div>
              <button onClick={() => setShowHistory(false)}><X size={24} /></button>
            </div>
            <div className="space-y-4 overflow-y-auto max-h-[calc(100vh-200px)]">
              {history.map(item => (
                <div key={item.id} className="p-5 bg-slate-50 rounded-3xl hover:bg-white cursor-pointer group transition-all" onClick={() => handleLoadHistory(item)}>
                  <p className="font-black text-slate-900 truncate">{item.fileName}</p>
                  <div className="flex justify-between items-center mt-2">
                    <span className="text-[10px] text-slate-400">{new Date(item.timestamp).toLocaleString()}</span>
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteHistory(item.id); }} className="text-slate-300 hover:text-rose-500"><Trash2 size={16} /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showNotification && (
        <div className="fixed top-10 left-1/2 -translate-x-1/2 z-[100] animate-in slide-in-from-top-10">
          <div className={`px-10 py-4 rounded-[2rem] shadow-2xl font-black text-white flex items-center gap-4 ${showNotification.type === 'success' ? 'bg-emerald-500' : 'bg-rose-500'}`}>
            {showNotification.type === 'success' ? <Check size={20} /> : <AlertCircle size={20} />}
            <span>{showNotification.message}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;

