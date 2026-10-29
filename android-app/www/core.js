/*
 * Easy Gateway shared client core.
 *
 * This file is loaded as a classic script before the application bundle so the
 * same pure helpers can be unit-tested in Node without a DOM. It intentionally
 * contains no network, storage or DOM access.
 */
(function (root) {
  "use strict";

  var TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
  var INVALID_QR_MESSAGE = "This QR code is invalid. Generate a new one and try again.";
  var SUPPORTED_TOKEN_MESSAGE = INVALID_QR_MESSAGE;
  var UNSUPPORTED_ADDRESS_MESSAGE = "This QR code uses an unsupported address.";
  var PRODUCTION_HTTP_MESSAGE = "This QR uses an HTTP link, which the production app doesn't allow. Scan the HTTPS QR code or use the configured local-development app.";

  /** Private LAN / loopback hosts used only to pick the right error message. */
  function isPrivateDevelopmentHost(hostname) {
    var host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1") return true;
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    return /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host);
  }

  function tokenIsValid(value) {
    return TOKEN_RE.test(String(value || ""));
  }

  /**
   * The server adds ?mode=demo to every demo-only import link. The marker lives
   * in the QR itself, so the app can tell the two token types apart without
   * parsing a server error message.
   */
  function isDemoOnlyLink(url) {
    try {
      return String(url.searchParams.get("mode") || "").toLowerCase() === "demo";
    } catch (_) {
      return false;
    }
  }

  function parseLink(raw, options) {
    var opts = options || {};
    var value = String(raw == null ? "" : raw).trim();
    if (!value) return { error: "The QR code did not contain a link." };

    var url;
    try {
      url = new URL(value);
    } catch (_) {
      return { error: "This QR code is not an Easy Gateway link." };
    }

    var scheme = url.protocol.toLowerCase();

    // Custom scheme: easygateway://shop/<slug>, easygateway://import-product/<token>,
    // easygateway://scan/<token>. These are produced by the app itself and never
    // carry product details, only a slug or a server-issued token.
    if (scheme === "easygateway:") {
      var customHost = String(url.host || "").toLowerCase();
      var customPath = String(url.pathname || "").replace(/^\/+|\/+$/g, "");
      if (customHost === "shop") {
        var slug = "";
        try {
          slug = decodeURIComponent(customPath || url.searchParams.get("slug") || "");
        } catch (_) {
          return { error: SUPPORTED_TOKEN_MESSAGE };
        }
        if (!slug) return { error: "This store link does not include a shop." };
        return { kind: "store", slug: slug, url: value };
      }
      if (customHost === "import-product" || customHost === "scan") {
        var customToken = customPath || url.searchParams.get("token") || "";
        if (!tokenIsValid(customToken)) return { error: SUPPORTED_TOKEN_MESSAGE };
        return {
          kind: customHost === "scan" ? "scan" : "import",
          token: customToken,
          demoOnly: isDemoOnlyLink(url),
          url: value
        };
      }
      return { error: SUPPORTED_TOKEN_MESSAGE };
    }

    if (scheme !== "https:" && scheme !== "http:") {
      return { error: "This QR code is not an Easy Gateway link." };
    }

    // A QR must never smuggle credentials in the URL. The app always talks to
    // its configured origin and would ignore them, so reject the link outright.
    if (url.username || url.password) {
      return { error: "This QR link contains embedded sign-in details and cannot be opened." };
    }

    var allowHttp = opts.allowHttp === true;
    var allowedHosts = (opts.allowedHosts || []).map(function (host) {
      return String(host || "").toLowerCase();
    }).filter(Boolean);
    var host = String(url.host || "").toLowerCase();
    var hostAllowed = !allowedHosts.length || allowedHosts.indexOf(host) !== -1;

    // Cleartext is only ever valid when the build explicitly enables it AND the
    // exact host (including port) is configured. Otherwise fail closed.
    if (scheme === "http:" && !allowHttp) {
      // Use the production-specific wording only when the link targets this
      // app's own server or a private development host. Anything else is an
      // unsupported address, not a production HTTP problem.
      return {
        error: hostAllowed || isPrivateDevelopmentHost(url.hostname)
          ? PRODUCTION_HTTP_MESSAGE
          : UNSUPPORTED_ADDRESS_MESSAGE
      };
    }
    if (!hostAllowed) {
      return { error: UNSUPPORTED_ADDRESS_MESSAGE };
    }

    var importMatch = String(url.pathname || "").match(/^\/import-product\/([A-Za-z0-9_-]{43})\/?$/);
    if (importMatch) {
      return { kind: "import", token: importMatch[1], demoOnly: isDemoOnlyLink(url), url: url.toString() };
    }

    var scanMatch = String(url.pathname || "").match(/^\/scan\/([A-Za-z0-9_-]{43})\/?$/);
    if (scanMatch) return { kind: "scan", token: scanMatch[1], url: url.toString() };

    var queryToken = url.searchParams.get("scanToken");
    if (tokenIsValid(queryToken)) {
      return { kind: "import", token: queryToken, demoOnly: isDemoOnlyLink(url), url: url.toString() };
    }

    var storeMatch = String(url.pathname || "").match(/^\/shop\/([^/]+)\/?$/);
    if (storeMatch) {
      var storeSlug = "";
      try {
        storeSlug = decodeURIComponent(storeMatch[1]);
      } catch (_) {
        return { error: SUPPORTED_TOKEN_MESSAGE };
      }
      if (!storeSlug) return { error: "This store link does not include a shop." };
      return { kind: "store", slug: storeSlug, url: url.toString() };
    }

    return { error: SUPPORTED_TOKEN_MESSAGE };
  }

  /** CSV with quotes around every field and CRLF line endings, as Excel expects. */
  function csv(rows) {
    return (rows || []).map(function (row) {
      return (row || []).map(function (value) {
        return '"' + String(value == null ? "" : value).replace(/"/g, '""') + '"';
      }).join(",");
    }).join("\r\n");
  }

  function inventoryFilter(products, filter, query, expiryDays) {
    var term = String(query || "").trim().toLowerCase();
    var selected = String(filter || "all");
    return (products || []).filter(function (product) {
      var haystack = [product.name, product.sku, product.barcode, product.category].join(" ").toLowerCase();
      if (term && haystack.indexOf(term) === -1) return false;
      if (selected === "low") return Number(product.stock) <= Number(product.reorderAt);
      if (selected === "expiring") {
        var days = typeof expiryDays === "function" ? expiryDays(product.expiry) : null;
        return days !== null && days !== undefined && days >= 0 && days <= 7;
      }
      if (selected === "qr") return !!product.qrImported;
      return true;
    });
  }

  /**
   * The only routes the app may use for an import token. Demo Mode uses the
   * preview endpoint so a demo token never reaches the live consume route.
   */
  function importEndpoint(demoMode) {
    return demoMode
      ? { path: "/demo-product-qr/consume-preview", mode: "demo", touchesLiveData: false }
      : { path: "/product-import/consume", mode: "live", touchesLiveData: true };
  }

  /**
   * Explains a failed import without ever suggesting that the app retry a
   * mutation. `qrDemoOnly` is the marker carried by the scanned link itself:
   * true for a Demo Mode QR, false for a live QR, null/undefined when the
   * caller only has the pending token (for example a launch scanToken link).
   * The server returns one combined 410 message per route, so the marker, not
   * the wording, decides whether this was a cross-mode rejection or a
   * same-mode expired/already-scanned code.
   */
  function importErrorMessage(demoMode, status, message, qrDemoOnly) {
    var text = String(message || "");
    if (status === 410) {
      if (qrDemoOnly === true && !demoMode) {
        return "This is a Demo Mode QR. Turn Demo Mode on to import it; your live inventory was not changed.";
      }
      if (qrDemoOnly === false && demoMode) {
        return "This is a live import QR. Demo Mode is on, so nothing was changed. Turn Demo Mode off and sign in to import it.";
      }
      return "This QR has expired or was already scanned. Generate a fresh QR code and try again.";
    }
    return text;
  }

  var api = {
    tokenIsValid: tokenIsValid,
    parseLink: parseLink,
    csv: csv,
    inventoryFilter: inventoryFilter,
    importEndpoint: importEndpoint,
    importErrorMessage: importErrorMessage
  };

  root.EGCore = api;
  if (root.window && root.window !== root) root.window.EGCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
