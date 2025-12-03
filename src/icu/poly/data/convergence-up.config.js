import dayjs from "dayjs";
import { listConvergenceTaskConfigs } from '../db/convergence-task-config-repository.js';

let cachedConfigsPromise = null;

/**
 * 从数据库加载扫尾盘任务配置，结果会缓存，除非显式刷新。
 * @param {Object} [options]
 * @param {boolean} [options.refresh=false]
 * @returns {Promise<Array>}
 */
export async function loadConvergenceTaskConfigs({ refresh = false } = {}) {
    if (!cachedConfigsPromise || refresh) {
        cachedConfigsPromise = listConvergenceTaskConfigs().then((configs) => {
            if (!configs || configs.length === 0) {
                throw new Error(
                    '[convergence-up.config] 数据库未找到任务配置，请先运行配置导入脚本。',
                );
            }
            return configs;
        });
    }

    return cachedConfigsPromise;
}

const convergenceTaskConfigs = await loadConvergenceTaskConfigs();
export default convergenceTaskConfigs;

