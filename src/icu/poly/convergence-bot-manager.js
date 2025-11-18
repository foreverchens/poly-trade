import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { TailConvergenceStrategy } from "./convergence-bot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const configFiles = [
    "./data/convergence-yes.data.json",
    "./data/convergence-up.data.json",
];

const strategies = configFiles.map((file) => new TailConvergenceStrategy(path.resolve(__dirname, file)));

Promise.all(strategies.map((s) => s.start())).catch((err) => {
    console.error("[扫尾盘管理器] 启动失败", err);
    process.exit(1);
});
