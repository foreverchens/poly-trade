(() => {
    const queryForm = document.getElementById("queryForm");
    const marketSlugInput = document.getElementById("marketSlugInput");
    const queryButton = document.getElementById("queryButton");
    const statusEl = document.getElementById("status");
    const summarySection = document.getElementById("summarySection");
    const summaryGrid = document.getElementById("summaryGrid");
    const summaryMeta = document.getElementById("summaryMeta");
    const chartsGrid = document.getElementById("chartsGrid");
    const chartsEmpty = document.getElementById("chartsEmpty");
    const chartsMeta = document.getElementById("chartsMeta");
    const samplesTableBody = document.getElementById("samplesTableBody");
    const tableMeta = document.getElementById("tableMeta");
    const SVG_NS = "http://www.w3.org/2000/svg";

    const COLOR_VARIABLES = [
        "--accent",
        "--accent-2",
        "--accent-3",
        "--accent-4",
        "--accent-5",
        "--accent-6",
        "--accent-7",
        "--accent-8",
    ];
    let resolvedColors = null;

    const METRICS = [
        { key: "assert_price", label: "锚定资产价格 (USDT)", precision: 4, transform: asNumber },
        {
            key: "assert_amp",
            label: "锚定资产涨跌幅 (%)",
            precision: 2,
            transform: (value) => scaleBy(value, 100),
        },
        {
            key: "up_price",
            label: "UP 概率 (%)",
            precision: 2,
            transform: (value) => scaleProbability(value),
        },
        {
            key: "down_price",
            label: "DOWN 概率 (%)",
            precision: 2,
            transform: (value) => scaleProbability(value),
        },
        {
            key: "top_price",
            label: "Top 价格 (%)",
            precision: 2,
            transform: (value) => scaleProbability(value),
        },
        {
            key: "top_price_spread",
            label: "Top 价差 (%)",
            precision: 2,
            transform: (value) => scaleProbability(value),
        },
        { key: "top_z", label: "Top Z", precision: 2, transform: (value) => scaleBy(value, 10) },
        { key: "top_vol", label: "Top Vol", precision: 0, transform: asNumber },
        { key: "liq_sum", label: "Liq Sum", precision: 0, transform: asNumber },
    ];
    const CHART_EXCLUDED_KEYS = new Set(["top_vol"]);

    queryForm.addEventListener("submit", handleSubmit);

    const presetSlug = new URLSearchParams(location.search).get("market_slug");
    if (presetSlug) {
        marketSlugInput.value = presetSlug;
        fetchAndRender(presetSlug);
    }

    function handleSubmit(event) {
        event.preventDefault();
        const slug = marketSlugInput.value.trim();
        if (!slug) {
            setStatus("请输入 market_slug", "error");
            return;
        }
        fetchAndRender(slug);
    }

    async function fetchAndRender(slug) {
        setStatus("加载中…", "muted");
        setLoading(true);
        try {
            const payload = await fetchSamples(slug);
            const samples = Array.isArray(payload.samples) ? payload.samples : [];
            renderSamples(slug, samples);
            if (samples.length) {
                setStatus(`加载完成：${samples.length} 条 minute 样本`, "success");
            } else {
                setStatus("没有找到该 market_slug 的 minute 数据", "error");
            }
        } catch (error) {
            console.error(error);
            setStatus(error.message || "加载失败", "error");
            renderSamples(slug, []);
        } finally {
            setLoading(false);
        }
    }

    async function fetchSamples(slug) {
        const url = `/api/hour-minute-samples?market_slug=${encodeURIComponent(slug)}`;
        const response = await fetch(url, { headers: { accept: "application/json" } });
        if (!response.ok) {
            const text = await response.text();
            let message = text;
            try {
                const parsed = JSON.parse(text);
                message = parsed.message || parsed.error || text;
            } catch (err) {
                // ignore JSON parse errors and fall back to raw text
            }
            throw new Error(message || `接口返回 ${response.status}`);
        }
        return response.json();
    }

    function renderSamples(slug, samples) {
        const normalized = samples
            .map((sample) => ({
                ...sample,
                minute_idx: Number(sample.minute_idx) || 0,
            }))
            .sort((a, b) => a.minute_idx - b.minute_idx);
        renderSummary(slug, normalized);
        renderCharts(normalized);
        renderTable(normalized);
    }

    function renderSummary(slug, samples) {
        if (!samples.length) {
            summarySection.classList.add("hidden");
            summaryGrid.innerHTML = "";
            summaryMeta.textContent = "";
            return;
        }
        summarySection.classList.remove("hidden");
        const latest = samples[samples.length - 1];
        summaryMeta.textContent = `market_slug：${slug} · 最新 minute：${latest.minute_idx}`;
        const summaryItems = [
            { label: "Top Side", value: latest.top_side || "—" },
            { label: "涨跌幅(%)", value: formatValue(latest, getMetric("assert_amp")) },
            { label: "Top 价格(%)", value: formatValue(latest, getMetric("top_price")) },
            { label: "Top 价差(%)", value: formatValue(latest, getMetric("top_price_spread")) },
            { label: "Top Z", value: formatValue(latest, getMetric("top_z")) },
            { label: "Top Vol", value: formatValue(latest, getMetric("top_vol")) },
            { label: "Liq Sum", value: formatValue(latest, getMetric("liq_sum")) },
            { label: "样本数", value: `${samples.length}` },
        ];
        summaryGrid.innerHTML = summaryItems
            .map(
                (item) => `
            <div class="summary-item">
                <span>${item.label}</span>
                <strong>${item.value}</strong>
            </div>
        `,
            )
            .join("");
    }

    function renderCharts(samples) {
        chartsGrid.innerHTML = "";
        const hasSamples = samples.length > 0;
        chartsEmpty.classList.toggle("hidden", hasSamples);
        chartsMeta.textContent = hasSamples
            ? `共 ${samples.length} 条 minute，横坐标为 minute_idx`
            : "";
        if (!hasSamples) {
            return;
        }
        const chartMetrics = METRICS.filter((metric) => !CHART_EXCLUDED_KEYS.has(metric.key));
        chartMetrics.forEach((metric, index) => {
            const points = samples
                .map((sample) => {
                    const y = metric.transform(sample[metric.key]);
                    if (!Number.isFinite(y)) return null;
                    return { x: sample.minute_idx, y };
                })
                .filter(Boolean);
            const card = document.createElement("div");
            card.className = "chart-card";
            const head = document.createElement("div");
            head.className = "chart-card-head";
            const title = document.createElement("strong");
            title.textContent = metric.label;
            const value = document.createElement("span");
            value.className = "chart-card-value";
            value.textContent = points.length
                ? formatNumber(points[points.length - 1].y, metric.precision)
                : "—";
            head.appendChild(title);
            head.appendChild(value);
            card.appendChild(head);
            if (!points.length) {
                const empty = document.createElement("div");
                empty.className = "chart-empty";
                empty.textContent = "暂无数据";
                card.appendChild(empty);
            } else {
                const svg = buildLineChart(points, getColor(index));
                card.appendChild(svg);
            }
            chartsGrid.appendChild(card);
        });
    }

    function renderTable(samples) {
        if (!samples.length) {
            tableMeta.textContent = "暂无数据";
            samplesTableBody.innerHTML = "";
            return;
        }
        tableMeta.textContent = `共 ${samples.length} 条，每条代表 1 分钟`;
        const rows = samples
            .map((sample) => {
                const metricValues = METRICS.map((metric) => formatValue(sample, metric));
                const cells = [sample.minute_idx, ...metricValues, sample.top_side || "—"];
                return `<tr>${cells.map((cell) => `<td>${cell ?? "—"}</td>`).join("")}</tr>`;
            })
            .join("");
        samplesTableBody.innerHTML = rows;
    }

    function buildLineChart(points, color) {
        const width = 600;
        const height = 220;
        const padding = 40;
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        svg.setAttribute("preserveAspectRatio", "none");
        svg.classList.add("chart-canvas");
        const xValues = points.map((p) => p.x);
        const yValues = points.map((p) => p.y);
        const minX = Math.min(...xValues);
        const maxX = Math.max(...xValues);
        let minY = Math.min(...yValues);
        let maxY = Math.max(...yValues);
        if (minY === maxY) {
            const adjust = minY === 0 ? 1 : Math.abs(minY) * 0.1;
            minY -= adjust;
            maxY += adjust;
        }
        const chartWidth = width - padding * 2;
        const chartHeight = height - padding * 2;
        const scaleX = (value) => {
            if (maxX === minX) return padding + chartWidth / 2;
            return padding + ((value - minX) / (maxX - minX)) * chartWidth;
        };
        const scaleY = (value) => {
            if (maxY === minY) return padding + chartHeight / 2;
            return padding + chartHeight - ((value - minY) / (maxY - minY)) * chartHeight;
        };

        for (let i = 0; i <= 3; i++) {
            const line = document.createElementNS(SVG_NS, "line");
            const y = padding + (chartHeight / 3) * i;
            line.setAttribute("x1", padding);
            line.setAttribute("x2", padding + chartWidth);
            line.setAttribute("y1", y);
            line.setAttribute("y2", y);
            line.setAttribute("stroke", "rgba(255,255,255,0.05)");
            line.setAttribute("stroke-width", "1");
            svg.appendChild(line);
        }

        const path = document.createElementNS(SVG_NS, "path");
        const d = points
            .map((point, idx) => {
                const x = scaleX(point.x).toFixed(2);
                const y = scaleY(point.y).toFixed(2);
                return `${idx === 0 ? "M" : "L"}${x} ${y}`;
            })
            .join(" ");
        path.setAttribute("d", d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", color);
        path.setAttribute("stroke-width", "3");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);

        const lastPoint = points[points.length - 1];
        if (lastPoint) {
            const dot = document.createElementNS(SVG_NS, "circle");
            dot.setAttribute("cx", scaleX(lastPoint.x));
            dot.setAttribute("cy", scaleY(lastPoint.y));
            dot.setAttribute("r", "4");
            dot.setAttribute("fill", color);
            dot.setAttribute("stroke", "#05070b");
            dot.setAttribute("stroke-width", "2");
            svg.appendChild(dot);
        }

        return svg;
    }

    function setLoading(isLoading) {
        queryButton.disabled = isLoading;
        marketSlugInput.disabled = isLoading;
    }

    function setStatus(message, tone = "muted") {
        statusEl.textContent = message;
        statusEl.className = `status ${tone === "success" ? "success" : tone === "error" ? "error" : "muted"}`;
    }

    function formatValue(sample, metric) {
        if (!metric) return "—";
        const value = metric.transform(sample[metric.key]);
        return Number.isFinite(value) ? formatNumber(value, metric.precision) : "—";
    }

    function formatNumber(value, precision = 2) {
        const formatter = new Intl.NumberFormat("zh-CN", {
            minimumFractionDigits: 0,
            maximumFractionDigits: precision,
        });
        return formatter.format(value);
    }

    function getMetric(key) {
        return METRICS.find((metric) => metric.key === key) || null;
    }

    function asNumber(value) {
        const num = typeof value === "string" ? Number(value) : value;
        return Number.isFinite(num) ? num : null;
    }

    function scaleProbability(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return null;
        return num / 10;
    }

    function scaleBy(value, scale) {
        const num = Number(value);
        if (!Number.isFinite(num)) return null;
        return num / scale;
    }

    function getColor(index) {
        if (!resolvedColors) {
            const styles = window.getComputedStyle(document.documentElement);
            resolvedColors = COLOR_VARIABLES.map((key, idx) => {
                const value = styles.getPropertyValue(key)?.trim();
                if (value) return value;
                // fallback to a readable palette if CSS variables are missing
                const fallback = [
                    "#38bdf8",
                    "#c084fc",
                    "#f97316",
                    "#22d3ee",
                    "#facc15",
                    "#4ade80",
                    "#fb7185",
                    "#a5b4fc",
                ];
                return fallback[idx] || fallback[0];
            });
        }
        return resolvedColors[index % resolvedColors.length];
    }
})();
