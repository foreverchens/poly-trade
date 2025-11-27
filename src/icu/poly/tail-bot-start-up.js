import "dotenv/config";
import { TailConvergenceStrategy as UpDownStrategy } from "./bots/tail-convergence/up-bot.js";



new UpDownStrategy(0).start().catch((err) => {
    console.error("[扫尾盘管理器-UP/DOWN] 启动失败", err);
    process.exit(1);
});
new UpDownStrategy(1).start().catch((err) => {
    console.error("[扫尾盘管理器-UP/DOWN] 启动失败", err);
    process.exit(1);
});


