# Nâng cấp MediaPipe Unity Plugin: v0.12.0 → v0.16.3

Tài liệu này là **bước 1**: thay package đang vendor trong repo bằng bản mới, giữ cho code cũ vẫn biên dịch, rồi mới bật Tasks API ở **bước 2**.

> **Chưa được kiểm chứng bằng Unity.** Môi trường soạn thay đổi này không có Unity, không có Android SDK/NDK, không có Bazel. Toàn bộ phần "kiểm chứng" dưới đây là đối chiếu chữ ký API với source thật của v0.16.3 trên GitHub. Việc biên dịch và chạy thử **bắt buộc phải làm trên máy bạn**.

---

## 0. Vì sao phải làm bước này trước

| | Hiện tại (vendor trong repo) | v0.16.3 |
|---|---|---|
| Plugin | `com.github.homuler.mediapipe` **0.12.0** | **0.16.3** (2025-11-08) |
| MediaPipe core | 0.10.1 (`WORKSPACE`) | **0.10.22** |
| Unity tối thiểu | 2021.3 (project đang là `2021.3.18f1`) | **2022.3** |
| Tasks API | **không có** (`Runtime/Scripts/Tasks/` không tồn tại) | có |

Hệ quả trực tiếp: code dùng `ObjectDetector` / `categoryAllowList` **không thể biên dịch** trên package hiện tại. Không có đường tắt — phải thay package.

---

## 1. Chuẩn bị (làm trước khi động vào project)

1. **Sao lưu**: commit sạch trên một nhánh riêng, ví dụ
   ```bash
   cd XRObjects
   git checkout -b upgrade/mediapipe-0.16.3
   git status            # phải sạch
   ```
   Package hiện tại nặng **189 MB**, đừng để nó lẫn vào commit.

2. **Cài Unity 2022.3.x** (LTS mới nhất bạn có thể tải) qua Unity Hub, kèm module **Android Build Support** + **SDK/NDK/OpenJDK**. Ghi lại số phiên bản chính xác, ví dụ `2022.3.62f1`.

3. **Bazel** (để build native nếu cần) — xem mục 5.

---

## 2. Xoá package cũ, thêm package mới

Package được vendor cục bộ tại `XRObjects/Packages/com.github.homuler.mediapipe/` (189 MB, chứa `Runtime/Plugins/Android/mediapipe_android.aar` và `Runtime/Plugins/libmediapipe_c.so`).

```bash
cd XRObjects

# 2.1 xoá bản vendor
rm -rf Packages/com.github.homuler.mediapipe
rm -f  Packages/com.github.homuler.mediapipe.meta    # nếu có

# 2.2 tải package 0.16.3 từ release chính thức (~290 MB)
gh release download v0.16.3 \
  --repo homuler/MediaPipeUnityPlugin \
  --pattern 'com.github.homuler.mediapipe-0.16.3.tgz' \
  --dir /tmp/mp
```

Cách thêm vào project — **chọn một**:

- **Cách A (khuyến nghị, có kiểm soát phiên bản)**: giải nén rồi trỏ tới đường dẫn cục bộ.
  ```bash
  mkdir -p Packages/com.github.homuler.mediapipe
  tar -xzf /tmp/mp/com.github.homuler.mediapipe-0.16.3.tgz \
      -C Packages/com.github.homuler.mediapipe --strip-components=1
  ```
  Sửa `Packages/manifest.json`, thêm:
  ```json
  "com.github.homuler.mediapipe": "file:com.github.homuler.mediapipe"
  ```
  > Nếu bạn **không** muốn giữ 290 MB trong Git, hãy thêm đường dẫn này vào `.gitignore` và ghi lại cách tái tạo trong README.

- **Cách B (gọn hơn)**: dùng git URL ghim tag.
  ```json
  "com.github.homuler.mediapipe": "https://github.com/homuler/MediaPipeUnityPlugin.git?path=Packages/com.github.homuler.mediapipe#v0.16.3"
  ```
  Unity sẽ tự clone và **tự build native bằng Bazel** — chậm hơn nhiều lần đầu, nhưng không phải commit 290 MB.

4. Mở project bằng Unity 2022.3 → Unity sẽ hỏi nâng cấp project, chọn **Continue**. Mở xong kiểm tra **Window ▸ Package Manager** thấy `MediaPipe Unity Plugin 0.16.3`.

---

## 3. Nâng ARFoundation (bắt buộc, nếu không sẽ vỡ)

`Packages/manifest.json` đang ghim ARFoundation **4.2.9** — bản này **không** chạy trên Unity 2022.3.

```json
"com.unity.xr.arfoundation": "5.1.x",
"com.unity.xr.arcore":      "5.1.x",
"com.unity.xr.management":  "4.5.x"
```

Ghim cùng một minor cho `arfoundation` và `arcore`. `com.unity.xr.arcore` và `com.unity.xr.arfoundation` **phải cùng phiên bản**.

Đồng thời kiểm tra `com.google.ar.core.arfoundation.extensions` (đang trỏ git URL không ghim tag) — nên ghim tag tương thích ARFoundation 5.

**Thay đổi API cần soát sau khi nâng** (ARCursor.cs và các script AR khác):
- `ARRaycastManager.Raycast(...)` — vẫn còn, nhưng `TrackableType.Depth` yêu cầu ARCore Depth API bật trong `AROcclusionManager`.
- `ARCameraManager.TryAcquireLatestCpuImage` — không đổi.
- `UnityEngine.Device.Screen` — cần `using UnityEngine.Device;` (ARCursor đã có).
- Enum `UnityEngine.XR.ARSubsystems.TrackableType` — không đổi.

---

## 4. Bật Tasks API cho `ARMPObjectDetection`

File `Assets/XRObjects/Scripts/ARMPObjectDetection.cs` đã được viết lại với **hai nhánh** trong cùng một file:

- `MEDIAPIPE_TASKS` **không** định nghĩa → đường `CalculatorGraph` cũ (v0.12.0). Đây là mặc định, nên bước 1 **không làm hỏng** code đang chạy.
- `MEDIAPIPE_TASKS` **có** định nghĩa → đường `ObjectDetector` Tasks API.

Bật bằng Scripting Define Symbol:

**Project Settings ▸ Player ▸ Other Settings ▸ Scripting Define Symbols**, thêm `MEDIAPIPE_TASKS`.

> Chỉ bật **sau khi** Unity đã import xong package 0.16.3. Bật khi còn package cũ sẽ ra hàng loạt lỗi `ObjectDetector could not be found`.

Thư mục project **không có file `.asmdef` nào**, nên không dùng được `versionDefines` để tự phát hiện phiên bản — vì vậy phải chuyển sang define thủ công. Nếu sau này bạn thêm asmdef, hãy chuyển sang `versionDefines` để khỏi phải nhớ.

### Tham số mới lộ ra trong Inspector

Trên component `ARMPObjectDetection`:

| Trường | Mặc định | Ý nghĩa |
|---|---|---|
| `_runningMode` | `LIVE_STREAM` | `LIVE_STREAM`: trả về ngay, có thể bỏ frame. `IMAGE`: đồng bộ, không có rủi ro vòng đời buffer. |
| `_categoryAllowList` | 12 nhãn | Chuyển thành `ObjectDetectorOptions.categoryAllowList` — lọc **trong model**, thay vì lọc sau khi đã detect. |
| `_maxResults` | 5 | Số detection tối đa mỗi frame. |
| `_scoreThreshold` | 0.35 | Ngưỡng tin cậy. |
| `_delegate` | `CPU` | `EDGETPU_NNAPI` = NNAPI delegate. Tự fallback về CPU nếu khởi tạo lỗi. |
| `_modelAssetPath` | `ssdlite_object_detection.bytes` | Tên asset trong StreamingAssets. |
| `_verboseLogging` | false | Log số detection mỗi frame. |

`ARCursor.allowedObjectLabels` **vẫn còn tác dụng** — nó là bộ lọc thứ hai trước khi raycast. Bạn có thể đồng bộ hai nơi bằng `SetCategoryAllowList(...)`, hoặc để nguyên (lọc sau detect vẫn đúng, chỉ tốn thêm chút CPU).

---

## 5. Native library / Bazel

Package `.tgz` chính thức **đã kèm** native library dựng sẵn. Bạn chỉ cần build lại native khi:

- bạn sửa `WORKSPACE` hoặc `third_party/*.diff`, **hoặc**
- bạn cần thêm/bớt ABI.

`XRObjects/WORKSPACE` hiện ghim `mediapipe-0.10.1`. Nếu build native, phải nâng lên **`mediapipe-0.10.22`** và áp **16 patch** trong `third_party/` của plugin mới (các diff đã đổi giữa hai bản — không chép đè patch cũ).

```bash
# trong thư mục plugin, theo hướng dẫn build của repo plugin
bazel build -c opt --config=android_arm64 //mediapipe/java/com/google/mediapipe:...
```

Bỏ qua mục này nếu bạn dùng native library có sẵn.

---

## 6. Android build settings

Giữ nguyên như README repo:
- **Scripting Backend**: IL2CPP
- **Target Architectures**: ARM64 (và ARMv7 nếu cần thiết bị cũ)
- **Minimum API Level**: 24
- Scene: `SceneXRObjects`
- Xoá `Google.Protobuf.dll` trùng trong `/Editor/Scripts/Internal/Analytics` nếu Unity báo lỗi trùng assembly

> **Cảnh báo ARMv7**: MediaPipe 0.10.22 hướng tới ARM64. Nếu build ARMv7 gặp lỗi thiếu symbol trong `libmediapipe_c.so`, hãy bỏ ARMv7 và chỉ xuất ARM64 (mọi máy ARCore đều ARM64).

---

## 7. Checklist kiểm chứng

Làm theo thứ tự, **dừng ở bước nào lỗi thì báo lại bước đó**:

1. [ ] Unity 2022.3 mở project không lỗi compile **khi CHƯA** có `MEDIAPIPE_TASKS`.
   → Chứng minh bước 1 không phá code cũ.
2. [ ] Build APK nhánh cũ, chạy trên máy thật: detect + menu context vẫn hoạt động như trước.
3. [ ] Thêm define `MEDIAPIPE_TASKS`, Unity compile lại **không lỗi**.
4. [ ] Trong Inspector, `_categoryAllowList`, `_scoreThreshold`, `_delegate` hiện ra.
5. [ ] Build APK nhánh mới, chạy: log `ARMPObjectDetection: Tasks API ready (...)`.
6. [ ] Chỉ đưa `bottle` vào khung hình → có box + nhãn `bottle`. Đưa `chair` (không nằm trong allow list) → **không** có box.
7. [ ] Kiểm tra box **đúng vị trí** trên màn hình (đây là chỗ dễ sai nhất — xem mục 8).
8. [ ] Chạy 5–10 phút, xem Profiler: bộ nhớ không tăng đều (rò rỉ buffer).

---

## 8. Những lỗi tiềm ẩn đã sửa trong bản viết lại

Ghi lại để bạn biết cái gì đã đổi và **không** vô tình đưa lại:

1. **`image.Dispose()` trước khi đọc `image.width`** — code cũ dispose rồi mới dùng `image.width` trong khối `renderMLCapture`. Bản mới cache kích thước **trước** khi dispose.
2. **Cấp phát lại buffer mỗi frame** — `_bufferTemp` được `new` mỗi frame ở đường preview. Bản mới dùng lại một `Texture2D` duy nhất.
3. **Buffer bị ghi đè khi MediaPipe còn đang đọc** — `Image(... NativeArray)` **wrap** bộ nhớ chứ không copy (comment trong `Image.cs` nói rõ: "pixelData won't be released ... you can reuse the memory"). Ở `LIVE_STREAM`, frame sau ghi đè frame trước → ảnh bị rách. Bản mới xoay vòng **3 buffer**.

   > Đối chiếu: sample chính thức `ObjectDetectorRunner` cũng **wrap** (`BuildCPUImage() => new Image(imageFormat, _texture)`) và bảo vệ bằng **pool 10 `TextureFrame`**, không dispose `Image`. Bản viết lại dùng ring buffer 3 — đủ cho chế độ "drop frame khi quá tải" của `LIVE_STREAM`. Nếu bạn thấy ảnh bị rách trên máy yếu, tăng `_LiveStreamBufferCount` lên 10 để bằng sample.<br>
   > Nếu nghi ngờ `Image` bị dispose quá sớm: bỏ khối `using (...)` quanh `DetectAsync` và để GC finalizer dọn, đúng như sample đang làm.
4. **Kết quả cũ không được xoá** — `TryDetect` ghi: "When objects are not found, `result` won't be overwritten". Bản mới `Clear()` trước mỗi lần `TryDetect`, nếu không box cũ sẽ bám mãi trên màn hình.
5. **Callback chạy trên worker thread** — `ResultCallback` của Tasks API được gọi ngoài main thread. Bản mới đẩy vào `ConcurrentQueue` và chỉ gọi Unity event trong `Update()`.
6. **Model không đọc được trên Android** — `Application.streamingAssetsPath` nằm **trong APK**, `File.ReadAllBytes` sẽ fail. Bản mới dùng `StreamingAssetsResourceManager.PrepareAssetAsync` + `ResourceUtil.TryGetFilePath`.
7. **`FindFirstObjectByType` không có ở Unity 2021.3** — bản mới bọc trong `#if UNITY_2022_2_OR_NEWER`.

---

## 9. Điểm dễ sai nhất: toạ độ bounding box

Đây là chỗ **phải kiểm tra bằng mắt trên máy thật**.

- `ARCursor.cs` đọc `LocationData.RelativeBoundingBox` — giá trị **chuẩn hoá 0..1**.
- Tasks API trả `Detection.boundingBox` là `Rect` với `left/top/right/bottom` tính bằng **pixel** của ảnh đưa vào detector.

`ARMPObjectDetection` (nhánh Tasks) đã quy đổi: chia cho `image.Width()` / `image.Height()` và gán vào `RelativeBoundingBox`. Nếu box hiện **lệch hoặc sai tỉ lệ**, kiểm tra theo thứ tự:

1. Ảnh đưa vào detector là ảnh **đã crop** theo tỉ lệ màn hình (`croppedHeight`), không phải toàn bộ cảm biến. Phép chia phải dùng đúng chiều cao đã crop — code hiện tại dùng `image.Width()/Height()` của `Image` truyền vào, tức đúng ảnh đã crop.
2. `ARCursor` còn lật trục X (`1 - Xmin`) vì ảnh camera bị mirror. Nếu box lật ngược, sửa ở `ARCursor`, **không** sửa trong adapter.
3. `input_vertically_flipped` trong graph cũ là `true`. Tasks API tự xử lý orientation qua `ImageProcessingOptions`; code hiện truyền `null`. Nếu ảnh bị lật dọc, đây là chỗ cần chỉnh.

---

## 10. Nếu phải quay lui

```bash
git checkout -- XRObjects/Packages XRObjects/Packages/manifest.json
git checkout -- XRObjects/Assets/XRObjects/Scripts/ARMPObjectDetection.cs
```

Bỏ define `MEDIAPIPE_TASKS` là đủ để quay về đường cũ **mà không cần** revert file script, vì cả hai nhánh nằm trong cùng file.
