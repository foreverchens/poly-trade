import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { TailConvergenceStrategy as YesNoStrategy } from "./bots/tail-convergence/yes-bot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const yesNoStrategy = new YesNoStrategy(
    path.resolve(__dirname, "./data/convergence-yes.data.json"),
);

yesNoStrategy.start().catch((err) => {
    console.error("[扫尾盘管理器-YES/NO] 启动失败", err);
    process.exit(1);
});


