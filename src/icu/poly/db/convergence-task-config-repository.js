import prisma from './client.js';

function mapRowToTaskConfig(row) {
    if (!row) {
        return null;
    }

    return {
        task: {
            name: row.name,
            slug: row.slug,
            symbol: row.symbol,
            pkIdx: row.pk_idx,
            active: row.active,
            test: row.test,
            extra: row.extra ?? "",
        },
        schedule: {
            cronExpression: row.schedule_cron_expression,
            cronTimeZone: row.schedule_cron_timezone,
            tickIntervalSeconds: row.schedule_tick_interval_seconds,
        },
        position: {
            positionSizeUsdc: row.position_size_usdc,
            extraSizeUsdc: row.position_extra_size_usdc,
            allowExtraEntryAtCeiling: row.allow_extra_entry_at_ceiling,
        },
        riskControl: {
            price: {
                triggerPriceGt: row.risk_price_trigger_gt,
                takeProfitPrice: row.risk_price_take_profit,
            },
            time: {
                maxMinutesToEnd: row.risk_time_max_minutes_to_end,
                monitorModeMinuteThreshold: row.risk_time_monitor_mode_minute_threshold,
            },
            statistics: {
                zMin: row.risk_statistics_z_min,
                ampMin: row.risk_statistics_amp_min,
                highVolatilityZThreshold: row.risk_statistics_high_volatility_z_thresh,
            },
            liquidity: {
                sufficientThreshold: row.risk_liquidity_sufficient_threshold,
            },
            spikeProtection: {
                count: row.risk_spike_protection_count,
            },
        },
        extra: row.extra ?? "",
        createTime: row.create_time,
    };
}

function mapTaskConfigToRow(config) {
    if (!config || !config.task) {
        throw new Error('配置缺少 task 对象');
    }

    return {
        slug: config.task.slug,
        name: config.task.name,
        symbol: config.task.symbol,
        pk_idx: config.task.pkIdx,
        active: Boolean(config.task.active),
        test: Boolean(config.task.test),

        schedule_cron_expression: config.schedule?.cronExpression ?? '',
        schedule_cron_timezone: config.schedule?.cronTimeZone ?? '',
        schedule_tick_interval_seconds: Number(config.schedule?.tickIntervalSeconds ?? 0),

        position_size_usdc: Number(config.position?.positionSizeUsdc ?? 0),
        position_extra_size_usdc: Number(config.position?.extraSizeUsdc ?? 0),
        allow_extra_entry_at_ceiling: Boolean(config.position?.allowExtraEntryAtCeiling),

        risk_price_trigger_gt: Number(config.riskControl?.price?.triggerPriceGt ?? 0),
        risk_price_take_profit: Number(config.riskControl?.price?.takeProfitPrice ?? 0),

        risk_time_max_minutes_to_end: Number(config.riskControl?.time?.maxMinutesToEnd ?? 0),
        risk_time_monitor_mode_minute_threshold: Number(
            config.riskControl?.time?.monitorModeMinuteThreshold ?? 0,
        ),

        risk_statistics_z_min: Number(config.riskControl?.statistics?.zMin ?? 0),
        risk_statistics_amp_min: Number(config.riskControl?.statistics?.ampMin ?? 0),
        risk_statistics_high_volatility_z_thresh: Number(
            config.riskControl?.statistics?.highVolatilityZThreshold ?? 0,
        ),

        risk_liquidity_sufficient_threshold: Number(
            config.riskControl?.liquidity?.sufficientThreshold ?? 0,
        ),
        risk_spike_protection_count: Number(config.riskControl?.spikeProtection?.count ?? 0),
        extra: config.extra ?? config.task.extra ?? '',
    };
}

export async function listConvergenceTaskConfigs() {
    const rows = await prisma.convergence_task_config.findMany({
        orderBy: {
            create_time: 'asc',
        },
    });
    return rows.map(mapRowToTaskConfig);
}

export async function getConvergenceTaskConfig(slug) {
    const row = await prisma.convergence_task_config.findUnique({
        where: { slug },
    });
    return mapRowToTaskConfig(row);
}

export async function upsertConvergenceTaskConfig(config) {
    const data = mapTaskConfigToRow(config);
    const row = await prisma.convergence_task_config.upsert({
        where: { slug: data.slug },
        create: data,
        update: data,
    });
    return mapRowToTaskConfig(row);
}

export async function updatePkIdxAndCredsByPkIdx(currentPkIdx, nextPkIdx, creds) {
    if (!Number.isInteger(currentPkIdx)) {
        throw new Error('currentPkIdx 必须是整数');
    }
    if (!Number.isInteger(nextPkIdx)) {
        throw new Error('nextPkIdx 必须是整数');
    }

    return prisma.convergence_task_config.updateMany({
        where: { pk_idx: currentPkIdx },
        data: {
            pk_idx: nextPkIdx,
            creds: typeof creds === 'undefined' ? undefined : creds ?? null,
        },
    });
}

export async function deleteConvergenceTaskConfig(slug) {
    if (!slug) {
        throw new Error('缺少 slug，无法删除配置');
    }
    await prisma.convergence_task_config.delete({
        where: { slug },
    });
}
