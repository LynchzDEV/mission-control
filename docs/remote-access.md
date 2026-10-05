# Open Mission Control from another device

Mission Control normally answers only on the machine it runs on. You can let your own devices reach it over Tailscale (your private network), and nobody else.

## Set it up (inside Ubuntu on the Windows machine)

1. Share the app on your tailnet only:

   `tailscale serve --bg 7777`

   Never use `tailscale funnel`. Funnel puts the app on the public internet.

2. Find your machine name. `tailscale serve status` prints the address, for example `https://lynchzpc-wsl.tail1234.ts.net`.

3. Find your Tailscale login. Run `tailscale whois <the IP of the device you will browse from>` (look for `LoginName`), or read it in the Tailscale admin console under Users.

4. Tell Mission Control who may come in. Add these lines to `~/.profile` (or to the autostart task's environment):

   ```sh
   export MISSION_CONTROL_ALLOWED_HOSTS=lynchzpc-wsl.<tailnet>.ts.net
   export MISSION_CONTROL_ALLOWED_USERS=<your login>
   ```

   Both take a comma-separated list. Hosts must be full `*.ts.net` names; anything else (wildcards, IP addresses, ports, other domains) is ignored with a warning in the log.

5. Restart the Mission Control autostart task so it picks up the new settings.

6. Test it from another device on your tailnet:

   `curl -s -o /dev/null -w '%{http_code}\n' https://lynchzpc-wsl.<tailnet>.ts.net/api/roles`

   `200` means you are in. `403` means the host or login does not match what you set. Then run the check in "Check it after you turn it on" below.

The Settings dialog then says "This app answers on this machine and to the Tailscale users you allow."

## Lock the machine down in Tailscale

Anyone on your tailnet can reach `https://<machine>.<tailnet>.ts.net`. Mission Control refuses them unless their login is allowlisted, but limit who can reach it at all: in the Tailscale admin console, edit the access rules (ACLs or grants) so only your own login can reach port 443 of this machine. Shared or other users' devices should not reach it.

## Check it after you turn it on

From ANOTHER device on your tailnet (not this machine), run:

`curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: localhost' https://<machine>.<tailnet>.ts.net/api/roles`

It must print `403`. Anything else means requests through Tailscale are being treated as local: turn sharing off (below) and report it.

## What keeps it safe

- **Tailnet only.** `tailscale serve` is reachable only by devices signed in to your tailnet. The app itself still listens on this machine only. Never use `tailscale funnel`.
- **Shared requests are always remote.** Tailscale marks every request it passes on (it adds `X-Forwarded-For` and `Tailscale-*` headers that the sender cannot remove). Mission Control treats any such request as coming from another device, even if it claims to be for `localhost`. It never gets the local-machine pass, and the API token is refused for it.
- **User allowlist.** Tailscale tells the app who is asking (the `Tailscale-User-Login` header). A shared request gets in only when it names an allowed host in `MISSION_CONTROL_ALLOWED_HOSTS` and its login is in `MISSION_CONTROL_ALLOWED_USERS`. If the user list is empty, nobody gets in from outside.
- **Origin check.** Changes must come from the app's own page (the browser's `Origin` must match the address), so another website cannot act for you.
- **Local programs.** A program running on this machine already has full local access, so a local request that carries a forged `Tailscale-*` header gains nothing; it is simply treated as remote and refused unless it also passes the allowlist.

## Turn it off

1. `sudo tailscale serve --https=443 off`
2. Remove the two `export` lines and restart the autostart task.
