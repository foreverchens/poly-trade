# Polymarket 交易机器人 & 分析平台

一个功能完善的 Polymarket 预测市场自动化交易系统，包含多种交易策略、实时市场分析和 Web 仪表板。

## 🌟 核心功能

### 交易机器人
- **自动做市机器人** - 基于订单簿深度的动态报价做市
- **网格交易机器人** - 单市场网格策略，系统化低买高卖
- **扫尾收敛策略** - 事件驱动的加密货币市场收敛交易
  - Up Bot: 追踪比特币/加密货币"涨跌"市场
  - Yes Bot: 通用的是/否市场收敛策略

### 分析与监控
- 实时加密货币市场数据可视化
- 多时间周期历史价格图表
- 订单簿深度分析
- 持仓追踪与盈亏监控
- 交易历史与执行日志

### Web 仪表板
- **加密市场**: 浏览和分析活跃的预测市场
- **控制面板**: 实时市场概览与分析
- **机器人订单**: 追踪自动交易活动和订单历史

### REST API
- 市场数据接口
- 订单下单与管理
- 持仓与余额查询
- 历史数据访问

## 📁 项目结构

```
poly/
├── src/icu/poly/
│   ├── core/                      # 核心交易客户端与工具
│   │   ├── PolyClient.js         # Polymarket API 主封装类
│   │   ├── Logger.js             # 结构化日志
│   │   ├── z-score.js            # 统计分析
│   │   └── gen-key.js            # 钱包密钥生成
│   ├── bots/                     # 交易策略
│   │   └── tail-convergence/     # 收敛交易机器人
│   │       ├── up-bot.js         # 比特币收敛策略
│   │       ├── yes-bot.js        # 通用是/否收敛
│   │       ├── common.js         # 共享工具
│   │       ├── liquidity-check.js
│   │       └── take-profit.js
│   ├── view/                     # Web 仪表板 (HTML/CSS/JS)
│   ├── db/                       # 数据库层 (Prisma + SQLite)
│   ├── data/                     # 机器人配置文件
│   ├── web-server.js             # Express API 服务器
│   ├── auto-maker-bot.js         # 做市机器人
│   └── single-market-grid-bot.js # 网格交易机器人
└── test/                         # 测试套件
    └── icu/poly/
        ├── core/poly-client/     # 客户端方法测试
        └── bots/                 # 策略回测
```

## 🚀 快速开始

### 环境要求
- **Node.js** >= 18.x
- **npm** 或 **yarn**
- Polymarket 账户及 API 访问权限
- Polygon 钱包及 USDC.e 用于交易

### 安装步骤

```bash
# 克隆仓库
git clone https://github.com/yourusername/poly.git
cd poly

# 安装依赖
npm install

# 生成 Prisma 客户端
npx prisma generate

# 初始化数据库
npx prisma db push
```

### 配置

在项目根目录创建 `.env` 文件：

```env
# 钱包配置
poly_mnemonic="你的 12 个单词助记词"
poly_mnemonic_idx=0

# 可选：覆盖默认端点
RPC_URL=https://polygon-rpc.com
# CLOB_HOST=https://clob.polymarket.com

# 服务器配置
PORT=3001
BTC_PRICE_SOURCE=https://api.binance.com/api/v3/klines
BTC_PRICE_SYMBOL=BTCUSDT
```

⚠️ **安全警告**: 切勿将 `.env` 文件或私钥提交到版本控制系统！

## 🎯 使用方法

### 启动 Web 服务器 & 仪表板

```bash
npm start
```

访问仪表板：
- **加密市场**: http://localhost:3001/
- **控制面板**: http://localhost:3001/dashboard
- **机器人订单**: http://localhost:3001/bot-orders

### 运行交易机器人

#### 自动做市机器人
```bash
node src/icu/poly/auto-maker-bot.js
```

#### 网格交易机器人
```bash
node src/icu/poly/single-market-grid-bot.js
```

#### 扫尾收敛机器人
```bash
# 比特币收敛策略
node src/icu/poly/tail-bot-start-up.js

# 通用是/否收敛策略
node src/icu/poly/tail-bot-start-yes.js
```

### 测试

```bash
# 运行所有测试
npm test

# 运行特定测试文件
npm run test:single -- "测试名称" path/to/file.test.js
```

## 📡 API 接口

### 市场数据

#### 获取加密货币市场
```http
GET /api/crypto-markets?tag=235
```

返回按结束日期排序的活跃加密货币预测市场。

#### 获取价格历史
```http
GET /api/price-history?market={tokenId}&interval=1h
```

支持的时间间隔：`1h`, `6h`, `1d`, `1w`, `max`

#### 获取订单簿
```http
GET /api/orderbook/{tokenId}
```

返回当前订单簿的买单和卖单。

#### 获取最优价格
```http
GET /api/best-prices/{tokenId}
```

返回最优买价和卖价。

### 交易

#### 下单
```http
POST /api/place-order
Content-Type: application/json

{
  "price": 0.65,
  "size": 100,
  "side": "BUY",
  "tokenId": "123456..."
}
```

#### 取消订单
```http
POST /api/cancel-order
Content-Type: application/json

{
  "orderId": "0xabc..."
}
```

#### 查询挂单
```http
GET /api/open-orders?market={conditionId}&assetId={tokenId}
```

### 投资组合

#### 获取交易记录
```http
GET /api/trades?address=0x...
```

#### 机器人订单
```http
GET /api/bot-orders?limit=100
DELETE /api/bot-orders/{id}
PUT /api/bot-orders/{id}
```

## 🤖 交易策略详解

### 1. 自动做市机器人

**策略原理**: 基于订单簿深度的动态报价做市。

**核心参数**:
- `MIN_QUOTE_USD`: 最小订单金额（默认 $20）
- `SAFE_DEPTH_USD`: 安全深度阈值（默认 $2000）
- `TICKS_FROM_MID`: 与中间价的跳动点差（2-3 档）

**工作流程**:
1. 监控订单簿双边深度
2. 在足够流动性后方挂买单
3. 根据市场状况动态调整价格
4. 持久化状态支持重启恢复

### 2. 网格交易机器人

**策略原理**: 在预定义网格水平内系统化低买高卖。

**核心参数**:
- `GRID`: 价格网格数组 `[1, 0.99, 0.97, ..., 0]`
- `tradeUsd`: 每个网格档位的交易金额
- `initPosition`: 初始仓位倍数

**工作流程**:
1. 按当前市价建立初始仓位
2. 在相邻网格档位挂买卖单
3. 成交后移动网格档位
4. 捕获价格振荡产生的利润

### 3. 扫尾收敛策略

**策略原理**: 基于价格收敛的统计套利，在事件临近结算时入场。

**核心参数**:
- `zMin`: 最小 z-score 阈值
- `ampMin`: 最小小时振幅
- `maxMinutesToEnd`: 距离结束的最大分钟数
- `triggerPriceGt`: 入场价格阈值

**工作流程**:
1. 扫描临近结算的市场
2. 使用 z-score 分析识别偏离
3. 满足统计标准时建仓
4. 管理止盈和风险控制

**特化版本**:
- **Up Bot**: 专为比特币"高于/低于"每日市场优化
- **Yes Bot**: 通用的是/否市场收敛

## 🧪 开发指南

### 代码规范

- **ES 模块** 必需（`type: "module"`）
- **4 空格缩进**
- **尾随逗号** 用于多行对象
- **Kebab-case** 命名 API 路由（`/api/place-order`）
- **描述性前缀** 用于常量（`DEFAULT_*`、`SUPPORTED_*`）

### 测试指南

- 每个 `PolyClient` 方法对应一个测试文件
- 测试位于 `test/icu/poly/core/poly-client/`
- 使用 Node 内置测试运行器
- 扩展 `test-helper.js` 添加测试固件

### 日志系统

使用 `log4js` 结构化日志：
- 日志存储在 `logs/{日期}-{级别}.log`
- 日志级别：`info`、`error`、`debug`
- 自动按日切分

### 数据库

SQLite + Prisma ORM：

```bash
# Schema 变更后重新生成 Prisma 客户端
npx prisma generate

# 应用 schema 迁移
npx prisma db push

# 打开 Prisma Studio（可视化编辑器）
npx prisma studio
```

## 🛡️ 安全与风险管理

### 最佳实践

1. **保护密钥安全**: 将 `.env` 排除在版本控制外
2. **先测试模式**: 正式交易前用 `test: true` 运行机器人
3. **监控持仓**: 定期检查挂单和持仓状态
4. **设置限额**: 保守配置仓位规模和风险参数
5. **审查日志**: 检查 `logs/` 目录中的错误和异常

### 风控机制

- 最大仓位限制
- 基于时间的入场限制
- 流动性充足性检查
- 价格突变保护机制
- 自动止盈订单

## 📊 监控与维护

### 健康检查

- 监控 `logs/` 目录中的日志文件
- 通过 `/bot-orders` 端点检查机器人订单状态
- 查看数据库记录获取订单历史
- 追踪 USDC 余额和持仓

### 常用操作

```bash
# 查看最近的机器人订单
curl http://localhost:3001/api/bot-orders?limit=20

# 检查当前持仓
curl http://localhost:3001/api/trades?address=你的地址

# 获取市场信息
curl http://localhost:3001/api/crypto-markets?tag=235
```

## 🤝 贡献指南

欢迎贡献！请遵循以下指南：

### 提交信息
- 使用祈使句：`add feature`、`fix bug`
- 保持主题简洁
- 相关时引用 issue 编号

### Pull Request
- 总结范围和变更
- 列出受影响的端点/模块
- 记录新的环境变量
- UI 变更包含截图
- 说明 `.env` 要求

### 提交前检查
1. 运行 `npm test` - 确保所有测试通过
2. 运行 `npm run lint` - 检查代码风格
3. 必要时更新文档
4. 使用真实 API 进行本地测试

## 📝 许可证

ISC

## ⚠️ 免责声明

本软件仅用于教育目的。预测市场交易涉及财务风险。作者不对使用本软件造成的任何财务损失负责。请务必自行研究并负责任地交易。

## 🔗 相关资源

- [Polymarket 官网](https://polymarket.com/)
- [Polymarket CLOB API 文档](https://docs.polymarket.com/)
- [Polygon 网络](https://polygon.technology/)

## 📧 联系方式

如有问题或需要支持，请在 GitHub 上提 issue。

---

## 💡 快速参考

### 启动命令速查

| 组件 | 命令 | 说明 |
|------|------|------|
| Web 服务器 | `npm start` | 启动 API + 仪表板 |
| 做市机器人 | `node src/icu/poly/auto-maker-bot.js` | 双边做市 |
| 网格机器人 | `node src/icu/poly/single-market-grid-bot.js` | 网格套利 |
| BTC 收敛 | `node src/icu/poly/tail-bot-start-up.js` | 比特币扫尾策略 |
| 通用收敛 | `node src/icu/poly/tail-bot-start-yes.js` | 是/否扫尾策略 |
| 运行测试 | `npm test` | 执行完整测试套件 |

### 端口说明

- **3001**: Web 服务器默认端口（可通过 `PORT` 环境变量修改）

### 数据库位置

- **SQLite 文件**: `src/icu/poly/db/orders.db`
- **Schema 定义**: `src/icu/poly/db/schema.prisma`

### 日志位置

- **日志目录**: `logs/`
- **命名格式**: `YYYYMMDD-{level}.log`
- **自动轮转**: 每日创建新文件

