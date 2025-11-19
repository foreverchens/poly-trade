module.exports = {
    env: {
        browser: true,
        node: true,
        es2021: true,
    },
    parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
    },
    extends: [
        "eslint:recommended",
        "plugin:import/recommended",
        "plugin:prettier/recommended" // 让 Prettier 接管格式相关规则，避免冲突
    ],
    plugins: ["import"],
    rules: {
        // ===== 基本 Java 味道 =====

        // if / for 等必须带大括号（和 Java 一样严格）
        curly: ["error", "all"],

        // 每个声明单独一行：const a; const b;（类似 Java 一行一个声明）
        "one-var": ["error", "never"],

        // 命名风格：变量/函数用 camelCase，属性也尽量规范
        camelcase: ["error", { properties: "always" }],

        // 类名大写开头，构造器必须用 new，普通函数名不要首字母大写
        "new-cap": [
            "error",
            {
                newIsCap: true,
                capIsNew: false
            }
        ],

        // 禁止随便 _xxx 命名（更 Java 风）
        "no-underscore-dangle": "error",

        // ===== 换行风格（尽量接近 Java 的“规整感”） =====

        // 对象：多行时属性对齐
        "object-curly-newline": [
            "error",
            {
                multiline: true,
                consistent: true
            }
        ],

        // 数组元素换行风格保持一致
        "array-element-newline": ["error", "consistent"],

        // 参数列表过长时换行
        "function-paren-newline": ["error", "multiline"],
        "function-call-argument-newline": ["error", "consistent"],

        // ===== import 顺序：类似 Java 的 import 分组 =====

        "import/order": [
            "error",
            {
                groups: [
                    ["builtin", "external"], // Node/第三方包在上
                    ["internal"],            // 内部模块
                    ["parent", "sibling", "index"] // 相对路径在最后
                ],
                "newlines-between": "always"
            }
        ],

        // import 不允许重复
        "import/no-duplicates": "error",

        // ===== 和 Prettier 保持一致的基础设置（保证不打架） =====

        indent: ["error", 4, { SwitchCase: 1 }],
        quotes: ["error", "double"],
        semi: ["error", "always"]
    }
};
