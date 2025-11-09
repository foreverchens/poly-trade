# PolyClient 测试说明

## 目录结构

测试文件位于 `test/icu/poly/core/poly-client/` 目录下，每个测试用例都有独立的文件。

```
test/icu/poly/core/poly-client/
├── test-helper.js                    # 测试辅助工具（共享的 PolyClient 实例和常量）
├── list-reward-market.test.js        # 奖励市场列表测试
├── get-market-info.test.js           # 获取市场信息测试
├── get-price.test.js                 # 获取价格测试
├── get-order-book.test.js            # 获取订单簿测试
├── list-crypto-market-sorted-by-end-date.test.js  # 加密市场列表测试
├── list-crypto-events.test.js        # 加密事件列表测试
├── get-prices-history.test.js        # 价格历史测试
├── list-open-orders.test.js          # 挂单列表测试
├── place-order.test.js               # 下单测试
├── cancel-order.test.js              # 取消订单测试
├── list-positions.test.js            # 持仓列表测试
├── list-my-trades.test.js            # 我的交易列表测试
└── get-usdc-balance.test.js          # USDC 余额测试
```

## 运行所有测试

```bash
npm test
```

或者直接运行：

```bash
node --test test/**/*.test.js
```

## 运行单个测试用例

### 方法 1：直接使用 node 命令（推荐）

```bash
# 运行单个测试文件
node --test test/icu/poly/core/poly-client/get-usdc-balance.test.js

# 运行匹配模式的测试用例（支持正则表达式）
node --test --test-name-pattern="should return USDC balance" test/icu/poly/core/poly-client/get-usdc-balance.test.js

# 运行所有包含 "price" 的测试用例
node --test --test-name-pattern="price" test/**/*.test.js
```

### 方法 2：使用 npm 脚本

```bash
# 运行单个测试用例
npm run test:single -- --test-name-pattern="should return USDC balance" test/icu/poly/core/poly-client/get-usdc-balance.test.js
```

## 测试文件列表

### Market API 测试
- `list-reward-market.test.js` - 奖励市场列表相关测试
  - `should return reward markets list`
  - `should return markets sorted by reward rate`
  - `should filter markets with market_competitiveness > 0`
- `get-market-info.test.js` - 获取市场信息测试
  - `should get specific market info by marketId`
- `get-price.test.js` - 获取价格测试
  - `should get buy price for token`
  - `should get sell price for token`
  - `should get prices for multiple tokens`
- `get-order-book.test.js` - 获取订单簿测试
  - `should get order book for token`
- `list-crypto-market-sorted-by-end-date.test.js` - 加密市场列表测试
  - `should return crypto markets sorted by end date`
- `list-crypto-events.test.js` - 加密事件列表测试
  - `should return crypto events list`
- `get-prices-history.test.js` - 价格历史测试
  - `should get price history for token`

### Trading API 测试
- `list-open-orders.test.js` - 挂单列表测试
  - `should return open orders list`
  - `should filter orders by market`
- `place-order.test.js` - 下单测试
  - `should place a buy order`
  - `should place a sell order`
- `cancel-order.test.js` - 取消订单测试
  - `should cancel an order`

### Position API 测试
- `list-positions.test.js` - 持仓列表测试
  - `should return positions list`

### Order API 测试
- `list-my-trades.test.js` - 我的交易列表测试
  - `should return my trades list`

### Balance API 测试
- `get-usdc-balance.test.js` - USDC 余额测试
  - `should return USDC balance`

## 实际示例

```bash
# 示例 1: 运行获取 USDC 余额的测试
node --test test/icu/poly/core/poly-client/get-usdc-balance.test.js

# 示例 2: 运行所有价格相关的测试
node --test --test-name-pattern="price" test/**/*.test.js

# 示例 3: 运行所有订单相关的测试
node --test --test-name-pattern="order" test/**/*.test.js

# 示例 4: 运行单个测试用例
node --test --test-name-pattern="should return USDC balance" test/icu/poly/core/poly-client/get-usdc-balance.test.js
```

## 快速参考

### 常用命令

```bash
# 运行所有测试
npm test

# 运行单个测试文件
node --test test/icu/poly/core/poly-client/get-usdc-balance.test.js

# 运行匹配模式的测试（支持正则表达式）
node --test --test-name-pattern="模式" test/**/*.test.js
```

## 注意事项

1. 某些测试用例（如下单测试）可能会因为余额不足或其他原因失败，这是正常的
2. 测试需要配置 `.env` 文件中的 `PRIVATE_KEY` 环境变量
3. 运行测试前请确保网络连接正常，因为测试会调用真实的 API
4. `--test-name-pattern` 支持正则表达式，可以匹配部分测试名称
5. 每个测试文件都是独立的，可以单独运行

