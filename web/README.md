# XR-Objects — bản web demo

Bản web mô phỏng pipeline của [XR-Objects](../../README.md) (Google Research, ACM UIST 2024):
**camera → nhận diện vật thể → neo → context menu AR → Gemini**.

App Android gốc vẫn là dự án Unity trong thư mục `XRObjects/` của repo — xem
[`public/guide.html`](public/guide.html) để biết cách build APK.

## Chạy cục bộ

```bash
cd web
cp .env.example .env.local     # rồi điền key thật
node dev.mjs                   # http://localhost:3000
```

`dev.mjs` chỉ dùng để phát triển: nó phục vụ `public/` tĩnh và gọi thẳng các
handler trong `api/` (giống cách Vercel chạy serverless function).

## Cấu trúc

```
web/
├── vercel.json            # outputDirectory: public, functions, headers
├── dev.mjs                # dev server cục bộ
├── public/                # index.html (app), guide.html (hướng dẫn), app.js, styles.css
├── api/
│   ├── _gemini.js         # helper Gemini + prompt gốc từ ImageQuery.cs
│   ├── config.js          # cấu hình runtime cho trình duyệt
│   ├── health.js          # self-check Gemini + Supabase
│   ├── detect.js          # ảnh → vật thể + bbox
│   ├── label.js           # nhãn thương hiệu (prompt gốc XR-Objects)
│   ├── describe.js        # tóm tắt thông tin
│   ├── ask.js             # hỏi đáp nhiều lượt
│   └── compare.js         # so sánh tối đa 4 vật thể
└── supabase/schema.sql    # bảng + RLS + view object_feed
```

## Biến môi trường

| Biến | Ý nghĩa |
| --- | --- |
| `GEMINI_API_KEY` | Bắt buộc để có AI thật. Không có → tự chuyển chế độ demo. |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | Publishable/anon key (an toàn để lộ, đã có RLS) |
| `GEMINI_MODEL` | Tuỳ chọn, mặc định `gemini-2.0-flash` |

## Deploy

1. Vercel → **Add New Project** → chọn repo `xr-objects`.
2. **Root Directory = `web`**, Framework preset = **Other**, Build Command để trống,
   Output Directory = `public` (đã khai báo trong `vercel.json`).
3. Thêm các biến môi trường ở trên → **Deploy**.
4. Supabase → **SQL Editor** → chạy `supabase/schema.sql` → lấy URL + anon key.
5. Mở `/api/health` để kiểm tra kết nối.

## Ghi chú bảo mật

- Gemini key chỉ nằm trong serverless function, không bao giờ gửi xuống trình duyệt.
- Policy RLS trong `schema.sql` đang **mở** (`using (true)`) cho bản demo không cần đăng nhập.
  Trước khi dùng thật, thêm `owner_id` + Supabase Auth và siết policy theo `auth.uid()`.
