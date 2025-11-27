import "dotenv/config";
import { TailConvergenceStrategy as UpDownStrategy } from "./bots/tail-convergence/up-bot.js";

// 从命令行参数获取任务索引，默认为 0
// 使用方式: node tail-bot-start-up.js [taskIndex]
// 例如: node tail-bot-start-up.js 0  (运行第1个任务)
//      node tail-bot-start-up.js 1  (运行第2个任务)
const taskIndex = parseInt(process.argv[2] || "1", 10);

const upDownStrategy = new UpDownStrategy(taskIndex);

upDownStrategy.start().catch((err) => {
    console.error("[扫尾盘管理器-UP/DOWN] 启动失败", err);
    process.exit(1);
});


