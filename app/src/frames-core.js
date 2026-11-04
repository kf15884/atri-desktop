'use strict'
/**
 * 一起看番（0.4）：挑帧和交图节奏，纯计算，不碰网络、不碰 Electron。
 * 在观看窗口里以 <script> 用（window.AtriFrames），在 node 测试里 require。
 * 挑帧规则和服务器看视频（atri limbs/src/video/frames.ts）同一套：
 * - 整屏平均找切点；8×6 分块里变得最厉害的那块找换字幕、小动作
 * - 分块门槛 = 最近一段的底噪中位数 × 4，夹在 3–24
 * - 画面变了等它稳定下来再选那一帧；一直在动隔 3 秒补一张；30 秒兜底
 * 思路参考 SAOS-3624/dsh-see-now（Apache-2.0）与 ztough926/video-understanding（GPL-3.0，只借思路，没用代码）。
 */
;(function (root, factory) {
  const m = factory()
  if (typeof module === 'object' && module.exports) module.exports = m
  else root.AtriFrames = m
})(typeof self !== 'undefined' ? self : this, function () {
  const SCAN_W = 64
  const SCAN_H = 36
  const BLOCKS_X = 8
  const BLOCKS_Y = 6

  /** 64×36 的 RGBA（画布缩小后取的）→ 每格 HSV（0–255） */
  function gridHsv(rgba) {
    const out = new Float32Array(SCAN_W * SCAN_H * 3)
    for (let i = 0; i < SCAN_W * SCAN_H; i++) {
      const r = rgba[i * 4] / 255
      const g = rgba[i * 4 + 1] / 255
      const b = rgba[i * 4 + 2] / 255
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const d = max - min
      let h = 0
      if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6
        else if (max === g) h = (b - r) / d + 2
        else h = (r - g) / d + 4
        h *= 60
        if (h < 0) h += 360
      }
      out[i * 3] = (h / 360) * 255
      out[i * 3 + 1] = max === 0 ? 0 : (d / max) * 255
      out[i * 3 + 2] = max * 255
    }
    return out
  }

  function cellDiff(prev, cur, i) {
    const dh = Math.abs(cur[i] - prev[i])
    return Math.min(dh, 255 - dh) * (Math.min(cur[i + 1], prev[i + 1]) / 255) + Math.abs(cur[i + 1] - prev[i + 1]) + Math.abs(cur[i + 2] - prev[i + 2])
  }

  /** 整屏平均变化 */
  function scorePair(prev, cur) {
    let sum = 0
    for (let i = 0; i < cur.length; i += 3) sum += cellDiff(prev, cur, i)
    return sum / (cur.length / 3)
  }

  /** 分块最大变化 */
  function blockMax(prev, cur) {
    const bw = SCAN_W / BLOCKS_X
    const bh = SCAN_H / BLOCKS_Y
    let best = 0
    for (let by = 0; by < BLOCKS_Y; by++) {
      for (let bx = 0; bx < BLOCKS_X; bx++) {
        let sum = 0
        for (let y = by * bh; y < (by + 1) * bh; y++) for (let x = bx * bw; x < (bx + 1) * bw; x++) sum += cellDiff(prev, cur, (y * SCAN_W + x) * 3)
        best = Math.max(best, sum / (bw * bh))
      }
    }
    return best
  }

  const DEFAULT_SELECT = { cutAbs: 12, cutSpike: 2.5, cutMinGap: 1, noiseK: 4, thrMin: 3, thrMax: 24, noiseWindow: 240, motionSeconds: 3, minGap: 0.5, floorSeconds: 30 }

  /** 边看边挑：第 i 帧（t 秒），分数 {g, b}，下一帧的整屏分数（要多看一帧确认是不是尖峰） */
  class Selector {
    constructor(o = {}) {
      this.o = { ...DEFAULT_SELECT, ...o }
      this.recent = []
      this.lastCut = -Infinity
      this.lastKeep = -Infinity
      this.changing = false
      this.changeStart = 0
      this.prevG = 0
    }
    threshold() {
      if (this.recent.length < 6) return this.o.thrMin * 2
      const sorted = [...this.recent].sort((a, b) => a - b)
      return Math.min(this.o.thrMax, Math.max(this.o.thrMin, sorted[Math.floor(sorted.length / 2)] * this.o.noiseK))
    }
    /** 这一帧算不算在变（给暂停判断用） */
    moving(s) {
      return s.b >= this.threshold() || s.g >= this.o.cutAbs
    }
    push(i, t, s, nextG) {
      const o = this.o
      if (i === 0) {
        this.lastKeep = t
        return { t, via: 'first', score: 0 }
      }
      const thr = this.threshold()
      this.recent.push(s.b)
      if (this.recent.length > o.noiseWindow) this.recent.shift()
      const prevG = this.prevG
      this.prevG = s.g
      const keep = (via) => {
        this.lastKeep = t
        return { t, via, score: Math.max(s.g, s.b) }
      }
      if (s.g >= o.cutAbs && s.g > o.cutSpike * Math.max(1, prevG, nextG) && t - this.lastCut >= o.cutMinGap) {
        this.lastCut = t
        this.changing = false
        return keep('cut')
      }
      if (s.b >= thr) {
        if (!this.changing) {
          this.changing = true
          this.changeStart = t
        }
        if (t - this.changeStart >= o.motionSeconds && t - this.lastKeep >= o.motionSeconds) return keep('motion')
        return null
      }
      if (this.changing) {
        this.changing = false
        if (t - this.lastKeep >= o.minGap) return keep('settle')
      }
      if (t - this.lastKeep >= o.floorSeconds) return keep('floor')
      return null
    }
  }

  const PRIORITY = { first: 0, cut: 1, settle: 2, motion: 3, floor: 3 }
  function evenly(xs, n) {
    if (n <= 0) return []
    if (xs.length <= n) return xs
    const out = []
    for (let k = 0; k < n; k++) out.push(xs[Math.floor((k * xs.length) / n)])
    return out
  }
  /** 太多了：切点 > 稳定帧 > 其余，同一级均匀抽，按时间排好 */
  function capPicked(picked, max) {
    if (picked.length <= max) return picked
    const out = []
    for (const level of [0, 1, 2, 3]) {
      const room = max - out.length
      if (room <= 0) break
      const group = picked.filter((p) => PRIORITY[p.via] === level)
      out.push(...(group.length > room ? evenly(group, room) : group))
    }
    return out.sort((a, b) => a.t - b.t)
  }

  /**
   * 什么时候交一批去看：
   * - interval：每 intervalMs 交一次（默认 10 秒）
   * - realtime：攒够 realtimeMin 个新时刻就交，最快 realtimeGapMs 一次；最长也不超过 intervalMs
   * - 同时最多 maxInFlight 个请求在路上
   * - 连着 pauseMs 都没变化 = 暂停：不交（暂停前攒下的先交掉）
   */
  class Batcher {
    constructor(o = {}) {
      this.o = { mode: 'interval', intervalMs: 10000, realtimeMin: 3, realtimeGapMs: 5000, maxInFlight: 2, pauseMs: 12000, maxCells: 12, ...o }
      this.pending = []
      this.lastSubmit = null
      this.inFlight = 0
      this.lastMove = null
      this.paused = false
    }
    /** 每帧调一次；返回暂停状态有没有变 */
    frame(now, moving) {
      if (this.lastSubmit === null) this.lastSubmit = now
      if (this.lastMove === null || moving) this.lastMove = now
      const paused = now - this.lastMove >= this.o.pauseMs
      const changed = paused !== this.paused
      this.paused = paused
      return changed
    }
    add(pick) {
      this.pending.push(pick)
    }
    take(now) {
      if (this.pending.length === 0 || this.inFlight >= this.o.maxInFlight) return null
      if (this.lastSubmit === null) this.lastSubmit = now
      const since = now - this.lastSubmit
      const due =
        this.paused ||
        since >= this.o.intervalMs ||
        (this.o.mode === 'realtime' && this.pending.length >= this.o.realtimeMin && since >= this.o.realtimeGapMs)
      if (!due) return null
      const batch = capPicked(this.pending, this.o.maxCells)
      this.pending = []
      this.lastSubmit = now
      this.inFlight++
      return batch
    }
    done() {
      this.inFlight = Math.max(0, this.inFlight - 1)
    }
  }

  function clock(sec) {
    const s = Math.max(0, Math.round(sec))
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
  }

  /** 交给看图模型的那段话（系统提示和格式要求由 Atri 那边给） */
  function buildPrompt(x) {
    const ep = x.episode ? (/^\d+$/.test(String(x.episode)) ? `第 ${x.episode} 集` : String(x.episode)) : ''
    const lines = [
      `正在看《${x.title || '不知道名字的番'}》${ep}，这是 ${clock(x.from)}–${clock(x.to)} 的画面。`,
      `图 1：按时间顺序截下来的关键帧，从左到右、从上到下，每格下面标了“#序号 时间”：${x.cells.map((c) => `#${c.n} ${clock(c.t)}`).join('、')}。`,
    ]
    let k = 2
    if (x.strip) lines.push(`图 ${k++}：其中几格底部的字幕条（原分辨率），从上到下按时间排，左边标了序号；字幕以这张为准，照抄原文。`)
    if (x.cast && x.cast.length) lines.push(`图 ${k++}：角色参考图，编号对应：${x.cast.map((m) => `${m.n}=${m.name}${m.looks ? `（${m.looks}）` : ''}`).join('，')}。`)
    else if (x.names && x.names.length) lines.push(`已知角色：${x.names.join('、')}。`)
    if (x.prev) lines.push(`上一段（接着它写）：${x.prev}`)
    // 听到的声音由主进程填进来（听完才知道）；没有就删掉这一行
    if (x.heardSlot) lines.push(HEARD_SLOT)
    lines.push(x.format)
    return lines.join('\n')
  }

  const HEARD_SLOT = '{{HEARD}}'
  function fillHeard(prompt, heard) {
    return String(prompt).replace(HEARD_SLOT + '\n', heard ? `同一段听到的（耳朵听的，可能听错；以字幕条为准）：${heard}\n` : '')
  }

  /** 听的模型有时把草稿也写进来：只取 <结果>…</结果>；没写标签就去掉英文草稿行 */
  function finalAnswer(text) {
    const t = String(text || '')
    const tagged = [...t.matchAll(/<结果>([\s\S]*?)(?:<\/结果>|$)/g)].map((m) => m[1].trim()).filter(Boolean)
    if (tagged.length) return tagged[tagged.length - 1]
    const lines = t.split('\n').filter((l) => /[\u4e00-\u9fff]/.test(l) && !/^(Rules|Requirements|Draft|Check|Let's|Length)/i.test(l.trim()))
    return (lines.length ? lines.join('\n') : t).trim()
  }

  /** 16kHz 单声道 16 位 PCM 片段 → WAV */
  function wav16(chunks) {
    const n = chunks.reduce((a, c) => a + c.length, 0)
    const buf = new ArrayBuffer(44 + n * 2)
    const v = new DataView(buf)
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true)
    let p = 44
    for (const c of chunks) for (let i = 0; i < c.length; i++, p += 2) v.setInt16(p, c[i], true)
    return new Uint8Array(buf)
  }

  /** 音量（0–1）：太小就当没声音，不去听 */
  function rms(chunks) {
    let sum = 0
    let n = 0
    for (const c of chunks) for (let i = 0; i < c.length; i++) { sum += (c[i] / 32768) ** 2; n++ }
    return n ? Math.sqrt(sum / n) : 0
  }

  /** 从模型回答里取第一个 JSON 对象 */
  function parseJson(text) {
    const s = String(text || '')
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a < 0 || b <= a) return null
    try {
      const v = JSON.parse(s.slice(a, b + 1))
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null
    } catch {
      return null
    }
  }

  /** 上一段写成一两句（下一次请求带上，接着写） */
  function prevLine(data) {
    if (!data) return ''
    const ev = Array.isArray(data.events) ? data.events.slice(-2).map((e) => String(e && e.text || '')).filter(Boolean) : []
    return [data.scene || '', ...ev].filter(Boolean).join('；').slice(0, 120)
  }

  /** 花费：单价按每百万 token 算 */
  function cost(usage, price) {
    const pin = Number(price && price.in) || 0
    const pout = Number(price && price.out) || 0
    return ((Number(usage.promptTokens) || 0) * pin + (Number(usage.completionTokens) || 0) * pout) / 1e6
  }

  return { SCAN_W, SCAN_H, gridHsv, scorePair, blockMax, Selector, capPicked, Batcher, clock, buildPrompt, parseJson, prevLine, cost, DEFAULT_SELECT, HEARD_SLOT, fillHeard, finalAnswer, wav16, rms }
})
