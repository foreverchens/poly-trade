import "dotenv/config";
import { TailConvergenceStrategy as UpDownStrategy } from "./bots/tail-convergence/up-bot.js";
import { loadConvergenceTaskConfigs } from "./data/convergence-up.config.js";

const taskConfigs = await loadConvergenceTaskConfigs();

for (const taskConfig of taskConfigs) {
    console.log(`[扫尾盘管理器-UP/DOWN] 启动任务: ${taskConfig.task.name}`);
    if (!taskConfig.task.active) {
        console.log(`[扫尾盘管理器-UP/DOWN] 任务: ${taskConfig.task.name} 未激活，跳过`);
        continue;
    }
    await new UpDownStrategy(taskConfig).start().catch((err) => {
        console.error("[扫尾盘管理器-UP/DOWN] 启动失败", err);
        process.exit(1);
    });
}

