# Install Mission Control on Windows

Mission Control does not run on Windows directly. It runs inside **WSL2** (Windows Subsystem for Linux, a real Ubuntu that ships with Windows), and you use it from your normal Windows browser. Nothing in the app needs changing for this.

## 1. What you need

- Windows 11, or Windows 10 version 2004 or newer.
- About 3 GB of free disk space.
- Accounts for the AIs you plan to use: Claude (required for planning), OpenAI Codex (reviews by default), and a z.ai token for GLM (builds by default). You can swap any of these later.

## 2. Install WSL and Ubuntu 24.04

Open **PowerShell** (no admin needed to start; Windows asks for approval itself if it has to) in a folder holding a copy of this repo (GitHub → Code → Download ZIP, unzipped, is fine), then run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\setup-wsl.ps1
```

It checks WSL and installs Ubuntu 24.04 if it is missing (`wsl --install -d Ubuntu-24.04`). If Windows asks you to restart, restart and run it again. The first time Ubuntu opens, pick a Linux user name and password.

## 3. Run the setup inside Ubuntu

Open **Ubuntu 24.04** from the Start menu. Everything from here on is typed in that Ubuntu window, not PowerShell.

```sh
git clone https://github.com/LynchzDEV/mission-control.git ~/mission-control
~/mission-control/scripts/wsl/setup.sh --with-plugins
```

The project must live in your Ubuntu home folder (`~/mission-control`, which is `/home/<you>/mission-control`). Do not put it under `/mnt/c/...` (your Windows drive): Mission Control refuses folders outside your home, and the Windows drive is very slow from Linux.

What the setup does (safe to run again any time):

- Installs system tools with `sudo` (it asks for your Ubuntu password): git, curl, unzip, lsof, ripgrep, Node.js (the Codex tool runs on it), and the compiler bits one terminal library needs.
- Installs or upgrades **Bun** to 1.2.23 or newer.
- Installs the **Claude** and **Codex** command-line tools if they are missing, and checks that `codex --version` runs. It does not sign you in.
- With `--with-plugins`: installs bubblewrap and socat for the plugin sandbox, and turns off an Ubuntu 24.04 setting that blocks it (see step 9).
- Installs the app's own packages (`bun install`).

Other options: `--repo <git-url>` clones into `~/mission-control` for you; `--no-cli` skips the Claude and Codex installs.

## 4. Sign in to the AIs

Close and reopen the Ubuntu window first so the new tools are found. Then:

1. **Claude**: run `claude`, follow the sign-in prompt, then exit.
2. **Codex**: run `codex login`. Do this before the first job, because Codex reviews every change by default.
3. **GLM**: GLM runs the build jobs by default. After the first start (step 5), open Studio → Manage AIs → GLM and paste your z.ai base URL and token. No z.ai account? In Studio, give the build and review roles to AIs you do have.

## 5. First start

```sh
cd ~/mission-control
bun start
```

You should see `mission-control listening on http://127.0.0.1:7777`. Leave that window open.

## 6. Open the cockpit

In your Windows browser, open [http://localhost:7777](http://localhost:7777). Windows passes `localhost` through to WSL by itself.

## 7. Keep it running 24/7

WSL shuts Ubuntu down when no Windows program is attached to it, so closing the Ubuntu window stops Mission Control. To keep it up, register a task that starts it each time you sign in to Windows. In PowerShell (no admin needed), from the same folder as step 2, or from the Ubuntu copy at `\\wsl$\Ubuntu-24.04\home\<you>\mission-control`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1
Start-ScheduledTask -TaskName 'Mission Control'
```

It creates a task named "Mission Control" that runs at sign-in **hidden** (no window to close by accident): `conhost.exe --headless wsl.exe -d Ubuntu-24.04 -- bash -lc "{ cd ~/'mission-control' && bun start; } >> ~/mission-control.log 2>&1"`. The task is set to retry up to 3 times, one minute apart, but Windows may not retry when Mission Control itself exits with an error — check `~/mission-control.log` and run `Start-ScheduledTask -TaskName 'Mission Control'` if it is down. It also runs on battery. Other distro or folder: add `-Distro <name>` or `-RepoPath <path>`.

- **See what it is doing**: in Ubuntu, `tail -f ~/mission-control.log`.
- **Stop / start**: in PowerShell, `Stop-ScheduledTask -TaskName 'Mission Control'` and `Start-ScheduledTask -TaskName 'Mission Control'`. If the cockpit still answers after stopping, run `wsl --shutdown`.
- **Remove**: run the same script with `-Remove`.
- **If the hidden mode does not work on your PC** (some Windows 10 builds handle `conhost --headless` badly: nothing starts, or a window shows anyway): re-run the script with `-ShowWindow`. A console window then opens at sign-in. Minimize it, do not close it, because closing it stops Mission Control.

Running the task when Mission Control is already up does no harm: a second copy sees the first one and exits.

Also turn sleep off: Settings → System → Power → "When plugged in, put my device to sleep after" → **Never**. A sleeping PC answers nothing.

## 8. Updating

In Ubuntu:

```sh
cd ~/mission-control
git pull
mkdir -p /tmp/nodeshim && ln -sf ~/.bun/bin/bun /tmp/nodeshim/node && PATH=/tmp/nodeshim:$PATH ~/.bun/bin/bun install && rm -r /tmp/nodeshim
```

The long line is `bun install` with Bun standing in for Node.js, because the Node.js that Ubuntu ships cannot build one of the app's packages (see Troubleshooting).

Then restart: stop the running copy (Ctrl+C in its window, or `Stop-ScheduledTask -TaskName 'Mission Control'` from PowerShell if the autostart task started it) and start it again (`bun start`, or `Start-ScheduledTask -TaskName 'Mission Control'`).

## 9. Use it from another device (phone, laptop)

Mission Control only answers requests from the PC itself. That is on purpose, and the safe way around it is an encrypted tunnel over [Tailscale](https://tailscale.com) (a private network between your own devices):

Pick **one** of these two setups. Either way, install Tailscale on the other device too, signed in to the same account.

- **A. Tailscale on Windows, SSH into Windows.** Install Tailscale on Windows and turn on Windows' **OpenSSH Server** (Settings → System → Optional features). The SSH target is the Windows PC's tailnet name, and the SSH session lands in Windows, which forwards the tunnel to `localhost:7777`; Windows then passes it on to WSL like your browser does (step 6). To get a Linux shell from that SSH session, type `wsl`.
- **B. Tailscale inside Ubuntu.** In Ubuntu, install Tailscale and run `sudo tailscale up --ssh`. Ubuntu then shows up as its **own device** in your tailnet, separate from the Windows PC (often named after the PC). The SSH target is that Ubuntu device's name, and your user is your Ubuntu user name. Windows' OpenSSH is not used.

On the other device, open the tunnel and keep it open:

```sh
ssh -N -L 7777:127.0.0.1:7777 <user>@<tailnet-device-name>
```

Then open [http://localhost:7777](http://localhost:7777) on that device. Mission Control itself still only listens on `127.0.0.1`; the tunnel is what carries your requests to it.

> **Never** use `tailscale funnel`, port forwarding on your router, or a firewall rule that opens port 7777 to your network. Mission Control can run commands on your PC; anyone who can reach it can too.

## 10. Troubleshooting

| What you see | What to do |
|---|---|
| `http://localhost:7777` does not load in Windows, but `curl http://127.0.0.1:7777/api/health` inside Ubuntu answers | Turn on mirrored networking (needs Windows 11 22H2 or newer; on older Windows, run `wsl --shutdown` and start Mission Control again instead): create or edit `%UserProfile%\.wslconfig` with the two lines `[wsl2]` and `networkingMode=mirrored`, run `wsl --shutdown` in PowerShell, then start Mission Control again. |
| `cwd must be under $HOME` | The project or a repo you opened is outside your Ubuntu home (often under `/mnt/c`). Clone it into `~` inside Ubuntu instead. |
| An isolated plugin (for example the ClickUp board) fails to start | Run `~/mission-control/scripts/wsl/setup.sh --with-plugins`. It installs bubblewrap and socat and sets `kernel.apparmor_restrict_unprivileged_userns=0` (saved in `/etc/sysctl.d/60-mission-control-userns.conf`). Ubuntu 24.04 blocks the plugin sandbox without it; this is the setting the sandbox library's own README asks for. Delete that file to undo. |
| `another instance is running, refusing to double-bind` | Mission Control is already running (often the autostart task). Just open the browser. To restart it, stop the old copy first. |
| `bun: command not found` after setup | Close and reopen the Ubuntu window, or run `source ~/.profile`. |
| Jobs fail right away with a GLM or Codex error | Finish step 4 for that AI, or give its role to another AI in Studio → Manage AIs. |
| `codex` says `/usr/bin/env: 'node': No such file or directory` | Codex needs Node.js. In Ubuntu: `sudo apt-get install -y nodejs`, then `codex --version`. |
| `bun install` fails with `install script from "node-pty" exited with 1` | Run it with Bun standing in for Node.js: `cd ~/mission-control && mkdir -p /tmp/nodeshim && ln -sf ~/.bun/bin/bun /tmp/nodeshim/node && PATH=/tmp/nodeshim:$PATH ~/.bun/bin/bun install && rm -r /tmp/nodeshim` |
| `WslRegisterDistribution failed with error: 0x80370102`, or a message that virtualization is not enabled | Turn on hardware virtualization in your PC's BIOS/UEFI settings (called SVM or AMD-V on AMD, VT-x or Intel Virtualization Technology on Intel), save, reboot, and run step 2 again. |
