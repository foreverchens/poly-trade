async function fetchOrders() {
    const loading = document.getElementById("loading");
    const table = document.getElementById("ordersTable");
    const tbody = document.getElementById("ordersBody");

    loading.style.display = "block";
    table.style.display = "none";
    tbody.innerHTML = "";

    function truncateId(id) {
        if (!id) return "-";
        if (id.length <= 13) return id;
        return id.substring(0, 6) + "..." + id.substring(id.length - 4);
    }

    try {
        const res = await fetch("/api/bot-orders?limit=100");
        const data = await res.json();

        if (data.error) {
            loading.textContent = "Error: " + data.message;
            return;
        }

        data.forEach((order, index) => {
            const row = document.createElement("tr");
            const date = new Date(order.createdAt).toLocaleString();
            const sideClass = order.side === "BUY" ? "side-yes" : "side-no";

            // Store in global array for edit modal
            window.ordersData = data;

            row.innerHTML = `
                <td>${date}</td>
                <td>${order.marketSlug}</td>
                <td>${order.outcome}</td>
                <td class="${sideClass}">${order.side}</td>
                <td>${order.price.toFixed(3)}</td>
                <td>${order.size}</td>
                <td title="${order.orderId}"><small>${truncateId(order.orderId)}</small></td>
                <td title="${order.parentOrderId || ""}"><small>${truncateId(order.parentOrderId)}</small></td>
                <td>${order.zScore !== null ? order.zScore.toFixed(2) : "-"}</td>
                <td>${order.secondsToEnd !== null ? order.secondsToEnd + "s" : "-"}</td>
                <td>${order.priceChange !== null ? (order.priceChange * 100).toFixed(2) + "%" : "-"}</td>
                <td>${order.isLiquiditySignal ? "Liquidity" : "Normal"}</td>
                <td>
                    <button class="action-btn edit-btn" onclick='openEditModal(${index})'>Edit</button>
                    <button class="action-btn delete-btn" onclick="deleteOrder('${order.id}')">Del</button>
                </td>
            `;
            tbody.appendChild(row);
        });

        loading.style.display = "none";
        table.style.display = "table";
    } catch (err) {
        console.error(err);
        loading.textContent = "Failed to fetch orders";
    }
}

async function deleteOrder(id) {
    if (!confirm("Are you sure you want to delete this order?")) return;

    try {
        const res = await fetch(`/api/bot-orders/${id}`, { method: "DELETE" });
        const data = await res.json();
        if (data.success) {
            fetchOrders();
        } else {
            alert("Failed to delete: " + (data.message || "Unknown error"));
        }
    } catch (err) {
        alert("Error deleting order");
        console.error(err);
    }
}

function openEditModal(index) {
    const order = window.ordersData[index];
    document.getElementById("editId").value = order.id;
    document.getElementById("editPrice").value = order.price;
    document.getElementById("editSize").value = order.size;
    document.getElementById("editOutcome").value = order.outcome;
    document.getElementById("editSide").value = order.side;
    document.getElementById("editModal").style.display = "block";
}

function closeModal() {
    document.getElementById("editModal").style.display = "none";
}

async function saveOrder() {
    const id = document.getElementById("editId").value;
    const price = document.getElementById("editPrice").value;
    const size = document.getElementById("editSize").value;
    const outcome = document.getElementById("editOutcome").value;
    const side = document.getElementById("editSide").value;

    try {
        const res = await fetch(`/api/bot-orders/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ price, size, outcome, side }),
        });
        const data = await res.json();

        if (data.error) {
            alert("Failed to update: " + data.message);
        } else {
            closeModal();
            fetchOrders();
        }
    } catch (err) {
        alert("Error updating order");
        console.error(err);
    }
}

// Close modal if clicking outside
window.onclick = function (event) {
    const modal = document.getElementById("editModal");
    if (event.target == modal) {
        closeModal();
    }
};

// Load on start
fetchOrders();
