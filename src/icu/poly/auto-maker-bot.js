import {appendFile, readFile, writeFile} from "fs/promises";
import {PolyClient, PolySide} from "src/icu/poly/core/PolyClient.js"; // 按你的文件名改路径

// 性价比低
// ===== 写死配置（最小可用）=====
// 双边做市、双方 ID
const TOKEN_ID_Y = '57527508293969725929016010432598810481282998125631347013024726997019637985331';
const TOKEN_ID_N = '4589745821222679801714536143948817055789206104581183883296167003774519971663';

// 轮询周期 10 秒
const LOOP_MS = 10_000;
// 与中间价的跳动点差：2~3 较合适（备用策略）
const TICKS_FROM_MID = 2;
// 目标单笔下单规模（美元面值），会不小于盘口的最小委托量
const MIN_QUOTE_USD = 20;
// 安全深度阈值（美元），需要在该深度之后挂单才算相对安全
const SAFE_DEPTH_USD = 2_000;
// 当最优档已有极深挂单时的提升幅度（例如 1.5 表示提升 50%）
const HIGH_DEPTH_MULTIPLIER = 1.5;
// 每次只检查前几档深度
const MAX_DEPTH_LEVELS = 3;
// =============================

// 工具函数

const client = new PolyClient(); // 其内部已读取 PRIVATE_KEY 等默认参数

const TICK = 0.01;
const STATE_FILE = new URL("./maker-bot.state.json", import.meta.url);
const EVENT_LOG_FILE = new URL("./maker-bot.events.jsonl", import.meta.url);

if (!TOKEN_ID_Y || !TOKEN_ID_N) {
    throw new Error("Missing TOKEN_ID_Y or TOKEN_ID_N");
}

// 示例成交哈希：0x7952d3130ffba2640d4ac25aaea76908e0c7f3b15b0fff9189f8b4e09aa449a3，价格 0.64
// 示例成交哈希：0xc4383fbf4555d10043c5a3d2cd033644322737e131cd69863b6d4e990edf2e5d，价格 0.31
const legs = [{tokenId: TOKEN_ID_Y, label: "YES", orderId: null, price: null}, {
    tokenId: TOKEN_ID_N,
    label: "NO",
    orderId: null,
    price: null
},];

function logLegs(prefix) {
    console.log(`${prefix} 挂单=${JSON.stringify(legs.map(({label, orderId, price}) => ({
        label, orderId, price,
    })))}`);
}

async function saveLegs() {
    try {
        await writeFile(STATE_FILE, `${JSON.stringify(legs.map(({label, orderId, price}) => ({
            label, orderId, price,
        })), null, 2)}\n`);
    } catch (err) {
        console.error("保存挂单状态失败", err);
    }
}

async function loadLegs() {
    try {
        const raw = await readFile(STATE_FILE, "utf8");
        const data = JSON.parse(raw);
        data?.forEach(({label, orderId, price}) => {
            const leg = legs.find((item) => item.label === label);
            if (!leg) return;
            leg.orderId = orderId ?? null;
            leg.price = typeof price === "number" ? price : null;
        });
        logLegs("已加载状态");
    } catch (err) {
        if (err.code !== "ENOENT") {
            console.error("加载挂单状态失败", err);
        }
    }
}

async function recordEvent(eventType, leg, details = {}) {
    const base = {
        timestamp: new Date().toISOString(),
        event: eventType,
        tokenId: leg?.tokenId ?? null,
        label: leg?.label ?? null,
        prevPrice: details.prevPrice ?? null,
        nextPrice: details.nextPrice ?? null,
        orderId: details.orderId ?? null,
        prevOrderId: details.prevOrderId ?? null,
        size: details.size ?? null,
        depthAheadUsd: details.depthAheadUsd ?? null,
        bestBid: details.bestBid ?? null,
        targetPrice: details.targetPrice ?? null,
        message: details.message ?? undefined,
        extra: details.extra ?? undefined,
    };

    if (details.error instanceof Error) {
        base.error = details.error.message;
    } else if (typeof details.error === "string") {
        base.error = details.error;
    }

    const payload = Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined));

    try {
        await appendFile(EVENT_LOG_FILE, `${JSON.stringify(payload)}\n`);
    } catch (err) {
        console.error("记录事件日志失败", err);
    }
}

async function placeBid(leg) {
    const orderBook = await client.getOrderBook(leg.tokenId).catch((err) => {
        console.error(`[${leg.label}] 获取订单簿失败`, err);
        return null;
    });

    const rawBids = Array.isArray(orderBook?.bids) ? orderBook.bids.slice(-MAX_DEPTH_LEVELS).reverse() : [];
    const depthLevels = rawBids.map((level) => {
        const priceNum = Number(level?.price);
        const sizeNum = Number(level?.size);
        if (!Number.isFinite(priceNum) || !Number.isFinite(sizeNum)) {
            return null;
        }
        const price = Number(priceNum.toFixed(2));
        const depthUsd = Number((price * sizeNum).toFixed(2));
        return {price, size: sizeNum, depthUsd};
    }).filter(Boolean);

    let bestBid = depthLevels[0]?.price;
    if (!Number.isFinite(bestBid)) {
        bestBid = Number(await client.getPrice(PolySide.BUY, leg.tokenId));
    }

    if (!Number.isFinite(bestBid)) {
        console.log(`[${leg.label}] 跳过：缺少买一价`);
        return;
    }

    let depthAheadUsd = 0;
    let targetPrice = 0;
    let curDepthAheadUsd = 0;
    while (depthLevels.length > 0) {
        const depthSummary = depthLevels.map((lvl, idx) => {
            if (lvl.price >= leg.price) {
                curDepthAheadUsd += lvl.depthUsd;
                if (lvl.price === leg.price) {
                    curDepthAheadUsd -= lvl.depthUsd / 2;
                }
            }
            return `${lvl.price}@${lvl.depthUsd.toFixed(0)}`;
        }).join(" -> ");
        console.log(`[${leg.label}] 前三档深度：${depthSummary}`);

        if (depthLevels[0].depthUsd >= SAFE_DEPTH_USD * HIGH_DEPTH_MULTIPLIER) {
            // 最优挡 深度足够
            targetPrice = depthLevels[0].price;
            depthAheadUsd = depthLevels[0].depthUsd;
            break
        }

        depthAheadUsd = depthLevels[0].depthUsd;
        for (let i = 1; i < depthLevels.length; i++) {
            depthAheadUsd += depthLevels[i].depthUsd;
            if (depthAheadUsd >= SAFE_DEPTH_USD) {
                targetPrice = depthLevels[i].price;
                break;
            }
        }
        if (targetPrice === 0) {
            // 最优三档深度不满足要求、直接取第三档价格
            targetPrice = depthLevels[depthLevels.length - 1].price;
        }
        break;
    }

    if (targetPrice === 0) {
        targetPrice = Number((bestBid - TICK * TICKS_FROM_MID).toFixed(2));
    }
    const prevPrice = leg.price;
    console.log(`[${leg.label}] 最优买价=${bestBid.toFixed(2)} 当前价=${leg.price ?? "∅"}@${curDepthAheadUsd.toFixed(0)}  目标价=${targetPrice.toFixed(2)}@${depthAheadUsd.toFixed(0)}`);
    // 价格发生变化 并且 当前安全深度已经不足要求的0.8
    const shouldReplace = !leg.price || leg.price !== targetPrice && (curDepthAheadUsd < SAFE_DEPTH_USD * 0.8);
    if (!shouldReplace) {
        return;
    }

    const prevOrderId = leg.orderId;

    if (leg.orderId) {
        const prevOrder = leg.orderId;
        try {
            await client.cancelOrder(prevOrder);
            leg.orderId = null;
            leg.price = null;
            console.log(`[${leg.label}] 已取消订单 ${prevOrder}`);
            await saveLegs();
            logLegs(`[${leg.label}] 取消后状态`);
        } catch (err) {
            console.error(`取消 ${leg.label} 订单失败`, err);
            return;
        }
    }

    let size = Math.max(1, Math.round(MIN_QUOTE_USD / targetPrice));

    console.log(`[${leg.label}] 正在挂买单 数量=${size} @ ${targetPrice.toFixed(2)}`);

    const order = await client.placeOrder(targetPrice, size, PolySide.BUY, leg.tokenId,).catch((err) => {
        console.error(`下单 ${leg.label} 失败`, err);
        return null;
    });

    if (order?.success) {
        leg.orderId = order.orderID;
        leg.price = targetPrice;
        console.log(`已报价 ${leg.label} @ ${targetPrice.toFixed(2)} 数量 ${size}`);
        await recordEvent("replace-order", leg, {
            prevPrice,
            nextPrice: targetPrice,
            orderId: order.orderID,
            prevOrderId,
            size,
            bestBid,
            targetPrice,
            depthAheadUsd,
        });
        await saveLegs();
        logLegs(`[${leg.label}] 下单后状态`);
    } else {
        console.log(`[${leg.label}] 下单被拒`, order);
        await saveLegs();
        logLegs(`[${leg.label}] 下单失败状态`);
    }
}


async function tick() {
    // 顺序执行，避免过多并发请求
    for (const leg of legs) {
        await placeBid(leg);
    }
}

await loadLegs();
logLegs("启动阶段");
await saveLegs();
await tick().catch((err) => console.error(err));
setInterval(() => {
    tick().catch((err) => console.error(err));
    console.log('')
}, LOOP_MS);
