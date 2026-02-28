# tempcomitm

A man-in-the-middle proxy for Tempco/Purmo radiator heating systems, providing local control via MQTT and a web UI.

## What it does

tempcomitm sits between your Tempco/Purmo radiator controllers and the upstream cloud server (`e3.lvi.eu`). It intercepts HTTP/HTTPS traffic to and from the controllers, parses the proprietary API, and exposes device state and controls through standard MQTT topics and a built-in web interface.

The controllers continue to function normally with the cloud service while tempcomitm observes and optionally modifies traffic in transit.

## Features

- **MITM HTTP/HTTPS Proxy** -- Transparent interception of Tempco controller traffic with full request/response logging
- **Web UI** -- Built-in dashboard on port 3000 for monitoring and controlling radiators
- **MQTT Integration** -- Publish device state and accept commands via MQTT (compatible with Home Assistant, openHAB, etc.)
- **Temperature Control** -- Set target temperatures per zone from MQTT or the web UI
- **Holiday Mode** -- Toggle holiday/away mode per device
- **Transaction Logging** -- Full request/response logs for protocol analysis and debugging
- **State Persistence** -- Device state and zone aliases saved to disk across restarts
- **Docker Ready** -- Multi-stage Dockerfile for minimal production images

## Quick Start with Docker

```bash
# Build the image
docker build -t tempcomitm .

# Run with default settings
docker run -d \
  --name tempcomitm \
  -p 80:80 \
  -p 443:443 \
  -p 3000:3000 \
  -e TEMPCO_MQTT_URL=mqtt://your-broker:1883 \
  -v tempcomitm-state:/app/state \
  -v tempcomitm-logs:/app/logs \
  tempcomitm
```

Or use docker-compose (add a service entry to your existing `docker-compose.yml`):

```yaml
tempcomitm:
  build: ./tempcomitm
  ports:
    - "80:80"
    - "443:443"
    - "3000:3000"
  environment:
    TEMPCO_MQTT_URL: mqtt://mosquitto:1883
    TEMPCO_MQTT_PREFIX: tempco
  volumes:
    - ./tempcomitm/state:/app/state
    - ./tempcomitm/logs:/app/logs
  restart: unless-stopped
```

## Quick Start without Docker

Requires Node.js 22 or later.

```bash
cd tempcomitm
npm install
npm run build
npm start
```

For development with auto-rebuild:

```bash
npm run dev
```

## Configuration

All configuration is done through environment variables. Copy `.env.example` to `.env` and adjust as needed.

| Variable | Default | Description |
|---|---|---|
| `TEMPCO_HTTP_PORT` | `80` | Local HTTP proxy listen port |
| `TEMPCO_HTTPS_PORT` | `443` | Local HTTPS proxy listen port |
| `TEMPCO_UPSTREAM_HOST` | `e3.lvi.eu` | Upstream cloud server hostname |
| `TEMPCO_UPSTREAM_HTTP_PORT` | `80` | Upstream HTTP port |
| `TEMPCO_UPSTREAM_HTTPS_HOST` | `108.142.40.45` | Upstream HTTPS IP address |
| `TEMPCO_UPSTREAM_HTTPS_PORT` | `443` | Upstream HTTPS port |
| `TEMPCO_WEB_PORT` | `3000` | Web UI listen port |
| `TEMPCO_MQTT_URL` | `mqtt://localhost:1883` | MQTT broker URL |
| `TEMPCO_MQTT_PREFIX` | `tempco` | MQTT topic prefix |
| `TEMPCO_DISABLE_LOG` | `false` | Disable transaction logging |
| `TEMPCO_VERBOSE` | `false` | Enable verbose console output |
| `TEMPCO_STATE_DIR` | `state` | Directory for persisted state files |
| `TEMPCO_LOG_DIR` | `logs` | Directory for transaction logs |

## MQTT Topics

### Published (state)

| Topic | Payload | Description |
|---|---|---|
| `tempco/{deviceId}/state` | JSON | Full device state object |
| `tempco/{deviceId}/temperature/current` | Number | Current measured temperature (Celsius) |
| `tempco/{deviceId}/temperature/target` | Number | Target set temperature (Celsius) |
| `tempco/{deviceId}/holiday` | `ON` / `OFF` | Holiday mode status |
| `tempco/{deviceId}/online` | `ON` / `OFF` | Device online status |

### Subscribed (commands)

| Topic | Payload | Description |
|---|---|---|
| `tempco/{deviceId}/temperature/set` | Number | Set target temperature in Celsius |
| `tempco/{deviceId}/holiday/set` | `ON` / `OFF` | Enable or disable holiday mode |

## REST API

The web UI exposes a simple REST API on the configured web port (default 3000).

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Web UI dashboard |
| `GET` | `/api/devices` | List all known devices and their state |
| `GET` | `/api/devices/:id` | Get state for a single device |
| `POST` | `/api/devices/:id/temperature` | Set target temperature (`{ "celsius": 21.5 }`) |
| `POST` | `/api/devices/:id/holiday` | Set holiday mode (`{ "on": true }`) |
| `GET` | `/api/zones` | List zone aliases |
| `POST` | `/api/zones/:id/alias` | Set zone alias (`{ "alias": "Living Room" }`) |

## Architecture

```
                        +------------------+
                        |  Tempco Cloud    |
                        |  (e3.lvi.eu)     |
                        +--------+---------+
                                 |
                            HTTP / HTTPS
                                 |
                  +--------------+--------------+
                  |        tempcomitm           |
                  |                             |
                  |  +-------+    +---------+   |
                  |  | HTTP  |    | HTTPS   |   |
                  |  | Proxy |    | Proxy   |   |
                  |  +---+---+    +----+----+   |
                  |      |             |         |
                  |      +------+------+         |
                  |             |                 |
                  |      +------+------+         |
                  |      | Transaction |         |
                  |      |   Parser    |         |
                  |      +------+------+         |
                  |             |                 |
                  |    +--------+--------+       |
                  |    |        |        |       |
                  |  +-v--+  +-v---+  +-v----+  |
                  |  |State|  |MQTT |  |Logger|  |
                  |  |Mgr  |  |Bridge| |      |  |
                  |  +--+--+  +--+--+  +------+  |
                  |     |        |               |
                  |  +--v--------v--+            |
                  |  |   Web UI     |            |
                  |  |  (:3000)     |            |
                  |  +--------------+            |
                  +------------------------------+
                                 |
                            HTTP / HTTPS
                                 |
                  +--------------+--------------+
                  |    Tempco Radiator           |
                  |    Controllers               |
                  +-----------------------------+
```

## How It Works

1. **DNS Redirect**: Configure your local DNS (e.g., via dnsmasq or router settings) to point `e3.lvi.eu` to the machine running tempcomitm. The Tempco controllers will then connect to the proxy instead of the cloud.

2. **HTTP Interception**: The proxy accepts HTTP connections on port 80 and forwards them to the real upstream server. Requests and responses are parsed to extract device state, temperature readings, and configuration changes.

3. **HTTPS Tunneling**: HTTPS connections on port 443 are forwarded as raw TCP streams to the upstream server IP. This maintains TLS connectivity for the controllers without needing to terminate TLS.

4. **State Extraction**: When the proxy sees API calls like `/api/v0.1/machine/device/edit/...`, it decodes the JSON payload to extract device IDs, temperatures, modes, and other parameters. This state is persisted to disk.

5. **MQTT Publishing**: Extracted state is published to MQTT topics, making it available to home automation systems. Commands received via MQTT are translated back into Tempco API calls and forwarded to the upstream server.

6. **Web Dashboard**: A built-in web UI provides a real-time view of all discovered devices with controls for temperature and holiday mode.

## License

MIT
