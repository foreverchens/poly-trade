import 'dotenv/config';
import { upsertConvergenceTaskConfig } from './convergence-task-config-repository.js';

const seeds = [
    {
        task: {
            name: 'ETH_UpDown_Hourly',
            slug: 'ethereum-up-or-down-december-${day}-${hour}${am_pm}-et',
            symbol: 'ETH',
            pkIdx: 8,
            active: true,
            test: false,
        },
        schedule: {
            cronExpression: '0 30-35 * * * *',
            cronTimeZone: 'America/New_York',
            tickIntervalSeconds: 30,
        },
        position: {
            positionSizeUsdc: 20,
            extraSizeUsdc: 80,
            allowExtraEntryAtCeiling: true,
        },
        riskControl: {
            price: {
                triggerPriceGt: 0.99,
                takeProfitPrice: 0.998,
            },
            time: {
                maxMinutesToEnd: 10,
                monitorModeMinuteThreshold: 50,
            },
            statistics: {
                zMin: 2.5,
                ampMin: 0.002,
                highVolatilityZThreshold: 3,
            },
            liquidity: {
                sufficientThreshold: 1000,
            },
            spikeProtection: {
                count: 2,
            },
        },
        extra: '',
    },
    {
        task: {
            name: 'BTC_UpDown_Hourly',
            slug: 'bitcoin-up-or-down-december-${day}-${hour}${am_pm}-et',
            symbol: 'BTC',
            pkIdx: 8,
            active: true,
            test: false,
        },
        schedule: {
            cronExpression: '0 30-35 * * * *',
            cronTimeZone: 'America/New_York',
            tickIntervalSeconds: 30,
        },
        position: {
            positionSizeUsdc: 100,
            extraSizeUsdc: 500,
            allowExtraEntryAtCeiling: true,
        },
        riskControl: {
            price: {
                triggerPriceGt: 0.99,
                takeProfitPrice: 0.998,
            },
            time: {
                maxMinutesToEnd: 10,
                monitorModeMinuteThreshold: 50,
            },
            statistics: {
                zMin: 2.5,
                ampMin: 0.002,
                highVolatilityZThreshold: 3,
            },
            liquidity: {
                sufficientThreshold: 3000,
            },
            spikeProtection: {
                count: 2,
            },
        },
        extra: '',
    },
    {
        task: {
            name: 'XRP_UpDown_Hourly',
            slug: 'xrp-up-or-down-december-${day}-${hour}${am_pm}-et',
            symbol: 'XRP',
            pkIdx: 8,
            active: true,
            test: false,
        },
        schedule: {
            cronExpression: '0 30-35 * * * *',
            cronTimeZone: 'America/New_York',
            tickIntervalSeconds: 30,
        },
        position: {
            positionSizeUsdc: 20,
            extraSizeUsdc: 80,
            allowExtraEntryAtCeiling: true,
        },
        riskControl: {
            price: {
                triggerPriceGt: 0.99,
                takeProfitPrice: 0.998,
            },
            time: {
                maxMinutesToEnd: 10,
                monitorModeMinuteThreshold: 50,
            },
            statistics: {
                zMin: 2.5,
                ampMin: 0.002,
                highVolatilityZThreshold: 3,
            },
            liquidity: {
                sufficientThreshold: 1000,
            },
            spikeProtection: {
                count: 2,
            },
        },
        extra: '',
    },
    {
        task: {
            name: 'SOL_UpDown_Hourly',
            slug: 'solana-up-or-down-december-${day}-${hour}${am_pm}-et',
            symbol: 'SOL',
            pkIdx: 8,
            active: true,
            test: false,
        },
        schedule: {
            cronExpression: '0 30-35 * * * *',
            cronTimeZone: 'America/New_York',
            tickIntervalSeconds: 30,
        },
        position: {
            positionSizeUsdc: 20,
            extraSizeUsdc: 80,
            allowExtraEntryAtCeiling: true,
        },
        riskControl: {
            price: {
                triggerPriceGt: 0.99,
                takeProfitPrice: 0.998,
            },
            time: {
                maxMinutesToEnd: 10,
                monitorModeMinuteThreshold: 50,
            },
            statistics: {
                zMin: 2.5,
                ampMin: 0.002,
                highVolatilityZThreshold: 3,
            },
            liquidity: {
                sufficientThreshold: 1000,
            },
            spikeProtection: {
                count: 2,
            },
        },
        extra: '',
    },
];

async function main() {
    for (const config of seeds) {
        const saved = await upsertConvergenceTaskConfig(config);
        console.log(`[seed] upserted config ${saved.task.slug}`);
    }
}

main()
    .then(() => {
        console.log('[seed] convergence task configs synced');
        process.exit(0);
    })
    .catch((error) => {
        console.error('[seed] failed to sync convergence task configs', error);
        process.exit(1);
    });

