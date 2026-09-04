-- 團購可以設「幾點截止」。
-- ⛔ 只「加」一個可留空的欄位，不動 deadline、不動任何既有訂單資料。
-- null = 當天 23:59 截止（＝加這欄之前的行為），所以既有的兩張單完全不受影響。
alter table public.group_buys
  add column if not exists deadline_time time;
