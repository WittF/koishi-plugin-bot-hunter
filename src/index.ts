import { Context, Schema, Session, h } from 'koishi'

export const name = 'bot-hunter'
export const inject = ['database']

/** 6 天 6 小时 6 分钟 */
export const DEFAULT_MUTE_SECONDS = 6 * 86400 + 6 * 3600 + 6 * 60

export interface Rule {
  name: string
  trigger: string
  windowMs: number
  patterns: string[]
  muteSeconds: number
  enabled: boolean
}

export interface Config {
  operators: string[]
  immune: string[]
  unbanKeyword: string
  rules: Rule[]
  debug: boolean
}

export const Config: Schema<Config> = Schema.object({
  operators: Schema.array(String)
    .role('table')
    .default(['3431185320'])
    .description('允许触发探测与解禁的 QQ 号。其他人发同样的命令不会开始计时。'),
  immune: Schema.array(String)
    .role('table')
    .default([])
    .description('永不处置的 QQ 号。Bot 自身与 operators 自动豁免，不用填。'),
  unbanKeyword: Schema.string()
    .default('unban')
    .description('解禁命令关键词。用法 `unban #sl`：解除当前群内所有因 `#sl` 被本插件禁言、且尚未解禁的成员。'),
  rules: Schema.array(
    Schema.object({
      name: Schema.string().required().description('规则名，用于日志与记录。'),
      trigger: Schema.string().required().description('探测命令全文，例如 `#sl`。operator 发出后开始计时。'),
      windowMs: Schema.natural()
        .default(1000)
        .description('计时窗口（毫秒）。只有在窗口内到达且命中特征的回复才处置；超窗的命中只记日志。'),
      patterns: Schema.array(String)
        .role('table')
        .default([])
        .description('回复文本特征（JavaScript 正则，忽略大小写），任一命中即算。'),
      muteSeconds: Schema.natural()
        .default(DEFAULT_MUTE_SECONDS)
        .description('禁言秒数。默认 540360 = 6 天 6 小时 6 分钟。'),
      enabled: Schema.boolean().default(true).description('是否启用。关闭后不再探测，但仍可 unban。'),
    }),
  )
    .default([
      {
        name: 'sl',
        trigger: '#sl',
        windowMs: 1000,
        patterns: ['SnowLuma\\s*状态'],
        muteSeconds: DEFAULT_MUTE_SECONDS,
        enabled: true,
      },
    ])
    .description('探测规则。每条规则 = 一个探测命令 + 一组回复特征。'),
  debug: Schema.boolean()
    .default(false)
    .description('把观察期内每条候选回复的时延与匹配结果写入日志（调窗口用）。'),
})

export interface BanRecord {
  id: number
  platform: string
  guildId: string
  userId: string
  rule: string
  trigger: string
  delayMs: number
  content: string
  mutedAt: Date
  muteSeconds: number
  expiresAt: Date
  active: boolean
  releasedAt: Date | null
  releasedBy: string
  note: string
}

declare module 'koishi' {
  interface Tables {
    bot_hunter_ban: BanRecord
  }
}

interface CompiledRule extends Rule {
  regexps: RegExp[]
}

interface ArmedState {
  rule: CompiledRule
  at: number
  /** 本次探测里已处置过的 userId。判重时看同群所有探测状态，避免叠加触发或多规则同时命中把同一人处置两次 */
  hits: Set<string>
}

/** 观察期：超过这个时长后探测状态解除；观察期内的命中但超窗只记日志 */
export function observeMs(rule: Pick<Rule, 'windowMs'>): number {
  return Math.max(3000, rule.windowMs * 10)
}

export function textOf(session: Pick<Session, 'elements' | 'content'>): string {
  const elements = session.elements ?? h.parse(session.content ?? '')
  return h
    .select(elements, 'text')
    .map((e) => String(e.attrs.content ?? ''))
    .join('')
    .trim()
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function compileRules(rules: Rule[], warn: (msg: string) => void): CompiledRule[] {
  return rules.map((rule) => {
    const regexps: RegExp[] = []
    for (const p of rule.patterns ?? []) {
      try {
        regexps.push(new RegExp(p, 'i'))
      } catch (e) {
        warn(`规则 ${rule.name} 的特征 ${JSON.stringify(p)} 不是合法正则，已忽略：${(e as Error).message}`)
      }
    }
    if (rule.enabled && !regexps.length) {
      warn(`规则 ${rule.name} 没有可用特征，触发 ${rule.trigger} 后不会处置任何人`)
    }
    return { ...rule, regexps }
  })
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('bot-hunter')

  ctx.model.extend(
    'bot_hunter_ban',
    {
      id: 'unsigned',
      platform: 'string',
      guildId: 'string',
      userId: 'string',
      rule: 'string',
      trigger: 'string',
      delayMs: 'integer',
      content: 'text',
      mutedAt: 'timestamp',
      muteSeconds: 'integer',
      expiresAt: 'timestamp',
      active: 'boolean',
      releasedAt: 'timestamp',
      releasedBy: 'string',
      note: 'text',
    },
    { primary: 'id', autoInc: true },
  )

  const rules = compileRules(config.rules ?? [], (m) => logger.warn(m))
  const operators = new Set(config.operators ?? [])
  const immune = new Set(config.immune ?? [])
  const unbanRe = new RegExp(`^${escapeRegExp(config.unbanKeyword || 'unban')}\\s+(\\S+)$`, 'i')

  /** platform:guildId -> 正在计时的探测 */
  const armed = new Map<string, ArmedState[]>()

  function keyOf(session: Session) {
    return `${session.platform}:${session.guildId}`
  }

  function pruned(key: string, now: number): ArmedState[] {
    const list = (armed.get(key) ?? []).filter((s) => now - s.at <= observeMs(s.rule))
    if (list.length) armed.set(key, list)
    else armed.delete(key)
    return list
  }

  function who(session: Session) {
    const nick = session.author?.nick || session.author?.name || session.username || ''
    return nick ? `${nick}(${session.userId})` : String(session.userId)
  }

  async function punish(session: Session, state: ArmedState, delayMs: number, text: string) {
    const { rule } = state
    const guildId = session.guildId!
    const userId = session.userId!
    try {
      await session.bot.muteGuildMember(guildId, userId, rule.muteSeconds * 1000)
    } catch (e) {
      logger.warn(`[${rule.name}] 群 ${guildId} 禁言 ${who(session)} 失败（${delayMs}ms 命中）：${(e as Error)?.message ?? e}`)
      return
    }
    const mutedAt = new Date()
    try {
      await ctx.database.create('bot_hunter_ban', {
        platform: session.platform,
        guildId,
        userId,
        rule: rule.name,
        trigger: rule.trigger,
        delayMs,
        content: text.slice(0, 500),
        mutedAt,
        muteSeconds: rule.muteSeconds,
        expiresAt: new Date(mutedAt.getTime() + rule.muteSeconds * 1000),
        active: true,
        releasedBy: '',
        note: '',
      })
    } catch (e) {
      logger.warn(
        `[${rule.name}] 群 ${guildId} 已禁言 ${who(session)} ${rule.muteSeconds}s（${delayMs}ms 命中），但记录写入失败，unban 找不到此人、需手动解禁：${(e as Error)?.message ?? e}`,
      )
      return
    }
    logger.info(`[${rule.name}] 群 ${guildId} 已禁言 ${who(session)} ${rule.muteSeconds}s（${delayMs}ms 回复命中特征）`)
  }

  async function unban(session: Session, trigger: string) {
    const guildId = session.guildId!
    const records = await ctx.database.get('bot_hunter_ban', {
      platform: session.platform,
      guildId,
      trigger,
      active: true,
    })
    if (!records.length) {
      logger.info(`[unban] 群 ${guildId} 没有因 ${trigger} 被禁且未解禁的记录`)
      return
    }
    let ok = 0
    for (const r of records) {
      try {
        await session.bot.muteGuildMember(guildId, r.userId, 0)
      } catch (e) {
        logger.warn(`[unban] 群 ${guildId} 解禁 ${r.userId} 失败：${(e as Error)?.message ?? e}`)
        continue
      }
      await ctx.database.set('bot_hunter_ban', r.id, {
        active: false,
        releasedAt: new Date(),
        releasedBy: session.userId!,
      })
      // 解禁后本群进行中的探测不再把这个人当"已处置"，下一次探测可以重新命中
      for (const s of armed.get(keyOf(session)) ?? []) s.hits.delete(r.userId)
      ok++
      logger.info(`[unban] 群 ${guildId} 已解禁 ${r.userId}（记录 #${r.id}，${trigger}，由 ${session.userId} 操作）`)
    }
    logger.info(`[unban] 群 ${guildId} ${trigger}：${ok}/${records.length} 条已解禁`)
  }

  async function handle(session: Session) {
    if (!session.guildId || session.isDirect) return
    if (!session.userId || session.userId === session.selfId) return
    const now = Date.now()
    const text = textOf(session)
    const key = keyOf(session)
    const list = pruned(key, now)

    if (operators.has(session.userId)) {
      const rule = rules.find((r) => r.enabled && text === r.trigger)
      if (rule) {
        // 同一规则再次触发 = 重新计时，替换旧状态而不是叠加，避免一条回复落在两个窗口里
        const rest = list.filter((s) => s.rule.name !== rule.name)
        rest.push({ rule, at: now, hits: new Set() })
        armed.set(key, rest)
        logger.info(`[${rule.name}] 群 ${session.guildId} 由 ${who(session)} 触发，窗口 ${rule.windowMs}ms`)
        return
      }
      const m = text.match(unbanRe)
      if (m) {
        const raw = m[1]
        const trigger = rules.find((r) => r.trigger.toLowerCase() === raw.toLowerCase())?.trigger ?? raw
        await unban(session, trigger)
      }
      return
    }

    if (!list.length) return
    // 本轮已处置过（任一规则）就不再碰
    if (list.some((s) => s.hits.has(session.userId!))) return
    for (const state of list) {
      const { rule } = state
      const delayMs = now - state.at
      const matched = rule.regexps.some((re) => re.test(text))
      if (!matched) {
        if (config.debug) logger.debug(`[${rule.name}] 群 ${session.guildId} ${who(session)} +${delayMs}ms 未命中特征`)
        continue
      }
      if (delayMs > rule.windowMs) {
        logger.info(`[${rule.name}] 群 ${session.guildId} ${who(session)} +${delayMs}ms 命中特征但超出 ${rule.windowMs}ms 窗口，未处置`)
        continue
      }
      if (immune.has(session.userId)) {
        logger.info(`[${rule.name}] 群 ${session.guildId} ${who(session)} +${delayMs}ms 命中但在豁免名单，未处置`)
        continue
      }
      // 先占位再 await，同一 tick 连到两条也只处置一次
      for (const s of list) s.hits.add(session.userId)
      await punish(session, state, delayMs, text)
      break
    }
  }

  ctx.on('message', (session) => {
    handle(session).catch((e) => logger.error(e))
  })
}
