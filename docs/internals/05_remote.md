# Remote architecture

Each connection joins a client to a local environment over HTTP and WebSocket.
Desktop can also start and connect to a WSL backend on the same machine.

## Identity is independent of the route

- An environment keeps its ID across restarts and endpoint changes. Repository identity can
  correlate clones across environments (preferring `upstream` for PR features, grouping forks by
  `origin`), but work never silently crosses environments.
- [Environment ID initialization](../../apps/server/src/environment/ServerEnvironment.ts) publishes
  atomically and retains repair state so concurrent initializers choose the same winner; do not
  sweep that recovery state as temp cleanup.
- **Routes are untrusted hints.** Only the connecting client can prove reachability. Never fall back
  to loopback when a shareable endpoint is unavailable (loopback names the client's own machine).
  Verify a direct or learned route answers as the expected environment before sending credentials,
  and never let a token paired over HTTPS downgrade to plain HTTP.
- Pull request routing trust covers the saved route set: adding or changing a route revokes trust;
  reordering does not.

## Hosted web is a client

The hosted web app stores its connection catalog in the browser and connects directly to each
environment without proxying traffic. A [hosted pairing URL](../../apps/web/src/hostedPairing.ts)
puts the backend target in the query and the pairing secret in the URL fragment so the secret never
reaches the hosted origin, then strips it from history.

## Desktop previews tunnel loopback

A desktop webview for a remote environment keeps `localhost` URLs and tunnels loopback connections
through `/api/preview/tunnel` on the environment's own origin:

- **Fixed SOCKS5 proxy, not PAC.** Chromium ignores PAC scripts for loopback hosts. Use a fixed
  proxy that routes only loopback through the tunnel (excluding link-local addresses) and never
  falls back directly—a failed or disabled tunnel must error rather than silently load the
  reviewer's own localhost.
- **Media tickets and local-owner check.** Desktop main holds no environment credentials, so the
  renderer supplies a media ticket per connection (also tracking route switches). Because Chromium
  cannot authenticate to SOCKS5 and a forwarded port is a plain local port, on Linux and macOS both
  listeners serve only connections the system attributes to the current OS user (`/proc/net/tcp`
  on Linux, `lsof` on macOS), and a connection whose owner cannot be read is refused. On Windows
  the listeners do not check the owner.

## Access and process ownership are separate

- Remote servers outlive client releases. Clients negotiate features via advertised capabilities
  rather than assuming version parity. Process replacement uses the
  [update protocol](./07_server-updates.md).
