// TC8 — 團購（S9 #22 / S10 #23）
// 獨立於月例會（有商品規格與金額），但共用同一份 members 身分。
// ⛔ 待審／已拒絕的單，一般身分連 API 都撈不到（RLS 已擋，這裡再擋一層）。

const SB_URL    = Deno.env.get("SUPABASE_URL")!;
const SB_SECRET = Deno.env.get("TC8_SECRET_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_SECRET, Authorization: `Bearer ${SB_SECRET}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`db ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function whoami(req: Request) {
  const t = req.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (!t) return null;
  const rows = await db(`sessions?token_hash=eq.${await sha256(t)}&select=member_id,pending,expires_at`);
  const s = rows[0];
  if (!s || s.pending || !s.member_id || new Date(s.expires_at) < new Date()) return null;
  const m = await db(`members?id=eq.${s.member_id}&select=id,name,role,status`);
  if (!m.length || m[0].status !== null) return null;
  return m[0] as { id: number; name: string; role: string };
}
const isOfficer = (me: { role: string } | null) => me?.role === "officer";
const TEXT = (v: unknown, max: number) => {
  const t = (v ?? "").toString().trim();
  return t ? (t.length > max ? t.slice(0, max) : t) : null;
};
const twToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);  // 台灣的今天

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { action, ...b } = await req.json();

    // ── 開單（夥伴自己開）──────────────────────────────────
    if (action === "create" || action === "update") {
      const me = await whoami(req);
      if (!me) return json({ ok: false, error: "NOT_BOUND", message: "請先用 LINE 登入" }, 401);

      const title = TEXT(b.title, 80);
      const deadline = TEXT(b.deadline, 10);
      if (!title) return json({ ok: false, error: "BAD_INPUT", message: "請填商品名稱" }, 400);
      if (!deadline) return json({ ok: false, error: "BAD_INPUT", message: "請填截止日" }, 400);

      // ⭐ 單層只管「誰開的、什麼時候截止」；價格、數量下限、規格、照片都在商品層
      const row: Record<string, unknown> = {
        title,
        body: TEXT(b.body, 2000),
        deadline,
        updated_at: new Date().toISOString(),
      };

      if (action === "update") {
        const id = Number(b.id);
        const cur = await db(`group_buys?id=eq.${id}&select=id,owner_id,status`);
        if (!cur.length) return json({ ok: false, error: "NOT_FOUND" }, 404);
        // 開單者本人或幹部可以改。⭐ 羅伯特要求：幹部也能代填/修正最小訂購量與價格
        if (cur[0].owner_id !== me.id && !isOfficer(me)) {
          return json({ ok: false, error: "FORBIDDEN", message: "只能修改自己開的團購" }, 403);
        }
        await db(`group_buys?id=eq.${id}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row),
        });
        return json({ ok: true, id });
      }

      row.owner_id = me.id;
      // ⛔ 先當草稿：還沒有商品的單送去給幹部審，幹部無從審起（羅伯特 2026-08-26）
      row.status = "draft";
      const rows = await db("group_buys", {
        method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row),
      });
      return json({ ok: true, id: rows[0].id, status: "draft" });
    }

    // ── 商品項目（一張單可以有很多樣）───────────────────────
    if (action === "item_save") {
      const me = await whoami(req);
      if (!me) return json({ ok: false, error: "NOT_BOUND" }, 401);
      const buyId = Number(b.buy_id);
      const cur = await db(`group_buys?id=eq.${buyId}&select=owner_id`);
      if (!cur.length) return json({ ok: false, error: "NOT_FOUND" }, 404);
      if (cur[0].owner_id !== me.id && !isOfficer(me)) return json({ ok: false, error: "FORBIDDEN" }, 403);

      const name = TEXT(b.name, 80);
      if (!name) return json({ ok: false, error: "BAD_INPUT", message: "請填商品名稱" }, 400);
      const row: Record<string, unknown> = {
        buy_id: buyId, name,
        body: TEXT(b.body, 1000),
        unit_price: Math.max(0, Math.trunc(Number(b.unit_price) || 0)),
        min_qty: Math.max(1, Math.trunc(Number(b.min_qty) || 1)),
        // 每樣商品最多 2 張照片
        photos: Array.isArray(b.photos) ? b.photos.filter((x: unknown) => typeof x === "string").slice(0, 2) : [],
        sort: Math.trunc(Number(b.sort) || 0),
        // 每人限購：null = 不限。0 或負數一律當成不限，
        // 不要讓「填 0」變成誰都不能買。
        max_per_person: (Math.trunc(Number(b.max_per_person) || 0) > 0)
          ? Math.trunc(Number(b.max_per_person)) : null,
      };
      if (typeof b.active === "boolean") row.active = b.active;
      let itemId: number;
      if (b.id) {
        itemId = Number(b.id);
        await db(`group_buy_items?id=eq.${itemId}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row),
        });
      } else {
        const rows = await db("group_buy_items", {
          method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row),
        });
        itemId = rows[0].id as number;
      }

      // ⭐ 規格跟著商品一起存：整組取代，不再一顆一顆問（羅伯特 2026-08-26）
      //    specs = [{grp:"顏色", labels:["紅","藍"]}, ...]
      //    ⚠️ 舊的 variant 直接刪掉：group_buy_orders.variant_id 是 on delete set null，
      //       而訂購內容本身存在 choices jsonb（文字），所以刪掉不會弄丟任何人訂了什麼。
      if (Array.isArray(b.specs)) {
        await db(`group_buy_variants?item_id=eq.${itemId}`, {
          method: "DELETE", headers: { Prefer: "return=minimal" },
        });
        const rows: Record<string, unknown>[] = [];
        for (const sp of b.specs.slice(0, 6)) {
          const grp = TEXT(sp?.grp, 20);
          if (!grp || !Array.isArray(sp.labels)) continue;
          let sort = 0;
          for (const raw of sp.labels.slice(0, 30)) {
            const label = TEXT(raw, 40);
            if (!label) continue;
            sort += 10;
            rows.push({ item_id: itemId, buy_id: buyId, grp, label, sort });
          }
        }
        if (rows.length) {
          await db("group_buy_variants", {
            method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(rows),
          });
        }
      }
      return json({ ok: true, id: itemId });
    }

    // ── 商品規格（尺寸、顏色）─────────────────────────────
    if (action === "variant_save") {
      const me = await whoami(req);
      if (!me) return json({ ok: false, error: "NOT_BOUND" }, 401);
      const itemId = Number(b.item_id);
      const cur = await db(`group_buy_items?id=eq.${itemId}&select=buy_id,group_buys(owner_id)`);
      if (!cur.length) return json({ ok: false, error: "NOT_FOUND" }, 404);
      const owner = (cur[0].group_buys as { owner_id?: number } | null)?.owner_id;
      if (owner !== me.id && !isOfficer(me)) return json({ ok: false, error: "FORBIDDEN" }, 403);

      const row = {
        item_id: itemId,
        buy_id: cur[0].buy_id,
        grp: TEXT(b.grp, 20) ?? "規格",
        label: TEXT(b.label, 40),
        sort: Math.trunc(Number(b.sort) || 0),
      };
      if (!row.label) return json({ ok: false, error: "BAD_INPUT", message: "請填規格名稱" }, 400);
      if (b.id) {
        const patch: Record<string, unknown> = { ...row };
        if (typeof b.active === "boolean") patch.active = b.active;
        await db(`group_buy_variants?id=eq.${Number(b.id)}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch),
        });
      } else {
        await db("group_buy_variants", {
          method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row),
        });
      }
      return json({ ok: true });
    }

    // ── 幹部：待審清單與核可／退回 ─────────────────────────
    if (action === "pending") {
      const me = await whoami(req);
      if (!isOfficer(me)) return json({ ok: false, error: "FORBIDDEN" }, 403);
      // 待審的看不到商品（RLS 擋著），所以連商品一起用 service key 撈出來給幹部看
      const rows = await db(`group_buys?status=eq.pending&select=id,title,body,deadline,created_at,members!group_buys_owner_id_fkey(id,name),group_buy_items(id,name,unit_price,min_qty,photos)&order=created_at.asc`);
      return json({ ok: true, list: rows ?? [] });
    }

    // ── 幹部：所有團購的總覽（含訂購件數，不用一個一個點進去）──
    if (action === "overview") {
      const me = await whoami(req);
      if (!isOfficer(me)) return json({ ok: false, error: "FORBIDDEN" }, 403);
      // ⛔ 排除 draft：還沒送審的草稿是團主自己的東西，幹部不該看到
      const buys = await db(`group_buys?status=neq.draft&select=id,title,status,deadline,owner_id,body,members!group_buys_owner_id_fkey(id,name),group_buy_items(id,name,unit_price,min_qty)&order=deadline.desc`) ?? [];
      const orders = await db(`group_buy_orders?select=buy_id,item_id,qty`) ?? [];
      const qtyOf: Record<number, number> = {};
      for (const o of orders) qtyOf[o.item_id as number] = (qtyOf[o.item_id as number] ?? 0) + (o.qty as number);
      // 財務長要在這一頁看完每一團還差多少沒收，不用一團一團點進去
      const pays = await db(`group_buy_payments?select=buy_id,amount`) ?? [];
      const paidOf: Record<number, number> = {};
      for (const p of pays) paidOf[p.buy_id as number] = (paidOf[p.buy_id as number] ?? 0) + (p.amount as number);
      return json({
        ok: true,
        list: buys.map((b: Record<string, unknown>) => {
          const items = (b.group_buy_items ?? []) as Record<string, unknown>[];
          return {
            id: b.id, title: b.title, status: b.status, deadline: b.deadline, body: b.body,
            owner: (b.members as { name?: string } | null)?.name ?? "",
            amount: items.reduce((n, i) => n + (qtyOf[i.id as number] ?? 0) * (i.unit_price as number), 0),
            paid_total: paidOf[b.id as number] ?? 0,
            items: items.map((i) => ({
              id: i.id, name: i.name, unit_price: i.unit_price, min_qty: i.min_qty,
              qty: qtyOf[i.id as number] ?? 0,
              reached: (qtyOf[i.id as number] ?? 0) >= (i.min_qty as number),
            })),
          };
        }),
      });
    }
    if (action === "approve") {
      const me = await whoami(req);
      if (!isOfficer(me)) return json({ ok: false, error: "FORBIDDEN" }, 403);
      const id = Number(b.id);
      await db(`group_buys?id=eq.${id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: b.reject ? "rejected" : "open",
          approved_by: me!.id, approved_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }),
      });
      return json({ ok: true });
    }

    // ── 下單 ────────────────────────────────────────────────
    if (action === "order") {
      const me = await whoami(req);
      if (!me) return json({ ok: false, error: "NOT_BOUND", message: "請先用 LINE 登入" }, 401);
      const itemId = Number(b.item_id);
      const qty = Math.trunc(Number(b.qty) || 0);

      const it = await db(`group_buy_items?id=eq.${itemId}&select=id,buy_id,name,max_per_person,group_buys(status,deadline)`);
      if (!it.length) return json({ ok: false, error: "NOT_FOUND" }, 404);
      const buy = it[0].group_buys as { status: string; deadline: string };
      if (buy.status !== "open") return json({ ok: false, error: "CLOSED", message: "這個團購已經結束了" }, 409);
      if (twToday() > buy.deadline) return json({ ok: false, error: "CLOSED", message: "已經過了截止日" }, 409);

      // 規格選擇 {"顏色":"紅","尺寸":"M"}；同一個人可以買不同規格各一筆
      let choices: Record<string, string> | null = null;
      if (b.choices && typeof b.choices === "object") {
        choices = {};
        for (const [k, v] of Object.entries(b.choices)) {
          const val = TEXT(v, 40); if (!val) continue;
          choices[String(k).slice(0, 20)] = val;
        }
        if (!Object.keys(choices).length) choices = null;
      }

      // 每人限購。qty<=0 是「取消訂單」，不必檢查。
      // ⛔ 一定要放在「新增」與「改單」兩條路的前面：只擋新增的話，
      //    先訂 1 件再把數量改成 5 件就整個繞過去了。
      const cap = Math.trunc(Number(it[0].max_per_person) || 0);
      if (cap > 0 && qty > 0) {
        const mineRows = await db(
          `group_buy_orders?item_id=eq.${itemId}&member_id=eq.${me.id}&select=id,qty`);
        const editing = b.order_id ? Number(b.order_id) : 0;
        const others = mineRows
          .filter((r: { id: number }) => r.id !== editing)
          .reduce((a: number, r: { qty: number }) => a + (Number(r.qty) || 0), 0);
        if (others + qty > cap) {
          return json({ ok: false, error: "OVER_LIMIT",
            message: `這樣商品每人最多 ${cap} 件` +
                     (others ? `，你已經訂了 ${others} 件` : "") + "。" }, 409);
        }
      }

      if (b.order_id) {
        const own = await db(`group_buy_orders?id=eq.${Number(b.order_id)}&select=id,member_id`);
        if (!own.length) return json({ ok: false, error: "NOT_FOUND" }, 404);
        if (own[0].member_id !== me.id) return json({ ok: false, error: "FORBIDDEN" }, 403);
        // ⛔ 已經繳過錢的人不能自己改或刪訂單。
        //    否則訂單沒了、收款紀錄還留著，變成畫面上查無此人的孤兒帳
        //    （2026-08-26 真的發生過：系統說已收 $1200，訂購名單一個人都沒有）。
        const paidRows = await db(`group_buy_payments?buy_id=eq.${it[0].buy_id}&member_id=eq.${me.id}&select=amount`);
        if (paidRows.length) {
          return json({ ok: false, error: "ALREADY_PAID",
            message: `你這一團已經繳了 $${paidRows[0].amount}，不能自己改或取消。` +
                     `請找幹部處理退款，幹部取消收款之後就能改了。` }, 409);
        }
        if (qty <= 0) {
          await db(`group_buy_orders?id=eq.${Number(b.order_id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
          return json({ ok: true, removed: true });
        }
        await db(`group_buy_orders?id=eq.${Number(b.order_id)}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ qty, choices, note: TEXT(b.note, 200), updated_at: new Date().toISOString() }),
        });
        return json({ ok: true, qty });
      }

      if (qty <= 0) return json({ ok: false, error: "BAD_INPUT", message: "數量要大於 0" }, 400);
      await db("group_buy_orders", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ buy_id: it[0].buy_id, item_id: itemId, member_id: me.id,
                               choices, qty, note: TEXT(b.note, 200) }),
      });
      return json({ ok: true, qty });
    }

    // ── 我訂了什麼 ──────────────────────────────────────────
    if (action === "mine") {
      const me = await whoami(req);
      if (!me) return json({ ok: true, orders: [] });
      const rows = await db(`group_buy_orders?member_id=eq.${me.id}&select=id,buy_id,item_id,choices,qty,note`);
      return json({ ok: true, orders: rows ?? [] });
    }

    // ── 開單者／幹部：完整名單與各規格統計 ────────────────────
    if (action === "detail") {
      const me = await whoami(req);
      if (!me) return json({ ok: false, error: "NOT_BOUND" }, 401);
      const buyId = Number(b.buy_id);
      const cur = await db(`group_buys?id=eq.${buyId}&select=id,owner_id,title,deadline,status`);
      if (!cur.length) return json({ ok: false, error: "NOT_FOUND" }, 404);
      if (cur[0].owner_id !== me.id && !isOfficer(me)) {
        return json({ ok: false, error: "FORBIDDEN", message: "只有開單的人跟幹部看得到訂購名單" }, 403);
      }
      const [items, orders, pays, logs] = await Promise.all([
        db(`group_buy_items?buy_id=eq.${buyId}&select=id,name,unit_price,min_qty,sort&order=sort.asc`),
        db(`group_buy_orders?buy_id=eq.${buyId}&select=id,item_id,member_id,choices,qty,note,created_at,members!group_buy_orders_member_id_fkey(id,name)&order=created_at.asc`),
        db(`group_buy_payments?buy_id=eq.${buyId}&select=member_id,amount,paid_at,paid_by`),
        db(`group_buy_payment_log?buy_id=eq.${buyId}&select=id,member_id,action,amount,by_member,note,at&order=at.desc`),
      ]);
      // 收款人與經手人的名字自己查一次，不用內嵌關聯
      const who = new Set<number>();
      for (const p of pays ?? []) { who.add(p.member_id); who.add(p.paid_by); }
      for (const l of logs ?? []) { who.add(l.member_id); who.add(l.by_member); }
      const NAME: Record<number, string> = {};
      if (who.size) {
        const ms = await db(`members?id=in.(${[...who].join(",")})&select=id,name`);
        for (const m of ms ?? []) NAME[m.id as number] = m.name as string;
      }
      const paidMap: Record<number, { amount: number; paid_at: string; by: string }> = {};
      for (const p of pays ?? []) {
        paidMap[p.member_id as number] = { amount: p.amount, paid_at: p.paid_at, by: NAME[p.paid_by as number] ?? "" };
      }
      const byItem: Record<number, Record<string, unknown>> = {};
      for (const it of items ?? []) {
        byItem[it.id] = { id: it.id, name: it.name, unit_price: it.unit_price, min_qty: it.min_qty,
                          qty: 0, amount: 0, tally: {} as Record<string, number>, list: [] as unknown[] };
      }
      let grand = 0;
      // 收錢是收「一個人的總額」，所以這裡同時按人加總，不是只按商品
      const byMember: Record<number, { member_id: number; name: string; qty: number; amount: number }> = {};
      for (const o of orders ?? []) {
        const it = byItem[o.item_id as number];
        if (!it) continue;
        (it.qty as number) += o.qty;
        (it.amount as number) += o.qty * (it.unit_price as number);
        grand += o.qty * (it.unit_price as number);
        // 統計「紅色／M」這種組合各幾件——開單的人要照這個去下單
        const key = o.choices && Object.keys(o.choices).length
          ? Object.entries(o.choices as Record<string, string>).map(([k, v]) => `${k}：${v}`).join("／")
          : "（無規格）";
        const t = it.tally as Record<string, number>;
        t[key] = (t[key] ?? 0) + o.qty;
        const who = (o.members as { name?: string } | null)?.name ?? "";
        (it.list as unknown[]).push({
          name: who,
          spec: key === "（無規格）" ? "" : key,
          qty: o.qty, note: o.note ?? "",
        });
        const mid = o.member_id as number;
        byMember[mid] ??= { member_id: mid, name: who, qty: 0, amount: 0 };
        byMember[mid].qty += o.qty;
        byMember[mid].amount += o.qty * (it.unit_price as number);
      }
      const list = Object.values(byItem).map((x) => ({ ...x, reached: (x.qty as number) >= (x.min_qty as number) }));
      // 每個人一列：應付多少、收了沒、收的當下是多少錢
      const people = Object.values(byMember)
        .map((m) => {
          const p = paidMap[m.member_id];
          return { ...m, paid: !!p, paid_amount: p ? p.amount : 0, paid_at: p ? p.paid_at : null,
                   paid_by: p ? p.by : "",
                   // 勾完之後又改訂單，就會對不起來——財務要看得到這個差額
                   mismatch: p ? p.amount !== m.amount : false };
        })
        .sort((x, y) => (x.paid === y.paid ? x.name.localeCompare(y.name, "zh-Hant") : (x.paid ? 1 : -1)));
      const paidTotal = people.filter((x) => x.paid).reduce((n, x) => n + x.amount, 0);
      const ledger = (logs ?? []).map((l: Record<string, unknown>) => ({
        id: l.id, action: l.action, amount: l.amount, at: l.at, note: l.note,
        name: NAME[l.member_id as number] ?? "", by: NAME[l.by_member as number] ?? "",
      }));
      return json({ ok: true, buy: cur[0], items: list, grand_amount: grand,
                    people, paid_total: paidTotal, unpaid_total: grand - paidTotal,
                    ledger, can_mark: isOfficer(me) });
    }

    // ── 刪掉整張團購單 ──────────────────────────────────────
    // ⛔ 已經有人訂購就不給刪——刪掉等於把別人的訂購紀錄一起抹掉。
    //    那種情況要用「取消」，訂購的人才看得到發生什麼事。
    if (action === "remove") {
      const me = await whoami(req);
      if (!me) return json({ ok: false, error: "NOT_BOUND" }, 401);
      const id = Number(b.id);
      const cur = await db(`group_buys?id=eq.${id}&select=id,owner_id,status,title`);
      if (!cur.length) return json({ ok: false, error: "NOT_FOUND" }, 404);
      if (!isOfficer(me)) {
        return json({ ok: false, error: "FORBIDDEN",
                      message: "刪除要請幹部處理——團購裡會有訂購與收款紀錄，刪掉救不回來。" }, 403);
      }
      // ⛔ 有人訂購就先擋一次，並把「會連帶刪掉什麼」算出來告訴幹部。
      //    要真的刪必須明確帶 force —— 不讓任何人一鍵抹掉別人的訂購與收款紀錄。
      const [orders, pays] = await Promise.all([
        db(`group_buy_orders?buy_id=eq.${id}&select=id,qty,member_id`),
        db(`group_buy_payments?buy_id=eq.${id}&select=member_id,amount`),
      ]);
      if (orders.length && b.force !== true) {
        const buyers = new Set(orders.map((o: { member_id: number }) => o.member_id)).size;
        const paidTotal = (pays ?? []).reduce((n: number, p: { amount: number }) => n + p.amount, 0);
        return json({
          ok: false, error: "HAS_ORDER",
          orders: orders.length, buyers, payments: (pays ?? []).length, paid_total: paidTotal,
          message: `這團已經有 ${buyers} 個人、共 ${orders.length} 筆訂購` +
                   (pays?.length ? `，已收款 $${paidTotal}` : "") + "。",
        }, 409);
      }
      // items / variants / payments 都是 on delete cascade，會跟著一起清掉
      await db(`group_buys?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      return json({ ok: true, deleted: cur[0].title });
    }

    // ── 送出審核：團主把草稿交給幹部 ─────────────────────────
    // ⛔ 沒有商品不給送——幹部審一張空單毫無意義
    if (action === "submit") {
      const me = await whoami(req);
      if (!me) return json({ ok: false, error: "NOT_BOUND" }, 401);
      const id = Number(b.id);
      const cur = await db(`group_buys?id=eq.${id}&select=id,owner_id,status`);
      if (!cur.length) return json({ ok: false, error: "NOT_FOUND" }, 404);
      if (cur[0].owner_id !== me.id && !isOfficer(me)) {
        return json({ ok: false, error: "FORBIDDEN", message: "只能送出自己開的團購" }, 403);
      }
      if (!["draft", "rejected"].includes(cur[0].status)) {
        return json({ ok: false, error: "BAD_STATE", message: "這張單已經送出過了" }, 409);
      }
      const items = await db(`group_buy_items?buy_id=eq.${id}&select=id&limit=1`);
      if (!items.length) {
        return json({ ok: false, error: "NO_ITEM", message: "至少要有一樣商品才能送審" }, 400);
      }
      await db(`group_buys?id=eq.${id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "pending", updated_at: new Date().toISOString() }),
      });
      return json({ ok: true, status: "pending" });
    }

    // ── 我開的、還沒上架的單 ────────────────────────────────
    // ⛔ RLS 只讓 open/closed/cancelled 被前台讀到，待審的單連開單者自己都撈不到，
    //    結果「建立→加商品」這一步直接斷掉（按了像沒反應，關掉頁面就再也回不去）。
    if (action === "mine_buys") {
      const me = await whoami(req);
      if (!me) return json({ ok: true, buys: [], items: [], variants: [] });
      const buys = await db(`group_buys?owner_id=eq.${me.id}&status=in.(draft,pending,rejected)&select=id,owner_id,title,body,deadline,status&order=deadline.asc`) ?? [];
      if (!buys.length) return json({ ok: true, buys: [], items: [], variants: [] });
      const ids = buys.map((x: { id: number }) => x.id).join(",");
      const items = await db(`group_buy_items?buy_id=in.(${ids})&select=id,buy_id,name,body,unit_price,min_qty,photos,sort&order=sort.asc`) ?? [];
      const itemIds = items.map((i: { id: number }) => i.id).join(",");
      const variants = itemIds
        ? (await db(`group_buy_variants?item_id=in.(${itemIds})&select=id,item_id,grp,label,sort&order=sort.asc`) ?? [])
        : [];
      return json({ ok: true, buys, items, variants });
    }

    // ── 標記收款 / 取消收款（只有幹部：錢統一交給財務長）──────
    // ⛔ 金額一律伺服器自己重算，前端送來的數字一概不採信
    if (action === "pay") {
      const me = await whoami(req);
      if (!me) return json({ ok: false, error: "NOT_BOUND" }, 401);
      // ⛔ 錢統一由財務長收，登記繳費只有幹部能做——開單的人看得到名單，但不能勾
      if (!isOfficer(me)) {
        return json({ ok: false, error: "FORBIDDEN", message: "只有幹部可以登記繳費" }, 403);
      }
      const buyId = Number(b.buy_id), memberId = Number(b.member_id);
      if (!buyId || !memberId) return json({ ok: false, error: "BAD_REQUEST" }, 400);

      if (b.paid === false) {
        // 取消前先把原本收了多少讀出來，才寫得進帳
        const old = await db(`group_buy_payments?buy_id=eq.${buyId}&member_id=eq.${memberId}&select=amount`);
        await db(`group_buy_payments?buy_id=eq.${buyId}&member_id=eq.${memberId}`, {
          method: "DELETE", headers: { Prefer: "return=minimal" },
        });
        await db("group_buy_payment_log", {
          method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ buy_id: buyId, member_id: memberId, action: "void",
                                 amount: old?.[0]?.amount ?? 0, by_member: me.id, note: TEXT(b.note, 100) }),
        });
        return json({ ok: true, paid: false });
      }

      const [items, orders] = await Promise.all([
        db(`group_buy_items?buy_id=eq.${buyId}&select=id,unit_price`),
        db(`group_buy_orders?buy_id=eq.${buyId}&member_id=eq.${memberId}&select=item_id,qty`),
      ]);
      if (!orders?.length) return json({ ok: false, error: "NO_ORDER", message: "這個人在這張單裡沒有訂購" }, 404);
      const price: Record<number, number> = {};
      for (const it of items ?? []) price[it.id as number] = it.unit_price as number;
      let amount = 0;
      for (const o of orders) amount += (o.qty as number) * (price[o.item_id as number] ?? 0);

      await db("group_buy_payments", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ buy_id: buyId, member_id: memberId, amount,
                               paid_at: new Date().toISOString(), paid_by: me.id,
                               note: TEXT(b.note, 100) }),
      });
      await db("group_buy_payment_log", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ buy_id: buyId, member_id: memberId, action: "paid",
                               amount, by_member: me.id, note: TEXT(b.note, 100) }),
      });
      return json({ ok: true, paid: true, amount });
    }

    // ── 截止清理：未達門檻自動取消 ──────────────────────────
    // ⛔ 不能靠任何人記得回來收尾（BNI 平台上次死掉就是因為過期內容沒人清）
    if (action === "sweep") {
      const n = await db("rpc/close_expired_group_buys", { method: "POST", body: "{}" });
      return json({ ok: true, closed: n });
    }

    return json({ ok: false, error: "unknown action" }, 400);
  } catch (e) {
    return json({ ok: false, error: "SERVER", message: String(e) }, 500);
  }
});
