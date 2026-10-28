package com.easygateway.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpCookie;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native HTTP and file bridge for Easy Gateway.
 *
 * Why this exists:
 * The Capacitor WebView runs at https://localhost while the API is hosted on a
 * different origin. The existing Express session cookie is SameSite=Lax and the
 * API does not enable CORS, so a browser fetch from the WebView would be blocked.
 * This bridge performs the request natively, keeps the HttpOnly server session in
 * an app-private cookie jar, and attaches it explicitly. It does not disable TLS
 * verification, skip authentication, or expose the session cookie to JavaScript.
 *
 * Mutating requests are never retried automatically: a timeout is reported to the
 * UI so the operator can confirm the result rather than create a duplicate sale.
 */
@CapacitorPlugin(name = "EasyGatewayNative")
public class EasyGatewayNativePlugin extends Plugin {

    private static final String PREFS = "easy_gateway_native";
    private static final String COOKIE_KEY = "session_cookies_v1";
    private static final int CONNECT_TIMEOUT_MS = 60000;
    private static final int READ_TIMEOUT_MS = 60000;
    private static final ExecutorService EXECUTOR = Executors.newCachedThreadPool();
    private static final Object COOKIE_LOCK = new Object();

    @PluginMethod
    public void getConfig(PluginCall call) {
        JSObject result = new JSObject();
        result.put("apiBaseUrl", BuildConfig.API_BASE_URL);
        result.put("environment", BuildConfig.ENV_LABEL);
        result.put("allowCleartext", BuildConfig.ALLOW_CLEARTEXT);
        result.put("debug", BuildConfig.DEBUG);
        result.put("appVersion", BuildConfig.VERSION_NAME);
        result.put("packageName", getContext().getPackageName());
        result.put("platform", "android");
        call.resolve(result);
    }

    @PluginMethod
    public void request(PluginCall call) {
        final String method = call.getString("method", "GET").toUpperCase(Locale.US);
        final String path = call.getString("path", "");
        final String body = call.getString("body");
        final String contentType = call.getString("contentType", "application/json");

        if (!path.startsWith("/") || path.contains("..") || path.contains("\\")) {
            call.reject("The API path is invalid.", "INVALID_PATH");
            return;
        }

        final String baseUrl;
        try {
            baseUrl = validatedBaseUrl();
        } catch (Exception error) {
            call.reject(error.getMessage(), "INVALID_API_CONFIG");
            return;
        }

        EXECUTOR.execute(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(baseUrl + path);
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod(method);
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("Accept", "application/json");
                connection.setUseCaches(false);

                String cookieHeader = cookieHeaderFor(url);
                if (!cookieHeader.isEmpty()) {
                    connection.setRequestProperty("Cookie", cookieHeader);
                }

                if (body != null && !body.isEmpty() && !"GET".equals(method) && !"HEAD".equals(method)) {
                    byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                    connection.setDoOutput(true);
                    connection.setFixedLengthStreamingMode(payload.length);
                    connection.setRequestProperty("Content-Type", contentType + "; charset=utf-8");
                    try (OutputStream stream = connection.getOutputStream()) {
                        stream.write(payload);
                    }
                }

                int status = connection.getResponseCode();
                storeResponseCookies(connection);
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                String responseBody = readAll(stream);

                JSObject headers = new JSObject();
                for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
                    if (entry.getKey() == null) continue;
                    String key = entry.getKey().toLowerCase(Locale.US);
                    if ("set-cookie".equals(key)) continue; // never expose HttpOnly session cookies to the WebView
                    if (entry.getValue() != null && !entry.getValue().isEmpty()) {
                        headers.put(key, entry.getValue().get(0));
                    }
                }

                JSObject result = new JSObject();
                result.put("status", status);
                result.put("body", responseBody);
                result.put("headers", headers);
                result.put("url", url.toString());
                call.resolve(result);
            } catch (java.net.SocketTimeoutException timeout) {
                call.reject(
                    "Easy Gateway did not respond in time. Check the connection before retrying, especially after recording a sale.",
                    "NETWORK_TIMEOUT",
                    timeout
                );
            } catch (Exception error) {
                String message = error.getMessage();
                call.reject(
                    "Could not reach Easy Gateway" + (message == null || message.isEmpty() ? "." : ": " + message),
                    "NETWORK_ERROR",
                    error
                );
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    @PluginMethod
    public void clearSession(PluginCall call) {
        synchronized (COOKIE_LOCK) {
            prefs().edit().remove(COOKIE_KEY).apply();
        }
        call.resolve(new JSObject().put("ok", true));
    }

    @PluginMethod
    public void saveCsv(PluginCall call) {
        String filename = sanitiseFilename(call.getString("filename", "easy-gateway-export.csv"), ".csv");
        String content = call.getString("content", "");
        String mimeType = call.getString("mimeType", "text/csv");
        saveAndShare(call, filename, content.getBytes(StandardCharsets.UTF_8), mimeType, true);
    }

    @PluginMethod
    public void savePng(PluginCall call) {
        String filename = sanitiseFilename(call.getString("filename", "easy-gateway-sample-qr.png"), ".png");
        String dataUrl = call.getString("data", "");
        int comma = dataUrl.indexOf(',');
        String encoded = dataUrl.startsWith("data:") && comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
        try {
            byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
            saveAndShare(call, filename, bytes, "image/png", false);
        } catch (IllegalArgumentException error) {
            call.reject("The QR image data is invalid.", "INVALID_IMAGE", error);
        }
    }

    private void saveAndShare(PluginCall call, String filename, byte[] content, String mimeType, boolean csv) {
        Context context = getContext();
        final Uri[] uriHolder = new Uri[1];
        final String[] pathHolder = new String[1];
        getActivity().runOnUiThread(() -> {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentResolver resolver = context.getContentResolver();
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                    String relative = csv
                        ? Environment.DIRECTORY_DOWNLOADS + "/Easy Gateway"
                        : Environment.DIRECTORY_PICTURES + "/Easy Gateway";
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, relative);
                    values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    Uri collection = csv ? MediaStore.Downloads.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                    Uri uri = resolver.insert(collection, values);
                    if (uri == null) throw new IllegalStateException("Could not create the export file.");
                    try (OutputStream stream = resolver.openOutputStream(uri)) {
                        if (stream == null) throw new IllegalStateException("Could not open the export file.");
                        stream.write(content);
                    }
                    values.clear();
                    values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    resolver.update(uri, values, null, null);
                    uriHolder[0] = uri;
                    pathHolder[0] = relative + "/" + filename;
                } else {
                    File directory = new File(
                        context.getExternalFilesDir(csv ? Environment.DIRECTORY_DOWNLOADS : Environment.DIRECTORY_PICTURES),
                        "Easy Gateway"
                    );
                    if (!directory.exists() && !directory.mkdirs()) {
                        throw new IllegalStateException("Could not create the export folder.");
                    }
                    File file = new File(directory, filename);
                    try (FileOutputStream stream = new FileOutputStream(file)) {
                        stream.write(content);
                    }
                    uriHolder[0] = FileProvider.getUriForFile(
                        context,
                        context.getPackageName() + ".fileprovider",
                        file
                    );
                    pathHolder[0] = file.getAbsolutePath();
                }

                Intent share = new Intent(Intent.ACTION_SEND);
                share.setType(mimeType);
                share.putExtra(Intent.EXTRA_STREAM, uriHolder[0]);
                share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(share, "Save or share " + filename);
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().startActivity(chooser);

                JSObject result = new JSObject();
                result.put("saved", true);
                result.put("shared", true);
                result.put("path", pathHolder[0]);
                result.put("filename", filename);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Could not save or share the file: " + error.getMessage(), "FILE_ERROR", error);
            }
        });
    }

    private String validatedBaseUrl() throws Exception {
        URL url = new URL(BuildConfig.API_BASE_URL);
        String protocol = url.getProtocol();
        if ("https".equals(protocol)) return url.toString();
        if ("http".equals(protocol) && BuildConfig.DEBUG && BuildConfig.ALLOW_CLEARTEXT) return url.toString();
        throw new Exception("This build requires an HTTPS Easy Gateway API.");
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private String cookieHeaderFor(URL url) {
        String host = url.getHost().toLowerCase(Locale.US);
        String requestPath = url.getPath();
        if (requestPath == null || requestPath.isEmpty()) requestPath = "/";
        boolean secure = "https".equalsIgnoreCase(url.getProtocol());
        long now = System.currentTimeMillis();
        List<String> pairs = new ArrayList<>();
        synchronized (COOKIE_LOCK) {
            JSONArray stored = readCookies();
            JSONArray kept = new JSONArray();
            for (int i = 0; i < stored.length(); i++) {
                JSONObject cookie = stored.optJSONObject(i);
                if (cookie == null) continue;
                String domain = cookie.optString("domain", "").toLowerCase(Locale.US);
                String path = cookie.optString("path", "/");
                String name = cookie.optString("name", "");
                String value = cookie.optString("value", "");
                boolean hostOnly = cookie.optBoolean("hostOnly", true);
                boolean isSecure = cookie.optBoolean("secure", false);
                long expiresAt = cookie.optLong("expiresAt", 0L);
                boolean expired = expiresAt > 0 && expiresAt <= now;
                if (expired) continue;
                boolean domainMatch = hostOnly
                    ? host.equalsIgnoreCase(domain)
                    : (host.equalsIgnoreCase(domain) || host.endsWith("." + domain));
                boolean pathMatch = requestPath.startsWith(path);
                if (!name.isEmpty() && domainMatch && pathMatch && (!isSecure || secure)) {
                    pairs.add(name + "=" + value);
                    kept.put(cookie);
                } else if (!expired) {
                    kept.put(cookie);
                }
            }
            prefs().edit().putString(COOKIE_KEY, kept.toString()).apply();
        }
        return join(pairs, "; ");
    }

    private void storeResponseCookies(HttpURLConnection connection) {
        List<String> headers = new ArrayList<>();
        for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
            if (entry.getKey() != null && "set-cookie".equalsIgnoreCase(entry.getKey())) {
                for (String value : entry.getValue()) headers.add(value);
            }
        }
        if (headers.isEmpty()) return;
        long now = System.currentTimeMillis();
        synchronized (COOKIE_LOCK) {
            JSONArray stored = readCookies();
            for (String header : headers) {
                List<HttpCookie> parsed;
                try {
                    parsed = HttpCookie.parse(header);
                } catch (IllegalArgumentException ignored) {
                    continue;
                }
                for (HttpCookie cookie : parsed) {
                    String domain = cookie.getDomain();
                    boolean hostOnly = domain == null || !domain.startsWith(".");
                    String host = connection.getURL().getHost();
                    if (domain == null || domain.isEmpty()) domain = host;
                    if (domain.startsWith(".")) domain = domain.substring(1);
                    String path = cookie.getPath() == null || cookie.getPath().isEmpty() ? "/" : cookie.getPath();
                    long maxAge = cookie.getMaxAge();
                    long expiresAt = 0L;
                    if (maxAge == 0) {
                        expiresAt = now - 1000;
                    } else if (maxAge > 0) {
                        expiresAt = now + maxAge * 1000L;
                    }
                    JSONArray next = new JSONArray();
                    for (int i = 0; i < stored.length(); i++) {
                        JSONObject existing = stored.optJSONObject(i);
                        if (existing == null) continue;
                        boolean same = existing.optString("name").equals(cookie.getName())
                            && existing.optString("domain").equalsIgnoreCase(domain)
                            && existing.optString("path").equals(path);
                        if (!same) next.put(existing);
                    }
                    if (expiresAt <= 0 || expiresAt > now) {
                        JSONObject item = new JSONObject();
                        try {
                            item.put("name", cookie.getName());
                            item.put("value", cookie.getValue());
                            item.put("domain", domain);
                            item.put("path", path);
                            item.put("secure", cookie.getSecure());
                            item.put("hostOnly", hostOnly);
                            item.put("expiresAt", expiresAt);
                            item.put("savedAt", now);
                        } catch (Exception ignored) {
                            continue;
                        }
                        next.put(item);
                    }
                    stored = next;
                }
            }
            prefs().edit().putString(COOKIE_KEY, stored.toString()).apply();
        }
    }

    private JSONArray readCookies() {
        String raw = prefs().getString(COOKIE_KEY, "[]");
        try {
            return new JSONArray(raw);
        } catch (Exception error) {
            return new JSONArray();
        }
    }

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) return "";
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = stream.read(buffer)) != -1) output.write(buffer, 0, read);
        stream.close();
        return output.toString(StandardCharsets.UTF_8.name());
    }

    private static String join(List<String> values, String separator) {
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) builder.append(separator);
            builder.append(values.get(i));
        }
        return builder.toString();
    }

    private static String sanitiseFilename(String input, String extension) {
        String value = input == null ? "" : input.replaceAll("[^A-Za-z0-9._-]", "-");
        if (value.isEmpty()) value = "easy-gateway-export" + extension;
        if (!value.toLowerCase(Locale.US).endsWith(extension)) value += extension;
        return value;
    }
}
