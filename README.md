# Socrative · AI Cursor

Extension Chrome Manifest V3 cho **bài ôn tập được phép sử dụng AI**. Extension chỉ nhận câu hỏi/lựa chọn từ **phản hồi API trực tiếp của Socrative**, dùng AI **giải hàng loạt toàn bộ bài ngay sau khi nhận dữ liệu**, lưu kết quả và thay đổi con trỏ:

- **Bàn tay (`pointer`)**: lựa chọn được AI gợi ý.
- **Mũi tên (`default`)**: các lựa chọn khác, hoặc câu đang chờ/kết quả lỗi.
- Tắt chức năng: khôi phục con trỏ gốc của trang.
- Không tự chọn đáp án, không tự nộp bài, không sửa kết quả trên server.

> AI có thể sai. API câu hỏi cung cấp nội dung và lựa chọn, không bảo đảm cung cấp đáp án chuẩn. `hasCorrectAnswer: true` không chỉ ra lựa chọn nào đúng. Extension không bảo đảm kết quả chính xác hoặc hoạt động với mọi phiên bản giao diện Socrative.

## 1. Cài đặt nhanh

Không cần `npm install`, không cần build hoặc server riêng.

1. Mở `chrome://extensions` trong Chrome 111 trở lên.
2. Bật **Developer mode / Chế độ nhà phát triển**.
3. Chọn **Load unpacked / Tải tiện ích đã giải nén**.
4. Chọn đúng thư mục:

   ```text
   C:\Users\info\Documents\socrative_solve\extension
   ```

5. Ghim **Socrative · AI Cursor** lên thanh công cụ nếu muốn.
6. Mở bài ôn tập tại `https://b.socrative.com` hoặc `https://student.socrative.com`. **Tải lại trang sau khi cài/cập nhật extension.**
7. Mở popup, bật **Gợi ý bằng con trỏ**. Đây là thao tác cho phép gửi **toàn bộ câu hỏi/lựa chọn trong bài** đến GateCheap và có thể phát sinh phí API cho cả bài.
8. Theo dõi mục **Giải hàng loạt**. Những câu đã giải xuất hiện gợi ý ngay khi chuyển đến; muốn có gợi ý sẵn cho cả bài thì chờ số câu **có gợi ý** đạt tổng số câu hỗ trợ. Không cần giữ popup mở.

Chức năng mặc định **tắt ở lần cài đầu**. Trạng thái bật/tắt được lưu trên máy; nếu đã bật, các trang Socrative phù hợp sẽ tiếp tục hoạt động khi mở lại Chrome. Tắt trước khi không muốn gửi thêm câu hỏi. Nếu chưa nhận được API câu hỏi, extension giữ con trỏ thường và chờ dữ liệu; không gửi nội dung DOM để giải riêng.

### API trực tiếp trong phiên bản 1.2

- Không có tính năng nhập file hay xử lý dữ liệu offline. Nguồn dữ liệu duy nhất là phản hồi API được quan sát trực tiếp trên trang Socrative.
- Khi cập nhật từ bản cũ, dữ liệu nhập/cache/hàng đợi cũ bị loại bỏ do không xác minh được nguồn. Cấu hình AI, trạng thái bật/tắt và hạn mức gọi trong phiên được giữ lại. Tải lại trang để nhận API mới.
- Tự tạo hàng đợi ngay khi nhận API câu hỏi; chỉ gửi AI khi đã bật chức năng.
- Mỗi request chứa **tối đa 5 câu**, tổng nội dung nhóm tối đa khoảng 24.000 ký tự (câu riêng lẻ dài có thể đi một nhóm). Một request batch chạy tại một thời điểm, từ đầu danh sách API.
- Với bài 50 câu ngắn và chưa có cache: **10 request thay vì 50 request riêng lẻ**. Đây không phải bảo đảm chi phí giảm đúng 5 lần vì phí còn tùy số token và chính sách provider.
- Kết quả từng câu được kiểm tra theo ID và ghi cache sau mỗi nhóm. Chuyển đến câu đã giải dùng cache trong tab, không chờ AI và không gọi lại chỉ vì đổi thứ tự đáp án.
- API tải lại hoặc nhiều tab cùng bài dùng chung hàng đợi/cache, không tạo lại batch giống hệt.
- Popup hiển thị số câu có gợi ý, đã xử lý, đang giải, chờ, lỗi, chưa chắc chắn và bỏ qua. Thanh tiến độ là **đã xử lý**, bao gồm lỗi/bỏ qua; chỉ số **có gợi ý** mới là số câu có lựa chọn AI.
- **Thử lại câu lỗi / chưa chắc chắn** chỉ gửi lại các câu chưa có kết quả dùng được, giữ nguyên các câu thành công.
- Lỗi kết nối, timeout, quyền/quota hoặc toàn bộ JSON batch không hợp lệ sẽ dừng phần hàng đợi còn lại; không tự thử lại tính phí. Lỗi một câu trong JSON batch hợp lệ không làm mất kết quả tốt của các câu khác.
- Tắt công tắc dừng và hủy request đang chờ. Bật lại tiếp tục phần chưa xử lý. Batch vẫn chạy khi đóng popup hoặc tab Socrative; muốn dừng cần **tắt công tắc**.
- Hàng đợi lưu trong session; quyền `alarms` đánh thức service worker định kỳ khi còn việc. Nếu worker bị dừng giữa một request, các câu đó được đánh dấu lỗi để bạn chủ động thử lại, tránh tự gọi lại một request có thể đã bị tính phí. Các nhóm chưa chạy vẫn được tiếp tục.
- Câu ảnh/âm thanh/video bị bỏ qua. AI có thể từ chối chọn; những câu chưa có gợi ý vẫn có con trỏ thường. Không có bảo đảm tất cả câu đều đã giải khi bạn vừa mở bài.

## 2. Cấu hình AI đã đặt sẵn

| Thuộc tính | Giá trị |
| --- | --- |
| Base URL | `https://gatecheap.vn/v1` |
| Endpoint | `https://gatecheap.vn/v1/chat/completions` |
| Model | `gpt-6.1-sol` |
| Xác thực | `Authorization: Bearer …` |
| Timeout | 25 giây mỗi yêu cầu |

API key được hardcode theo yêu cầu trong:

```text
C:\Users\info\Documents\socrative_solve\extension\config.private.js
```

Chỉ service worker nhập file này. Popup, script trên trang, log và tài liệu không chứa giá trị key. File đã được loại khỏi Git bằng:

```text
C:\Users\info\Documents\socrative_solve\.gitignore
```

**Hardcode không phải bảo mật tuyệt đối.** Bất kỳ ai có thư mục extension hoặc quyền đọc hồ sơ trình duyệt/máy tính đều có thể lấy key. Không chia sẻ/đăng công khai thư mục extension đang chứa key. Nên thu hồi key đã gửi trong cuộc trò chuyện và thay bằng key mới có hạn mức thấp. Sau khi sửa file cấu hình, nhấn **Reload** tại `chrome://extensions`, rồi tải lại trang Socrative.

Không tự đổi model, endpoint hay tự thử lại yêu cầu tính phí. Nếu chuyển provider khác, cần chỉnh cả cấu hình, allowlist trong mã, quyền host và CSP. Key thật **chưa được dùng để gọi AI trong quá trình kiểm thử**; trạng thái hoạt động/quota của key và độ trễ model cần xác nhận khi sử dụng thực tế.

## 3. Nhận dữ liệu từ API trực tiếp

Extension quan sát các phản hồi `fetch` và `XMLHttpRequest` của trang từ `document_start`, chỉ nhận endpoint:

```text
https://b.socrative.com/api/quizzes/{id}/questions
https://student.socrative.com/api/quizzes/{id}/questions
```

- Chỉ đọc body phản hồi JSON ở hai host cho phép, trạng thái 200 hoặc 304 nếu có body; giữ đúng Unicode tiếng Việt/tiếng Nhật.
- Không phát lại request Socrative, không đọc cookie để tự gọi API, không thay đổi phản hồi mà trang nhận được.
- Không lấy headers, cookie, token đăng nhập, thông tin phòng hoặc học sinh để gửi AI.
- Giới hạn body quan sát 4 MB; mỗi phản hồi tối đa 500 câu. Mỗi lượt đăng ký batch tối đa 2 MB dữ liệu chuẩn hóa, tổng hàng đợi tối đa 10 bài/1.000 câu và khoảng 3 MB.
- API mới bổ sung bài vào hàng đợi chung. Các job đã nhận vẫn được giữ; muốn bỏ bài cũ hãy tắt và **Xóa bộ nhớ** trước khi mở bài mới.
- Popup hiển thị **Dữ liệu API → số câu từ API** của hàng đợi trong phiên. Không cần mở popup để bắt API hoặc chạy batch.
- DOM chỉ dùng để xác định câu đang hiển thị và ghép nút lựa chọn với ID từ API. Chưa nhận được API hoặc ghép không chắc chắn thì không gọi AI từ DOM và không hiện bàn tay gợi ý.

Nếu số câu từ API vẫn bằng 0, **tải lại trang Socrative hoặc mở lại bài sau khi reload extension** để trang phát sinh request câu hỏi. Extension không thể lấy lại phản hồi đã diễn ra trước lúc được cài/chạy. Nếu Socrative đổi endpoint hoặc schema, cần cập nhật mã nhận API; không có đường nhập file thay thế.

## 4. Cách đối chiếu đáp án

1. Bắt `fetch`/`XMLHttpRequest` từ lúc trang bắt đầu tải. Không tự phát lại API Socrative, không dùng cookie để gọi API riêng.
2. Chỉ lấy cấu trúc câu hỏi/lựa chọn, kiểm tra host, kích thước và schema.
3. Đối chiếu câu hiện tại theo nội dung và ID lựa chọn; không dùng A/B/C/D hoặc thứ tự xuất hiện.
4. Với nút chọn nhiều đáp án không có ID trong DOM: chỉ ghép nội dung lựa chọn với ID API khi tất cả nội dung là duy nhất và không mâu thuẫn. Nếu không ghép chắc chắn thì không gợi ý.
5. Service worker gọi AI với từng nhóm câu hỏi và danh sách `{id, text}`; yêu cầu JSON `results`, kiểm tra lại ID câu/đáp án, số lựa chọn và trường hợp AI không đủ thông tin. Thứ tự kết quả AI không cần trùng thứ tự đầu vào.
6. Content script chỉ cập nhật con trỏ nếu câu hiện tại vẫn khớp với yêu cầu đã gửi. Kết quả trả chậm của câu trước không được áp dụng sang câu mới.

Popup hiển thị giải thích AI dưới dạng văn bản, không render HTML do AI trả về.

### Bộ nhớ và hạn mức

- Kết quả AI và câu hỏi API đã chuẩn hóa lưu trong `chrome.storage.session`, giới hạn truy cập ở ngữ cảnh extension tin cậy; mất khi khởi động lại trình duyệt hoặc reload extension.
- Cache kết quả có thời hạn 12 giờ; khóa gồm model, nội dung, loại câu và ID/nội dung đáp án, độc lập với thứ tự đảo đáp án.
- Batch chạy một request tại một thời điểm, không có fallback giải nội dung từ DOM. Tổng giới hạn chung 120 request AI/giờ trong phiên, mỗi request batch tính một lượt.
- **Xóa bộ nhớ** xóa hàng đợi và cache AI, không reset hạn mức chống gọi lặp. Dữ liệu API đã quan sát trong tab vẫn tồn tại đến khi trang tải lại/đóng.
- Xóa bộ nhớ khi đang bật khiến dữ liệu API còn trong các tab được đăng ký lại và có thể **giải lại toàn bộ bài**, phát sinh phí. Nên tắt trước khi xóa.
- **Giải / thử lại câu hiện tại** ưu tiên cache nếu có. Câu đã lỗi trong batch cần dùng nút **Thử lại câu lỗi / chưa chắc chắn**. Muốn giải mới cả bài, dùng **Xóa bộ nhớ** trước.
- Tắt chức năng hủy các yêu cầu đang chờ và bỏ gợi ý. Nhà cung cấp có thể đã tính phí yêu cầu nhận trước khi bị hủy.

## 5. Phạm vi hỗ trợ và xử lý lỗi

Phiên bản này hỗ trợ câu hỏi **lựa chọn bằng chữ**, với cấu trúc API và giao diện Socrative Student v2 đã kiểm tra. Có thể chọn một hoặc nhiều đáp án khi đối chiếu được ID. Chưa hỗ trợ câu tự luận, ảnh, âm thanh, video, OCR hoặc giao diện khác cấu trúc đã kiểm tra. Câu thiếu ID/nội dung rõ ràng được bỏ qua thay vì đoán.

| Hiện tượng | Cách xử lý |
| --- | --- |
| Popup yêu cầu tải lại trang | Reload tab Socrative sau khi cài/reload extension. |
| Chờ API câu hỏi | Tải lại trang hoặc mở lại bài để nhận API mới. Không có gợi ý ở trang chờ/phòng/đăng nhập. |
| Câu hiển thị chưa khớp API | Kiểm tra đã nhận API đúng bài; tải lại trang. Không đoán theo vị trí đáp án. |
| Đang giải | Chờ tối đa 25 giây. Chưa có kết quả thì không có bàn tay gợi ý. |
| HTTP 401 / 403 | Kiểm tra key/quyền tài khoản GateCheap. |
| HTTP 402 / 429 | Kiểm tra credit/quota; chờ rồi bấm thử lại. |
| HTTP 404 | Kiểm tra model/endpoint phía GateCheap. |
| Timeout / JSON không hợp lệ | Bấm **Thử lại câu lỗi / chưa chắc chắn**; không tự retry để tránh tăng chi phí. |
| AI chưa đủ thông tin | Mọi lựa chọn giữ con trỏ thường. Không coi đó là tất cả đáp án đều sai. |
| Tắt nhưng trang vẫn có bàn tay | Đó có thể là con trỏ gốc của Socrative; extension đã khôi phục CSS ban đầu. |

## 6. Kiểm thử

Yêu cầu Node.js 22 trở lên; không có thư viện ngoài. Từ PowerShell:

```powershell
Set-Location 'C:\Users\info\Documents\socrative_solve'
npm.cmd test
npm.cmd run check
npm.cmd run test:browser
```

- Unit/integration tests: phản hồi API Unicode, schema, ID, JSON AI, timeout, HTTP lỗi, cache, giới hạn quyền, tắt/hủy yêu cầu và không làm lộ key. Có thêm kiểm thử 50 câu/10 request, chống batch trùng, bỏ qua media/cache, lỗi từng câu, thử lại chọn lọc và khôi phục service worker. Kiểm tra loại bỏ dữ liệu phiên cũ, từ chối lệnh nhập đã gỡ và không giải câu chưa đăng ký từ API.
- Kiểm tra tĩnh: cú pháp mọi file JS, manifest, tài nguyên, quyền tối thiểu, key chỉ nằm trong file riêng và không còn mã/giao diện nhập file trong extension.
- Browser test: mở Chrome trong hồ sơ tạm, nạp extension MV3 thật, dùng HTML Socrative đã lưu làm fixture. Bản extension tạm dùng key giả; mọi API Socrative/AI của fixture đều được trả lời cục bộ bằng Chrome DevTools Protocol, không sử dụng credit.
- Browser test xác nhận không gọi AI khi mới chỉ có DOM, nhận API bằng cả `fetch` và `XMLHttpRequest` để giải batch, chuyển câu đã giải không gọi lại, và popup không có mục nhập file.
- Browser test cần Chrome có `Extensions.loadUnpacked` qua CDP và tùy chọn `--enable-unsafe-extension-debugging` (đã chạy trên Chrome 154). Chrome cũ không hỗ trợ lệnh này vẫn có thể cài extension thủ công bằng Load unpacked. Có thể đặt `$env:CHROME_PATH` đến file trình duyệt tương thích trước khi chạy.
- Ảnh giao diện và báo cáo kiểm thử nằm tại:

  ```text
  C:\Users\info\Documents\socrative_solve\.test-artifacts\popup.png
  C:\Users\info\Documents\socrative_solve\.test-artifacts\quiz.png
  C:\Users\info\Documents\socrative_solve\.test-artifacts\browser-report.json
  ```

Kiểm thử trình duyệt dùng DOM và phản hồi cục bộ, không đăng nhập hay nộp bài trên Socrative thật; không chứng minh độ chính xác của AI hoặc quyền/quota key thật.

## 7. Bảo mật và quyền riêng tư

- Không xin quyền cookies, debugger, đọc mọi website hoặc thực thi mã từ xa. Quyền debugger trong browser test là cờ của hồ sơ Chrome tạm, **không phải quyền của extension**.
- Quyền host chỉ giới hạn hai host Socrative và GateCheap. Không cung cấp bộ chuyển tiếp cho URL tùy ý từ trang.
- Script MAIN world có thể bị trang can thiệp; message từ trang được coi là không tin cậy, kiểm tra lại và không thể yêu cầu lấy API key. Đây không phải cơ chế chống trang web độc hại hoàn hảo; chỉ bật trên phiên ôn tập tin cậy.
- Chỉ câu hỏi/lựa chọn từ API được gửi tới dịch vụ AI bên thứ ba. Không gửi request headers hay token Socrative. Không thêm analytics.
- Các file dữ liệu/HTML ban đầu ở thư mục dự án được giữ nguyên và không kèm vào thư mục extension để cài đặt. Extension không đọc những file đó.
