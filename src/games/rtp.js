// 步骤6 · 返还率自动计算引擎（T6.9，§3.2）
// 抓娃娃 = 解析式（池权重 × 条目概率 × 折算价值）；老虎机 = 内置蒙特卡洛（固定 seed、10 万次）
// 输出三张表：整机返还率 / 分选项返还率 / 条目贡献占比；另给奖惩净值（仅参考、不拦截）
// 惩罚不结算不扣款（G11），不计入返还率扣减，仅折算为 Spank 风险作净值参考

import { simulateSpin, buildStrip, getSlotConfig } from './slot.js'
import { mulberry32 } from './rng.js'
import { getParam } from '../kernel/templates.js'
import { KernelError } from '../kernel/util.js'

export const TARGET_RANGES = {
  grab: { min: 0.80, max: 0.90, design: 0.87 },
  slot: { min: 0.93, max: 0.97, design: 0.95 },
}

// 折算价值（§3.2）
async function loadValueTables(DB) {
  const items = await DB.prepare('SELECT id, price, rarity, category, action, action_value FROM item_templates').all()
  const itemMap = {}
  for (const r of items.results || []) itemMap[r.id] = r
  const rewards = await DB.prepare('SELECT id, value FROM reward_templates').all()
  const rewardMap = {}
  for (const r of rewards.results || []) rewardMap[r.id] = r
  const recipes = await DB.prepare('SELECT id, target_type, target_id, pieces_required FROM fragment_recipes').all()
  const recipeMap = {}
  for (const r of recipes.results || []) recipeMap[r.id] = r
  const penalties = await DB.prepare('SELECT id, spank_min, spank_max FROM penalty_templates').all()
  const penaltyMap = {}
  for (const r of penalties.results || []) penaltyMap[r.id] = r
  const unit = Number(await getParam(DB, 'reduce_unit_price', '10'))
  return { itemMap, rewardMap, recipeMap, penaltyMap, unit }
}

function makeValueFn(tables) {
  const { itemMap, rewardMap, recipeMap } = tables
  return (ref_type, ref_id, amount) => {
    if (ref_type === 'coin') return amount || 0
    if (ref_type === 'item') return itemMap[ref_id]?.price || 0
    if (ref_type === 'reward') return rewardMap[ref_id]?.value || 0
    if (ref_type === 'fragment') {
      const r = recipeMap[ref_id]
      if (!r) return 0
      const base = r.target_type === 'item' ? (itemMap[r.target_id]?.price || 0) : (rewardMap[r.target_id]?.value || 0)
      return base / (r.pieces_required || 1)
    }
    return 0 // penalty：不产生正产出
  }
}

function spankRisk(tables, ref_type, ref_id) {
  if (ref_type !== 'penalty') return 0
  const p = tables.penaltyMap[ref_id]
  if (!p) return 0
  return ((p.spank_min + p.spank_max) / 2) * tables.unit
}

// ---------- 抓娃娃：解析式（§3.2） ----------
const GRAB_RARITY = [[1, 60], [2, 25], [3, 12], [4, 3]]
const GRAB_SUCCESS = { 1: 0.90, 2: 0.75, 3: 0.55, 4: 0.40 }
const HAND_SLIP = 0.3

export async function computeGrabRTP(DB, payload = null, fee = 10, rarityWeights = null) {
  const tables = await loadValueTables(DB)
  const valueOf = makeValueFn(tables)
  const rarityAxis = rarityWeights || GRAB_RARITY.map(([l, w]) => [l, w])

  // 条目来源：payload（提审预览）或线上表
  let controls = {}
  let poolsByOption = {}
  if (payload) {
    for (const c of payload.controls || []) controls[c.option] = c
    for (const e of payload.pools || []) {
      if (!e.is_active) continue
      poolsByOption[e.option] = poolsByOption[e.option] || []
      poolsByOption[e.option].push(e)
    }
  } else {
    const sideRows = await DB.prepare("SELECT * FROM drop_side_controls WHERE game = 'grab'").all()
    for (const c of sideRows.results || []) controls[c.option] = c
    const poolRows = await DB.prepare("SELECT * FROM drop_pools WHERE game = 'grab' AND is_active = 1").all()
    for (const e of poolRows.results || []) {
      poolsByOption[e.option] = poolsByOption[e.option] || []
      poolsByOption[e.option].push(e)
    }
  }

  const totalRarity = rarityAxis.reduce((s, [, w]) => s + w, 0)
  const perOption = []
  const items = []
  let evTotal = 0
  let riskTotal = 0

  for (const [rarity, w] of rarityAxis) {
    const option = `L${rarity}`
    const list = poolsByOption[option] || []
    const c = controls[option] || { reward_side_prob: 0.5, penalty_side_prob: 0.5 }
    const optProb = w / totalRarity
    const hitProb = optProb * (GRAB_SUCCESS[rarity] + HAND_SLIP * (1 - GRAB_SUCCESS[rarity]))

    const rewardW = list.filter(e => e.side === 'reward').reduce((s, e) => s + e.weight, 0)
    const penaltyW = list.filter(e => e.side === 'penalty').reduce((s, e) => s + e.weight, 0)
    const rw = Math.max(0, c.reward_side_prob)
    const pw = Math.max(0, c.penalty_side_prob)
    const sideSum = rw + pw || 1

    let ev = 0
    let risk = 0
    for (const e of list) {
      const sideProb = e.side === 'reward' ? (rw / sideSum) : (pw / sideSum)
      const entryProb = hitProb * sideProb * (e.weight / (e.side === 'reward' ? rewardW || 1 : penaltyW || 1))
      const val = valueOf(e.ref_type, e.ref_id, e.amount)
      ev += entryProb * val
      risk += entryProb * spankRisk(tables, e.ref_type, e.ref_id)
      if (val > 0 || e.ref_type === 'penalty') {
        items.push({ option, refType: e.ref_type, refId: e.ref_id, prob: entryProb, contribution: entryProb * val / fee, risk: entryProb * spankRisk(tables, e.ref_type, e.ref_id) / fee })
      }
    }
    perOption.push({ option, prob: optProb, ev, contribution: ev / fee })
    evTotal += ev
    riskTotal += risk
  }

  const rtp = evTotal / fee
  const net = (evTotal - riskTotal) / fee
  return {
    game: 'grab', type: 'analytic', fee,
    rtp, net,
    range: TARGET_RANGES.grab,
    perOption,
    items: items.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
  }
}

// ---------- 老虎机：蒙特卡洛（固定 seed、10 万次，含爆裂/Fever/保底/彩池） ----------
export async function computeSlotRTP(DB, payload = null, spins = 100000, fee = 10) {
  const tables = await loadValueTables(DB)
  const cfg = payload ? { ...(await getSlotConfig(DB)), ...payload } : await getSlotConfig(DB)
  const poolRate = Number(await getParam(DB, 'pool_rate', '5'))
  const fragValue = rid => {
    const r = tables.recipeMap[rid]
    if (!r) return 0
    const base = r.target_type === 'item' ? (tables.itemMap[r.target_id]?.price || 0) : (tables.rewardMap[r.target_id]?.value || 0)
    return base / (r.pieces_required || 1)
  }
  // 转轮期望（预生成揭示口径）
  const wheelEV = cfg.wheel.reduce((s, x) => {
    if (x.type === 'reward') return s + x.prob / 100 * 50
    if (x.type === 'coin') return s + x.prob / 100 * x.value
    if (x.type === 'coin_range') return s + x.prob / 100 * ((x.min + x.max) / 2)
    if (x.type === 'fragment') return s + x.prob / 100 * fragValue(1) * (x.rarity === 4 ? 120 / 60 : 1)
    return s
  }, 0)
  const monkeyEV = 12.5 * 2 / 3   // 2 张 5~15 币的期望

  // 分桶：连线 / 爆裂追加 / Fever / 小剧场+转轮+碎片 / 保底 / 彩池
  const buckets = { lines: 0, cascade: 0, fever: 0, bonus: 0, pity: 0, pool: 0 }
  const rng = mulberry32(20260916)
  let feverSlot = 0, feverActive = false, feverLeft = 0, multIdx = 0, noWin = 0
  let inPaid = 0

  for (let i = 0; i < spins; i++) {
    const fever = feverActive && feverLeft > 0
    if (!fever) {
      inPaid += fee
      buckets.pool += fee * poolRate / 100   // 彩池长期全额返还（§3.3：贡献≈入池比例）
    }
    const sim = simulateSpin({
      seed: Math.floor(rng() * 0xffffffff), cfg, fee,
      feverActive: fever, startMultIdx: fever ? multIdx : 0,
      forceWin: noWin >= cfg.pity.streak,
    })
    const base = sim.steps.find(s => s.type === 'cascade')
    const basePay = base ? base.roundPay : 0
    buckets.lines += basePay
    buckets.cascade += sim.payout - basePay
    if (sim.pityApplied) buckets.pity += sim.payout
    for (const f of sim.fragments) buckets.bonus += fragValue(3) * 0 // 占位；统一在 bonus 计
    // 碎片价值（华丽12 / 鎏金 120/7）
    for (const f of sim.fragments) buckets.bonus += f === 4 ? 120 / 7 : 12
    if (sim.monkey) buckets.bonus += monkeyEV
    if (sim.wheel) buckets.bonus += wheelEV

    if (fever) {
      feverLeft--
      if (feverLeft <= 0) {
        feverActive = false; feverSlot = 0; multIdx = 0
        buckets.fever += 12   // 结束保底华丽碎片
      }
    } else {
      feverSlot += sim.feverDelta
      if (feverSlot >= cfg.fever.slotMax || sim.cascadeTriggerFever) {
        feverActive = true; feverLeft = cfg.fever.spins; feverSlot = 0; multIdx = 0
      }
    }
    multIdx = sim.endMultIdx
    noWin = sim.payout > 0 ? 0 : noWin + 1
  }

  const evTotal = buckets.lines + buckets.cascade + buckets.fever + buckets.bonus + buckets.pity + buckets.pool
  // RTP = 总产出 / 总投入（免费转产出计入、投入只算付费）
  const finalRtp = evTotal / inPaid

  const perOption = Object.entries(buckets).map(([k, v]) => ({
    option: k, ev: Math.round(v * 100) / 100, contribution: v / inPaid,
  }))
  const net = finalRtp   // 老虎机无扣款惩罚（追猴去毒化），净值≈返还率
  return {
    game: 'slot', type: 'montecarlo', spins, fee,
    rtp: finalRtp, net,
    range: TARGET_RANGES.slot,
    perOption,
    items: [],
    note: `彩池按长期返还口径计入入池比例 ${poolRate}%（§3.3）`,
  }
}

export async function computeGameRTP(DB, game, payload = null, fee = 10, rarityWeights = null) {
  if (game === 'grab') return computeGrabRTP(DB, payload, fee, rarityWeights)
  if (game === 'slot') return computeSlotRTP(DB, payload, 100000, fee)
  throw new KernelError('UNKNOWN_GAME', '未知的游戏，无法计算返还率')
}

// 符号带健壮性校验（slot payload 提审时）
export function validateSlotPayload(cfg) {
  const strip = buildStrip(cfg.weights)
  return strip.length > 0
}
