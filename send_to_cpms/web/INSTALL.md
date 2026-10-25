# Installing the CPMS test app on a server (Hetzner, nginx)

One-time setup of `send_to_cpms/web` on an Ubuntu/Debian server that already runs nginx. After
this, every push to `main` deploys automatically through the GitHub Action
`.github/workflows/deploy-web.yml`.

```
browser ──HTTPS + basic auth──▶ nginx ──▶ 127.0.0.1:8600  node server.js  (systemd: cpms-web, user cpms)
GitHub Action ──SSH (user deploy)──▶ rsync files → npm ci → restart cpms-web
```

> **If you are an AI assistant carrying this out:** work through the steps in order, checking
> each one before moving on. Ask the user for the values in **Step 0**. **Never print, store or
> type secrets yourself** — AWS keys, passwords and the SSH private key are entered or copied by
> the user; tell them the exact command to run (in Claude Code they can prefix it with `!`). Ask
> before anything that agrees to terms (Let's Encrypt) or changes other nginx sites, and stop if
> a check fails.

## Step 0 — Values to get from the user

| Value | Example | Used for |
|---|---|---|
| `DOMAIN` | `cpms.example.com` | nginx and the HTTPS certificate — its DNS A/AAAA record must point at this server |
| `LE_EMAIL` | `you@example.com` | Let's Encrypt expiry notices |
| `AUTH_USER` | `vanguard` | the basic-auth login name (the user sets the password) |
| `AWS_DEFAULT_REGION` | `eu-west-2` | the region of `cpms-eventbus-consent` |
| `AWS_BUCKET_NAME` | `my-project-bucket` | the bucket holding `cpms/success/` and `cpms/fail/` |
| `REPO_DIR` | `~/vg` | where this repo is cloned on the server (needed once, for the first copy) |

The app goes in `/opt/cpms/app` (the repo's layout), runs as user `cpms`, and the GitHub Action
logs in as user `deploy`.

## Step 1 — Check the server

```bash
. /etc/os-release && echo "$PRETTY_NAME"           # Ubuntu / Debian expected
systemctl is-active nginx                           # active
dig +short "$DOMAIN"                                # this server's public IP
curl -s https://ifconfig.me; echo                   # compare with the line above
ls /etc/nginx/sites-enabled/                        # note existing sites — don't change them
```

## Step 2 — Install packages

Node.js 20 or later is required (22 LTS recommended):

```bash
node --version 2>/dev/null || echo "no node"
# If missing or older than v20:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo apt-get install -y rsync curl apache2-utils certbot python3-certbot-nginx
node --version && npm --version
```

## Step 3 — Users and folders

```bash
sudo useradd --system --home /opt/cpms --shell /usr/sbin/nologin cpms 2>/dev/null || true
sudo useradd --create-home --shell /bin/bash deploy 2>/dev/null || true

sudo install -d -o deploy -g deploy -m 755 /opt/cpms /opt/cpms/app
sudo install -d -o deploy -g deploy -m 755 /opt/cpms/app/send_to_cpms /opt/cpms/app/send_to_cpms/web /opt/cpms/app/consent_fanout
# The two folders the app writes to (stub data with emails, the ref key, comments):
sudo install -d -o cpms -g cpms -m 700 /opt/cpms/app/send_to_cpms/web/data
sudo install -d -o cpms -g cpms -m 755 /opt/cpms/app/consent_fanout/comments
```

## Step 4 — Settings file (the user fills in the AWS keys)

The server needs its **own** AWS IAM user with only the permissions in
`send_to_cpms/web/hosting/iam-policy.json` (put events on the bus; read `cpms/success/` and
`cpms/fail/`). The user creates it in the AWS console, replacing `REGION`, `ACCOUNT_ID` and
`BUCKET_NAME` in the policy, and creates an access key for it. **Don't reuse the deploy keys from
`.env.prod`.**

Create the file with placeholders (non-secret values filled in from Step 0):

```bash
sudo install -d -o root -g cpms -m 750 /etc/cpms
sudo tee /etc/cpms/cpms-web.env >/dev/null <<EOF
AWS_ACCESS_KEY_ID=REPLACE_ME
AWS_SECRET_ACCESS_KEY=REPLACE_ME
AWS_DEFAULT_REGION=$AWS_DEFAULT_REGION
AWS_BUCKET_NAME=$AWS_BUCKET_NAME
PORT=8600
HOST=127.0.0.1
COOKIE_SECURE=0
EOF
sudo chown root:cpms /etc/cpms/cpms-web.env
sudo chmod 640 /etc/cpms/cpms-web.env
```

Then **the user** puts in the two keys themselves:

```bash
sudo nano /etc/cpms/cpms-web.env      # replace both REPLACE_ME values, save
```

Check without showing them: `sudo grep -c REPLACE_ME /etc/cpms/cpms-web.env` → `0`.

## Step 5 — First copy of the app

Later deploys come from the GitHub Action; the first copy is made from the clone on the server,
with the same exclusions the Action uses:

```bash
cd "$REPO_DIR" && git pull
sudo rsync -a --delete --chmod=D755,F644 --chown=deploy:deploy \
  --exclude-from=send_to_cpms/web/hosting/rsync-exclude.txt \
  ./ /opt/cpms/app/
sudo -u deploy bash -c 'cd /opt/cpms/app/send_to_cpms/web && npm ci --omit=dev --no-audit --no-fund'
```

## Step 6 — systemd service

```bash
sudo cp /opt/cpms/app/send_to_cpms/web/hosting/cpms-web.service /etc/systemd/system/cpms-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now cpms-web
sleep 2
systemctl is-active cpms-web                               # active
curl -fsS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8600/   # 200
sudo journalctl -u cpms-web -n 20 --no-pager               # no "Missing settings" line
```

The unit expects `node` at `/usr/bin/node` (`command -v node`); if it's elsewhere, change
`ExecStart` in `/etc/systemd/system/cpms-web.service` and re-run `daemon-reload`.

## Step 7 — Let the deploy user restart the service (and nothing else)

```bash
SYSTEMCTL=$(command -v systemctl); JOURNALCTL=$(command -v journalctl)
echo "deploy ALL=(root) NOPASSWD: $SYSTEMCTL restart cpms-web, $JOURNALCTL -u cpms-web -n 50 --no-pager" \
  | sudo tee /etc/sudoers.d/cpms-deploy >/dev/null
sudo chmod 440 /etc/sudoers.d/cpms-deploy
sudo visudo -cf /etc/sudoers.d/cpms-deploy                 # must say "parsed OK"
```

The workflow calls `/usr/bin/systemctl` and `/usr/bin/journalctl`. If `command -v` shows other
paths, tell the user — the workflow's two `sudo -n` lines must match.

## Step 8 — nginx with basic auth

```bash
sudo cp /opt/cpms/app/send_to_cpms/web/hosting/nginx-cpms.conf /etc/nginx/sites-available/cpms
sudo sed -i "s/cpms.example.com/$DOMAIN/g" /etc/nginx/sites-available/cpms
sudo ln -sf /etc/nginx/sites-available/cpms /etc/nginx/sites-enabled/cpms
```

**The user** creates the login (they type the password; repeat without `-c` to add more users):

```bash
sudo htpasswd -c /etc/nginx/cpms.htpasswd "$AUTH_USER"
```

```bash
sudo chown root:www-data /etc/nginx/cpms.htpasswd && sudo chmod 640 /etc/nginx/cpms.htpasswd
sudo nginx -t && sudo systemctl reload nginx
curl -s -o /dev/null -w "%{http_code}\n" "http://$DOMAIN/"   # 401 (password required)
```

## Step 9 — HTTPS

Ask the user before running — it agrees to Let's Encrypt's terms:

```bash
sudo certbot --nginx -d "$DOMAIN" -m "$LE_EMAIL" --agree-tos --redirect --non-interactive
sudo sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=1/' /etc/cpms/cpms-web.env
sudo systemctl restart cpms-web
curl -s -o /dev/null -w "%{http_code}\n" "https://$DOMAIN/"   # 401
systemctl list-timers | grep -i certbot                         # renewal is scheduled
```

The user then checks `https://DOMAIN` in a browser: login prompt, then the app.

## Step 10 — Firewall

Only SSH and the web ports are open; 8600 stays private (the app listens on 127.0.0.1 anyway):

```bash
sudo ufw status
# If ufw is active:
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full'
```

## Step 11 — Connect the GitHub Action

Make an SSH key for the Action, allowed to log in as `deploy`:

```bash
sudo -u deploy bash -c 'mkdir -p ~/.ssh && chmod 700 ~/.ssh &&
  ssh-keygen -t ed25519 -N "" -C "github-actions-cpms" -f ~/.ssh/github_actions &&
  cat ~/.ssh/github_actions.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

In GitHub → the repo → **Settings → Secrets and variables → Actions**, **the user** adds:

| Name | Kind | Value |
|---|---|---|
| `DEPLOY_SSH_KEY` | secret | the **private** key — the user runs `sudo cat /home/deploy/.ssh/github_actions` and pastes it (don't print it in the assistant's output) |
| `DEPLOY_KNOWN_HOSTS` | secret | output of `ssh-keyscan -p 22 <server address>` (best run from the user's own machine) |
| `DEPLOY_HOST` | secret | the server's address (IP or hostname) |
| `DEPLOY_USER` | secret | `deploy` |
| `DEPLOY_PATH` | variable | `/opt/cpms/app` (optional — that's the default) |
| `DEPLOY_PORT` | variable | the SSH port, if not 22 |
| `DEPLOY_ENABLED` | variable | `true` — the workflow is skipped until this is set |

Then delete the private key from the server — it's only needed in GitHub:

```bash
sudo rm /home/deploy/.ssh/github_actions
```

Test: GitHub → **Actions → Deploy web app → Run workflow**. It should end with `cpms-web is up`.

## Day to day

- **Deploys:** push to `main` (changes under `send_to_cpms/web`, `schemas`, `taxonomy`, `docs`,
  `diagrams` or `consent_fanout`), or run the workflow by hand.
- **Logs:** `sudo journalctl -u cpms-web -f`
- **Restart:** `sudo systemctl restart cpms-web`
- **Add a login:** `sudo htpasswd /etc/nginx/cpms.htpasswd <name>`
- **Server-owned data** (never overwritten by deploys): `/opt/cpms/app/send_to_cpms/web/data/`
  (stub CRM / Marketo — contains email addresses — and the `ref` key) and
  `/opt/cpms/app/consent_fanout/comments/`. Back these up.
- **Rotating the AWS key:** create a new access key for the server's IAM user, put it in
  `/etc/cpms/cpms-web.env`, restart, then delete the old key in AWS.

## If something fails

| Symptom | Check |
|---|---|
| Service won't start | `sudo journalctl -u cpms-web -n 50` — a `Missing settings` line means the env file is incomplete |
| `502 Bad Gateway` | the service is down: `systemctl status cpms-web` |
| Action fails at "Copy files" | `DEPLOY_KNOWN_HOSTS` / `DEPLOY_SSH_KEY` / `DEPLOY_USER` secrets; `deploy` can write to `/opt/cpms/app` |
| Action fails at "restart" with a sudo error | `/etc/sudoers.d/cpms-deploy` paths match `/usr/bin/systemctl` |
| Registrations fail with AccessDenied | the server's IAM policy (region, account ID, bucket name) |
| Diagrams don't draw | the browser must reach `viewer.diagrams.net` (the page loads its viewer script from there) |
