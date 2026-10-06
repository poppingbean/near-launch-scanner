# near-launch-scanner

Ứng dụng chạy local, độc lập. Nó quét các launchpad trên NEAR để tìm token mới, theo dõi quá trình raise vốn và thời điểm pool có thanh khoản, chấm điểm rủi ro bằng rule cứng rồi AI (Claude), và mua theo 2 đợt (tranche). Mặc định chạy **DRY-RUN**: chỉ ghi kế hoạch mua, không gửi giao dịch.

## Cài đặt

Yêu cầu Node.js 20 trở lên.

```bash
npm install
```

```bash
cp .env.example .env
```

Sau đó điền `.env` (file này đã được git-ignore và không được chia sẻ):

- `NEAR_ACCOUNT_ID`, `NEAR_PRIVATE_KEY` (dạng `ed25519:...`): chỉ cần khi trade thật. Key chỉ nằm trong bộ nhớ và bị che (redact) trong mọi log.
- **AI review** mặc định chạy bằng **Claude Code CLI cài trên máy** (`AI_BACKEND=cli`), dùng gói Claude của bạn nên không tốn phí API.
  - Thiết lập một lần: mở terminal, chạy `claude`, gõ `/login` và đăng nhập tài khoản Claude.
  - App tự loại bỏ các biến môi trường `CLAUDE*`/`ANTHROPIC*` và bỏ qua cấu hình provider trong `~/.claude/settings.json` (ví dụ chuyển hướng sang z.ai), để review luôn dùng đúng login Claude.
  - Khi khởi động, app gọi thử AI một lần. Nếu lỗi (ví dụ login hết hạn), app vẫn quét và đánh giá nhưng **không mua tranche 1** (`REQUIRE_AI_READY=true`), và tự kiểm tra lại mỗi 10 phút. Trạng thái AI hiển thị trên monitor.
  - Muốn dùng API trả phí: đặt `AI_BACKEND=api` và `ANTHROPIC_API_KEY`.

## Chạy

| Lệnh | Tác dụng |
|---|---|
| `npm start` | Quét, đánh giá và mua (dry-run, trừ khi bật live) kèm monitor UI |
| `npm run scan` | Chỉ quét và hiển thị, không đánh giá hay mua |
| `npm run status` | Thống kê token, các lần đánh giá gần đây và vị thế |
| `npm run evaluate -- <token> <launchpad> <launchTx>` | Chấm điểm một launch có sẵn (không bao giờ mua) |
| `npm run backfill -- <launchpad> <giờ>` | Nạp các launch gần đây vào store |

**Monitor UI:** <http://localhost:8787>. UI chỉ đọc, chỉ lắng nghe trên 127.0.0.1 và không có nút mua/bán. Đổi cổng bằng `DASHBOARD_PORT`, đặt `0` để tắt. UI gồm:

**Bán thủ công:** trong mục Positions, mỗi vị thế có nút **25% / 50% / All**. Bấm nút thì app quote trước, hiện hộp xác nhận (số token, NEAR dự kiến, NEAR tối thiểu sau slippage, REAL SALE hay PAPER) và chỉ bán khi bạn xác nhận. Nút bị khóa ở chế độ scan-only và khi vị thế đã bán hết. Endpoint bán chỉ nhận yêu cầu từ chính trang monitor (Host loopback, cùng origin, JSON, token ngẫu nhiên mỗi lần chạy), nên trang web khác mở trong trình duyệt không thể gọi lệnh bán.

**Unwrap:** nếu ví còn wNEAR (do một lần unwrap thất bại hoặc lệnh mua lỗi), header hiện số wNEAR kèm nút **Unwrap** để đổi toàn bộ về NEAR. Khi khởi động, app tự đối soát các lệnh bán bị ghi "0 NEAR" bằng cách đọc lại giao dịch.

- trạng thái ví và hạn mức;
- tình trạng poll của từng launchpad;
- các raise đang mở (tiến độ và thời gian còn lại);
- token live đang được quan sát;
- kết quả đánh giá: gate fail, AI, trade;
- vị thế đang giữ;
- log realtime;
- chi tiết features của từng token (bấm vào một dòng).

## Luồng xử lý

```
launchpad tx → NEW (raise) → LIVE (có pool) → quan sát OBSERVE_SECONDS → hard rules
   ├─ FAIL → skipped
   └─ PASS → MUA TRANCHE 1 (2 N) ngay → AI review chạy nền (không chặn vòng quét)
                ├─ BUY_MORE (confidence ≥ AI_MIN_CONFIDENCE) → MUA TRANCHE 2 (3 N),
                │     bỏ qua nếu giá đã tăng > MAX_TRANCHE2_PRICE_RISE so với lúc mua tranche 1
                ├─ HOLD (hoặc BUY_MORE nhưng confidence thấp) → GIỮ tranche 1, không mua thêm (t1_held_ai_hold)
                └─ SELL → BÁN NGAY toàn bộ tranche 1 (t1_sold_ai_sell)
```

- **Tranche 1** chiếm 1 suất trong `MAX_BUYS_PER_DAY`. Tranche 2 không chiếm thêm suất, nhưng vẫn tính vào `MAX_TOTAL_SPEND_NEAR`.
- **Chốt lời:** mỗi `POSITION_CHECK_SECONDS` (30s) app định giá từng vị thế bằng quote bán toàn bộ về NEAR. Phần pool không đủ thanh khoản để khớp được tính bằng 0 (cách tính thận trọng).
  - Khi ROI > `TAKE_PROFIT_ROI` (3 = +300%), app bán **vừa đủ** token để nhận về `TAKE_PROFIT_WITHDRAW_NEAR` (2.5 N = 2 N gốc + 0.5 N lời) và giữ phần còn lại. Mỗi token chỉ chốt một lần.
  - **AI đề xuất** một trong ba hành động cho tranche 1 đã mua: **BUY_MORE** (mua thêm tranche 2), **HOLD** (giữ, không mua thêm; vẫn được theo dõi chốt lời và bán tay bằng nút Sell) hoặc **SELL** (bán ngay toàn bộ). BUY_MORE dưới ngưỡng confidence được chuyển thành HOLD. Nếu AI lỗi hoặc timeout, app làm theo `AI_FAILURE_ACTION` (mặc định `sell`). Khi bán mà pool không đủ thanh khoản, phần còn lại nằm trong ví và được báo trên monitor.
- **Dry-run** ghi các vị thế "paper" (lượng token theo quote) để bạn quan sát ROI và chốt lời mô phỏng. Sổ paper tách riêng với sổ live, không tính vào hạn mức khi chạy live.
- Khi app dừng, các AI review đang chạy được chờ cho xong. Nếu app bị kill giữa chừng, token sẽ ở trạng thái `ai_review_interrupted` và không mua tranche 2.

## Tiêu chí đánh giá

- **Chấp nhận mức tập trung cao:** vì app vào lệnh trong vài phút đầu, việc vài ví mua sớm nắm phần lớn supply được coi là rủi ro chấp nhận được. Không có gate về tỷ lệ của người mua lớn nhất, và AI được dặn không SKIP chỉ vì lý do này. Các dấu hiệu phối hợp vẫn là gate cứng: ví liên kết với nhau hoặc với creator, creator cấp vốn cho người mua, creator bán ra.
- **Market cap:** tính theo FDV = giá spot (quote 0.1 NEAR) × total supply × giá NEAR/USD (lấy từ pool USDC/wNEAR trên Ref DCL). Hiện ở cột MCap trên monitor.
- **Giá tăng so với giao dịch đầu tiên:** chỉ kiểm tra khi MCap ≥ `IGNORE_RUNUP_BELOW_MCAP_USD` (mặc định $10,000). Dưới mức đó, token tăng 2–3× (hay hơn) vẫn được coi là còn sớm. Nếu không đọc được MCap, app vẫn áp dụng kiểm tra (`MAX_PRICE_MULTIPLE`).

## Launchpad hỗ trợ

**Cặp quote được mua** (`ACCEPTED_QUOTES`):

| Quote | Đường mua | Đường bán khi chốt lời |
|---|---|---|
| wNEAR | 1 tx: wrap + swap trực tiếp | token → wNEAR, sau đó unwrap |
| NEARLY (`nearly-993927.nearlytrade.near`) | 1 tx: DCL multi-hop wNEAR → NEARLY → token (pool NEARLY/wNEAR khoảng 33.8k N) | DCL multi-hop token → NEARLY → wNEAR |
| RHEA (`token.rhealab.near`) | 2 tx: wNEAR → RHEA qua Ref v2 pool #6458 (khoảng 130k N), rồi RHEA → token trên DCL | token → RHEA trên DCL, rồi RHEA → wNEAR qua Ref v2 |

Các cặp khác (ZEC, BNB bridge, NINU/DIARHEA làm quote, …) bị bỏ qua với trạng thái `skipped_quote`.

| Launchpad | Cơ chế | Mua |
|---|---|---|
| nearlytrade.near | Launch tức thì, pool Ref DCL một phía, LP khóa ở `lock2.nearlytrade.near` | Có (DCL) |
| launchpad.justhoot.near | Launch tức thì, pool DCL; có "sniping tax" khoảng 2 phút nên app chờ ít nhất `JUSTHOOT_MIN_AGE_SECONDS` | Có (DCL) |
| meme-cooking.near | Raise (soft cap 100 N, kéo dài 1h hoặc 24h) → finalize → pool Ref v2 khoảng 98 N, LP khóa ở `token-locker.ref-labs.near` | Có (Ref v2) |
| gaypad.j1-racing.near | Bonding curve | Chỉ theo dõi |

## An toàn

- Giao dịch thật chỉ được gửi khi **cả hai** điều kiện sau đúng: `DRY_RUN=false` và `ENABLE_LIVE_TRADING=I_UNDERSTAND_THE_RISK`.
- Hạn mức cứng:
  - `MAX_BUYS_PER_DAY` (mặc định 10 token mỗi 24h);
  - `MAX_TOTAL_SPEND_NEAR`;
  - `MIN_NEAR_RESERVE` (ví luôn giữ lại số NEAR này);
  - `SLIPPAGE_BPS`.
- Nên dùng một ví riêng chỉ chứa số NEAR bạn chấp nhận mất. Memecoin trên các launchpad này phần lớn về 0.

## Cách lệnh mua được dựng

Định dạng giao dịch được sao chép từ các swap thật trên mainnet. Mỗi lần mua là một giao dịch gửi tới `wrap.near`:

1. `near_deposit`: wrap NEAR thành wNEAR.
2. `ft_transfer_call`:
   - pool DCL: gửi tới `dclv2.ref-labs.near` với msg `Swap{pool_ids, output_token, min_output_amount}`;
   - pool Ref v2: gửi tới `v2.ref-finance.near` với msg `{actions:[{pool_id, token_in:wrap.near, token_out, amount_in, min_amount_out}]}`.

`min_output_amount` = quote × (1 − slippage). Nếu ví chưa có storage cho token hoặc wNEAR, app gọi `storage_deposit` trước.

## Giới hạn

- Với pool RHEA: nếu tx thứ 2 thất bại, RHEA sẽ nằm lại trong ví.
- Nếu swap thất bại (slippage), NEAR đã wrap sẽ nằm lại trong ví dưới dạng wNEAR. App vẫn tính khoản này vào số đã chi (cách tính thận trọng).
- Rule và AI chỉ giảm rủi ro, không loại bỏ được rủi ro. Cụ thể: dev bán sau khi app mua, sybil cluster dùng ví mới, hoặc honeypot dùng contract tùy biến.
