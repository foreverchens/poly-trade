/**
 * 扫尾盘策略 - Up/Down 任务配置
 * 支持多任务配置，每个任务独立运行
 */
export default [
    {
        // 任务基础配置
        task: {
            name: "ETH_UpDown_Hourly",
            slug: "ethereum-up-or-down-november-${day}-${hour}${am_pm}-et",
            symbol: "ETH",
            test: false,
        },

        // 调度配置
        schedule: {
            cronExpression: "0 30-35 * * * *",
            cronTimeZone: "America/New_York",
            tickIntervalSeconds: 30,
        },

        // 建仓配置
        position: {
            positionSizeUsdc: 30,
            extraSizeUsdc: 120,
            allowExtraEntryAtCeiling: true,
        },

        // 风控配置
        riskControl: {
            // 价格风控
            price: {
                triggerPriceGt: 0.99,       // 触发价格下限
                takeProfitPrice: 0.998,     // 止盈价格
            },

            // 时间风控
            time: {
                maxMinutesToEnd: 10,                  // 最大剩余时间（分钟）
                monitorModeMinuteThreshold: 50,       // 监控模式分钟阈值
            },

            // 统计风控
            statistics: {
                /**
                 * 最小偏离度阈值，用于判断未来波动率趋势、有隐含波动率更好
                 * 预感未来波动率将不断下降、可适当降低zMin阈值
                 * 预感未来波动率将不断上升、可适当提高zMin阈值
                 * highVolatilityZThreshold同理
                 */
                zMin: 2.5,                              // 最小 Z-Score 阈值
                ampMin: 0.001,                        // 最小振幅
                highVolatilityZThreshold: 3,          // 高波动 Z-Score 阈值
            },

            // 流动性风控
            liquidity: {
                sufficientThreshold: 1500,            // 流动性充足阈值
            },

            // 插针防护
            spikeProtection: {
                count: 2,                             // 插针防护计数阈值
            },
        },
    },
    {
        // 任务基础配置
        task: {
            name: "BTC_UpDown_Hourly",
            slug: "bitcoin-up-or-down-november-${day}-${hour}${am_pm}-et",
            symbol: "BTC",
            test: false,
        },

        // 调度配置
        schedule: {
            cronExpression: "0 30-35 * * * *",
            cronTimeZone: "America/New_York",
            tickIntervalSeconds: 30,
        },

        // 建仓配置
        position: {
            positionSizeUsdc: 50,
            extraSizeUsdc: 200,
            allowExtraEntryAtCeiling: true,
        },

        // 风控配置
        riskControl: {
            // 价格风控
            price: {
                triggerPriceGt: 0.99,       // 触发价格下限
                takeProfitPrice: 0.998,     // 止盈价格
            },

            // 时间风控
            time: {
                maxMinutesToEnd: 10,                  // 最大剩余时间（分钟）
                monitorModeMinuteThreshold: 50,       // 监控模式分钟阈值
            },

            // 统计风控
            statistics: {
                zMin: 2.5,                              // 最小 Z-Score
                ampMin: 0.001,                        // 最小振幅
                highVolatilityZThreshold: 3,          // 高波动 Z-Score 阈值
            },

            // 流动性风控
            liquidity: {
                sufficientThreshold: 3000,            // 流动性充足阈值
            },

            // 插针防护
            spikeProtection: {
                count: 2,                             // 插针防护计数阈值
            },
        },
    },
];

