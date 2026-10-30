# koishi-plugin-bot-hunter

自动处置群里的异常 QQ Bot（SnowLuma 之类）。

## 工作方式

1. operator（默认 3431185320）在群里发出探测命令，例如 `#sl`，插件开始计时。
2. 窗口（默认 1000 ms）内，群里任何成员发出的消息若命中规则特征（默认 `SnowLuma\s*状态`），立即禁言，默认 540360 秒 = 6 天 6 小时 6 分钟，并写入数据表 `bot_hunter_ban`。
3. 命中特征但超出窗口的消息（比如群友事后 +1 复制）只记日志，不处置。观察期（3 秒与 10 倍窗口取大者）过后探测状态自动解除。
4. operator 发 `unban #sl`：解除**当前群**内所有因 `#sl` 被本插件禁言、且尚未解禁的成员，记录标记为已解禁。

全程静默：群里不发任何消息，一切看 Koishi 日志（`bot-hunter`）与数据表。

豁免：Bot 自己、operators、`immune` 名单。禁言接口报错（Bot 不是管理员、对方是管理员）只记 warn，不落库。

## 配置

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `operators` | `['3431185320']` | 允许触发与解禁的 QQ 号 |
| `immune` | `[]` | 永不处置的 QQ 号 |
| `unbanKeyword` | `unban` | 解禁关键词，用法 `unban <trigger>` |
| `rules[]` | 一条 `sl` 规则 | 见下 |
| `debug` | `false` | 记录观察期内每条候选回复的时延与匹配结果 |

规则字段：`name`（记录用）、`trigger`（探测命令全文）、`windowMs`（窗口毫秒）、`patterns`（正则数组，忽略大小写，任一命中即算）、`muteSeconds`、`enabled`。

新增一种 Bot：在控制台 `rules` 里加一条，例如 `name: napcat`、`trigger: #napcat`、`patterns: ['NapCat\\s*状态']`。`enabled` 关掉后不再探测，但 `unban` 仍按 `trigger` 查记录解禁。

## 数据表 `bot_hunter_ban`

`platform` `guildId` `userId` `rule` `trigger` `delayMs`（回复时延）`content`（命中文本前 500 字）`mutedAt` `muteSeconds` `expiresAt` `active` `releasedAt` `releasedBy` `note`。

## 时延怎么算

OneBot 事件时间戳只有秒级，窗口用的是 Koishi 本地收到两条消息的时间差。每次命中（含超窗）都把实测毫秒写进日志，窗口不合适就在控制台调 `windowMs`。

## 开发

```bash
npm install
npm test        # tsc + node --test（桩 Context，不需要真实 Koishi 实例）
```
