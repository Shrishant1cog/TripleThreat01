/*
 * Easy Gateway shop tools shared by the website and the Android WebView app.
 *
 * Loaded after the main application bundle. It only uses the small EGApp
 * bridge and the EGRetail rules module, so the same file works in both
 * clients without duplicating the inventory/sales implementation.
 */
(function () {
  "use strict";

  var core = window.EGRetail;
  var app = window.EGApp;
  if (!core || !app) return;

  var overlay = null;
  var mode = "";
  var cart = [];
  var quickCode = "";
  var quickCustomer = "";
  var quickError = "";
  var lastReceipt = null;
  var lastDemoState = null;
  var busy = false;
  var actionState = null;
  var actionLoading = false;
  var summaryState = null;
  var summaryLoading = false;
  var summaryDate = "";
  var summaryError = "";
  // Sell and Stocking are two modes of the same shop tool. Stocking writes a
  // receipt and inventory movement instead of reducing stock.
  var toolMode = "sell";
  var stockingProduct = null;
  var stockingError = "";
  var stockingResult = null;
  var stockingBusy = false;
  var serialTargetId = "";
  var stockScanTarget = "";
  var saleKey = "";
  var stockKey = "";
  var REWARDS = [
    { code: "SAVE50", label: "\u20b950 voucher", coins: 100, value: 50, description: "Redeem 100 coins for a \u20b950 shop voucher." },
    { code: "SAVE150", label: "\u20b9150 voucher", coins: 250, value: 150, description: "Redeem 250 coins for a \u20b9150 shop voucher." },
    { code: "SAVE350", label: "\u20b9350 voucher", coins: 500, value: 350, description: "Redeem 500 coins for a \u20b9350 shop voucher." }
  ];

  function el(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    if (app.safe) return app.safe(value);
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function money(value) {
    return app.fmt ? app.fmt(value) : core.money(value);
  }

  function amount(value) {
    return app.num ? app.num(value) : String(Number(value) || 0);
  }

  function today() {
    return app.localDate ? app.localDate() : core.dateOnly(new Date());
  }

  function isDemo() {
    return !!app.demoMode;
  }

  function notify(message) {
    if (app.toast) app.toast(message);
  }

  function demoError(message, status) {
    var error = new Error(message);
    error.status = status || 400;
    return error;
  }

  function demoData() {
    return app.loadDemoData();
  }

  function saveDemo() {
    if (app.saveDemoData) app.saveDemoData();
  }

  function demoProductByCode(code) {
    var key = String(code || "").trim().toLowerCase();
    if (!key) return null;
    var products = demoData().products || [];
    for (var i = 0; i < products.length; i++) {
      var product = products[i];
      if (String(product.barcode || "").toLowerCase() === key) return product;
      if (String(product.sku || "").toLowerCase() === key) return product;
    }
    return null;
  }

  function demoRequest(path, options) {
    var data = demoData();
    var opts = options || {};
    var method = String(opts.method || "GET").toUpperCase();
    var body = opts.body || {};
    var route = String(path).split("?")[0];
    var query = new URLSearchParams(String(path).split("?")[1] || "");

    if (route === "/products/lookup" && method === "GET") {
      var found = demoProductByCode(query.get("code"));
      if (!found) throw demoError('No active product matches "' + String(query.get("code") || "") + '". Add it in Inventory first.', 404);
      return Promise.resolve({ product: JSON.parse(JSON.stringify(found)) });
    }

    if (route === "/sales" && method === "POST") {
      var requested = Array.isArray(body.items) && body.items.length ? body.items : [{ productId: body.productId, quantity: body.quantity }];
      var lines = [];
      var seen = {};
      var seenSerials = {};
      requested.forEach(function (item) {
        var productId = String((item && item.productId) || "");
        var code = String((item && item.code) || "");
        var quantity = Number(item && item.quantity);
        var serials = Array.isArray(item && item.serials) ? item.serials.map(function (serial) { return String(serial || "").trim(); }).filter(Boolean) : [];
        var product = productId
          ? data.products.find(function (p) { return p.id === productId; })
          : demoProductByCode(code);
        if (!product) throw demoError("Product not found in the sample inventory.", 404);
        if (!Number.isFinite(quantity) || quantity <= 0) throw demoError("Select a product and enter a positive quantity.", 400);
        if (product.trackSerials) {
          if (!Number.isInteger(quantity)) throw demoError(product.name + " tracks serial numbers, so quantities must be whole numbers.", 409);
          if (serials.length !== quantity) throw demoError("Scan exactly " + quantity + " serial number" + (quantity === 1 ? "" : "s") + " for " + product.name + ".", 409);
          serials.forEach(function (serial) {
            var normalized = core.normalizeCode(serial);
            if (seenSerials[normalized]) throw demoError('Serial "' + serial + '" was scanned more than once in this sale.', 409);
            seenSerials[normalized] = true;
            var unit = (product.serials || []).find(function (u) { return core.normalizeCode(u.serial) === normalized; });
            if (!unit || unit.status !== "in_stock") throw demoError("Serial " + serial + " is not available in stock for " + product.name + ".", 409);
          });
        } else if (serials.length) {
          throw demoError(product.name + " does not track individual serial numbers. Remove the serial values and sell by quantity.", 400);
        }
        var key = product.id + "|" + (serials.length ? serials.join(",") : "");
        if (!serials.length && seen[product.id]) seen[product.id].quantity += quantity;
        else {
          var line = { productId: product.id, quantity: quantity, serials: serials };
          seen[key] = line;
          if (!serials.length) seen[product.id] = line;
          lines.push(line);
        }
      });
      if (!lines.length) throw demoError("Add at least one product to the sale.", 400);
      var total = 0;
      lines.forEach(function (line) {
        var product = data.products.find(function (p) { return p.id === line.productId; });
        if (!product) throw demoError("Product not found.", 404);
        if (Number(product.stock) < line.quantity) throw demoError("Insufficient stock for " + product.name + ". Only " + amount(product.stock) + " " + product.unit + " remain.", 409);
      });
      lines.forEach(function (line) {
        var product = data.products.find(function (p) { return p.id === line.productId; });
        product.stock = Math.round((Number(product.stock) - line.quantity) * 1000) / 1000;
        if (product.trackSerials) {
          line.serials.forEach(function (serial) {
            var normalized = core.normalizeCode(serial);
            var unit = (product.serials || []).find(function (u) { return core.normalizeCode(u.serial) === normalized; });
            if (unit) unit.status = "sold";
          });
        }
        line.product = product;
        line.total = Math.round(Number(product.price) * line.quantity * 100) / 100;
        total += line.total;
      });
      total = Math.round(total * 100) / 100;
      var customerName = String(body.customerName || "").trim();
      var customer = null;
      var coins = 0;
      if (customerName) {
        customer = data.customers.find(function (c) { return String(c.name).toLowerCase() === customerName.toLowerCase(); });
        if (!customer) {
          customer = { id: "demo-c" + Date.now(), name: customerName, phone: "", coins: 0, spend: 0, orders: 0, createdAt: new Date().toISOString() };
          data.customers.unshift(customer);
        }
        coins = Math.floor(total / Math.max(1, Number(data.settings.coinThreshold) || 100));
        customer.coins += coins;
        customer.spend += total;
        customer.orders += 1;
      }
      var groupId = "demo-group-" + Date.now();
      var sales = lines.map(function (line, index) {
        var sale = {
          id: "demo-sale-" + Date.now() + "-" + index,
          groupId: groupId,
          productId: line.product.id,
          item: line.product.name,
          customer: customer ? customer.name : "Walk-in customer",
          quantity: line.quantity,
          amount: line.total,
          coinsEarned: index === 0 ? coins : 0,
          status: "Recorded",
          time: new Date().toISOString(),
          createdAt: new Date().toISOString()
        };
        data.sales.unshift(sale);
        return sale;
      });
      saveDemo();
      return Promise.resolve({
        sale: JSON.parse(JSON.stringify(sales[0])),
        sales: JSON.parse(JSON.stringify(sales)),
        coinsEarned: coins,
        total: total,
        groupId: groupId,
        customer: customer ? customer.name : "Walk-in customer"
      });
    }

    if (route === "/stock/receipts" && method === "POST") {
      var stockItems = Array.isArray(body.items) ? body.items : [];
      if (!stockItems.length) throw demoError("Add at least one product line to the receipt.", 400);
      var receipt = {
        id: "demo-receipt-" + Date.now(),
        reference: String(body.reference || "").trim(),
        note: String(body.note || "").trim(),
        itemCount: stockItems.length,
        totalCost: 0,
        createdAt: new Date().toISOString()
      };
      var received = [];
      stockItems.forEach(function (item) {
        var product = item.productId ? data.products.find(function (p) { return p.id === item.productId; }) : demoProductByCode(item.code);
        if (!product) throw demoError("Product not found in the sample inventory.", 404);
        var quantity = Number(item.quantity);
        var serials = Array.isArray(item.serials) ? item.serials.map(function (s) { return String(s || "").trim(); }).filter(Boolean) : [];
        if (!Number.isFinite(quantity) || quantity <= 0) throw demoError("Every stock line needs a positive quantity.", 400);
        if (product.trackSerials) {
          if (!Number.isInteger(quantity)) throw demoError(product.name + " tracks serial numbers, so quantities must be whole numbers.", 409);
          if (serials.length !== quantity) throw demoError("Enter exactly " + quantity + " serial number" + (quantity === 1 ? "" : "s") + " for " + product.name + ".", 409);
          serials.forEach(function (serial) {
            var normalized = core.normalizeCode(serial);
            var duplicate = data.products.some(function (p) {
              return (p.serials || []).some(function (u) { return core.normalizeCode(u.serial) === normalized; });
            });
            if (duplicate) throw demoError("Serial " + serial + " is already recorded in the sample shop.", 409);
          });
          product.serials = Array.isArray(product.serials) ? product.serials : [];
          serials.forEach(function (serial) { product.serials.push({ serial: serial, status: "in_stock" }); });
        } else if (serials.length) {
          throw demoError(product.name + " does not track individual serial numbers.", 400);
        }
        var cost = item.unitCost == null || item.unitCost === "" ? Number(product.cost) || 0 : Number(item.unitCost);
        product.stock = Math.round((Number(product.stock) + quantity) * 1000) / 1000;
        product.cost = cost;
        if (item.expiry) product.expiry = String(item.expiry).slice(0, 10);
        receipt.totalCost = Math.round((receipt.totalCost + cost * quantity) * 100) / 100;
        received.push({ productId: product.id, name: product.name, quantity: quantity, unitCost: cost, expiry: product.expiry || "", serials: serials, balanceAfter: product.stock });
      });
      data.stockReceipts = Array.isArray(data.stockReceipts) ? data.stockReceipts : [];
      data.stockReceipts.unshift(receipt);
      saveDemo();
      return Promise.resolve({ receipt: receipt, items: received });
    }

    if (route === "/loyalty/rewards" && method === "GET") {
      return Promise.resolve({ rewards: REWARDS });
    }

    if (route === "/loyalty/redeem" && method === "POST") {
      var wallet = data.customers.find(function (c) { return c.id === body.customerId; });
      if (!wallet) throw demoError("Customer not found in the sample shop.", 404);
      var reward = REWARDS.find(function (r) { return r.code === core.normalizeCode(body.rewardCode); });
      if (!reward) throw demoError("Choose a valid loyalty reward.", 400);
      if (Number(wallet.coins) < reward.coins) throw demoError("This customer has " + amount(wallet.coins) + " coins. " + reward.label + " needs " + reward.coins + " coins.", 409);
      wallet.coins = Number(wallet.coins) - reward.coins;
      var voucher = "EG-V-" + Math.random().toString(16).slice(2, 10).toUpperCase();
      var redemption = { id: "demo-redeem-" + Date.now(), customerId: wallet.id, customerName: wallet.name, rewardCode: reward.code, rewardLabel: reward.label, coinsSpent: reward.coins, rewardValue: reward.value, status: "issued", voucherCode: voucher, createdAt: new Date().toISOString() };
      data.loyaltyRedemptions = Array.isArray(data.loyaltyRedemptions) ? data.loyaltyRedemptions : [];
      data.loyaltyRedemptions.unshift(redemption);
      saveDemo();
      return Promise.resolve({ redemption: redemption, customer: { id: wallet.id, name: wallet.name, coins: wallet.coins }, message: "Voucher " + voucher + " issued for " + reward.label + " in Demo Mode." });
    }

    if (route === "/action-center" && method === "GET") {
      var now = Date.now();
      var products = (data.products || []).map(function (p) {
        var sold = 0;
        (data.sales || []).forEach(function (sale) {
          var time = new Date(sale.time || sale.createdAt || 0).getTime();
          if (sale.productId === p.id && Number.isFinite(time) && now - time <= 30 * 86400000) sold += Number(sale.quantity) || 0;
        });
        return {
          id: p.id,
          name: p.name,
          sku: p.sku,
          barcode: p.barcode || "",
          category: p.category,
          unit: p.unit,
          stock: Number(p.stock) || 0,
          reorderAt: Number(p.reorderAt) || 0,
          cost: Number(p.cost) || 0,
          price: Number(p.price) || 0,
          expiry: p.expiry || "",
          daysToExpiry: core.daysUntil(p.expiry),
          ageDays: p.createdAt ? Math.max(0, -core.daysUntil(p.createdAt)) : 60,
          soldLast30Days: sold
        };
      });
      return Promise.resolve(core.buildStockActions(products, new Date()));
    }

    if (route === "/daily-summary" && method === "GET") {
      var day = query.get("date") || today();
      var daySales = (data.sales || []).filter(function (sale) {
        return String(sale.time || sale.createdAt || "").slice(0, 10) === day;
      });
      var groups = {};
      daySales.forEach(function (sale) { groups[sale.groupId || sale.id] = true; });
      var revenue = daySales.reduce(function (sum, sale) { return sum + (Number(sale.amount) || 0); }, 0);
      var itemsSold = daySales.reduce(function (sum, sale) { return sum + (Number(sale.quantity) || 0); }, 0);
      var topMap = {};
      daySales.forEach(function (sale) {
        var key = sale.item || "Product";
        if (!topMap[key]) topMap[key] = { name: key, quantity: 0, revenue: 0 };
        topMap[key].quantity += Number(sale.quantity) || 0;
        topMap[key].revenue += Number(sale.amount) || 0;
      });
      var orders = Object.keys(groups).length;
      var summary = {
        date: day,
        shopName: data.user.shopName,
        currency: "INR",
        revenue: Math.round(revenue * 100) / 100,
        orders: orders,
        itemsSold: itemsSold,
        averageOrder: orders ? Math.round(revenue / orders * 100) / 100 : 0,
        coinsAwarded: daySales.reduce(function (sum, sale) { return sum + (Number(sale.coinsEarned) || 0); }, 0),
        newCustomers: (data.customers || []).filter(function (c) { return String(c.createdAt || "").slice(0, 10) === day; }).length,
        topProducts: Object.keys(topMap).map(function (key) { return topMap[key]; }).sort(function (a, b) { return b.revenue - a.revenue; }).slice(0, 5),
        lowStockCount: (data.products || []).filter(function (p) { return Number(p.stock) <= Number(p.reorderAt); }).length,
        expiringSoonCount: (data.products || []).filter(function (p) {
          var days = core.daysUntil(p.expiry);
          return days !== null && days >= 0 && days <= 7;
        }).length,
        generatedAt: new Date().toISOString()
      };
      summary.shareText = core.buildSummaryText(summary);
      return Promise.resolve({ summary: summary });
    }

    return Promise.reject(demoError("This action is not available in Demo Mode.", 404));
  }

  function request(path, options) {
    if (isDemo()) {
      try {
        return demoRequest(path, options);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return app.api(path, options);
  }

  function lookupUnit(code) {
    if (isDemo()) {
      var product = demoProductByCode(code);
      if (product) return Promise.resolve({ product: product, serialUnit: null });
      var match = null;
      (demoData().products || []).forEach(function (p) {
        (p.serials || []).forEach(function (unit) {
          if (unit.status === "in_stock" && core.normalizeCode(unit.serial) === core.normalizeCode(code)) match = { product: p, serialUnit: unit.serial };
        });
      });
      if (!match) return Promise.reject(demoError('No product matches "' + String(code || "") + '". Add it in Inventory first.', 404));
      return Promise.resolve(match);
    }
    return request("/products/lookup?code=" + encodeURIComponent(code)).then(function (result) {
      return { product: result.product, serialUnit: result.serialUnit || null };
    });
  }

  function lookupProduct(code) {
    return lookupUnit(code).then(function (result) { return result.product; });
  }

  function cartTotal() {
    return Math.round(cart.reduce(function (sum, line) {
      return sum + Number(line.product.price) * Number(line.quantity);
    }, 0) * 100) / 100;
  }

  function cartQuantity(productId) {
    var line = cart.find(function (item) { return item.product.id === productId; });
    return line ? Number(line.quantity) : 0;
  }

  function addToCart(product, quantity) {
    if (product.trackSerials) {
      if (!cart.some(function (line) { return line.product.id === product.id; })) {
        cart.push({ product: product, quantity: 0, serials: [] });
      }
      notify(product.name + " tracks serial numbers. Scan or type each unit serial in the cart.");
      return true;
    }
    var qty = Number(quantity) || 1;
    if (qty <= 0) qty = 1;
    var existing = cart.find(function (line) { return line.product.id === product.id; });
    var next = (existing ? Number(existing.quantity) : 0) + qty;
    var stock = Number(product.stock) || 0;
    if (next > stock) {
      notify("Only " + amount(stock) + " " + (product.unit || "unit") + " of " + product.name + " remain.");
      return false;
    }
    if (existing) existing.quantity = Math.round(next * 1000) / 1000;
    else cart.push({ product: product, quantity: Math.round(qty * 1000) / 1000, serials: [] });
    return true;
  }

  function findCartLine(productId) {
    return cart.find(function (line) { return line.product.id === productId; });
  }

  function addSerializedUnit(product, serial) {
    if (!product || !product.trackSerials) return false;
    var raw = String(serial || "").trim();
    var normalized = core.normalizeCode(raw);
    if (!raw) {
      notify("Scan or type a serial number first.");
      return false;
    }
    var duplicate = false;
    cart.forEach(function (line) {
      if ((line.serials || []).some(function (value) { return core.normalizeCode(value) === normalized; })) duplicate = true;
    });
    if (duplicate) {
      notify("Serial " + raw + " is already in this sale.");
      return false;
    }
    var line = findCartLine(product.id);
    if (!line) {
      line = { product: product, quantity: 0, serials: [] };
      cart.push(line);
    }
    if (line.serials.length >= Number(product.stock)) {
      notify("Only " + amount(product.stock) + " serialized " + (product.unit || "unit") + " of " + product.name + " remain.");
      return false;
    }
    line.serials.push(raw);
    line.quantity = line.serials.length;
    return true;
  }

  function productOptions() {
    var stock = (app.state.products || []).filter(function (p) { return Number(p.stock) > 0; });
    if (!stock.length) return '<option value="">No products in stock</option>';
    return stock.map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.name) + " \u00b7 " + amount(p.stock) + " " + esc(p.unit) + " \u00b7 " + money(p.price) + "</option>";
    }).join("");
  }

  function modeSwitcher() {
    return '<div class="egf-modes" role="tablist" aria-label="Shop tool mode">' +
      '<button type="button" role="tab" aria-selected="' + (toolMode === "sell" ? "true" : "false") + '" class="' + (toolMode === "sell" ? "active" : "") + '" data-ef-action="mode-sell">Sell</button>' +
      '<button type="button" role="tab" aria-selected="' + (toolMode === "stocking" ? "true" : "false") + '" class="' + (toolMode === "stocking" ? "active" : "") + '" data-ef-action="mode-stocking">Stocking</button>' +
      '</div>';
  }

  function serialCell(line) {
    var p = line.product;
    if (!p.trackSerials) {
      return '<div class="egf-qty"><button type="button" data-ef-action="qty-dec" data-id="' + esc(p.id) + '" aria-label="Remove one ' + esc(p.name) + '">\u2212</button><input type="number" min="0.001" step="0.001" value="' + esc(line.quantity) + '" data-ef-qty="' + esc(p.id) + '" aria-label="Quantity for ' + esc(p.name) + '"><button type="button" data-ef-action="qty-inc" data-id="' + esc(p.id) + '" aria-label="Add one ' + esc(p.name) + '">+</button></div>';
    }
    var units = (line.serials || []).map(function (serial) {
      return '<span class="egf-serial-chip">' + esc(serial) + ' <button type="button" data-ef-action="remove-serial" data-id="' + esc(p.id) + '" data-serial="' + esc(serial) + '" aria-label="Remove serial ' + esc(serial) + '">\u00d7</button></span>';
    }).join("") || '<span class="egf-sub">No serial scanned yet</span>';
    var scanButton = typeof app.scanBarcode === "function"
      ? '<button type="button" class="egf-inline" data-ef-action="scan-serial" data-id="' + esc(p.id) + '">Scan serial</button>'
      : "";
    return '<div class="egf-serials">' + units + '</div><div class="egf-serial-add"><input maxlength="120" autocomplete="off" data-ef-serial-input="' + esc(p.id) + '" placeholder="Serial number" aria-label="Serial number for ' + esc(p.name) + '"><button type="button" class="egf-inline" data-ef-action="add-serial" data-id="' + esc(p.id) + '">Add serial</button>' + scanButton + '</div>';
  }

  function renderQuickSale() {
    if (toolMode === "stocking") {
      renderStocking();
      return;
    }
    var demoBanner = isDemo()
      ? '<div class="egf-demo">Demo Mode is on. This sale changes sample data in this browser only and never touches PostgreSQL.</div>'
      : "";
    var total = cartTotal();
    var rows = cart.map(function (line) {
      var p = line.product;
      return '<tr><td><strong>' + esc(p.name) + "</strong><span class=\"egf-sub\">" + esc(p.sku) + (p.barcode ? " \u00b7 " + esc(p.barcode) : "") + "</span></td>" +
        "<td>" + money(p.price) + "</td>" +
        "<td>" + serialCell(line) + "</td>" +
        '<td><strong>' + money(Number(p.price) * Number(line.quantity)) + "</strong></td>" +
        '<td><button type="button" class="egf-x" data-ef-action="remove-line" data-id="' + esc(p.id) + '" aria-label="Remove ' + esc(p.name) + '">\u00d7</button></td></tr>';
    }).join("");
    var cartBlock = cart.length
      ? '<div class="egf-table-wrap"><table class="egf-table"><thead><tr><th>Product</th><th>Price</th><th>Quantity</th><th>Line total</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>"
      : '<div class="egf-empty">Scan a barcode, look up a SKU, or add a product to start the sale.</div>';
    var errorBlock = quickError ? '<div class="egf-error">' + esc(quickError) + (quickCode ? ' <button type="button" class="egf-inline" data-ef-action="add-product-barcode">Add a product with this barcode</button>' : "") + "</div>" : "";
    var scanButton = typeof app.scanBarcode === "function"
      ? '<button type="button" class="btn btn-secondary" data-ef-action="scan">Scan barcode</button>'
      : "";
    var receipt = lastReceipt ? renderReceipt() : "";

    var incomplete = cart.filter(function (line) { return line.product.trackSerials && (line.serials || []).length !== Number(line.quantity); });
    el("egfTitle").textContent = "Sell";
    el("egfSub").textContent = "Scan or look up products, build a cart, and record one sale.";
    el("egfBody").innerHTML = modeSwitcher() + demoBanner +
      '<div class="egf-scanrow">' +
        '<label class="field egf-grow">Barcode or SKU<input id="egfCode" maxlength="100" autocomplete="off" placeholder="Scan or type a barcode / SKU" value="' + esc(quickCode) + '"></label>' +
        '<button type="button" class="btn btn-secondary" data-ef-action="lookup">Look up</button>' +
        scanButton +
        '<button type="button" class="btn btn-secondary" data-ef-action="add-new-barcode" ' + (quickCode ? "" : "disabled") + ">New product</button>" +
      "</div>" +
      errorBlock +
      '<div class="egf-addrow"><label class="field egf-grow">Add from inventory<select id="egfProductSelect">' + productOptions() + "</select></label>" +
        '<button type="button" class="btn btn-primary" data-ef-action="add-selected">Add to cart</button></div>' +
      cartBlock +
      '<div class="egf-checkout">' +
        '<label class="field egf-grow">Customer name (optional)<input id="egfCustomer" maxlength="120" placeholder="Name to award loyalty coins" value="' + esc(quickCustomer) + '"></label>' +
        '<div class="egf-total"><span>Sale total</span><strong>' + money(total) + "</strong></div>" +
      "</div>" +
      (incomplete.length ? '<div class="egf-error">Scan one serial per unit before recording the sale: ' + incomplete.map(function (line) { return esc(line.product.name) + " (" + line.serials.length + "/" + amount(line.quantity) + ")"; }).join(", ") + "</div>" : "") +
      '<div class="egf-actions"><button type="button" class="btn btn-secondary" data-ef-action="close">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-ef-action="record-sale" ' + (cart.length && !incomplete.length && !busy ? "" : "disabled") + ">" + (busy ? "Recording\u2026" : "Record sale") + "</button></div>" +
      receipt;
    var code = el("egfCode");
    if (code) code.focus();
  }

  function renderStocking() {
    var demoBanner = isDemo()
      ? '<div class="egf-demo">Demo Mode is on. Stock receipts change sample inventory in this browser only and never touch PostgreSQL.</div>'
      : "";
    var product = stockingProduct;
    var serialField = product && product.trackSerials
      ? '<label class="field egf-grow">Unit serial numbers (one per line, exactly the received quantity)<textarea id="egfStockSerials" rows="4" placeholder="Enter or scan one serial per unit"></textarea></label>'
      : "";
    var scanButtons = typeof app.scanBarcode === "function"
      ? '<button type="button" class="btn btn-secondary" data-ef-action="stock-scan">Scan product code</button>' + (product && product.trackSerials ? '<button type="button" class="btn btn-secondary" data-ef-action="stock-scan-serial">Scan serial</button>' : "")
      : "";
    var selected = product
      ? '<div class="egf-stock-product"><strong>' + esc(product.name) + '</strong><span class="egf-sub">' + esc(product.sku) + (product.barcode ? " \u00b7 " + esc(product.barcode) : "") + " \u00b7 current " + amount(product.stock) + " " + esc(product.unit) + (product.trackSerials ? " \u00b7 serialized" : "") + '</span></div>'
      : '<div class="egf-empty">Scan a barcode or look up a product to start receiving stock.</div>';
    var errorBlock = stockingError ? '<div class="egf-error">' + esc(stockingError) + "</div>" : "";
    var receipt = stockingResult
      ? '<div class="egf-receipt"><div class="egf-receipt-badge">Stock received</div><h3>' + amount(stockingResult.items.reduce(function (sum, line) { return sum + Number(line.quantity); }, 0)) + ' units</h3><div class="egf-sub">' + esc(stockingResult.receipt.reference || "No supplier reference") + " \u00b7 " + esc(new Date(stockingResult.receipt.createdAt).toLocaleString("en-IN")) + "</div>" +
        stockingResult.items.map(function (line) { return '<div class="egf-receipt-line"><span>' + esc(line.name) + " \u00d7 " + amount(line.quantity) + "</span><strong>" + money(line.unitCost * line.quantity) + "</strong></div>"; }).join("") +
        '<div class="egf-actions"><button type="button" class="btn btn-primary" data-ef-action="stock-again">Receive another delivery</button></div></div>'
      : "";
    el("egfTitle").textContent = "Stocking";
    el("egfSub").textContent = "Receive delivered units with a supplier reference, cost and optional expiry date.";
    el("egfBody").innerHTML = modeSwitcher() + demoBanner +
      '<div class="egf-scanrow"><label class="field egf-grow">Barcode or SKU<input id="egfStockCode" maxlength="100" autocomplete="off" placeholder="Scan or type a product code"></label>' +
        '<button type="button" class="btn btn-secondary" data-ef-action="stock-lookup">Look up</button>' + scanButtons + "</div>" +
      errorBlock + selected +
      '<div class="egf-stockform">' +
        '<label class="field">Quantity received<input id="egfStockQty" type="number" min="0.001" step="0.001" value="1"></label>' +
        '<label class="field">Unit cost<input id="egfStockCost" type="number" min="0" step="0.01" value="' + esc(product ? product.cost : "") + '" placeholder="Optional; keeps current cost"></label>' +
        '<label class="field">Expiry date<input id="egfStockExpiry" type="date" value="' + esc(product ? product.expiry || "" : "") + '"></label>' +
        '<label class="field">Supplier reference<input id="egfStockRef" maxlength="80" placeholder="Invoice / delivery note"></label>' +
        '<label class="field egf-grow">Note<input id="egfStockNote" maxlength="500" placeholder="Optional receiving note"></label>' +
      "</div>" + serialField +
      '<div class="egf-actions"><button type="button" class="btn btn-secondary" data-ef-action="close">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-ef-action="receive-stock" ' + (product && !stockingBusy ? "" : "disabled") + ">" + (stockingBusy ? "Receiving\u2026" : "Receive stock") + "</button></div>" +
      receipt;
    var code = el("egfStockCode");
    if (code && !stockingResult) code.focus();
  }

  function splitSerials(value) {
    return String(value || "").split(/[\r\n,;]+/).map(function (serial) { return serial.trim(); }).filter(Boolean);
  }

  function lookupStockingProduct() {
    var input = el("egfStockCode");
    var code = String(input ? input.value : "").trim();
    if (!code) {
      stockingError = "Scan or type a barcode or SKU first.";
      renderStocking();
      return;
    }
    stockingError = "";
    lookupProduct(code).then(function (product) {
      stockingProduct = product;
    }).catch(function (error) {
      stockingError = error.message || "No product matches that code.";
    }).finally(function () {
      renderStocking();
    });
  }

  function receiveStock() {
    if (!stockingProduct || stockingBusy) return;
    var quantity = Number((el("egfStockQty") || {}).value);
    var costValue = (el("egfStockCost") || {}).value;
    var expiry = (el("egfStockExpiry") || {}).value || null;
    var reference = (el("egfStockRef") || {}).value || "";
    var note = (el("egfStockNote") || {}).value || "";
    var serials = stockingProduct.trackSerials ? splitSerials((el("egfStockSerials") || {}).value) : [];
    if (!Number.isFinite(quantity) || quantity <= 0) {
      stockingError = "Enter a positive quantity received.";
      renderStocking();
      return;
    }
    if (stockingProduct.trackSerials && serials.length !== quantity) {
      stockingError = "Enter exactly " + quantity + " serial number" + (quantity === 1 ? "" : "s") + " for " + stockingProduct.name + ".";
      renderStocking();
      return;
    }
    stockingBusy = true;
    stockingError = "";
    if (!stockKey) stockKey = "stock-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    renderStocking();
    var body = {
      reference: String(reference).trim(),
      note: String(note).trim(),
      idempotencyKey: stockKey,
      items: [{
        productId: stockingProduct.id,
        quantity: quantity,
        unitCost: costValue === "" ? undefined : Number(costValue),
        expiry: expiry || undefined,
        serials: serials
      }]
    };
    request("/stock/receipts", { method: "POST", headers: { "Idempotency-Key": stockKey }, body: body }).then(function (result) {
      var receivedName = stockingProduct ? stockingProduct.name : "Stock";
      stockingResult = result;
      stockingProduct = null;
      stockingError = "";
      stockKey = "";
      notify("Received " + quantity + " unit" + (quantity === 1 ? "" : "s") + " of " + receivedName + ". Stock and movement were recorded.");
      if (app.refresh) app.refresh();
    }).catch(function (error) {
      stockingError = error.message || "Could not record the stock receipt.";
      notify(stockingError);
    }).finally(function () {
      stockingBusy = false;
      renderStocking();
    });
  }

  function receiptText(receipt) {
    if (!receipt) return "";
    var shop = (app.state.user && app.state.user.shopName) || "Easy Gateway";
    var lines = ["Easy Gateway receipt", shop, ""];
    receipt.lines.forEach(function (line) {
      lines.push(line.name + " x " + amount(line.quantity) + "  " + money(line.total));
    });
    lines.push("");
    lines.push("Total: " + money(receipt.total));
    lines.push("Customer: " + receipt.customer);
    if (receipt.coinsEarned) lines.push("Loyalty coins awarded: " + amount(receipt.coinsEarned));
    lines.push("Receipt: " + String(receipt.groupId || receipt.id || "").slice(0, 12));
    lines.push(new Date(receipt.time).toLocaleString("en-IN"));
    lines.push("");
    lines.push("Stock was updated on the shop server. No card or cash payment was collected by Easy Gateway.");
    return lines.join("\n");
  }

  function renderReceipt() {
    var receipt = lastReceipt;
    var lines = receipt.lines.map(function (line) {
      return '<div class="egf-receipt-line"><span>' + esc(line.name) + " \u00d7 " + amount(line.quantity) + "</span><strong>" + money(line.total) + "</strong></div>";
    }).join("");
    return '<div class="egf-receipt"><div class="egf-receipt-badge">Sale recorded</div><h3>' + money(receipt.total) + "</h3>" +
      '<div class="egf-sub">Receipt ' + esc(String(receipt.groupId || receipt.id || "").slice(0, 12)) + " \u00b7 " + esc(new Date(receipt.time).toLocaleString("en-IN")) + "</div>" +
      lines +
      (receipt.coinsEarned ? '<div class="egf-coins">+' + amount(receipt.coinsEarned) + " loyalty coin" + (Number(receipt.coinsEarned) === 1 ? "" : "s") + " for " + esc(receipt.customer) + "</div>" : "") +
      '<div class="egf-actions"><button type="button" class="btn btn-secondary" data-ef-action="share-receipt">Share receipt</button><button type="button" class="btn btn-primary" data-ef-action="new-sale">New sale</button></div></div>';
  }

  function renderActionCenter() {
    el("egfTitle").textContent = "Stock action center";
    el("egfSub").textContent = "What needs attention now: stockouts, expiries, slow movers and cash tied up.";
    if (actionLoading) {
      el("egfBody").innerHTML = '<div class="egf-empty">Checking stock, sales and expiry dates\u2026</div>';
      return;
    }
    if (!actionState) {
      el("egfBody").innerHTML = '<div class="egf-error">Could not load the action center.</div><div class="egf-actions"><button type="button" class="btn btn-primary" data-ef-action="refresh-actions">Try again</button></div>';
      return;
    }
    var summary = actionState.summary || {};
    var actions = actionState.actions || [];
    var banner = isDemo() ? '<div class="egf-demo">Demo Mode: sample stock and sales are analysed locally. Nothing is written to the live shop.</div>' : "";
    var stats = '<div class="egf-stats">' +
      '<div class="egf-stat"><span>Actions</span><strong>' + amount(summary.total) + "</strong><small>Products to review</small></div>" +
      '<div class="egf-stat"><span>Out of stock</span><strong>' + amount(summary.outOfStock) + "</strong><small>Cannot be sold</small></div>" +
      '<div class="egf-stat"><span>Low stock</span><strong>' + amount(summary.lowStock) + "</strong><small>At reorder level</small></div>" +
      '<div class="egf-stat"><span>Expiring</span><strong>' + amount(summary.expiring) + "</strong><small>Within 7 days</small></div>" +
      '<div class="egf-stat"><span>Cash tied up</span><strong>' + money(summary.cashTiedUp) + "</strong><small>Slow / overstock at cost</small></div>" +
      "</div>";
    if (!actions.length) {
      el("egfBody").innerHTML = banner + stats + '<div class="egf-empty">No stock actions right now. Inventory, expiry dates and recent sales look healthy.</div>' +
        '<div class="egf-actions"><button type="button" class="btn btn-secondary" data-ef-action="refresh-actions">Refresh</button></div>';
      return;
    }
    var rows = actions.map(function (action) {
      var typeLabel = action.type === "out_of_stock" ? "Out of stock" : action.type === "low_stock" ? "Low stock" : action.type === "expiring_urgent" ? "Expiry risk" : action.type === "expiring" ? "Expiring" : action.type === "slow_mover" ? "Slow mover" : "Overstock";
      var tone = action.type === "out_of_stock" || action.type === "expiring_urgent" ? " danger" : action.type === "low_stock" || action.type === "expiring" ? " warn" : "";
      return '<div class="egf-action-row"><div class="egf-action-main"><span class="egf-pill' + tone + '">' + typeLabel + "</span><strong>" + esc(action.name) + '</strong><span class="egf-sub">' + esc(action.title) + " \u00b7 " + esc(action.detail) + "</span></div>" +
        '<div class="egf-action-buttons">' +
          (Number(action.stock) > 0 ? '<button type="button" class="btn btn-secondary" data-ef-action="sell" data-id="' + esc(action.productId) + '">Sell</button>' : "") +
          '<button type="button" class="btn btn-secondary" data-ef-action="reorder" data-id="' + esc(action.productId) + '">Plan restock</button>' +
        "</div></div>";
    }).join("");
    el("egfBody").innerHTML = banner + stats + '<div class="egf-action-list">' + rows + "</div>" +
      '<div class="egf-actions"><button type="button" class="btn btn-secondary" data-ef-action="refresh-actions">Refresh</button><button type="button" class="btn btn-primary" data-ef-action="close">Done</button></div>';
  }

  function renderSummary() {
    el("egfTitle").textContent = "Daily business summary";
    el("egfSub").textContent = "A shareable snapshot of sales, customers and stock watch for one day.";
    var date = summaryDate || today();
    var picker = '<div class="egf-scanrow"><label class="field egf-grow">Summary date<input type="date" id="egfSummaryDate" value="' + esc(date) + '"></label><button type="button" class="btn btn-secondary" data-ef-action="apply-summary">Apply</button><button type="button" class="btn btn-secondary" data-ef-action="refresh-summary">Refresh</button></div>';
    var banner = isDemo() ? '<div class="egf-demo">Demo Mode: this summary is calculated from sample data in this browser only.</div>' : "";
    if (summaryLoading) {
      el("egfBody").innerHTML = banner + picker + '<div class="egf-empty">Building the summary\u2026</div>';
      return;
    }
    if (summaryError || !summaryState) {
      el("egfBody").innerHTML = banner + picker + '<div class="egf-error">' + esc(summaryError || "Could not load the daily summary.") + "</div>";
      return;
    }
    var summary = summaryState.summary || summaryState;
    var top = summary.topProducts || [];
    var topRows = top.map(function (item) {
      return '<div class="egf-receipt-line"><span>' + esc(item.name) + "</span><strong>" + amount(item.quantity) + " sold \u00b7 " + money(item.revenue) + "</strong></div>";
    }).join("") || '<div class="egf-empty">No products were sold on this date.</div>';
    var shareText = summary.shareText || summaryState.shareText || core.buildSummaryText(summary);
    el("egfBody").innerHTML = banner + picker +
      '<div class="egf-stats"><div class="egf-stat"><span>Revenue</span><strong>' + money(summary.revenue) + "</strong><small>" + esc(summary.date) + "</small></div>" +
      '<div class="egf-stat"><span>Orders</span><strong>' + amount(summary.orders) + "</strong><small>Distinct sale groups</small></div>" +
      '<div class="egf-stat"><span>Items sold</span><strong>' + amount(summary.itemsSold) + "</strong><small>Total quantity</small></div>" +
      '<div class="egf-stat"><span>Average order</span><strong>' + money(summary.averageOrder) + "</strong><small>Revenue / orders</small></div>" +
      '<div class="egf-stat"><span>Loyalty coins</span><strong>' + amount(summary.coinsAwarded) + "</strong><small>Awarded to named customers</small></div>" +
      '<div class="egf-stat"><span>New customers</span><strong>' + amount(summary.newCustomers) + "</strong><small>First purchase on this date</small></div></div>" +
      '<div class="egf-two"><section><h3>Top products</h3>' + topRows + "</section><section><h3>Stock watch</h3>" +
        '<div class="egf-receipt-line"><span>Low stock</span><strong>' + amount(summary.lowStockCount) + " products</strong></div>" +
        '<div class="egf-receipt-line"><span>Expiring within 7 days</span><strong>' + amount(summary.expiringSoonCount) + " products</strong></div>" +
        '<div class="egf-share"><label class="field">Shareable text<textarea id="egfSummaryText" rows="9" readonly>' + esc(shareText) + "</textarea></label></div></section></div>" +
      '<div class="egf-actions"><button type="button" class="btn btn-secondary" data-ef-action="copy-summary">Copy text</button><button type="button" class="btn btn-primary" data-ef-action="share-summary">Share summary</button></div>';
  }

  function openFeature(name) {
    if (!overlay) return;
    if (!app.state || !app.state.user) {
      notify("Sign in to use shop tools.");
      return;
    }
    var nowDemo = isDemo();
    if (lastDemoState !== null && lastDemoState !== nowDemo) {
      cart = [];
      quickCustomer = "";
      quickCode = "";
      quickError = "";
      lastReceipt = null;
      stockingProduct = null;
      stockingResult = null;
      stockingError = "";
      saleKey = "";
      stockKey = "";
    }
    lastDemoState = nowDemo;
    if (name === "stocking") {
      toolMode = "stocking";
      name = "quick-sale";
    } else if (name === "quick-sale") {
      toolMode = "sell";
    }
    mode = name;
    overlay.hidden = false;
    document.body.classList.add("egf-open");
    if (name === "quick-sale") {
      quickError = "";
      renderQuickSale();
    } else if (name === "action-center") {
      actionState = null;
      renderActionCenter();
      loadActions();
    } else if (name === "daily-summary") {
      summaryDate = summaryDate || today();
      summaryState = null;
      summaryError = "";
      renderSummary();
      loadSummary();
    }
  }

  function closeFeature() {
    if (!overlay) return;
    overlay.hidden = true;
    document.body.classList.remove("egf-open");
    mode = "";
  }

  function loadActions() {
    actionLoading = true;
    actionState = null;
    if (mode === "action-center") renderActionCenter();
    request("/action-center").then(function (result) {
      actionState = result;
    }).catch(function (error) {
      notify(error.message || "Could not load the stock action center.");
      actionState = null;
    }).finally(function () {
      actionLoading = false;
      if (mode === "action-center") renderActionCenter();
    });
  }

  function loadSummary() {
    summaryLoading = true;
    summaryError = "";
    summaryState = null;
    if (mode === "daily-summary") renderSummary();
    var day = summaryDate || today();
    request("/daily-summary?date=" + encodeURIComponent(day)).then(function (result) {
      summaryState = result;
    }).catch(function (error) {
      summaryError = error.message || "Could not load the daily summary.";
    }).finally(function () {
      summaryLoading = false;
      if (mode === "daily-summary") renderSummary();
    });
  }

  function doLookup() {
    var code = String(quickCode || "").trim();
    if (!code) {
      quickError = "Scan or type a barcode or SKU first.";
      renderQuickSale();
      return;
    }
    quickError = "";
    renderQuickSale();
    lookupUnit(code).then(function (found) {
      var product = found.product;
      if (product.trackSerials) {
        if (found.serialUnit) {
          if (addSerializedUnit(product, found.serialUnit)) {
            quickCode = "";
            quickError = "";
            notify(product.name + " serial " + found.serialUnit + " added to the sale.");
          }
        } else {
          addToCart(product, 0);
          quickError = product.name + " tracks serial numbers. Scan or type each unit serial in the cart.";
        }
      } else if (!addToCart(product, 1)) {
        quickError = "Only " + amount(product.stock) + " " + (product.unit || "unit") + " remain.";
      } else {
        quickCode = "";
        quickError = "";
        notify(product.name + " added to the cart.");
      }
      renderQuickSale();
    }).catch(function (error) {
      // A serial scanned without a matching product may still belong to a
      // serialized line already in the cart.
      if (toolMode === "sell" && cart.some(function (line) { return line.product.trackSerials; })) {
        var target = serialTargetId ? findCartLine(serialTargetId) : (cart.filter(function (line) { return line.product.trackSerials; }).length === 1 ? cart.filter(function (line) { return line.product.trackSerials; })[0] : null);
        if (target && addSerializedUnit(target.product, code)) {
          quickCode = "";
          quickError = "";
          serialTargetId = "";
          notify("Serial " + code + " added to " + target.product.name + ".");
          renderQuickSale();
          return;
        }
      }
      quickError = error.message || "No product matches that code.";
      renderQuickSale();
    });
  }

  function addSelected() {
    var select = el("egfProductSelect");
    if (!select || !select.value) {
      notify("There are no in-stock products to add.");
      return;
    }
    var product = (app.state.products || []).find(function (p) { return p.id === select.value; });
    if (!product) return;
    if (addToCart(product, 1)) notify(product.name + " added to the cart.");
    quickError = "";
    renderQuickSale();
  }

  function recordSale() {
    if (!cart.length || busy) return;
    var incomplete = cart.filter(function (line) { return line.product.trackSerials && (line.serials || []).length !== Number(line.quantity); });
    if (incomplete.length) {
      notify("Scan one serial per unit before recording the sale.");
      return;
    }
    busy = true;
    if (!saleKey) saleKey = "sale-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    renderQuickSale();
    var lines = cart.map(function (line) {
      return { productId: line.product.id, quantity: Number(line.quantity), serials: (line.serials || []).slice() };
    });
    var snapshot = cart.map(function (line) {
      return { name: line.product.name, quantity: Number(line.quantity), total: Math.round(Number(line.product.price) * Number(line.quantity) * 100) / 100 };
    });
    request("/sales", { method: "POST", headers: { "Idempotency-Key": saleKey }, body: { items: lines, customerName: String(quickCustomer || "").trim(), idempotencyKey: saleKey } }).then(function (result) {
      lastReceipt = {
        id: result.sale && result.sale.id,
        groupId: result.groupId || (result.sale && result.sale.groupId),
        total: result.total,
        customer: result.customer || "Walk-in customer",
        coinsEarned: result.coinsEarned || 0,
        time: new Date().toISOString(),
        lines: snapshot
      };
      cart = [];
      quickCustomer = "";
      quickCode = "";
      quickError = "";
      saleKey = "";
      notify(result.coinsEarned > 0 ? "Sale recorded. " + result.coinsEarned + " loyalty coin(s) awarded." : "Sale recorded and stock updated.");
      if (app.refresh) app.refresh();
    }).catch(function (error) {
      quickError = error.message || "Could not record the sale.";
      notify(quickError);
    }).finally(function () {
      busy = false;
      renderQuickSale();
    });
  }

  function sellProduct(productId) {
    var product = (app.state.products || []).find(function (p) { return p.id === productId; });
    if (!product) {
      notify("That product is no longer in active inventory.");
      return;
    }
    openFeature("quick-sale");
    cart = [];
    addToCart(product, 1);
    renderQuickSale();
  }

  function shareText(text, title) {
    if (typeof app.nativeShare !== "undefined" && app.nativeShare && app.nativeShare.share) {
      return app.nativeShare.share({ title: title, text: text, dialogTitle: title }).catch(function (error) {
        if (!/cancel/i.test(String(error && error.message || ""))) notify("Could not open the share sheet.");
      });
    }
    if (navigator.share) {
      return navigator.share({ title: title, text: text }).catch(function (error) {
        if (!/cancel|abort/i.test(String(error && error.message || ""))) notify("Could not open the share sheet.");
      });
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () {
        notify("Text copied to the clipboard.");
      }).catch(function () {
        notify("Copy the summary text from the box instead.");
      });
    }
    notify("Sharing is not available in this browser.");
    return Promise.resolve();
  }

  function copySummary() {
    var box = el("egfSummaryText");
    if (!box) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(box.value).then(function () { notify("Summary copied."); }).catch(function () { box.select(); notify("Press Ctrl+C to copy the selected summary."); });
    } else {
      box.select();
      notify("Press Ctrl+C to copy the selected summary.");
    }
  }

  function handleAction(button) {
    var action = button.dataset.efAction;
    if (action === "close") { closeFeature(); return; }
    if (action === "mode-sell") { toolMode = "sell"; stockingError = ""; renderQuickSale(); return; }
    if (action === "mode-stocking") { toolMode = "stocking"; stockingError = ""; stockingResult = null; renderStocking(); return; }
    if (action === "lookup") { doLookup(); return; }
    if (action === "add-serial") {
      var serialLine = findCartLine(button.dataset.id);
      var serialInputs = Array.prototype.slice.call(document.querySelectorAll("[data-ef-serial-input]"));
      var serialInput = serialInputs.filter(function (input) { return input.getAttribute("data-ef-serial-input") === button.dataset.id; })[0];
      if (!serialLine || !serialInput) return;
      if (addSerializedUnit(serialLine.product, serialInput.value)) {
        serialInput.value = "";
        notify("Serial added to " + serialLine.product.name + ".");
      }
      renderQuickSale();
      return;
    }
    if (action === "remove-serial") {
      var unitLine = findCartLine(button.dataset.id);
      if (!unitLine) return;
      var normalizedSerial = core.normalizeCode(button.dataset.serial);
      unitLine.serials = (unitLine.serials || []).filter(function (serial) { return core.normalizeCode(serial) !== normalizedSerial; });
      unitLine.quantity = unitLine.serials.length;
      renderQuickSale();
      return;
    }
    if (action === "scan-serial") {
      serialTargetId = button.dataset.id;
      if (typeof app.scanBarcode === "function") app.scanBarcode();
      else notify("Camera scanning is not available here. Type the serial number instead.");
      return;
    }
    if (action === "stock-lookup") { lookupStockingProduct(); return; }
    if (action === "stock-scan") {
      stockScanTarget = "code";
      if (typeof app.scanBarcode === "function") app.scanBarcode();
      else notify("Camera scanning is not available here. Type the product code instead.");
      return;
    }
    if (action === "stock-scan-serial") {
      stockScanTarget = "serial";
      if (typeof app.scanBarcode === "function") app.scanBarcode();
      else notify("Camera scanning is not available here. Type the serial numbers instead.");
      return;
    }
    if (action === "receive-stock") { receiveStock(); return; }
    if (action === "stock-again") { stockingResult = null; stockingProduct = null; stockingError = ""; renderStocking(); return; }
    if (action === "scan") { if (typeof app.scanBarcode === "function") app.scanBarcode(); return; }
    if (action === "add-selected") { addSelected(); return; }
    if (action === "add-new-barcode") {
      var code = String(quickCode || "").trim();
      closeFeature();
      if (typeof app.openProductModalWithBarcode === "function") app.openProductModalWithBarcode(code);
      return;
    }
    if (action === "add-product-barcode") {
      var value = String(quickCode || "").trim();
      closeFeature();
      if (typeof app.openProductModalWithBarcode === "function") app.openProductModalWithBarcode(value);
      return;
    }
    if (action === "qty-inc" || action === "qty-dec") {
      var id = button.dataset.id;
      var line = cart.find(function (item) { return item.product.id === id; });
      if (!line) return;
      var delta = action === "qty-inc" ? 1 : -1;
      var next = Math.round((Number(line.quantity) + delta) * 1000) / 1000;
      if (next <= 0) cart = cart.filter(function (item) { return item.product.id !== id; });
      else if (next > Number(line.product.stock)) notify("Only " + amount(line.product.stock) + " " + (line.product.unit || "unit") + " remain.");
      else line.quantity = next;
      renderQuickSale();
      return;
    }
    if (action === "remove-line") {
      var removeId = button.dataset.id;
      cart = cart.filter(function (item) { return item.product.id !== removeId; });
      renderQuickSale();
      return;
    }
    if (action === "record-sale") { recordSale(); return; }
    if (action === "new-sale") { lastReceipt = null; cart = []; quickCustomer = ""; quickCode = ""; quickError = ""; renderQuickSale(); return; }
    if (action === "share-receipt") { shareText(receiptText(lastReceipt), "Easy Gateway receipt"); return; }
    if (action === "refresh-actions") { loadActions(); return; }
    if (action === "sell") { sellProduct(button.dataset.id); return; }
    if (action === "reorder") {
      closeFeature();
      if (app.navigate) app.navigate("purchasing");
      return;
    }
    if (action === "apply-summary") {
      var picker = el("egfSummaryDate");
      summaryDate = picker && picker.value ? picker.value : today();
      loadSummary();
      return;
    }
    if (action === "refresh-summary") { loadSummary(); return; }
    if (action === "share-summary") {
      var summaryText = summaryState && (summaryState.shareText || (summaryState.summary && summaryState.summary.shareText));
      if (!summaryText) {
        var textBox = el("egfSummaryText");
        summaryText = textBox ? textBox.value : "";
      }
      shareText(summaryText, "Easy Gateway daily summary");
      return;
    }
    if (action === "copy-summary") { copySummary(); return; }
  }

  function injectChrome() {
    var nav = document.querySelector(".sidebar nav");
    if (nav && !el("egfNavQuick")) {
      nav.insertAdjacentHTML("beforeend",
        '<div class="nav-label">SHOP TOOLS</div>' +
        '<button type="button" class="nav-item" id="egfNavQuick" data-feature="quick-sale"><span class="nav-icon">S</span>Sell</button>' +
        '<button type="button" class="nav-item" id="egfNavStock" data-feature="stocking"><span class="nav-icon">+</span>Stocking</button>' +
        '<button type="button" class="nav-item" data-feature="action-center"><span class="nav-icon">!</span>Stock action center</button>' +
        '<button type="button" class="nav-item" data-feature="daily-summary"><span class="nav-icon">D</span>Daily summary</button>');
    }
    var tabbar = document.querySelector(".mobile-tabbar");
    if (tabbar && !el("egfTabQuick")) {
      tabbar.insertAdjacentHTML("afterbegin",
        '<button type="button" id="egfTabQuick" data-feature="quick-sale" aria-label="Quick sale"><svg viewBox="0 0 24 24"><path d="M4 5h2l2.2 10.5h9.6L20 8H7"/><circle cx="9.5" cy="19" r="1.3"/><circle cx="17.5" cy="19" r="1.3"/></svg><span>Sell</span></button>');
    }
    var content = el("content");
    if (content && content.querySelector(".heading") && !el("egfLaunchbar")) {
      var heading = content.querySelector(".heading");
      if (heading) {
        heading.insertAdjacentHTML("afterend",
          '<div class="egf-launchbar" id="egfLaunchbar">' +
          '<button type="button" class="egf-chip egf-chip-main" data-feature="quick-sale"><strong>Sell</strong><span>Scan, cart and receipt</span></button>' +
          '<button type="button" class="egf-chip" data-feature="stocking"><strong>Stocking</strong><span>Receive deliveries and serials</span></button>' +
          '<button type="button" class="egf-chip" data-feature="action-center"><strong>Stock action center</strong><span>Stockouts, expiries, slow movers</span></button>' +
          '<button type="button" class="egf-chip" data-feature="daily-summary"><strong>Daily summary</strong><span>Share today\'s numbers</span></button>' +
          "</div>");
      }
    }
  }

  function buildOverlay() {
    overlay = document.createElement("div");
    overlay.className = "egf-overlay";
    overlay.id = "egfOverlay";
    overlay.hidden = true;
    overlay.innerHTML = '<section class="egf-sheet" role="dialog" aria-modal="true" aria-labelledby="egfTitle"><header class="egf-head"><div><div class="eyebrow">SHOP TOOL</div><h2 id="egfTitle">Shop tool</h2><p id="egfSub"></p></div><button type="button" class="icon-btn" data-ef-action="close" aria-label="Close">\u00d7</button></header><div class="egf-body" id="egfBody"></div></section>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) closeFeature();
    });
  }

  function buildStyles() {
    var style = document.createElement("style");
    style.id = "egfStyles";
    style.textContent =
      ".egf-open{overflow:hidden}" +
      ".egf-overlay{position:fixed;inset:0;z-index:70;background:rgba(22,34,24,.5);display:flex;align-items:center;justify-content:center;padding:18px}" +
      ".egf-overlay[hidden]{display:none}" +
      ".egf-sheet{width:min(920px,100%);max-height:calc(100vh - 36px);overflow:auto;background:#fff;border-radius:14px;box-shadow:0 25px 80px rgba(0,0,0,.25);padding:22px}" +
      ".egf-head{display:flex;justify-content:space-between;gap:15px;margin-bottom:16px}" +
      ".egf-head h2{font-size:22px;margin:0;letter-spacing:-.6px;color:#202d22}" +
      ".egf-head p{font-size:11px;color:#899286;margin:6px 0 0}" +
      ".egf-body{font-size:12px;color:#354236}" +
      ".egf-demo{padding:10px 12px;border:1px solid #f0e4bf;background:#fff6df;color:#8e6c21;border-radius:8px;font-size:10px;margin-bottom:14px}" +
      ".egf-modes{display:inline-flex;background:#eef2ea;border:1px solid #dfe7da;border-radius:9px;padding:3px;margin-bottom:14px;gap:3px}" +
      ".egf-modes button{border:0;background:transparent;color:#5b6858;font:inherit;font-size:11px;font-weight:750;padding:8px 20px;border-radius:7px}" +
      ".egf-modes button.active{background:#203a29;color:#fff;box-shadow:0 3px 9px rgba(32,58,41,.2)}" +
      ".egf-serials{display:flex;flex-wrap:wrap;gap:4px;max-width:260px}" +
      ".egf-serial-chip{display:inline-flex;align-items:center;gap:3px;background:#edf4e9;color:#3f6c41;border-radius:5px;padding:3px 5px;font-size:9px;font-weight:700}" +
      ".egf-serial-chip button{border:0;background:transparent;color:#a5483b;font-size:12px;line-height:1;padding:0 1px}" +
      ".egf-serial-add{display:flex;align-items:center;gap:5px;margin-top:6px;flex-wrap:wrap}" +
      ".egf-serial-add input{width:130px;border:1px solid #dfe4da;border-radius:5px;padding:4px 6px;font:inherit;font-size:10px}" +
      ".egf-stockform{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-bottom:12px}" +
      ".egf-stock-product{border:1px solid #dfe8d9;background:#f7faf4;border-radius:9px;padding:11px 13px;margin-bottom:12px}" +
      ".egf-stock-product strong{font-size:13px}" +
      ".egf-scanrow,.egf-addrow,.egf-checkout{display:flex;gap:9px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px}" +
      ".egf-grow{flex:1;min-width:180px;margin:0}" +
      ".egf-addrow .btn,.egf-scanrow .btn{height:36px}" +
      ".egf-error{padding:10px 12px;border:1px solid #efd0ca;background:#fff2ef;color:#a5483b;border-radius:8px;font-size:10px;margin-bottom:12px}" +
      ".egf-inline{border:0;background:none;color:#a5483b;font-weight:800;text-decoration:underline;font-size:10px;padding:0 0 0 4px}" +
      ".egf-table-wrap{overflow:auto;border:1px solid #e7eae3;border-radius:9px;margin-bottom:13px}" +
      ".egf-table{width:100%;border-collapse:collapse;white-space:nowrap}" +
      ".egf-table th{text-align:left;background:#fafbf9;padding:9px 11px;color:#8c9588;text-transform:uppercase;letter-spacing:.7px;font-size:8px;border-bottom:1px solid #eff1ec}" +
      ".egf-table td{padding:10px 11px;font-size:11px;border-bottom:1px solid #f0f2ee;color:#5b6658}" +
      ".egf-table tr:last-child td{border-bottom:0}" +
      ".egf-sub{display:block;font-size:9px;color:#9aa195;margin-top:3px}" +
      ".egf-qty{display:flex;align-items:center;gap:4px}" +
      ".egf-qty button{width:26px;height:26px;border:1px solid #dfe4da;background:#fff;border-radius:6px;font-size:14px;line-height:1;color:#465345}" +
      ".egf-qty input{width:64px;border:1px solid #dfe4da;border-radius:6px;padding:5px 6px;font-size:11px;text-align:center}" +
      ".egf-x{border:0;background:transparent;color:#a5483b;font-size:18px;line-height:1;padding:2px 6px}" +
      ".egf-empty{padding:26px;text-align:center;color:#90998d;font-size:11px;border:1px dashed #d8e1d3;background:#f8faf6;border-radius:9px;margin-bottom:13px}" +
      ".egf-total{display:flex;flex-direction:column;gap:2px;align-items:flex-end;padding:0 4px 6px}" +
      ".egf-total span{font-size:9px;color:#8a9387;text-transform:uppercase;letter-spacing:.7px;font-weight:800}" +
      ".egf-total strong{font-size:24px;letter-spacing:-.7px}" +
      ".egf-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:14px}" +
      ".egf-receipt{margin-top:16px;border:1px solid #d9e8d3;background:#f4f9f1;border-radius:10px;padding:16px}" +
      ".egf-receipt-badge{display:inline-block;font-size:8px;font-weight:800;padding:5px 7px;border-radius:5px;background:#e1efda;color:#3f6c41;margin-bottom:8px;text-transform:uppercase;letter-spacing:.7px}" +
      ".egf-receipt h3{font-size:26px;margin:0 0 4px;letter-spacing:-.8px}" +
      ".egf-receipt-line{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #e4eddf;font-size:11px}" +
      ".egf-receipt-line:last-child{border-bottom:0}" +
      ".egf-coins{margin-top:10px;padding:9px 11px;border-radius:7px;background:#fff6df;color:#8e6c21;font-size:10px;font-weight:700}" +
      ".egf-stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;margin-bottom:15px}" +
      ".egf-stat{border:1px solid #e7eae3;border-radius:9px;padding:11px 12px;background:#fbfcfa;min-width:0}" +
      ".egf-stat span{display:block;font-size:8px;color:#8a9387;text-transform:uppercase;letter-spacing:.7px;font-weight:800}" +
      ".egf-stat strong{display:block;font-size:18px;letter-spacing:-.5px;margin:5px 0 2px;overflow-wrap:anywhere}" +
      ".egf-stat small{font-size:9px;color:#9aa295}" +
      ".egf-action-list{border:1px solid #e7eae3;border-radius:9px;overflow:hidden}" +
      ".egf-action-row{display:flex;gap:12px;align-items:center;padding:12px 13px;border-bottom:1px solid #f0f2ed}" +
      ".egf-action-row:last-child{border-bottom:0}" +
      ".egf-action-main{flex:1;min-width:0}" +
      ".egf-action-main strong{display:block;font-size:12px;margin:5px 0 2px}" +
      ".egf-action-buttons{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}" +
      ".egf-pill{display:inline-block;font-size:8px;font-weight:800;padding:4px 6px;border-radius:5px;background:#edf4e9;color:#4c7749;text-transform:uppercase;letter-spacing:.6px}" +
      ".egf-pill.warn{background:#fff4df;color:#91671f}" +
      ".egf-pill.danger{background:#fff0ed;color:#a5483b}" +
      ".egf-two{display:grid;grid-template-columns:1fr 1fr;gap:16px}" +
      ".egf-two h3{font-size:13px;margin:0 0 8px}" +
      ".egf-two section{border:1px solid #e7eae3;border-radius:9px;padding:13px}" +
      ".egf-share{margin-top:12px}" +
      ".egf-share textarea{width:100%;border:1px solid #dfe4da;border-radius:7px;padding:9px;font:inherit;font-size:10px;line-height:1.55;color:#556052;resize:vertical}" +
      ".egf-launchbar{display:flex;gap:9px;flex-wrap:wrap;margin-bottom:16px}" +
      ".egf-chip{flex:1;min-width:170px;text-align:left;border:1px solid #e1e7dc;background:#fff;border-radius:10px;padding:11px 13px;display:flex;flex-direction:column;gap:2px;box-shadow:0 4px 14px rgba(27,43,28,.04)}" +
      ".egf-chip:hover{border-color:#bcd3b3;background:#f8fbf5}" +
      ".egf-chip strong{font-size:11px;color:#315d3d}" +
      ".egf-chip span{font-size:9px;color:#8b9487}" +
      ".egf-chip-main{background:#203a29;border-color:#203a29}" +
      ".egf-chip-main strong{color:#fff}" +
      ".egf-chip-main span{color:#b9cbb8}" +
      ".egf-chip-main:hover{background:#2a4933;border-color:#2a4933}" +
      "@media(max-width:760px){.egf-overlay{padding:0}.egf-sheet{width:100%;max-height:100vh;min-height:100vh;border-radius:0;padding:16px}.egf-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.egf-two{grid-template-columns:1fr}.egf-stockform{grid-template-columns:1fr}.egf-modes{display:flex}.egf-modes button{flex:1}.egf-scanrow,.egf-addrow,.egf-checkout{align-items:stretch}.egf-scanrow .btn,.egf-addrow .btn{width:100%}.egf-total{align-items:flex-start;padding-top:4px}.egf-action-row{align-items:flex-start;flex-direction:column}.egf-action-buttons{width:100%;justify-content:stretch}.egf-action-buttons .btn{flex:1}.egf-launchbar{gap:6px}.egf-chip{min-width:0;flex:1 1 100%}" +
      ".mobile-tabbar{grid-template-columns:repeat(6,minmax(0,1fr))!important}";
    document.head.appendChild(style);
  }

  function wireEvents() {
    document.addEventListener("click", function (event) {
      var feature = event.target.closest("[data-feature]");
      if (feature) {
        event.preventDefault();
        openFeature(feature.dataset.feature);
        return;
      }
      var action = event.target.closest("[data-ef-action]");
      if (action) {
        event.preventDefault();
        handleAction(action);
      }
    }, true);

    document.addEventListener("input", function (event) {
      if (event.target.id === "egfCode") quickCode = event.target.value;
      if (event.target.id === "egfCustomer") quickCustomer = event.target.value;
    });

    document.addEventListener("change", function (event) {
      if (event.target.matches("[data-ef-qty]")) {
        var id = event.target.getAttribute("data-ef-qty");
        var line = cart.find(function (item) { return item.product.id === id; });
        if (!line) return;
        var value = Number(event.target.value);
        if (!Number.isFinite(value) || value <= 0) cart = cart.filter(function (item) { return item.product.id !== id; });
        else if (value > Number(line.product.stock)) {
          notify("Only " + amount(line.product.stock) + " " + (line.product.unit || "unit") + " remain.");
          event.target.value = line.quantity;
          return;
        } else line.quantity = Math.round(value * 1000) / 1000;
        renderQuickSale();
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && overlay && !overlay.hidden) closeFeature();
      if (event.key === "Enter" && overlay && !overlay.hidden && event.target.id === "egfCode") {
        event.preventDefault();
        doLookup();
      }
    });
  }

  function start() {
    if (!el("egfOverlay")) {
      buildStyles();
      buildOverlay();
      wireEvents();
    }
    injectChrome();
    var content = el("content");
    if (content && window.MutationObserver) {
      var scheduled = false;
      new MutationObserver(function () {
        if (scheduled) return;
        scheduled = true;
        window.setTimeout(function () {
          scheduled = false;
          injectChrome();
        }, 0);
      }).observe(content, { childList: true });
    }
    window.EGFeatures = {
      open: openFeature,
      close: closeFeature,
      handleScannedCode: function (raw) {
        var code = String(raw || "").trim();
        if (!code) return false;
        if (mode === "quick-sale" && overlay && !overlay.hidden && toolMode === "stocking") {
          if (stockScanTarget === "serial" && stockingProduct && stockingProduct.trackSerials) {
            var box = el("egfStockSerials");
            if (box) box.value = (box.value ? box.value.replace(/\s+$/, "") + "\n" : "") + code;
            stockScanTarget = "";
            notify("Serial " + code + " added to the receipt.");
            return true;
          }
          stockScanTarget = "";
          stockingError = "";
          lookupProduct(code).then(function (product) {
            stockingProduct = product;
          }).catch(function (error) {
            stockingError = error.message || "No product matches that code.";
          }).finally(function () {
            if (mode === "quick-sale" && toolMode === "stocking") renderStocking();
          });
          return true;
        }
        if (mode === "quick-sale" && overlay && !overlay.hidden && toolMode === "sell" && serialTargetId) {
          var target = findCartLine(serialTargetId);
          if (target && addSerializedUnit(target.product, code)) {
            serialTargetId = "";
            notify("Serial " + code + " added to " + target.product.name + ".");
            renderQuickSale();
            return true;
          }
        }
        if (!core.isBarcodeValue(code)) return false;
        if (mode === "quick-sale" && overlay && !overlay.hidden && toolMode === "sell") {
          quickCode = code;
          doLookup();
          return true;
        }
        openFeature("quick-sale");
        quickCode = code;
        doLookup();
        return true;
      },
      demoRequest: demoRequest,
      receiptText: receiptText
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
