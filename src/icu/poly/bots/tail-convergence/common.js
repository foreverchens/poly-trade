import { readFileSync } from "fs";
import dayjs from "dayjs";
import { polyClient } from "../../core/PolyClient.js";

const EASTERN_TZ = "America/New_York";

export const TAKE_PROFIT_ORDER_STATUS = {
    PENDING: "待提交",
    PARTIALLY_MATCHED: "部分成交",
    FULLY_MATCHED: "全部成交",
    CANCELLED: "已取消",
};

export function resolveSlugList(slugOrList, referenceDate = new Date()) {
    const dayFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: EASTERN_TZ,
        day: "numeric",
    });
    const day = parseInt(dayFormatter.format(referenceDate), 10);

    const hourFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: EASTERN_TZ,
        hour: "numeric",
        hour12: true,
    });
    const hourParts = hourFormatter.formatToParts(referenceDate);
    const hour = parseInt(hourParts.find((part) => part.type === "hour")?.value || "0", 10);
    const amPm = hourParts.find((part) => part.type === "dayPeriod")?.value || "AM";

    const list = Array.isArray(slugOrList) ? slugOrList : [slugOrList];

    const results = list.map((slug) => {
        let resolved = slug;
        if (resolved.includes("${day}")) {
            resolved = resolved.replace(/\$\{day\}/g, day.toString());
        }
        if (resolved.includes("${hour}")) {
            resolved = resolved.replace(/\$\{hour\}/g, hour.toString());
        }
        if (resolved.includes("${am_pm}")) {
            resolved = resolved.replace(/\$\{am_pm\}/g, amPm.toLowerCase());
        }
        return resolved;
    });

    return Array.isArray(slugOrList) ? results : results[0];
}

export function loadStateFile(stateFilePath) {
    try {
        const data = JSON.parse(readFileSync(stateFilePath, "utf8"));
        return {
            config: data.config || {},
            orders: data.orders || {},
        };
    } catch (err) {
        throw new Error(`Failed to load state file ${stateFilePath}: ${err.message}`);
    }
}

export async function fetchMarketsWithinTime(slug, maxMinutesToEnd) {
    const now = dayjs().format("YYYY-MM-DD HH:mm:ss");
    const event = await polyClient.getEventBySlug(slug);
    if (!event) {
        console.log(`[@${now} ${slug}] 事件获取失败`);
        return [];
    }
    const markets = event.markets || [];
    if (!markets.length) {
        console.log(`[@${now} ${slug}] 未找到开放市场`);
        return [];
    }
    const timeMs = Date.parse(event.endDate) - Date.now();
    const minutesToEnd = timeMs / 60_000;
    if (minutesToEnd > maxMinutesToEnd) {
        console.log(
            `[@${now} ${slug}] 事件剩余时间=${Math.round(minutesToEnd)}分钟 超过最大时间=${maxMinutesToEnd}分钟，不处理`,
        );
        return [];
    }
    return markets;
}

export async function fetchBestAsk(client, tokenId) {
    const [bestBid, bestAsk] = await client.getBestPrice(tokenId);
    return bestAsk;
}

/**
 * a + b * (t/600)^k
 * a: 基础值 0.92
 * b: 增长值 0.06
 * k: 发散程度 0.4
 * t: 剩余时间(秒) 600秒时、阈值为0.98
 *
 * t      k=0.1    k=0.2    k=0.3    k=0.4    k=0.5
 * ------------------------------------------------------------
 * 600    0.980    0.980    0.980    0.980    0.980
 * ------------------------------------------------------------
 * 500    0.978    0.977    0.976    0.975    0.974
 * ------------------------------------------------------------
 * 400    0.976    0.975    0.972    0.969    0.968
 * ------------------------------------------------------------
 * 300    0.973    0.971    0.967    0.963    0.961
 * ------------------------------------------------------------
 * 200    0.969    0.966    0.960    0.955    0.952
 * ------------------------------------------------------------
 * 100    0.963    0.956    0.950    0.944    0.940
 * ------------------------------------------------------------
 * 0      0.920    0.920    0.920    0.920    0.920
 * ------------------------------------------------------------
 * k与发散程度 负相关、k越小、曲线前期越平缓、后期越发散 发散程度越大、阈值对剩余时间的变化越敏感
 *
 * 事件最后十分钟、价格阈值对剩余时间的发散函数
 * 剩余时间越短、价格阈值越小
 * @param {number} sec
 * @param {number} baseValue
 * @param {number} growthRate
 * @param {*} k 发散程度
 * @returns {number} 阈值
 */
export function threshold(sec, k = 0.3, a = 0.92, b = 0.06) {
    const s = Math.max(0, Math.min(600, sec));
    return Number((a + b * Math.pow(s / 600, k)).toFixed(3));
}
