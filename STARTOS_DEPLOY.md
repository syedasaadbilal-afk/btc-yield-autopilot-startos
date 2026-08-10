# Deploying BTC Yield Autopilot to StartOS

This packages the daemon+dashboard as a real StartOS service (`.s9pk`), installable like Hashrate Autopilot, with Starttunnel remote access. Scaffolded from `hashrate-autopilot-startos` (0.4.x `@start9labs/start-sdk`), verified locally: `npm run check` (tsc) and `npm run build` (ncc bundle) both pass clean against the real SDK types. `start-cli` itself (the s9pk packer/signer/installer) can only run on your machine against your dev key and your box, so everything from step 6 onward is on you - but every step up to that is now grounded in a config that's already proven to work.

## 1. Create the repo

Create a new **public** GitHub repo named `btc-yield-autopilot-startos` under your account, then push this entire project to it:

```
cd btc-xaut-autopilot
git init   # if not already a git repo
git add .
git commit -m "Initial StartOS package"
git branch -M main
git remote add origin https://github.com/syedasaadbilal-afk/btc-yield-autopilot-startos.git
git push -u origin main
```

## 2. Let Actions push the image to GHCR

`.github/workflows/build-image.yml` builds the existing `Dockerfile` (multi-arch: x86_64 + aarch64) and pushes to `ghcr.io/syedasaadbilal-afk/btc-yield-autopilot-startos`. It uses the built-in `GITHUB_TOKEN`, but that needs write access to packages first:

- Repo **Settings → Actions → General → Workflow permissions** → select **"Read and write permissions"** → Save.
- The workflow runs automatically on push to `main`, or trigger it manually from the **Actions** tab (`Build and push image` → **Run workflow**).
- Wait for it to go green - check the **Actions** tab.

**Important gotcha:** GHCR packages pushed via Actions default to **private**, even in a public repo. After the first successful run, go to the repo's **Packages** tab (or `github.com/users/syedasaadbilal-afk/packages/container/btc-yield-autopilot-startos/settings`) and change visibility to **Public**. If you skip this, StartOS's image pull will fail with an auth error and give you no useful hint why.

## 3. Install the StartOS SDK locally (your machine, not this sandbox)

Follow https://docs.start9.com/latest/developer-guide/sdk/installing-the-sdk to install `start-cli`. Then, once per machine:

```
start-cli init-key
```

This creates `~/.startos/developer.key.pem` - the key that signs your `.s9pk`.

Create `~/.startos/config.yaml`:

```yaml
host: http://<your-startos-box-name>.local
```

(Same hostname you already use to reach StartOS's own web UI.)

## 4. Build and install the package

From the repo root, on your machine:

```
npm ci
make arch/x86_64      # or `make arch/aarch64` if your box is ARM
make install
```

`make install` reads the host from `~/.startos/config.yaml` and pushes the signed `.s9pk` straight to your box. Watch for the "✅ Build Complete!" summary and then the install confirmation.

## 5. Enable Starttunnel + set up the app

1. Open the StartOS web UI → BTC Yield Autopilot → same "remote access" toggle you already used for Hashrate Autopilot.
2. Open the dashboard (locally or via the tunnel), go to the **Config** tab, and enter your Bitfinex API key + secret under "Bitfinex API credentials." This writes them into the service's data volume, not the image - never committed, never baked into the package.
3. Restart the BTC Yield Autopilot service from StartOS (Actions → Restart, or Stop/Start) so the daemon picks up the new credentials.
4. Confirm it comes up in **DRY_RUN** (the default) and looks right on the Status tab before touching LIVE.

## Shipping an update later

1. Make your code changes, bump the version in `startos/versions/current.ts` (e.g. `'0.1.1:0'`) with a release note.
2. Push to `main` → Actions rebuilds and pushes a new image tag.
3. If you changed the image tag in `startos/manifest/index.ts` (or just rely on `:latest` being refreshed), run `make arch/x86_64` again locally, then `make install` - StartOS handles it as an in-place update using the version you bumped.

## Known gaps / things I couldn't verify from here

- I could not run `start-cli` itself or reach your actual StartOS box, so the packing/signing/install steps (§3-4) are unverified beyond matching the exact structure of a package you already know installs successfully.
- `startos/i18n/dictionaries/default.ts` and `translations.ts` are minimal empty-dictionary stubs (verified they satisfy the real SDK's types via `tsc`), not copied from the reference repo's actual files - if the reference repo's versions do more than this, only `i18n('some string')` passthrough behavior (no translations) is guaranteed here.
- `.gitignore` wasn't in the reference repo, so none is included here - add one for `node_modules/`, `javascript/`, and `*.s9pk` if you don't want those in git.
