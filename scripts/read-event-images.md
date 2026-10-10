# Reading Kakao event images (daily)

Image events (image-stack event pages and landing-page banners) print their
period and rewards only inside pictures. The daily GitHub scrape stores each
event's image ids (`docs/data/events/details.json` → `imgs`) but can't read
them, so a scheduled Claude task on the user's PC reads the new ones once a day.
The site shows "이벤트 이미지 리워드 확인 전" on events still waiting.

Work only in the dedicated worktree `C:\Users\Desktop\.kakaopage-imgreader`
(detached, sparse). Never run these steps in the main checkout.

## Steps

1. `cd C:/Users/Desktop/.kakaopage-imgreader`
2. `node scripts/image-reads-sync.mjs prepare <outDir>` — pulls the latest data,
   downloads the images of events not read yet, writes
   `<outDir>/batches/batch-NNN.json`. If it prints `NOTHING TO READ`, stop.
3. For each batch file: Read it (a JSON array of events: key, kind, page_title,
   listing_title, listing_subtitle, listing_first, listing_last, images), then
   Read **every** image of every event and fill in one result entry per event
   (format below). With many batches, hand batches to parallel subagents with
   this file as their instructions.
4. Re-check: for any entry whose start is more than 3 days from `listing_first`
   (unless `listing_first` is the first day of records, 2026-08-12), whose end is
   more than 3 days from `listing_last` (unless the event is still listed today),
   or that found no reward although the listing title/subtitle mentions
   캐시/무료/다무/할인/이용권/한시한편 — read that event's images again from
   scratch, and if the images really say so, keep it and set
   `"rechecked": "<why it looked off>"`.
5. Write all entries to one file `{"events": [ ... ]}` and run
   `node scripts/image-reads-sync.mjs publish <that file>` — merges, rebuilds the
   promotion data, commits as ehgowjd1-afk and pushes (retries on its own if the
   daily scrape pushed in between).

## What to extract (one entry per event key)

```json
{ "key": "h:…", "readable": true,
  "start": "2026-10-10", "start_time": null, "end": "2026-10-24", "end_time": null,
  "occasion": "기타",
  "rewards": [
    { "kind": "wait_free", "text": "이벤트 기간 동안 3시간마다 1편씩 무료", "cash_max": null, "free_eps": null, "wait_hours": 3, "winners": null, "condition": null },
    { "kind": "cash_lottery", "text": "이벤트 작품 5편 이상 보면 최대 2,000캐시 뽑기권(500명)", "cash_max": 2000, "free_eps": null, "wait_hours": null, "winners": 500, "condition": "이벤트 작품 5편 이상 열람" }
  ],
  "works_named": ["시어머니지만 고부 갈등은 싫습니다"],
  "note": null }
```

1. **Period** printed in the image ('10. 10 ~ 10. 24', '9. 18 (18시) ~ 10. 4',
   '이벤트 기간 9월 18일(금) 18시 ~ 10월 4일(일)').
   - `start` / `end` as YYYY-MM-DD. The year is rarely printed: pick the one
     that puts the dates nearest `listing_first`..`listing_last`.
   - `start_time` / `end_time` as 24h HH:mm only when printed ('18시'→'18:00',
     '오후 10시'→'22:00', '23:59'); otherwise null.
   - Never use the 당첨자 발표 / 리워드 지급 / 고지 date as the end. Only an end
     printed ('~10/14까지') → start null. Nothing printed → both null.
2. **rewards** — every distinct reader benefit printed, one entry each:
   - `wait_free`: 'N시간마다 1편 무료', 'N다무', 기다무 단축 → `wait_hours`=N
   - `free_episodes`: 'N화 무료', '1~N화 무료', '무료 회차 N화', '무료 N편 증량/UP' → `free_eps`=N
   - `cash_all`: cash everyone gets, or everyone meeting a condition gets, with NO draw
   - `cash_lottery`: cash by draw — 뽑기권, 추첨, 'N명' → `winners`=N
   - `discount`: 할인 (소장/단행본/세트 할인; % or price in `text`)
   - `ticket`: 이용권, 대여권, 열람권
   - `other`: anything else (굿즈, 쿠폰, goods draws …)
   - `text`: short Korean summary in the image's own words.
     `cash_max`: biggest cash number for that benefit as an integer (2,000 → 2000;
     1만 → 10000). `condition`: the requirement ('5편 이상 열람') or null.
     Unreadable numbers → null. Never invent a benefit that isn't printed; a
     plain collection banner can have `rewards: []`.
3. **occasion**: 론칭(신작·론칭·오픈런) · 완결 · 시즌·외전 · 연참 · 복귀(컴백·휴재 복귀)
   · 기념(N억 뷰·N화 돌파·단행본·표지·애니 등) · 기획전(여러 작품 묶음·추천)
   · 플랫폼(사이트 전체 참여 이벤트) · 기타.
4. **works_named**: titles the images present as the event's works (max 10).
5. **readable**: false only if images won't open or carry no event text at all
   (then dates null, rewards []).
6. **note**: anything important that doesn't fit, else null.
