# EXCEL BORDER REPAIR ENGINE 🛡️📊

Hệ thống chuyên dụng **Phân tích, Phát hiện và Sửa lỗi Border cục bộ trong file Excel (.xlsx)** bằng thuật toán **Statistical Outlier Detection**, **Shared Edge Resolution** và **Surgical OpenXML/ZIP Patching**.

---

## 🎯 Mục Tiêu Cốt Lõi

1. **KHÔNG KẺ LẠI TOÀN BỘ BẢNG** (Không dùng "All Borders").
2. **KHÔNG COPY FORMATTING** từ dòng này sang dòng khác.
3. **BẢO TỒN NGUYÊN TRẠNG 100%**:
   - Giá trị ô, Text, Số, Ngày tháng, Công thức
   - Font chữ, Cỡ chữ, Bold, Italic, Màu chữ, Màu nền (Fill)
   - Căn lề (Alignment), Wrap text, Number format
   - Độ cao dòng (Row height), Độ rộng cột (Column width)
   - Vùng Merge Cells, Freeze panes, Print area
4. **CHỈ SỬA ĐÚNG BORDER THỰC SỰ BỊ LỖI**.

---

## 🧠 Thuật Toán & Kiến Trúc Xử Lý

### 1. Phân Tích Sheet Độc Lập
Mỗi Sheet trong file (ví dụ: `GT 09 HS A Q`, `GT09 Tân`, `GT09 Lắp đặt tĩnh`) được phân tích riêng biệt, không dùng mẫu của Sheet này áp đặt cho Sheet khác.

### 2. Tự Động Nhận Diện Block Động
- Quét từ khóa `MỤC LỤC VĂN BẢN` hoặc `STT`
- Xác định cấu trúc: `{ titleRow, infoRow, headerRow, dataStartRow, dataEndRow, endRow }`
- Ánh xạ vị trí tương đối của từng ô: `Header[col]`, `Data_First[col]`, `Data_Middle[col]`, `Data_Last[col]`.

### 3. Logic Shared Edge (Đường Viền Chung)
- Đường dọc nhìn thấy giữa ô $(r, c)$ và $(r, c+1)$ có thể đến từ:
  $$\text{VisibleVertical} = \text{Cell}(r,c).\text{right} \lor \text{Cell}(r,c+1).\text{left}$$
- Nếu ô bên trái không có Right border nhưng ô bên phải có Left border $\rightarrow$ **KHÔNG COI LÀ LỖI**.
- Chỉ khi **CẢ HAI ĐỀU THIẾU** và cấu trúc đa số yêu cầu có viền $\rightarrow$ Xác nhận là **GAP**.

### 4. Outlier & Confidence Scoring
- Tính toán tỷ lệ xuất hiện của Border Pattern theo vị trí tương đối qua hàng trăm block tương đương.
- Điểm tin cậy (Confidence Score):
  - $\ge 99.0\%$: Đủ điều kiện **Auto Fix**
  - $95.0\% - 98.99\%$: Đưa vào mục **Review Cần Duyệt**
  - $< 95.0\%$: Không tự động sửa

### 5. Surgical OOXML ZIP/XML Patching
Chỉ thay đổi thuộc tính `s` (style index) và `<border>` trong `xl/styles.xml` và `xl/worksheets/sheet*.xml`. Toàn bộ XML markup khác được giữ nguyên 100%.

---

## 🚀 Hướng Dẫn Chạy Project

### Chạy bằng Node.js / Docker

```bash
# 1. Cài đặt dependencies
npm install

# 2. Khởi động môi trường dev
npm run dev

# 3. Build production
npm run build
npm run start
```

### Chạy bằng Docker Compose

```bash
docker-compose up --build
```

---

## 🧪 10 Test Cases Bắt Buộc Đã Triển Khai

| STT | Test Case | Kết Quả Mong Đợi | Trạng Thái |
|-----|-----------|-------------------|------------|
| 1 | Ô giữa bảng bị mất Border | Phát hiện chính xác | ✅ PASS |
| 2 | Shared Edge: Trái không có Right, Phải có Left | Không báo lỗi | ✅ PASS |
| 3 | Vùng Merge Cells | Không unmerge, không kẻ viền nội bộ | ✅ PASS |
| 4 | Header có Border khác Data | Không báo lỗi (Hợp lệ) | ✅ PASS |
| 5 | Dòng cuối block có Border khác | Không báo lỗi (Hợp lệ) | ✅ PASS |
| 6 | Ô trống trong lưới bảng | Phát hiện thiếu Border | ✅ PASS |
| 7 | Font chữ khác nhau | Giữ nguyên Font 100% | ✅ PASS |
| 8 | Alignment & Fills khác nhau | Giữ nguyên 100% | ✅ PASS |
| 9 | Sheet 1 và Sheet 2 có format khác nhau | Cô lập từng Sheet | ✅ PASS |
| 10 | Outlier duy nhất trong đa số chuẩn | Confidence $\ge 99\%$ | ✅ PASS |
