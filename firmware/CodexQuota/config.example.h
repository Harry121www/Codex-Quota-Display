#pragma once

// Run node bridge/setup.mjs, then edit the generated config.h.
#define WIFI_SSID "YOUR_2_4_GHZ_WIFI"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define QUOTA_URL "http://YOUR_PC_LAN_IP:8765/api/quota"
#define DEVICE_TOKEN "REPLACE_WITH_RANDOM_DEVICE_TOKEN"

// Confirmed panel: 1.54-inch ST7789, 240x240, 8-pin SPI module.
#define TFT_WIDTH 240
#define TFT_HEIGHT 240
#define TFT_ROTATION 3 // Rotate 180 degrees from the original orientation.
#define TFT_INVERT true
#define TFT_SPI_MODE SPI_MODE0

// Matches yousifamanuel/clawd-mochi. GPIO numbers, NOT header positions.
#define TFT_SCLK 8
#define TFT_MOSI 10
#define TFT_DC 1
#define TFT_CS 4
#define TFT_RST 2
#define TFT_BL 3       // Clawd Mochi module: HIGH enables the backlight.
#define TFT_BL_ACTIVE HIGH

#define POLL_INTERVAL_MS 15000UL
#define LOCAL_STALE_MS 180000UL
