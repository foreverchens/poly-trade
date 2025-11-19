import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { TailConvergenceStrategy as UpDownStrategy } from "./bots/tail-convergence/up-bot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const upDownStrategy = new UpDownStrategy(
    path.resolve(__dirname, "./data/convergence-up.data.json"),
);

upDownStrategy.start().catch((err) => {
    console.error("[扫尾盘管理器-UP/DOWN] 启动失败", err);
    process.exit(1);
});


