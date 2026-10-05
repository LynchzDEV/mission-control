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

   `200` means you are in. `403` means the host or login does not match what you set.

The Settings dialog then says "This app answers on this machine and to the Tailscale users you allow."

## What keeps it safe

- **Tailnet only.** `tailscale serve` is reachable only by devices signed in to your tailnet. The app itself still listens on this machine only.
- **User allowlist.** Tailscale tells the app who is asking (the `Tailscale-User-Login` header). Only logins in `MISSION_CONTROL_ALLOWED_USERS` get in. If that list is empty, nobody gets in from outside.
- **Through Tailscale only.** A request using the Tailscale name is accepted only when it arrives from this machine itself, which is where Tailscale hands it over. The same name coming from anywhere else is refused.
- **Origin check.** Changes must come from the app's own page (the browser's `Origin` must match the address), so another website cannot act for you.

To turn it off, remove the two lines, restart the autostart task, and run `tailscale serve --https=443 off`.
