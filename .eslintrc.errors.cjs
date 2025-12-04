// 只检查可能导致运行时异常的关键问题
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
        "eslint:recommended", // 只使用推荐规则，包含未定义变量、未使用变量等
        "plugin:import/recommended" // 检查导入错误
        // 注意：不包含 prettier，因为格式问题不会导致运行时异常
    ],
    plugins: ["import"],
    rules: {
        // ===== 可能导致运行时异常的关键规则 =====

        // 未定义的变量和函数
        "no-undef": "error",
        "no-use-before-define": ["error", { functions: false, classes: true, variables: true }],

        // 未使用的变量（可能导致逻辑错误）
        "no-unused-vars": ["error", {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_"
        }],

        // 重复的变量声明
        "no-redeclare": "error",
        "no-duplicate-imports": "error",
        "import/no-duplicates": "error",

        // 可能导致异常的操作
        "no-cond-assign": "error", // 条件语句中的赋值
        "no-constant-condition": "error", // 常量条件
        "no-dupe-args": "error", // 重复的函数参数
        "no-dupe-keys": "error", // 重复的对象键
        "no-func-assign": "error", // 函数重新赋值
        "no-import-assign": "error", // import 重新赋值
        "no-sparse-arrays": "error", // 稀疏数组
        "no-unreachable": "error", // 不可达代码
        "no-unsafe-finally": "error", // finally 中的 return/throw
        "no-unsafe-negation": "error", // 不安全的否定

        // 类型相关错误
        "no-array-constructor": "error",
        "no-new-wrappers": "error", // 不要使用 new String/Number/Boolean

        // 可能导致内存泄漏或性能问题
        "no-implied-eval": "error", // 隐式 eval
        "no-new-func": "error", // 不要使用 new Function

        // import 相关错误
        "import/no-unresolved": "error", // 无法解析的导入
        "import/named": "error", // 命名导出不存在
        "import/default": "error", // 默认导出不存在
        "import/namespace": "error", // 命名空间导入错误

        // 控制流错误
        "no-fallthrough": "error", // switch case 缺少 break
        "no-case-declarations": "error", // case 中的声明需要大括号

        // ===== 关闭所有格式和风格相关的规则 =====
        // 这些不会导致运行时异常，所以不检查
        curly: "off",
        "one-var": "off",
        camelcase: "off",
        "new-cap": "off",
        "no-underscore-dangle": "off",
        "object-curly-newline": "off",
        "array-element-newline": "off",
        "function-paren-newline": "off",
        "function-call-argument-newline": "off",
        "import/order": "off",
        indent: "off",
        quotes: "off",
        semi: "off"
    }
};

