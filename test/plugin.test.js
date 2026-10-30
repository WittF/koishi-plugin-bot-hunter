// 用桩 Context 跑插件核心逻辑：node --test test/
const test = require('node:test')
const assert = require('node:assert/strict')
const { h } = require('koishi')
const plugin = require('../lib')

const SELF = '1040666674'
const OP = '3431185320'
const GROUP = '931805503'

class StubContext {
  constructor() {
    this.handlers = {}
    this.rows = []
    this.nextId = 1
    this.logs = []
    this.tables = {}
  }
  logger(name) {
    const push = (level) => (...args) => this.logs.push([level, args.map(String).join(' ')])
    return { info: push('info'), warn: push('warn'), debug: push('debug'), error: push('error') }
  }
  get model() {
    return { extend: (name, fields, opts) => { this.tables[name] = { fields, opts } } }
  }
  on(event, fn) {
    ;(this.handlers[event] ||= []).push(fn)
  }
  get database() {
    return {
      create: async (table, data) => {
        const row = { id: this.nextId++, ...data }
        this.rows.push(row)
        return row
      },
      get: async (table, query) => this.rows.filter((r) => Object.entries(query).every(([k, v]) => r[k] === v)),
      set: async (table, id, data) => {
        Object.assign(this.rows.find((r) => r.id === id), data)
      },
    }
  }
  async emit(session) {
    for (const fn of this.handlers.message) await fn(session)
    // handler 内部是 fire-and-forget，等一个 tick 让 async 流程跑完
    await new Promise((r) => setTimeout(r, 5))
  }
}

function makeBot() {
  const calls = []
  return {
    calls,
    muteGuildMember: async (guildId, userId, duration) => {
      calls.push({ guildId, userId, duration })
    },
  }
}

function msg(bot, userId, content, extra = {}) {
  return {
    platform: 'onebot',
    selfId: SELF,
    guildId: GROUP,
    channelId: GROUP,
    userId,
    isDirect: false,
    content,
    elements: h.parse(content),
    username: extra.username ?? userId,
    author: { name: extra.username ?? userId },
    bot,
    ...extra,
  }
}

const SNOW = 'SnowLuma 状态\n版本: 2.2.1\n平台: win32-x64\n运行时长: 4小时 25分钟'

function withClock(fn) {
  const real = Date.now
  let now = 1_800_000_000_000
  Date.now = () => now
  const clock = { tick: (ms) => { now += ms } }
  return fn(clock).finally(() => { Date.now = real })
}

function setup(configOverride = {}) {
  const ctx = new StubContext()
  const config = {
    operators: [OP],
    immune: [],
    unbanKeyword: 'unban',
    rules: [{ name: 'sl', trigger: '#sl', windowMs: 300, patterns: ['SnowLuma\\s*状态'], muteSeconds: 540360, enabled: true }],
    debug: false,
    ...configOverride,
  }
  plugin.apply(ctx, config)
  return ctx
}

test('#sl 后 0.3s 内命中特征 → 禁言 540360s 并落库', () =>
  withClock(async (clock) => {
    const ctx = setup()
    const bot = makeBot()
    await ctx.emit(msg(bot, OP, '#sl'))
    clock.tick(120)
    await ctx.emit(msg(bot, '3553579119', SNOW, { username: '大肥鱼' }))
    clock.tick(50)
    await ctx.emit(msg(bot, '2968215007', SNOW.replace('4小时 25分钟', '3小时 53分钟'), { username: '134421' }))
    assert.deepEqual(bot.calls, [
      { guildId: GROUP, userId: '3553579119', duration: 540360 * 1000 },
      { guildId: GROUP, userId: '2968215007', duration: 540360 * 1000 },
    ])
    assert.equal(ctx.rows.length, 2)
    assert.equal(ctx.rows[0].rule, 'sl')
    assert.equal(ctx.rows[0].trigger, '#sl')
    assert.equal(ctx.rows[0].delayMs, 120)
    assert.equal(ctx.rows[1].delayMs, 170)
    assert.equal(ctx.rows[0].active, true)
    assert.equal(ctx.rows[0].expiresAt.getTime() - ctx.rows[0].mutedAt.getTime(), 540360 * 1000)
  }))

test('群友 0.8s 后 +1 复制同样文本 → 不处置，只记日志', () =>
  withClock(async (clock) => {
    const ctx = setup()
    const bot = makeBot()
    await ctx.emit(msg(bot, OP, '#sl'))
    clock.tick(800)
    await ctx.emit(msg(bot, '10001', SNOW))
    assert.deepEqual(bot.calls, [])
    assert.equal(ctx.rows.length, 0)
    assert.ok(ctx.logs.some(([, m]) => m.includes('超出 300ms 窗口')))
  }))

test('窗口内但文本不命中特征 → 不处置', () =>
  withClock(async (clock) => {
    const ctx = setup()
    const bot = makeBot()
    await ctx.emit(msg(bot, OP, '#sl'))
    clock.tick(100)
    await ctx.emit(msg(bot, '10002', '什么情况'))
    assert.deepEqual(bot.calls, [])
  }))

test('没人发 #sl 时出现特征文本 → 不处置', () =>
  withClock(async () => {
    const ctx = setup()
    const bot = makeBot()
    await ctx.emit(msg(bot, '10003', SNOW))
    assert.deepEqual(bot.calls, [])
  }))

test('非 operator 发 #sl 不会武装', () =>
  withClock(async (clock) => {
    const ctx = setup()
    const bot = makeBot()
    await ctx.emit(msg(bot, '10004', '#sl'))
    clock.tick(100)
    await ctx.emit(msg(bot, '10005', SNOW))
    assert.deepEqual(bot.calls, [])
  }))

test('Bot 自己的消息、operator、豁免名单都不处置', () =>
  withClock(async (clock) => {
    const ctx = setup({ immune: ['20001'] })
    const bot = makeBot()
    await ctx.emit(msg(bot, OP, '#sl'))
    clock.tick(50)
    await ctx.emit(msg(bot, SELF, SNOW))
    await ctx.emit(msg(bot, OP, SNOW))
    await ctx.emit(msg(bot, '20001', SNOW))
    assert.deepEqual(bot.calls, [])
  }))

test('同一 Bot 窗口内连发两条只处置一次', () =>
  withClock(async (clock) => {
    const ctx = setup()
    const bot = makeBot()
    await ctx.emit(msg(bot, OP, '#sl'))
    clock.tick(50)
    await ctx.emit(msg(bot, '30001', SNOW))
    clock.tick(50)
    await ctx.emit(msg(bot, '30001', SNOW))
    assert.equal(bot.calls.length, 1)
    assert.equal(ctx.rows.length, 1)
  }))

test('观察期（3s）过后探测状态解除', () =>
  withClock(async (clock) => {
    const ctx = setup()
    const bot = makeBot()
    await ctx.emit(msg(bot, OP, '#sl'))
    clock.tick(3500)
    await ctx.emit(msg(bot, '40001', SNOW))
    assert.deepEqual(bot.calls, [])
    assert.ok(!ctx.logs.some(([, m]) => m.includes('超出')))
  }))

test('禁言接口报错 → 不落库', () =>
  withClock(async (clock) => {
    const ctx = setup()
    const bot = { calls: [], muteGuildMember: async () => { throw new Error('bot is not admin') } }
    await ctx.emit(msg(bot, OP, '#sl'))
    clock.tick(50)
    await ctx.emit(msg(bot, '50001', SNOW))
    assert.equal(ctx.rows.length, 0)
    assert.ok(ctx.logs.some(([lv, m]) => lv === 'warn' && m.includes('禁言') && m.includes('失败')))
  }))

test('unban #sl 只解当前群、只解 active 记录，并标记 released', () =>
  withClock(async (clock) => {
    const ctx = setup()
    const bot = makeBot()
    // 预置：本群两条 active、本群一条已解、另一群一条 active
    await ctx.database.create('bot_hunter_ban', { platform: 'onebot', guildId: GROUP, userId: '2968215007', rule: 'sl', trigger: '#sl', active: true })
    await ctx.database.create('bot_hunter_ban', { platform: 'onebot', guildId: GROUP, userId: '3553579119', rule: 'sl', trigger: '#sl', active: true })
    await ctx.database.create('bot_hunter_ban', { platform: 'onebot', guildId: GROUP, userId: '777', rule: 'sl', trigger: '#sl', active: false })
    await ctx.database.create('bot_hunter_ban', { platform: 'onebot', guildId: '111', userId: '888', rule: 'sl', trigger: '#sl', active: true })
    await ctx.emit(msg(bot, OP, 'unban #sl'))
    assert.deepEqual(bot.calls, [
      { guildId: GROUP, userId: '2968215007', duration: 0 },
      { guildId: GROUP, userId: '3553579119', duration: 0 },
    ])
    assert.equal(ctx.rows[0].active, false)
    assert.equal(ctx.rows[0].releasedBy, OP)
    assert.ok(ctx.rows[0].releasedAt instanceof Date)
    assert.equal(ctx.rows[1].active, false)
    assert.equal(ctx.rows[3].active, true)
    // 再发一次：没有 active 记录，不再调接口
    await ctx.emit(msg(bot, OP, 'unban #sl'))
    assert.equal(bot.calls.length, 2)
  }))

test('非 operator 发 unban #sl 无效', () =>
  withClock(async () => {
    const ctx = setup()
    const bot = makeBot()
    await ctx.database.create('bot_hunter_ban', { platform: 'onebot', guildId: GROUP, userId: '2968215007', rule: 'sl', trigger: '#sl', active: true })
    await ctx.emit(msg(bot, '60001', 'unban #sl'))
    assert.deepEqual(bot.calls, [])
    assert.equal(ctx.rows[0].active, true)
  }))

test('私聊消息忽略', () =>
  withClock(async () => {
    const ctx = setup()
    const bot = makeBot()
    await ctx.emit({ ...msg(bot, OP, '#sl'), guildId: undefined, isDirect: true })
    assert.equal(Object.keys(ctx.handlers).length, 1)
    assert.deepEqual(bot.calls, [])
  }))

test('带 @ 或图片的消息只取文本部分匹配', () =>
  withClock(async (clock) => {
    const ctx = setup()
    const bot = makeBot()
    await ctx.emit(msg(bot, OP, '#sl'))
    clock.tick(100)
    await ctx.emit(msg(bot, '70001', `<at id="${OP}"/> ${SNOW}`))
    assert.equal(bot.calls.length, 1)
  }))

test('非法正则被忽略并告警，不影响其他特征', () =>
  withClock(async (clock) => {
    const ctx = setup({ rules: [{ name: 'sl', trigger: '#sl', windowMs: 300, patterns: ['[', 'SnowLuma'], muteSeconds: 1, enabled: true }] })
    const bot = makeBot()
    assert.ok(ctx.logs.some(([lv, m]) => lv === 'warn' && m.includes('不是合法正则')))
    await ctx.emit(msg(bot, OP, '#sl'))
    clock.tick(10)
    await ctx.emit(msg(bot, '80001', SNOW))
    assert.equal(bot.calls.length, 1)
    assert.equal(bot.calls[0].duration, 1000)
  }))

test('规则 enabled=false 时不探测，但 unban 仍可用', () =>
  withClock(async (clock) => {
    const ctx = setup({ rules: [{ name: 'sl', trigger: '#sl', windowMs: 300, patterns: ['SnowLuma'], muteSeconds: 1, enabled: false }] })
    const bot = makeBot()
    await ctx.database.create('bot_hunter_ban', { platform: 'onebot', guildId: GROUP, userId: '2968215007', rule: 'sl', trigger: '#sl', active: true })
    await ctx.emit(msg(bot, OP, '#sl'))
    clock.tick(10)
    await ctx.emit(msg(bot, '90001', SNOW))
    assert.deepEqual(bot.calls, [])
    await ctx.emit(msg(bot, OP, 'unban #sl'))
    assert.deepEqual(bot.calls, [{ guildId: GROUP, userId: '2968215007', duration: 0 }])
  }))
