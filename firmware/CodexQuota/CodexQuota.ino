#include <WiFi.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <ArduinoJson.h>
#include <math.h>
#include <stdint.h>

#if __has_include("config.h")
#include "config.h"
#else
#error "Run node bridge/setup.mjs and edit firmware/CodexQuota/config.h first."
#endif

Adafruit_ST7789 tft(&SPI, TFT_CS, TFT_DC, TFT_RST);
struct QuotaWindow {
  float remaining;
  int minutes;
  int64_t resetsAt;
};
QuotaWindow quota[2];
int quotaCount = 0;
bool everReceived = false, bridgeStale = true, fetchFailed = true;
uint64_t serverEpochAtReceive = 0;
uint32_t receivedMs = 0, pollMs = 0, drawMs = 0, reconnectMs = 0;
uint32_t wifiLogMs = 0;
volatile uint8_t lastWifiDisconnectReason = 0;
volatile bool wifiAssociated = false;
String connectionState = "Starting";
bool imageShowing = false;
String displayedImageRevision;
uint16_t BG = 0x0841, ACCENT = 0xFFE0, MUTED = 0xD68A, TRACK = 0x31A0, WARNING = 0xFD20, DANGER = 0xF800;

struct TextRowCache {
  String text;
  String rightText;
  int size = 0;
  uint16_t color = 0;
  bool valid = false;
};
TextRowCache textRows[7];
int paintedLayout = -1;
int paintedBarWidth[2] = { -1, -1 };
uint16_t paintedBarColor[2] = { 0, 0 };

void onWifiEvent(arduino_event_id_t event, arduino_event_info_t info) {
  // Callbacks run on another task: only share simple numeric flags with the UI.
  if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    wifiAssociated = false;
    lastWifiDisconnectReason = info.wifi_sta_disconnected.reason;
    Serial.printf("WiFi disconnected: reason=%u\n", (unsigned)lastWifiDisconnectReason);
  } else if (event == ARDUINO_EVENT_WIFI_STA_CONNECTED) {
    wifiAssociated = true;
    lastWifiDisconnectReason = 0;
    Serial.println("WiFi associated; waiting for IP address");
  } else if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
    lastWifiDisconnectReason = 0;
    Serial.printf("WiFi connected: IP=%s\n", WiFi.localIP().toString().c_str());
  }
}

String wifiConnectionLabel() {
  const uint8_t reason = lastWifiDisconnectReason;
  if (wifiAssociated) return "WiFi: waiting for IP";
  if (reason == WIFI_REASON_NO_AP_FOUND || WiFi.status() == WL_NO_SSID_AVAIL) return "WiFi: AP not found";
  if (reason == WIFI_REASON_AUTH_FAIL || WiFi.status() == WL_CONNECT_FAILED) return "WiFi: auth failed";
  if (reason == WIFI_REASON_HANDSHAKE_TIMEOUT || reason == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT) return "WiFi: handshake timeout";
  return reason ? "WiFi reconnecting" : "Connecting to WiFi";
}

void applyTheme(JsonObjectConst theme) {
  if (theme.isNull()) return;
  const char *keys[] = { "background", "accent", "muted", "track", "warning", "danger" };
  uint16_t colors[6];
  for (int i = 0; i < 6; i++) {
    JsonVariantConst value = theme[keys[i]];
    if (!value.is<unsigned int>() || value.as<unsigned int>() > 65535U) return;
    colors[i] = value.as<uint16_t>();
  }
  if (BG == colors[0] && ACCENT == colors[1] && MUTED == colors[2] &&
      TRACK == colors[3] && WARNING == colors[4] && DANGER == colors[5]) return;
  BG = colors[0]; ACCENT = colors[1]; MUTED = colors[2];
  TRACK = colors[3]; WARNING = colors[4]; DANGER = colors[5];
  // Repaint once for an actual palette change, never on identical polling responses.
  paintedLayout = -1;
}

String windowLabel(int minutes, int index) {
  if (minutes <= 0) return index == 0 ? "Primary" : "Secondary";
  if (minutes % 10080 == 0) return String(minutes / 10080) + "w window";
  if (minutes % 1440 == 0) return String(minutes / 1440) + "d window";
  if (minutes % 60 == 0) return String(minutes / 60) + "h window";
  return String(minutes) + "m window";
}

String resetLabel(const QuotaWindow &window) {
  if (window.resetsAt <= 0) return "Reset: unknown";
  const int64_t now = serverEpochAtReceive + (uint32_t)(millis() - receivedMs) / 1000;
  int64_t remaining = window.resetsAt - now;
  if (remaining <= 0) return "Awaiting refresh";
  uint32_t minutes = (remaining + 59) / 60;
  if (minutes >= 1440) return "Reset: " + String(minutes / 1440) + "d " + String((minutes % 1440) / 60) + "h";
  return "Reset: " + String(minutes / 60) + "h " + String(minutes % 60) + "m";
}

void textAt(int x, int y, const String &text, int size, uint16_t color) {
  tft.setCursor(x, y); tft.setTextSize(size); tft.setTextColor(color); tft.print(text);
}

void updateTextRow(int index, int y, const String &text, int size, uint16_t color, const String &rightText) {
  TextRowCache &previous = textRows[index];
  if (previous.valid && previous.text == text && previous.rightText == rightText &&
      previous.size == size && previous.color == color) return;

  // Allocate one small strip, rather than a full-screen framebuffer.
  // Send completed pixels in one transfer so changed text never disappears first.
  static GFXcanvas16 rowCanvas(tft.width() - 20, 32);
  const int height = rightText.length() ? 16 : size * 8;
  if (rowCanvas.getBuffer()) {
    rowCanvas.fillScreen(BG);
    rowCanvas.setTextWrap(false);
    rowCanvas.setCursor(0, 0);
    rowCanvas.setTextSize(size);
    rowCanvas.setTextColor(rightText.length() ? MUTED : color);
    rowCanvas.print(text);
    if (rightText.length()) {
      rowCanvas.setTextSize(2);
      rowCanvas.setTextColor(color);
      rowCanvas.setCursor(rowCanvas.width() - (int)rightText.length() * 12, 0);
      rowCanvas.print(rightText);
    }
    tft.drawRGBBitmap(10, y, rowCanvas.getBuffer(), rowCanvas.width(), height);
  } else {
    // Keep the UI usable if RAM is tight; still redraw only changed rows.
    tft.fillRect(10, y, tft.width() - 20, height, BG);
    textAt(10, y, text, size, rightText.length() ? MUTED : color);
    if (rightText.length()) textAt(tft.width() - 10 - (int)rightText.length() * 12, y, rightText, 2, color);
  }
  previous.text = text;
  previous.rightText = rightText;
  previous.size = size;
  previous.color = color;
  previous.valid = true;
}

void updateBar(int index, int y, int fill, uint16_t color) {
  const int width = tft.width() - 20;
  const int previous = paintedBarWidth[index];
  if (previous == fill && paintedBarColor[index] == color) return;
  if (previous < 0 || paintedBarColor[index] != color) {
    if (fill > 0) tft.fillRect(10, y, fill, 6, color);
    if (fill < width) tft.fillRect(10 + fill, y, width - fill, 6, TRACK);
  } else if (fill > previous) {
    tft.fillRect(10 + previous, y, fill - previous, 6, color);
  } else if (fill < previous) {
    tft.fillRect(10 + fill, y, previous - fill, 6, TRACK);
  }
  paintedBarWidth[index] = fill;
  paintedBarColor[index] = color;
}

void drawScreen() {
  // An unchanged image stays on the panel, including during temporary outages.
  if (imageShowing) return;
  const int w = tft.width(), h = tft.height();
  const bool compact = h < 180;
  const int startY = compact ? 30 : 42;
  const int layout = everReceived && quotaCount > 0 ? quotaCount : 0;
  if (paintedLayout != layout) {
    if (paintedLayout < 0) {
      // Clear at startup or when the user explicitly changes the theme.
      tft.fillScreen(BG);
      textAt(10, 8, "CODEX", compact ? 2 : 3, ACCENT);
    } else {
      // Switching between the waiting screen and quota cards changes the layout.
      tft.fillRect(0, startY, w, h - startY - 22, BG);
    }
    for (int i = 0; i < 7; i++) textRows[i].valid = false;
    for (int i = 0; i < 2; i++) paintedBarWidth[i] = -1;
    paintedLayout = layout;
  }
  if (!everReceived || quotaCount == 0) {
    updateTextRow(0, compact ? 38 : 56, connectionState, 1, MUTED, "");
    updateTextRow(1, compact ? 58 : 80, "No quota data", 1, MUTED, "");
  } else {
    const int cardHeight = (h - startY - 22) / quotaCount;
    for (int i = 0; i < quotaCount; i++) {
      const int y = startY + i * cardHeight;
      const uint16_t color = quota[i].remaining <= 10 ? DANGER : quota[i].remaining <= 30 ? WARNING : ACCENT;
      const int font = compact ? 2 : (w >= 180 && cardHeight >= 100 ? 4 : 3);
      const String percent = String((int)floorf(quota[i].remaining)) + "%";
      if (compact) {
        updateTextRow(i * 3, y, windowLabel(quota[i].minutes, i), 1, color, percent);
      } else {
        updateTextRow(i * 3, y, windowLabel(quota[i].minutes, i), 1, MUTED, "");
        updateTextRow(i * 3 + 1, y + 12, percent, font, color, "");
      }
      const int barY = compact ? y + 18 : y + 12 + font * 8 + 3;
      const int fill = (int)((w - 20) * quota[i].remaining / 100.0f);
      updateBar(i, barY, fill, color);
      updateTextRow(i * 3 + 2, barY + 10, resetLabel(quota[i]), 1, MUTED, "");
    }
  }
  const bool stale = bridgeStale || fetchFailed || (everReceived && (uint32_t)(millis() - receivedMs) >= LOCAL_STALE_MS);
  String footer = WiFi.status() != WL_CONNECTED ? "WiFi offline" : !everReceived ? "Waiting for data" : stale ? "STALE - last known" : "LIVE - remaining";
  updateTextRow(6, h - 14, footer, 1, stale ? WARNING : ACCENT, "");
}

bool fetchImage(const String &revision) {
  if (imageShowing && displayedImageRevision == revision) return true;
  if (tft.width() != 240 || tft.height() != 240) return false;
  String url = QUOTA_URL;
  const int slash = url.lastIndexOf('/');
  if (slash < 0) return false;
  url = url.substring(0, slash) + "/image?revision=" + revision;
  WiFiClient client;
  HTTPClient http;
  http.setConnectTimeout(2000);
  http.setTimeout(3000);
  if (!http.begin(client, url)) return false;
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  http.addHeader("X-Display-Protocol", "3");
  const int code = http.GET();
  if (code != HTTP_CODE_OK || http.getSize() != 240 * 240 * 2) { http.end(); return false; }
  auto *stream = http.getStreamPtr();
  if (!stream) { http.end(); return false; }
  stream->setTimeout(2000);
  uint8_t bytes[240 * 2];
  uint16_t pixels[240];
  bool complete = true, changedPixels = false;
  const uint32_t started = millis();
  // One row uses under 1 KB of RAM; no full-frame allocation or flash writes.
  for (int y = 0; y < 240; y++) {
    if ((uint32_t)(millis() - started) > 15000UL || stream->readBytes(bytes, sizeof(bytes)) != sizeof(bytes)) { complete = false; break; }
    for (int x = 0; x < 240; x++) pixels[x] = (uint16_t)bytes[x * 2] | ((uint16_t)bytes[x * 2 + 1] << 8);
    tft.drawRGBBitmap(0, y, pixels, 240, 1);
    changedPixels = true;
    yield();
  }
  http.end();
  if (complete) {
    imageShowing = true;
    displayedImageRevision = revision;
    Serial.println("Image applied (240x240)");
  } else if (changedPixels) {
    // Restore a coherent quota screen after an interrupted image transfer.
    imageShowing = false;
    paintedLayout = -1;
  }
  return complete;
}

void fetchQuota() {
  String requestedImageRevision;
  WiFiClient client;
  HTTPClient http;
  http.setConnectTimeout(2000);
  http.setTimeout(3000);
  fetchFailed = true;
  if (!http.begin(client, QUOTA_URL)) { connectionState = "Invalid bridge URL"; return; }
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  http.addHeader("X-Display-Protocol", "3");
  const int code = http.GET();
  if (code == HTTP_CODE_OK) {
    JsonDocument doc;
    const int length = http.getSize();
    if (length > 4096 || length < 0) {
      connectionState = "Invalid response size";
    } else {
      // The bundled bridge always sends a small Content-Length response.
      const String body = http.getString();
      const DeserializationError error = deserializeJson(doc, body);
      if (!error) applyTheme(doc["theme"].as<JsonObjectConst>());
      if (!error) {
        JsonObjectConst display = doc["display"].as<JsonObjectConst>();
        const String mode = display["mode"] | "quota";
        if (mode == "quota" && imageShowing) { imageShowing = false; paintedLayout = -1; }
        if (mode == "image") {
          JsonObjectConst image = display["image"].as<JsonObjectConst>();
          const String revision = image["revision"] | "";
          bool validImage = revision.length() == 64 && (image["width"] | 0) == 240 &&
            (image["height"] | 0) == 240 && String(image["format"] | "") == "rgb565le";
          for (unsigned int i = 0; i < revision.length(); i++) {
            const char c = revision[i];
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) validImage = false;
          }
          if (validImage) requestedImageRevision = revision;
        }
      }
      JsonArrayConst windows = doc["windows"].as<JsonArrayConst>();
      const String status = doc["status"] | "unavailable";
      bool valid = !error && doc["serverTime"].is<uint64_t>() && doc["serverTime"].as<uint64_t>() > 0 &&
        (status == "ok" || status == "stale") && windows.size() >= 1 && windows.size() <= 2;
      QuotaWindow parsed[2];
      if (valid) {
        int i = 0;
        for (JsonObjectConst item : windows) {
          const float value = item["remainingPercent"].as<float>();
          if (!item["remainingPercent"].is<float>() || !isfinite(value) || value < 0 || value > 100) { valid = false; break; }
          parsed[i++] = { value, item["windowMinutes"] | 0, item["resetsAt"] | (int64_t)0 };
        }
      }
      if (valid) {
        quotaCount = windows.size();
        for (int i = 0; i < quotaCount; i++) quota[i] = parsed[i];
        serverEpochAtReceive = doc["serverTime"].as<uint64_t>();
        receivedMs = millis(); everReceived = true;
        bridgeStale = status != "ok"; fetchFailed = false;
        connectionState = "Connected";
      } else connectionState = "Quota unavailable";
    }
  } else {
    connectionState = code == 401 ? "Check device token" : "Bridge unreachable";
  }
  http.end();
  // Fetch only after closing the manifest connection, and only for a changed image.
  if (requestedImageRevision.length() && !fetchImage(requestedImageRevision)) {
    connectionState = "Image download failed";
    Serial.println("Image download failed; retrying on next poll");
  }
  Serial.println(connectionState);
}

void setup() {
  Serial.begin(115200);
  SPI.begin(TFT_SCLK, -1, TFT_MOSI, TFT_CS);
  tft.init(TFT_WIDTH, TFT_HEIGHT, TFT_SPI_MODE);
  tft.setRotation(TFT_ROTATION);
  tft.invertDisplay(TFT_INVERT);
  tft.setSPISpeed(20000000);
  tft.setTextWrap(false);
  if (TFT_BL >= 0) { pinMode(TFT_BL, OUTPUT); digitalWrite(TFT_BL, TFT_BL_ACTIVE); }
  connectionState = "Connecting to WiFi";
  drawScreen();
  WiFi.onEvent(onWifiEvent);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Connecting to WiFi SSID: %s\n", WIFI_SSID);
  pollMs = millis() - POLL_INTERVAL_MS;
}

void loop() {
  const uint32_t now = millis();
  if (WiFi.status() == WL_CONNECTED) {
    if ((uint32_t)(now - pollMs) >= POLL_INTERVAL_MS) { pollMs = now; fetchQuota(); }
  } else {
    fetchFailed = true;
    connectionState = wifiConnectionLabel();
    if ((uint32_t)(now - wifiLogMs) >= 10000UL) {
      wifiLogMs = now;
      Serial.printf("WiFi status=%d, reason=%u, uptime=%lu s\n", (int)WiFi.status(),
                    (unsigned)lastWifiDisconnectReason, (unsigned long)(now / 1000));
    }
    if ((uint32_t)(now - reconnectMs) >= 30000UL) { reconnectMs = now; WiFi.reconnect(); }
  }
  if ((uint32_t)(now - drawMs) >= 1000UL) { drawMs = now; drawScreen(); }
  delay(20);
}
