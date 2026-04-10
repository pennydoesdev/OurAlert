# Admin Bootstrap

This document walks you through creating the first admin account on a fresh OurALERT deployment.

There is no self-service signup for volunteers or admins. All accounts are created manually. The first admin is created by inserting a row directly into the `volunteers` table in D1.

---

## Prerequisites

1. You have deployed the Worker at least once (`npx wrangler deploy`)
2. You have run the schema migration (`npm run db:schema`)
3. You have Node.js 20+ installed locally

---

## Step 1 — Generate a password hash

From your local clone of the repo:

```bash
node scripts/hash-password.js "your-strong-password-here"
```

**Use a strong password.** This is the admin account for a platform that handles reports of law enforcement activity. Treat it like a root account. Minimum 16 characters, random, stored in a password manager.

The script will print output that looks like:

```
  Password hash (paste into D1 INSERT):

  AbC123...==:100000:XyZ456...==

  See docs/ADMIN_BOOTSTRAP.md for the full INSERT command.
```

Copy the entire hash line (the `salt:iterations:hash` string). You will paste it into the SQL command below.

---

## Step 2 — Insert the admin row via Wrangler

Replace the placeholder values and run this command:

```bash
wrangler d1 execute ouralert --remote --command \
  "INSERT INTO volunteers (id, email, password_hash, display_name, role, status, created_at) \
   VALUES ( \
     'adm_bootstrap_001', \
     'you@example.com', \
     'PASTE_HASH_FROM_STEP_1_HERE', \
     'Your Name', \
     'admin', \
     'active', \
     $(date +%s)000 \
   );"
```

**What each field means:**

| Field | What to put |
|---|---|
| `id` | Any unique string. `adm_bootstrap_001` is fine for the first admin. |
| `email` | Your actual email. This is where 2FA codes will be sent. |
| `password_hash` | The full output from `scripts/hash-password.js` |
| `display_name` | Shown in the moderation log and admin UI |
| `role` | Must be `admin` for the first account. Later accounts can be `volunteer` or `senior_mod`. |
| `status` | Must be `active`. `pending` and `suspended` are also valid states for non-first accounts. |
| `created_at` | `$(date +%s)000` produces the current unix timestamp in milliseconds |

---

## Step 2 — Alternative: D1 console in the Cloudflare dashboard

If you prefer not to use the CLI:

1. Go to `https://dash.cloudflare.com`
2. Workers & Pages → D1 → `ouralert`
3. Click the **Console** tab
4. Paste the same `INSERT INTO volunteers ...` command from Step 2
5. Run it

---

## Step 3 — Verify your admin account exists

```bash
wrangler d1 execute ouralert --remote --command \
  "SELECT id, email, display_name, role, status FROM volunteers WHERE role = 'admin';"
```

You should see your row listed.

---

## Step 4 — Log in

1. Visit `https://ouralert.org/volunteer`
2. Enter your email and the password you used in Step 1
3. A 6-digit code will be emailed to your address (requires SES or Loops to be configured first — see "Email provider setup" below)
4. Enter the code to complete 2FA
5. You will land on the moderation queue

---

## Step 5 — Create additional volunteer accounts

Once you are logged in as an admin, you can invite other volunteers from the admin panel at `/admin/volunteers`. You do not need to use the D1 console again for normal volunteer onboarding.

---

## GitHub Actions workflows

The `.github/workflows/` directory is populated by moving the staged YAML files from `docs/workflows-pending/`. This is a one-time manual step because the connector used to scaffold this repo does not have the `workflow` token scope required to write to `.github/workflows/` directly.

Run this once after cloning:

```bash
mkdir -p .github/workflows
mv docs/workflows-pending/*.yml .github/workflows/
rmdir docs/workflows-pending
git add .github/workflows docs/workflows-pending
git commit -m "[ci] activate auto-changelog and deploy workflows"
git push
```

After this, every push to `main` will auto-update `CHANGELOG.md` and trigger a deploy if `src/`, `public/`, or `wrangler.toml` changed.

### GitHub secrets required for the deploy workflow

In the repo settings → Secrets and variables → Actions, add:

- `CLOUDFLARE_API_TOKEN` — a scoped API token with `Workers Scripts: Edit` permission
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID (`e9647a01787b681c8b116ffc2649e12c`)

---

## Email provider setup

2FA login codes won't be delivered until you configure at least one email provider. Choose one:

### Option A — Amazon SES (recommended for transactional)

1. Verify the `ouralert.org` domain in the SES console (us-east-1)
2. Create an IAM user with `AmazonSESFullAccess` (or scoped-down equivalent)
3. Generate an access key pair
4. Set the Worker secrets:
   ```bash
   wrangler secret put SES_ACCESS_KEY_ID
   wrangler secret put SES_SECRET_ACCESS_KEY
   wrangler secret put SES_REGION      # us-east-1
   wrangler secret put SES_FROM        # noreply@ouralert.org
   ```

### Option B — Loops.so

1. Sign up at `https://loops.so`
2. Verify the `ouralert.org` domain
3. Create an API key (Settings → API)
4. Set the Worker secret:
   ```bash
   wrangler secret put LOOPS_API_KEY
   ```

Both can be configured simultaneously. Which provider is used for which email type is controlled by `DEFAULT_EMAIL_PROVIDER` in `wrangler.toml` and per-category overrides in `src/lib/email.js`.

---

## OneSignal setup (for push notifications)

1. Create a OneSignal app at `https://dashboard.onesignal.com`
2. Choose "Web Push" as the platform
3. Name it "OurALERT"
4. Site URL: `https://ouralert.org`
5. Save the **App ID** and **REST API Key**
6. Set the Worker secrets:
   ```bash
   wrangler secret put ONESIGNAL_APP_ID
   wrangler secret put ONESIGNAL_REST_KEY
   ```

---

## Featherless AI setup (for AlertIQ daily digest)

1. Get an API key from `https://featherless.ai`
2. Set the Worker secret:
   ```bash
   wrangler secret put FEATHERLESS_API_KEY
   ```

The AlertIQ digest cron will skip gracefully if this secret is missing.

---

## Turnstile setup

1. Go to `https://dash.cloudflare.com` → Turnstile → Add site
2. Site name: `OurALERT`
3. Domain: `ouralert.org`
4. Widget mode: **Invisible**
5. Save the site key (public) and secret key
6. Put the site key into `wrangler.toml` under `[vars] TURNSTILE_SITE_KEY`
7. Set the Worker secret:
   ```bash
   wrangler secret put TURNSTILE_SECRET
   ```

---

## Operational secrets

Two last secrets are internal to the Worker and not tied to any external service:

```bash
# Used to hash IP addresses before storage (rotate yearly)
wrangler secret put IP_SALT         # paste output of `openssl rand -hex 32`

# Used to sign volunteer session tokens (rotate if compromised)
wrangler secret put SESSION_SECRET  # paste output of `openssl rand -hex 32`
```

---

## Locking yourself out

If you lose access to the admin account:

1. Insert a new admin row using Step 1 + Step 2 above with a new email
2. Log in with the new admin
3. Suspend or delete the old admin from the admin panel at `/admin/volunteers`

There is no "forgot password" flow for admins on purpose. Password reset requires admin-level access and physical access to D1 — anyone with Cloudflare dashboard access can mint a new admin, so losing the password is never catastrophic.
