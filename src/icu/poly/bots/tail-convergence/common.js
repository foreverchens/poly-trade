import { readFileSync } from "fs";
import dayjs from "dayjs";
import { polyClient } from "../../core/PolyClient.js";

const EASTERN_TZ = "America/New_York";

export const TAKE_PROFIT_ORDER_STATUS = {
    "PENDING":"待提交",
    "PARTIALLY_MATCHED":"部分成交",
    "FULLY_MATCHED":"全部成交",
    "CANCELLED":"已取消",
};

export function resolveSlugList(slugList, referenceDate = new Date()) {
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

    return slugList.map((slug) => {
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
            `[@${now} ${slug}] 事件剩余时间=${Math.round(minutesToEnd)}分钟 超过最大时间=${maxMinutesToEnd}分钟，不处理`
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
 * 事件最后十分钟、价格阈值对剩余时间的发散函数
 * 剩余时间越短、价格阈值越大
 * sec = 600时、阈值为0.98
 * sec = 300时、阈值为0.95
 * sec = 120时、阈值为0.90
 * @param {number} sec
 * @param {*} k
 * @returns {number}
 */
export function threshold(sec, k = 0.5) {
    const s = Math.max(0, Math.min(600, sec));
    return Number((0.90 + 0.08 * Math.pow(s / 600, k)).toFixed(3));
  }


