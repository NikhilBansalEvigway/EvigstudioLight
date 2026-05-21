# EvigStudio Light Offline Deployment

This guide describes a simple offline-friendly deployment flow for an Ubuntu server.

Goals:

1. The server runs from **prebuilt Docker images** (no build step on the server).
1. Data persists via **named volumes**.
1. After the initial setup, containers **start automatically after reboot**.

The repository is set up so the default `docker-compose.yml` is the server/offline compose.

## Prerequisites

Online build machine (internet allowed):

1. Docker Engine + Docker Compose v2.

Offline Ubuntu server (no internet):

1. Docker Engine + Docker Compose v2 installed.
1. Enough disk space for images + volumes.

Notes:

1. **Do not** rely on `docker compose down` for routine operations on the server, because it removes containers (restart policy cannot restart a removed container). Use `docker compose stop` / `start` instead.
1. Automatic startup after reboot is handled by:
   - `sudo systemctl enable --now docker`
   - `restart: unless-stopped` in `docker-compose.yml`

## Files Used

In this repo:

1. `docker-compose.yml`: server/offline compose (images only).
1. `docker-compose.dev.yml`: development override (adds `build:` blocks).
1. `server/.env.offline`: API/server runtime config for offline.
1. `LLMOrchestrator/.env.offline`: orchestrator runtime config for offline.

On the offline server you will also have:

1. An exported images tarball, e.g. `evigstudio-images.tar`.

## Online Machine Steps (Build + Export Images)

These steps produce the image tarball you will move into the offline environment.

1. Build images locally:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml build
```

2. Confirm images exist (names must match `docker-compose.yml`):

1. `evigstudiolight-frontend:latest`
1. `evigstudiolight-api:latest`
1. `evigstudiolight-llm-orch:latest`
1. `evigstudiolight-llm-orch-worker:latest`

3. Export images to a tarball:

```bash
docker save \
  -o evigstudio-images.tar \
  evigstudiolight-frontend:latest \
  evigstudiolight-api:latest \
  evigstudiolight-llm-orch:latest \
  evigstudiolight-llm-orch-worker:latest \
  postgres:16-alpine \
  redis:7-alpine
```

4. Copy these to removable media / secure transfer into the offline environment:

1. `evigstudio-images.tar`
1. The project folder (or at minimum):
   - `docker-compose.yml`
   - `server/.env.offline`
   - `LLMOrchestrator/.env.offline`

## Offline Ubuntu Server Steps (One-Time Setup)

1. Install Docker and Docker Compose v2.

2. Ensure Docker starts automatically on boot:

```bash
sudo systemctl enable --now docker
```

3. Copy the project directory onto the server (choose a stable location), for example:

1. `/opt/evigstudio-light/`

4. Load the images tarball:

```bash
docker load -i evigstudio-images.tar
```

5. Start the stack once (this creates containers + networks + named volumes):

```bash
cd /opt/evigstudio-light
docker compose up -d
```

Before you run `docker compose up -d` on a server that already has data, verify the named volumes:

```bash
docker volume ls
```

You should see these exact names (pinned in `docker-compose.yml`):

1. `evigstudiolight_evigstudio_pgdata`
1. `evigstudiolight_llm-db-data`

If those volumes already exist, Compose will reuse them (no data loss).

6. Verify:

```bash
docker compose ps
```

7. Reboot test (recommended):

1. `sudo reboot`
1. After the machine comes back:

```bash
cd /opt/evigstudio-light
docker compose ps
```

If containers are present and running, the auto-start requirement is satisfied.

## Offline Server Day-2 Operations (No Scripts)

From the project directory:

1. Check status: `docker compose ps`
1. View logs: `docker compose logs -f --tail=200`
1. Stop without removing containers: `docker compose stop`
1. Start again: `docker compose start`
1. Restart: `docker compose restart`

Avoid:

1. `docker compose down` during normal usage (it removes containers).

## Upgrades (Offline)

1. Load the new tarball:

```bash
docker load -i evigstudio-images.tar
```

2. Recreate containers using the new images (data volumes remain):

```bash
cd /opt/evigstudio-light
docker compose up -d
```

## Data Persistence

The compose uses named volumes:

1. `evigstudio_pgdata` (pinned as `evigstudiolight_evigstudio_pgdata`): PostgreSQL data
1. `llm-db-data` (pinned as `evigstudiolight_llm-db-data`): orchestrator sqlite DB/state

These volumes persist across container recreation.

To list volumes:

```bash
docker volume ls
```

### If The Offline Server Uses Different Volume Names

If the offline server already has volumes containing the real data but with different names (example: `evigstudio_pgdata_v2`), then running `docker compose up -d` would create *new* empty volumes with the names in `docker-compose.yml`.

To reuse the existing data, you must make the compose file reference the *existing* volume names.

Where to change:

1. `docker-compose.yml`:
   - Under each service `volumes:` section.
   - Under the top-level `volumes:` section.

What to change (example):

1. If PostgreSQL data volume is named `evigstudio_pgdata_v2` on the server, change the pinned name:
   - `volumes.evigstudio_pgdata.name: evigstudiolight_evigstudio_pgdata`
   to `evigstudio_pgdata_v2`.

2. If orchestrator volume is named `llm-db-data-prod` on the server, change the pinned name:
   - `volumes.llm-db-data.name: evigstudiolight_llm-db-data`
   to `llm-db-data-prod`.

Why this is necessary:

1. Named volumes are looked up by name. Compose will only attach an existing volume if the name matches exactly.
1. If the name does not match, Compose treats it as “missing” and creates a new empty volume, which makes the app look like it has no data.
