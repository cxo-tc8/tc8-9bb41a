-- 讓「顏色」這類規格能各自有成團門檻：白色滿 50、黑色滿 50，分開算。
-- ⛔ 不要用「拆成兩樣商品」解這件事——同一件衣服的照片和說明會重複兩份，
--    夥伴要看兩遍、點兩次（2026-09-02 實際被打回）。門檻該下放到規格層。
alter table public.group_buy_variants
  add column if not exists min_qty int
  check (min_qty is null or min_qty > 0);

-- 每個規格選項各自的累積量。choices 形如 {"顏色":"白色","尺寸":"M"}，
-- 用 choices->>grp 對回選項名稱。只列出有設門檻的選項。
create or replace view public.v_gb_variant_progress as
select v.item_id,
       v.grp,
       v.label,
       v.min_qty,
       (coalesce(sum(o.qty), 0))::int as qty,
       (count(distinct o.member_id))::int as buyers
from public.group_buy_variants v
left join public.group_buy_orders o
       on o.item_id = v.item_id
      and o.choices ->> v.grp = v.label
where v.active and v.min_qty is not null
group by v.item_id, v.grp, v.label, v.min_qty;

grant select on public.v_gb_variant_progress to anon, authenticated, service_role;
