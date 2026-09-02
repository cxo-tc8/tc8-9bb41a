-- 每樣商品可設「每人最多幾件」。null = 不限購（既有商品全部維持不限）。
alter table public.group_buy_items
  add column if not exists max_per_person int
  check (max_per_person is null or max_per_person > 0);
