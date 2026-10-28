/*
 * Shared retail rules for the Easy Gateway server and both web clients.
 *
 * This file is intentionally dependency-free and works as a CommonJS module on
 * the server and as a plain browser script (window.EGRetail) in the website and
 * the Android WebView bundle.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.EGRetail = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function number(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function money(value, currency) {
    var amount = number(value);
    try {
      return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: currency || "INR",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(amount);
    } catch (_) {
      return "\u20b9" + amount.toFixed(2);
    }
  }

  function dateOnly(value) {
    if (value == null || value === "") return "";
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) return "";
      return value.getFullYear() + "-" + String(value.getMonth() + 1).padStart(2, "0") + "-" +
        String(value.getDate()).padStart(2, "0");
    }
    var raw = String(value);
    return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : "";
  }

  // Calendar-day difference using local calendar days. Callers that already
  // computed the difference in the shop timezone can pass daysToExpiry.
  function daysUntil(value, now) {
    var day = dateOnly(value);
    if (!day) return null;
    var parts = day.split("-").map(Number);
    var base = now instanceof Date ? now : new Date(now || Date.now());
    if (Number.isNaN(base.getTime())) base = new Date();
    var target = Date.UTC(parts[0], parts[1] - 1, parts[2]);
    var today = Date.UTC(base.getFullYear(), base.getMonth(), base.getDate());
    return Math.round((target - today) / 86400000);
  }

  function buildStockActions(products, now) {
    var list = Array.isArray(products) ? products : [];
    var actions = [];
    var summary = {
      total: 0,
      outOfStock: 0,
      lowStock: 0,
      expiring: 0,
      slowMovers: 0,
      overstock: 0,
      cashTiedUp: 0
    };

    for (var i = 0; i < list.length; i++) {
      var p = list[i] || {};
      var stock = number(p.stock);
      var reorderAt = number(p.reorderAt);
      var cost = number(p.cost != null ? p.cost : p.unitCost);
      var price = number(p.price != null ? p.price : p.sellingPrice);
      var sold30 = number(p.soldLast30Days != null ? p.soldLast30Days : p.sold30d);
      var days = p.daysToExpiry != null && p.daysToExpiry !== "" ? number(p.daysToExpiry) : daysUntil(p.expiry, now);
      var age = p.ageDays != null && p.ageDays !== "" ? number(p.ageDays) :
        (p.createdAt ? -daysUntil(p.createdAt, now) : null);
      var unit = p.unit || "unit";
      var name = p.name || "Unnamed product";
      var valueAtCost = Math.round(stock * cost * 100) / 100;
      var action = null;

      if (stock <= 0) {
        action = {
          type: "out_of_stock",
          priority: 100,
          title: "Out of stock",
          detail: name + " is unavailable. Reorder to resume sales.",
          suggestedAction: "reorder"
        };
      } else if (days != null && days <= 3) {
        action = {
          type: "expiring_urgent",
          priority: 95,
          title: days < 0 ? "Expired stock" : days === 0 ? "Expires today" : "Expires in " + days + " day" + (days === 1 ? "" : "s"),
          detail: stock + " " + unit + " at risk. Sell or rotate this stock first.",
          suggestedAction: "sell"
        };
      } else if (stock <= reorderAt) {
        action = {
          type: "low_stock",
          priority: 85,
          title: "Reorder soon",
          detail: "Stock " + stock + " " + unit + " is at or below the reorder level of " + reorderAt + ".",
          suggestedAction: "reorder"
        };
      } else if (days != null && days <= 7) {
        action = {
          type: "expiring",
          priority: 75,
          title: "Expiring in " + days + " day" + (days === 1 ? "" : "s"),
          detail: stock + " " + unit + " expire soon. Prioritize selling or discounting them.",
          suggestedAction: "sell"
        };
      } else if (sold30 === 0 && age != null && age >= 30) {
        action = {
          type: "slow_mover",
          priority: 50,
          title: "No recent sales",
          detail: "No sales in the last 30 days. " + money(valueAtCost) + " is tied up at cost.",
          suggestedAction: "sell"
        };
      } else if (stock > Math.max(reorderAt * 4, 10) && sold30 <= stock / 4) {
        action = {
          type: "overstock",
          priority: 40,
          title: "Overstocked",
          detail: "Stock " + stock + " " + unit + " is high compared with recent sales.",
          suggestedAction: "sell"
        };
      }

      if (!action) continue;
      summary.total++;
      if (action.type === "out_of_stock") summary.outOfStock++;
      else if (action.type === "low_stock") summary.lowStock++;
      else if (action.type === "expiring" || action.type === "expiring_urgent") summary.expiring++;
      else if (action.type === "slow_mover") summary.slowMovers++;
      else if (action.type === "overstock") summary.overstock++;
      if (action.type === "slow_mover" || action.type === "overstock") summary.cashTiedUp += valueAtCost;

      actions.push({
        id: p.id || ("action-" + i),
        productId: p.id || "",
        name: name,
        sku: p.sku || "",
        category: p.category || "",
        unit: unit,
        stock: stock,
        reorderAt: reorderAt,
        cost: cost,
        price: price,
        expiry: dateOnly(p.expiry),
        daysToExpiry: days,
        soldLast30Days: sold30,
        valueAtCost: valueAtCost,
        type: action.type,
        priority: action.priority,
        title: action.title,
        detail: action.detail,
        suggestedAction: action.suggestedAction
      });
    }

    summary.cashTiedUp = Math.round(summary.cashTiedUp * 100) / 100;
    actions.sort(function (a, b) {
      return b.priority - a.priority || a.name.localeCompare(b.name);
    });
    return { actions: actions, summary: summary };
  }

  function summaryDate(value) {
    var day = dateOnly(value);
    if (!day) return "";
    var parts = day.split("-").map(Number);
    var date = new Date(parts[0], parts[1] - 1, parts[2]);
    try {
      return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    } catch (_) {
      return day;
    }
  }

  function buildSummaryText(summary) {
    if (!summary) return "Easy Gateway daily summary";
    var lines = [];
    lines.push("Easy Gateway daily summary");
    lines.push((summary.shopName || "My shop") + (summary.date ? " \u00b7 " + summaryDate(summary.date) : ""));
    lines.push("");
    lines.push("Revenue: " + money(summary.revenue, summary.currency));
    lines.push("Orders: " + number(summary.orders));
    lines.push("Items sold: " + number(summary.itemsSold));
    lines.push("Average order: " + money(summary.averageOrder, summary.currency));
    lines.push("Loyalty coins awarded: " + number(summary.coinsAwarded));
    lines.push("New customers: " + number(summary.newCustomers));
    var top = Array.isArray(summary.topProducts) ? summary.topProducts : [];
    if (top.length) {
      lines.push("");
      lines.push("Top products:");
      for (var i = 0; i < top.length; i++) {
        lines.push((i + 1) + ". " + top[i].name + " \u2014 " + number(top[i].quantity) + " sold \u2014 " +
          money(top[i].revenue, summary.currency));
      }
    }
    lines.push("");
    lines.push("Stock watch: " + number(summary.lowStockCount) + " low stock \u00b7 " +
      number(summary.expiringSoonCount) + " expiring within 7 days");
    lines.push("Generated by Easy Gateway");
    return lines.join("\n");
  }

  function isBarcodeValue(value) {
    var raw = String(value == null ? "" : value).trim();
    if (raw.length < 4 || raw.length > 100) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return false;
    return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(raw);
  }

  return {
    buildStockActions: buildStockActions,
    buildSummaryText: buildSummaryText,
    daysUntil: daysUntil,
    money: money,
    dateOnly: dateOnly,
    isBarcodeValue: isBarcodeValue
  };
});
