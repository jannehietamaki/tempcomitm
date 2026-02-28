# tempcomitm

A man-in-the-middle proxy for Tempco/Purmo radiator heating systems, providing local control via MQTT and a web UI.

## What it does

tempcomitm sits between your Tempco/Purmo radiator controllers and the upstream cloud server (`e3.lvi.eu`). It intercepts HTTP traffic to and from the controllers, parses the proprietary API, and exposes device state and controls through standard MQTT topics and a built-in web interface.

The controllers continue to function normally with the cloud service while tempcomitm observes and modifies traffic in transit to enable local temperature control.

## Features

- **MITM HTTP Proxy** -- Intercepts Tempco controller traffic with request/response parsing
- **HTTPS Passthrough** -- TLS traffic forwarded as raw TCP (no termination needed)
- **Temperature Control** -- Set target temperatures per zone via MQTT or web UI
- **Command Injection** -- Injects commands into controller query/check responses (mimics how the cloud delivers settings)
- **Persistent Confirmation** -- Requires 3 consecutive matching device reports before confirming a change; automatically re-injects on revert
- **Upstream Sync** -- Sends changes to the cloud server so both sides stay in sync
- **Web UI** -- Built-in dashboard for monitoring and controlling radiators
- **MQTT Integration** -- Publish device state and accept commands (compatible with Home Assistant, openHAB, etc.)
- **Holiday Mode** -- Toggle holiday/away mode per device
- **Transaction Logging** -- Full request/response logs for protocol analysis
- **State Persistence** -- Device state and zone aliases saved to disk across restarts
- **Docker Ready** -- Multi-stage Dockerfile for minimal production images

## How Temperature Control Works

The Tempco controller polls the cloud via `/machine/query/check/` requests. Normally the cloud responds with `code:"2"` (no changes). When a temperature change is requested:

1. The command is queued and sent to the upstream cloud via `device/edit`
2. On the next `query/check` poll, the proxy replaces the `code:"2"` response with `code:"1"` containing the command -- this is exactly how the cloud delivers settings changes
3. The controller picks up the command, applies it, and reports the new value via `device/edit`
4. The proxy watches for 3 consecutive matching reports before considering the change confirmed
5. If the controller reverts to an old value, the proxy re-injects the command automatically

## Quick Start with Docker

```yaml
# docker-compose.yml
tempcomitm:
  build: ./tempcomitm
  network_mode: host
  environment:
    - TEMPCO_HTTP_PORT=80
    - TEMPCO_HTTPS_PORT=443
    - TEMPCO_UPSTREAM_HOST=108.142.40.45
    - TEMPCO_UPSTREAM_HOSTNAME=e3.lvi.eu
    - TEMPCO_UPSTREAM_HTTP_PORT=80
    - TEMPCO_UPSTREAM_HTTPS_HOST=108.142.40.45
    - TEMPCO_UPSTREAM_HTTPS_PORT=443
    - TEMPCO_WEB_PORT=3000
    - TEMPCO_MQTT_URL=mqtt://localhost:1883
    - TEMPCO_MQTT_PREFIX=tempco
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

## DNS Setup

Configure your local DNS (e.g. dnsmasq, Pi-hole, or router settings) to point `e3.lvi.eu` to the machine running tempcomitm. The Tempco controllers will then connect to the proxy instead of the cloud directly.

**Important:** The proxy must connect to the real cloud server by IP (`108.142.40.45`), not by hostname, to avoid a DNS loop.

## Configuration

All configuration is done through environment variables. Copy `.env.example` to `.env` and adjust as needed.

| Variable | Default | Description |
|---|---|---|
| `TEMPCO_LISTEN_HOST` | `0.0.0.0` | Bind address for proxy listeners |
| `TEMPCO_HTTP_PORT` | `80` | Local HTTP proxy listen port |
| `TEMPCO_HTTPS_PORT` | `443` | Local HTTPS proxy listen port |
| `TEMPCO_UPSTREAM_HOST` | `108.142.40.45` | Upstream cloud server IP (for HTTP) |
| `TEMPCO_UPSTREAM_HOSTNAME` | `e3.lvi.eu` | Upstream hostname (used in Host headers) |
| `TEMPCO_UPSTREAM_HTTP_PORT` | `80` | Upstream HTTP port |
| `TEMPCO_UPSTREAM_HTTPS_HOST` | `108.142.40.45` | Upstream HTTPS IP address |
| `TEMPCO_UPSTREAM_HTTPS_PORT` | `443` | Upstream HTTPS port |
| `TEMPCO_WEB_PORT` | `3000` | Web UI listen port |
| `TEMPCO_MQTT_URL` | `mqtt://localhost:1883` | MQTT broker URL |
| `TEMPCO_MQTT_PREFIX` | `tempco` | MQTT topic prefix |
| `TEMPCO_DISABLE_LOG` | `false` | Disable transaction logging |
| `TEMPCO_STATE_DIR` | `state` | Directory for persisted state files |
| `TEMPCO_LOG_DIR` | `logs` | Directory for transaction logs |

## MQTT Topics

All topics use the configured prefix (default: `tempco`).

### Published (state)

| Topic | Payload | Description |
|---|---|---|
| `{prefix}/zones/{deviceId}/state` | JSON | Full device state with celsius conversions |
| `{prefix}/zones/{deviceId}/temperature` | Number | Current air temperature (Celsius) |
| `{prefix}/zones/{deviceId}/target` | Number | Target comfort temperature (Celsius) |
| `{prefix}/zones/{deviceId}/power` | Number | Current power draw (watts) |
| `{prefix}/zones/{deviceId}/holiday` | `on` / `off` | Holiday mode status |
| `{prefix}/bridge/status` | `online` / `offline` | Bridge connection status (LWT) |

### Subscribed (commands)

| Topic | Payload | Description |
|---|---|---|
| `{prefix}/zones/{deviceId}/target/set` | Number | Set target temperature in Celsius |
| `{prefix}/zones/{deviceId}/holiday/set` | `on` / `off` / `true` / `false` / `1` / `0` | Enable or disable holiday mode |

## REST API

The web UI exposes a REST API on the configured web port (default 3000).

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Web UI dashboard |
| `GET` | `/api/health` | Health check (uptime, timestamp) |
| `GET` | `/api/devices` | List all devices and their state |
| `POST` | `/api/devices/:id/temperature` | Set target temperature (`{ "celsius": 21.5 }`) |
| `POST` | `/api/devices/:id/holiday` | Set holiday mode (`{ "on": true }`) |

## License

MIT
