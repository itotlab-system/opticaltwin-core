# Running it for your lab

[← Back to the README](../README.md)

## Access control

The server is open by default, which is only appropriate on a trusted network.
Set `OT_PASSWORD` to require a shared-password login:

```bash
OT_PASSWORD='your-password' python server.py
```

Also set `OT_SESSION_SECRET` to a fixed random value in any persistent
deployment, otherwise sessions are invalidated on every restart. The server
speaks plain HTTP. Put it behind a reverse proxy with TLS if it is reachable
beyond a LAN.

`OT_PASSWORD` is one shared secret, not a user system: there are no accounts, no
per-project permissions and no audit trail. Read [SECURITY.md](../SECURITY.md)
before deploying anywhere. **Do not expose this to the public internet.**

## Serving the built app

Build the frontend once with `npm run build` in `app/`. `python server.py` then
serves `app/dist/` on port 8000, so only the backend needs to run.
